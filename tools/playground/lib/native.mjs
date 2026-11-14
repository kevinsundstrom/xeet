// The long-lived `xeet-render serve --stdio` process, as a client.
//
// One process per binary. Requests are JSON lines with a monotonically
// increasing `id`; replies are matched by that id, so several renders can be in
// flight and a late reply is dropped rather than mis-delivered.
//
// Failure modes this class owns:
//
// - **Crash.** The process dies (a panic aborts: the release profiles use
//   `panic = "abort"`), so every pending request is failed with the stderr tail,
//   and the next request spawns a fresh process. A crash loop (three within five
//   seconds) stops the retries and reports the reason instead of thrashing.
// - **Hang.** A reply that does not arrive within `timeoutMs` fails that
//   request; the process is killed, because a renderer that stopped answering is
//   not trustworthy for the next one either.
// - **Rebuild.** `restart()` stops the old process; the next request starts the
//   new binary. No request ever runs against a binary that was replaced.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const CRASH_WINDOW_MS = 5000;
const CRASH_LIMIT = 3;

export class NativeProcess {
  /**
   * @param {object} options
   * @param {string} options.bin        the `xeet-render` binary
   * @param {number} [options.timeoutMs]
   * @param {(line: string) => void} [options.onStderr]
   */
  constructor({ bin, timeoutMs = 15000, onStderr } = {}) {
    this.bin = bin;
    this.timeoutMs = timeoutMs;
    this.onStderr = onStderr;
    /** @type {import("node:child_process").ChildProcess | null} */
    this.proc = null;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: any, sentAt: number}>} */
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.info = null;
    this.startedAt = 0;
    this.crashes = [];
    this.stats = { starts: 0, crashes: 0, requests: 0, timeouts: 0 };
    /** Pids we killed on purpose, so their exit is not counted as a crash. */
    this._stoppedPids = new Set();
    /** Bumped by restart(); a start that raced a restart does not win. */
    this.generation = 0;
  }

  get alive() {
    return Boolean(this.proc && this.proc.exitCode === null && !this.proc.killed);
  }

  /** The reason the target cannot be used right now, or null. */
  get failure() {
    if (this.crashes.length >= CRASH_LIMIT && Date.now() - this.crashes.at(-1) < CRASH_WINDOW_MS) {
      return `xeet-render serve crashed ${this.crashes.length} times in a row: ${this.stderrTail() || "no stderr"}`;
    }
    return null;
  }

  stderrTail(bytes = 4000) {
    return this.stderr.trim().slice(-bytes);
  }

  /** Starts the process if it is not running, and returns its `info` reply. */
  async ensure() {
    const failure = this.failure;
    if (failure) throw new Error(failure);
    if (this.alive && this.info) return this.info;
    return this.start();
  }

  start() {
    if (this._starting) return this._starting;
    this._starting = this._start().finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  async _start() {
    if (this.alive) return this.info;
    const generation = ++this.generation;
    const proc = spawn(this.bin, ["serve", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.stderr = "";
    this.info = null;
    this.startedAt = Date.now();
    this.stats.starts++;
    const startedAt = Date.now();

    proc.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8000);
      this.onStderr?.(chunk.toString());
    });

    createInterface({ input: proc.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // A non-JSON line on stdout is a bug in the binary; keep it as evidence
        // rather than crashing the server.
        this.stderr = (this.stderr + `[stdout not JSON] ${line}\n`).slice(-8000);
        return;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) return; // a late reply for a request that already failed
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        const e = new Error(message.error.message ?? "the render failed");
        e.code = message.error.code ?? "render_failed";
        e.status = message.error.status ?? 500;
        e.fields = message.error.fields ?? [];
        waiter.reject(e);
      } else {
        waiter.resolve(message);
      }
    });

    proc.on("error", (e) => {
      this.stderr = (this.stderr + `could not start ${this.bin}: ${e.message}\n`).slice(-8000);
      // A binary that cannot be executed never exits, so nothing else would
      // wake the handshake; fail it now instead of after a 60 s timeout.
      this.kill("spawn error");
    });

    proc.on("exit", (code, signal) => {
      if (this.proc === proc) this.proc = null;
      const why = signal ? `signal ${signal}` : `code ${code}`;
      // A process we stopped on purpose (restart, rebuild, shutdown, timeout) is
      // not a crash; `kill()` has already failed its pending requests.
      const stoppedOnPurpose = this._stoppedPids.delete(proc.pid);
      if (!stoppedOnPurpose && code !== 0) {
        this.stats.crashes++;
        this.crashes.push(Date.now());
        if (this.crashes.length > CRASH_LIMIT) this.crashes.shift();
      }
      for (const [id, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(
          new Error(
            `xeet-render serve exited (${why}) while rendering` +
              (this.stderrTail(600) ? `: ${this.stderrTail(600)}` : ""),
          ),
        );
        this.pending.delete(id);
      }
      if (!stoppedOnPurpose) {
        this.onStderr?.(`xeet-render serve exited (${why}); it lived ${Date.now() - startedAt} ms\n`);
      }
    });

    // Handshake: `info` both warms nothing and proves the loop is reading. The
    // first line the process reads pays the font/imagerie warm-up, so give it
    // the generous timeout.
    const info = await this.request({ op: "info" }, { timeoutMs: 60000 });
    if (generation !== this.generation) {
      // A restart happened while this one was starting; the newer one owns the
      // process.
      return this.info ?? { version: {} };
    }
    this.info = info.version ? { version: info.version, limits: info.limits } : null;
    return { version: info.version ?? {}, limits: info.limits ?? null, ops: info.ops ?? [] };
  }

  /** One request; resolves with the reply, rejects with a coded error. */
  request(message, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.alive) return Promise.reject(new Error("xeet-render serve is not running"));
    const id = this.nextId++;
    this.stats.requests++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stats.timeouts++;
        reject(new Error(`xeet-render serve did not answer within ${timeoutMs} ms`));
        // A stuck renderer is killed: the next request starts a fresh one, and
        // the pipe cannot be trusted to flush the late reply in order.
        this.kill("timeout");
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, sentAt: performance.now() });
      const line = JSON.stringify({ ...message, id }) + "\n";
      this.proc.stdin.write(line, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  /** Stops the process, failing anything pending; the next request restarts. */
  restart() {
    this.kill("restart");
    this.info = null;
    this.crashes = [];
  }

  kill(reason = "stop") {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this._stoppedPids ??= new Set();
    this._stoppedPids.add(proc.pid);
    proc.kill();
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`xeet-render serve was stopped (${reason})`));
      this.pending.delete(id);
    }
  }

  close() {
    this.kill("shutdown");
  }
}
