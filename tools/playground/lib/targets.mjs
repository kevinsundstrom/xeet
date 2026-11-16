// The target registry: what can render, at which version, and how to ask it.
//
// Four targets (docs/PLAYGROUND.md):
//
//   native  the long-lived `xeet-render serve --stdio` process
//   http    `api/index.mjs`'s fetch handler, called in-process
//   wasm    the browser runs it; the server only builds and versions it
//   chrome  the oracle module (`lib/chrome.mjs`), the ground truth
//
// Each one reports `{ id, label, available, version, stale, building, error? }`
// and a version of the same shape: `{ rev, dirty, builtAt, ruleset, upstream }`.
//
// ## Supersession
//
// While someone types, answers nobody is waiting for are waste. A newer request
// for the same client and target marks the older pending one superseded: the
// older one resolves as `{ superseded: true }` instead of carrying a stale PNG
// the UI would have to compare against a newer request's timestamp. The work is
// not cancelled (the native process cannot cancel a render mid-layout), but the
// result is dropped, and Chrome — the only slow target — checks the flag before
// it starts, so a burst of keystrokes costs one Chrome render, not twenty.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BUILDABLE,
  NATIVE_BIN,
  NODE_GLUE,
  NODE_WASM,
  WEB_GLUE,
  WEB_WASM,
  ROOT,
  build as buildTarget,
  isBuilding as buildInFlight,
  readMeta,
  staleness,
  versionFromMeta,
  versionOf,
} from "./build.mjs";
import * as httpTarget from "./http.mjs";
import { NativeProcess } from "./native.mjs";

const CHROME_MODULE = join(ROOT, "tools", "playground", "lib", "chrome.mjs");

export class ApiError extends Error {
  constructor(message, { status = 400, code = "bad_request", fields = [], target = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.target = target;
  }
}

/** Rendering targets, in the order the playground shows them. */
export const TARGETS = [
  { id: "chrome", label: "Chrome (truth)", kind: "chrome" },
  { id: "wasm", label: "WASM", kind: "wasm" },
  { id: "native", label: "native", kind: "native" },
  { id: "http", label: "HTTP fn", kind: "http" },
];

const isServerTarget = (id) => id === "native" || id === "http" || id === "chrome";

export class Targets {
  /** @param {{onEvent?: (event: object) => void}} [options] */
  constructor({ onEvent } = {}) {
    this.onEvent = onEvent ?? (() => {});
    /** @type {NativeProcess | null} */
    this.native = null;
    this.nativeInfo = null;
    this.nativeError = null;
    /** @type {any} */
    this.chromeObject = null;
    /** @type {Promise<any> | null} */
    this.chromePromise = null;
    /** @type {any} */
    this.chromeModuleValue = null;
    /** @type {Promise<any> | null} */
    this.chromeModulePromise = null;
    this.chromeError = null;
    /** The tail of the Chrome render chain: one browser, one render at a time. */
    this.chromeChain = Promise.resolve();
    /** `${client}\0${target}` → the token of the newest request. */
    this.inflight = new Map();
    /** `${client}\0${target}` → an AbortController for the in-flight Chrome render. */
    this.aborters = new Map();
    /** target id → `{ at, value }`, the version object a render reports. */
    this.versionCache = new Map();
  }

  // -------------------------------------------------------------------------
  // native
  // -------------------------------------------------------------------------

  nativeProcess() {
    if (!this.native) {
      this.native = new NativeProcess({
        bin: NATIVE_BIN,
        timeoutMs: 15000,
        onStderr: (text) => {
          const line = text.trim();
          if (line) console.error(`[native] ${line}`);
        },
      });
    }
    return this.native;
  }

  /** Starts the native process in the background, so the first keystroke is warm. */
  warm() {
    if (!existsSync(NATIVE_BIN)) return;
    this.nativeProcess()
      .ensure()
      .then((info) => {
        this.nativeInfo = info;
        this.nativeError = null;
      })
      .catch((e) => {
        this.nativeError = String(e.message ?? e);
      });
  }

  /** Restarts the process so the next request runs the newly built binary. */
  restartNative() {
    this.native?.restart();
    this.nativeInfo = null;
    this.nativeError = null;
  }

  // -------------------------------------------------------------------------
  // chrome
  // -------------------------------------------------------------------------

  /**
   * The oracle *module*, imported once per file version. Importing it launches
   * nothing: the browser is created by the factory, so `/api/targets` can ask
   * "is the chrome target there?" without starting Chrome.
   */
  async chromeModule() {
    if (this.chromeModuleValue) return this.chromeModuleValue;
    if (this.chromeError) throw this.chromeError;
    this.chromeModulePromise ??= (async () => {
      if (process.env.PLAYGROUND_CHROME === "0") {
        throw new Error("the chrome target is disabled (PLAYGROUND_CHROME=0)");
      }
      if (!existsSync(CHROME_MODULE)) {
        throw new Error("lib/chrome.mjs is not there yet (pg-oracle builds it)");
      }
      // The mtime in the URL keeps the module cache while letting an edit to
      // the oracle be picked up without restarting the playground.
      const mtime = statSync(CHROME_MODULE).mtimeMs;
      return await import(`${pathToFileURL(CHROME_MODULE).href}?v=${mtime}`);
    })();
    try {
      this.chromeModuleValue = await this.chromeModulePromise;
      return this.chromeModuleValue;
    } catch (e) {
      this.chromeError = e instanceof Error ? e : new Error(String(e));
      this.chromeModulePromise = null;
      throw this.chromeError;
    }
  }

  /**
   * The oracle object, created once. Its absence is not an error of the
   * playground: pg-oracle builds it in parallel, so until it exists the target
   * reports itself unavailable with that reason and everything else still works.
   *
   * `lib/chrome.mjs` exports a factory (`createChrome()` → `{ render, close,
   * version }`); a flat `{ render, close }` module is accepted too, so the two
   * shapes the brief allowed both work.
   */
  async chrome() {
    if (this.chromeObject) return this.chromeObject;
    if (this.chromeError) throw this.chromeError;
    this.chromePromise ??= (async () => {
      const mod = await this.chromeModule();
      const factory = mod.createChrome ?? mod.default?.createChrome;
      const flat = mod.render ?? mod.default?.render;
      if (typeof factory === "function") return await factory();
      if (typeof flat === "function") {
        return { render: flat, close: mod.close ?? mod.default?.close, version: mod.version };
      }
      throw new Error("lib/chrome.mjs exports neither createChrome() nor render()");
    })();
    try {
      this.chromeObject = await this.chromePromise;
      return this.chromeObject;
    } catch (e) {
      this.chromeError = e instanceof Error ? e : new Error(String(e));
      this.chromePromise = null;
      throw this.chromeError;
    }
  }

  // -------------------------------------------------------------------------
  // inventory
  // -------------------------------------------------------------------------

  /** One row per target: availability, version, staleness, current build. */
  async list() {
    const rows = [];
    for (const entry of TARGETS) rows.push(await this.describe(entry));
    return rows;
  }

  async describe(entry) {
    const base = { id: entry.id, label: entry.label, available: false, building: buildInFlight(entry.id) };
    try {
      if (entry.id === "native") return { ...base, ...(await this.describeNative()) };
      if (entry.id === "http") return { ...base, ...(await this.describeHttp()) };
      if (entry.id === "wasm") return { ...base, ...(await this.describeWasm()) };
      return { ...base, ...(await this.describeChrome()) };
    } catch (e) {
      return { ...base, available: false, version: versionOf({}), stale: true, error: String(e.message ?? e) };
    }
  }

  async describeNative() {
    const meta = await readMeta("native");
    const present = existsSync(NATIVE_BIN);
    const state = staleness([NATIVE_BIN], meta);
    let error = meta?.error ?? null;
    if (!present) error = meta?.error ?? "not built yet: POST /api/build { target: \"native\" }";
    else if (this.nativeError) error = this.nativeError;
    const version = versionOf({
      meta,
      artifact: present ? NATIVE_BIN : null,
      ruleset: this.nativeInfo?.version?.ruleset,
      appVersion: this.nativeInfo?.version?.upstream,
      fetchedAt: this.nativeInfo?.version?.upstreamFetchedAt,
    });
    return { available: present, version, stale: state.stale, staleWhy: state.why, error };
  }

  async describeHttp() {
    const meta = await readMeta("http");
    const artifact = existsSync(NODE_WASM) && existsSync(NODE_GLUE) ? NODE_WASM : null;
    const state = staleness([artifact], meta);
    let error = meta?.error ?? null;
    if (!artifact) {
      error = "the wasm module is not built yet: POST /api/build { target: \"http\" }";
    } else if (!(await httpTarget.available())) {
      error = httpTarget.handlerFailure() ?? "api/index.mjs could not be loaded";
    }
    return {
      available: Boolean(artifact) && !httpTarget.handlerFailure(),
      version: versionOf({
        meta,
        artifact,
        ruleset: httpTarget.ruleset(),
        appVersion: httpTarget.upstream(),
      }),
      stale: state.stale,
      staleWhy: state.why,
      error,
    };
  }

  async describeWasm() {
    const meta = await readMeta("wasm");
    const artifact = existsSync(WEB_WASM) && existsSync(WEB_GLUE) ? WEB_WASM : null;
    const state = staleness([artifact], meta);
    return {
      // The browser runs this one, so "available" means the module the browser
      // will fetch is on disk and current.
      available: Boolean(artifact),
      version: versionOf({ meta, artifact }),
      stale: state.stale,
      staleWhy: state.why,
      error: artifact ? meta?.error ?? null : "the web wasm build is missing: POST /api/build { target: \"wasm\" }",
      url: "/wasm/xeet_wasm.js",
    };
  }

  async describeChrome() {
    let error = null;
    let available = false;
    try {
      await this.chromeModule();
      available = true;
    } catch (e) {
      error = String(e.message ?? e);
    }
    return {
      available,
      // Chrome has no build: the module is interpreted on import, so it is
      // always as current as the checkout. Staleness is not a concept here.
      version: versionOf({ artifact: CHROME_MODULE }),
      stale: false,
      error,
      // Page mode needs a captured page; replica mode does not.
      modes: ["replica", "page"],
    };
  }

  /**
   * The version object a render response carries, cached for a second.
   *
   * Built from each artifact's meta, never from `git` (see
   * `versionFromMeta`): a keystroke must not wait on `git status`. Staleness is
   * a `/api/targets` concern, not a per-render one.
   */
  async version(id) {
    const now = Date.now();
    this.versionCache ??= new Map();
    const hit = this.versionCache.get(id);
    if (hit && now - hit.at < 1000) return hit.value;
    const meta = BUILDABLE.includes(id) ? await readMeta(id) : null;
    let value;
    if (id === "native") {
      value = versionFromMeta({
        meta,
        artifact: NATIVE_BIN,
        ruleset: this.nativeInfo?.version?.ruleset,
        appVersion: this.nativeInfo?.version?.upstream,
        fetchedAt: this.nativeInfo?.version?.upstreamFetchedAt,
      });
    } else if (id === "http") {
      value = versionFromMeta({
        meta,
        artifact: NODE_WASM,
        ruleset: httpTarget.ruleset(),
        appVersion: httpTarget.upstream(),
      });
    } else if (id === "wasm") {
      value = versionFromMeta({ meta, artifact: WEB_WASM });
    } else if (id === "chrome") {
      // Chrome has no build and no meta: it is interpreted from the checkout,
      // so the current revision is the honest answer.
      value = versionFromMeta({ artifact: CHROME_MODULE });
    } else {
      value = versionFromMeta({});
    }
    this.versionCache.set(id, { at: now, value });
    return value;
  }

  // -------------------------------------------------------------------------
  // render
  // -------------------------------------------------------------------------

  /**
   * Renders one post on one target.
   *
   * @param {{target: string, post: object, options?: object, mode?: string,
   *   source?: object, client?: string}} request
   */
  async render({ target, post, options, mode, source, client = "default" }) {
    if (!TARGETS.some((t) => t.id === target)) {
      throw new ApiError(`unknown target \`${target}\`; expected ${TARGETS.map((t) => t.id).join(", ")}`, {
        code: "unknown_target",
        status: 400,
      });
    }
    if (!isServerTarget(target)) {
      throw new ApiError(
        `\`${target}\` renders in the browser; call it there, not on the server`,
        { code: "client_side_target", status: 400 },
      );
    }
    if (!post || typeof post !== "object") {
      throw new ApiError("the request needs a `post` object", { code: "invalid_post", status: 400 });
    }

    const key = `${client}\u0000${target}`;
    const token = {};
    // A newer request for the same client and target aborts the older one where
    // the target supports it (Chrome does; the native process cannot cancel a
    // layout, so its result is dropped instead).
    this.aborters.get(key)?.abort();
    const controller = new AbortController();
    this.aborters.set(key, controller);
    this.inflight.set(key, token);
    const superseded = () => this.inflight.get(key) !== token;
    const started = performance.now();
    try {
      const result = await this.run(target, { post, options, mode, source, superseded, signal: controller.signal });
      const wall = performance.now() - started;
      if (superseded()) return { target, superseded: true, ms: { total: round(wall) } };
      return {
        target,
        png: result.png,
        width: result.width ?? null,
        height: result.height ?? null,
        dpr: result.dpr ?? options?.dpr ?? null,
        report: result.report ?? undefined,
        geometry: result.geometry ?? undefined,
        ms: result.ms
          ? {
              ...result.ms,
              // `total` is wall time for every target; `pipeline` is the
              // target's own view of the same request, when it reported one.
              ...(Number.isFinite(result.ms.target) || Number.isFinite(result.ms.total)
                ? { pipeline: result.ms.target ?? result.ms.total }
                : {}),
              total: round(wall),
            }
          : { total: round(wall) },
        version: await this.version(target),
        ...(result.extra ?? {}),
      };
    } catch (e) {
      // The oracle's own queue marks a dropped queued render `superseded`; that
      // is the same answer as our own bookkeeping, not a failure.
      if (superseded() || e.code === "superseded") {
        if (e.code !== "superseded") console.error(`[${target}] superseded request failed: ${e.message ?? e}`);
        return { target, superseded: true, ms: { total: round(performance.now() - started) } };
      }
      if (e instanceof ApiError) throw e;
      // The oracle codes its own refusals; a page that has no such post is a
      // client error, not a server failure.
      const status =
        e.code === "not_found" || e.code === "nested_only" ? 404 : e.status && e.status >= 400 ? e.status : 500;
      const error = new ApiError(e.message ?? "the render failed", {
        code: e.code ?? "render_failed",
        status,
        fields: e.fields ?? [],
        target,
      });
      error.cause = e;
      throw error;
    } finally {
      if (this.inflight.get(key) === token) this.inflight.delete(key);
      if (this.aborters.get(key) === controller) this.aborters.delete(key);
    }
  }

  async run(target, { post, options, mode, source, superseded, signal }) {
    if (target === "native") return this.runNative({ post, options });
    if (target === "http") return this.runHttp({ post, options });
    return this.runChrome({ post, options, mode, source, superseded, signal });
  }

  async runNative({ post, options }) {
    const proc = this.nativeProcess();
    try {
      const info = await proc.ensure();
      this.nativeInfo = info;
      this.nativeError = null;
    } catch (e) {
      this.nativeError = String(e.message ?? e);
      throw new ApiError(this.nativeError, { code: "target_unavailable", status: 503, target: "native" });
    }
    let reply;
    try {
      reply = await proc.request({ op: "render", post, options });
    } catch (e) {
      // A rebuild between the request and its answer stops the old process on
      // purpose; that is not the caller's fault, so run it once on the new
      // binary instead of reporting a failed column mid-build.
      if (!/was stopped \(restart\)/.test(String(e.message ?? ""))) throw e;
      const info = await proc.ensure();
      this.nativeInfo = info;
      reply = await proc.request({ op: "render", post, options });
    }
    return {
      png: reply.png,
      width: reply.width,
      height: reply.height,
      dpr: reply.dpr,
      report: reply.report,
      geometry: reply.geometry ?? undefined,
      ms: {
        // `serve.rs` measures `render` strictly around
        // `xr::render_with(&post, &opts, limits)` — layout, raster and PNG in
        // memory — so it is already the paint time. Parsing the request,
        // building the geometry and base64 are reported beside it.
        paint: reply.ms?.render,
        render: reply.ms?.render,
        parse: reply.ms?.parse,
        geometry: reply.ms?.geometry,
        encode: reply.ms?.encode,
        // Time inside the process, versus `total`, which includes the pipe.
        target: reply.ms?.total,
      },
    };
  }

  async runHttp({ post, options }) {
    const started = performance.now();
    const out = await httpTarget.render({ post, options });
    const wall = performance.now() - started;
    const size = out.report?.size ?? {};
    return {
      png: out.png,
      width: size.width ?? null,
      height: size.height ?? null,
      // The core's default when options are silent; the render used it even if
      // the caller did not name it.
      dpr: options?.dpr ?? 2,
      report: out.report,
      ms: {
        // The handler's `xeet.render(post, options)` call alone — not the JSON
        // request, not the base64 response. `target` is the whole handler and
        // `total` (added by the caller) is the round trip, which is what the
        // tooltip shows.
        paint: out.paintMs ?? null,
        render: out.paintMs ?? null,
        target: out.renderMs ?? Math.round(wall),
      },
    };
  }

  async runChrome({ post, options, mode, source, superseded, signal }) {
    const mod = await this.chrome().catch((e) => {
      throw new ApiError(String(e.message ?? e), { code: "target_unavailable", status: 503, target: "chrome" });
    });
    // Chrome draws X's layout, but the *decisions* (which body, which
    // attachment, what is hidden) must be xeet's, or the two columns differ for
    // a reason that is not layout. Hand the oracle the native report when it is
    // there; it falls back to the wasm engine, then to its own heuristic, and
    // says which it used.
    let report;
    try {
      report = (await this.explain({ post, options })).report;
    } catch (e) {
      console.error(`[chrome] no xeet report for decisions: ${e.message ?? e}`);
    }
    // Chrome shares one warm browser: renders queue, and a queued request that
    // has been superseded is dropped before it costs anything.
    //
    // The queue wait and the `explain` above are diagnostics: `ms.paint` is the
    // oracle's own paint (layout + screenshot), so a column waiting behind two
    // others does not look slow to render.
    const queuedAt = performance.now();
    const job = this.chromeChain.then(async () => {
      if (superseded()) return { superseded: true };
      const began = performance.now();
      const queue = Math.round(began - queuedAt);
      const started = began;
      const result = await mod.render({ post, options, mode: mode ?? "replica", source, report, signal });
      // Page mode can see a `Pinned` row in the cell's DOM. The post came from
      // a capture, so its social context is a fact about the page: hand the
      // caller a patch for the post it is holding (the native and http columns
      // will draw the row once the post carries it).
      const pinned = Boolean(result.geometry?.boxes?.pinnedRow) && post && typeof post === "object";
      const patch = pinned && post.socialContext !== "pinned" ? { socialContext: "pinned" } : null;
      if (patch) post.socialContext = "pinned";
      return {
        png: toBase64(result.png),
        width: result.width,
        height: result.height,
        dpr: result.dpr ?? options?.dpr ?? null,
        geometry: normalizeChromeGeometry(result.geometry),
        report: result.report ?? report ?? undefined,
        ms: {
          // `chrome.mjs` measures `paint` as its layout + screenshot phases,
          // excluding the page fetch, the harness load, and this queue.
          paint: result.ms?.paint ?? null,
          render: result.ms?.paint ?? result.ms?.total ?? Math.round(performance.now() - started),
          queue,
          target: result.ms?.total,
          layout: result.ms?.layout,
          screenshot: result.ms?.screenshot,
          fetch: result.ms?.fetch,
          load: result.ms?.load,
        },
        // Chrome is the truth: its version is the browser and the captured
        // app version, which no Rust artifact records.
        extra: {
          chromeVersion: result.version ?? null,
          notes: result.notes ?? [],
          frame: result.frame ?? null,
          ...(result.measuredId ? { measuredId: result.measuredId } : {}),
          ...(patch ? { postPatch: patch } : {}),
          // The oracle's own shapes, for anyone who wants the named boxes.
          chromeGeometry: result.geometry ?? null,
        },
      };
    });
    this.chromeChain = job.catch(() => {});
    return job;
  }

  /**
   * Explains a post without pixels: the validator `/api/resolve` uses.
   *
   * Native first, because it is the shipping parser and the fastest; the HTTP
   * function when the native binary is not built (a fresh checkout), so pasting
   * JSON still works. `engine` says which answered.
   */
  async explain({ post, options }) {
    try {
      const proc = this.nativeProcess();
      const info = await proc.ensure();
      this.nativeInfo = info;
      const reply = await proc.request({ op: "explain", post, options });
      return { engine: "native", report: reply.report };
    } catch (e) {
      if (e.code) throw e; // the renderer answered: the post is invalid
      // The native target could not run at all; the HTTP function has the same
      // core and the same answers.
      try {
        const report = await httpTarget.explain({ post, options });
        return { engine: "http", report };
      } catch (fallback) {
        if (fallback.code && fallback.status && fallback.status < 500) throw fallback;
        throw new ApiError("no renderer is available to validate this post", {
          code: "validator_unavailable",
          status: 503,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // build
  // -------------------------------------------------------------------------

  /** Rebuilds one target. One build at a time per target (shared, not queued). */
  async build(id) {
    if (!["native", "http", "wasm"].includes(id)) {
      throw new ApiError(`\`${id}\` is not buildable; build native, http or wasm`, {
        code: "not_buildable",
        status: 400,
      });
    }
    const result = await buildTarget(id);
    if (result.ok && id === "native") {
      // The next request must run the new binary, and the first keystroke after
      // a build should not pay the font load.
      this.restartNative();
      this.warm();
    }
    this.versionCache.clear();
    this.onEvent({ type: "targets", why: "build", target: id, ok: result.ok });
    return {
      ok: result.ok,
      ms: result.ms,
      log: result.log,
      target: id,
      ...(result.already ? { already: true } : {}),
      version: await this.version(id),
    };
  }

  async close() {
    this.native?.close();
    // Only close a Chrome that was actually created: shutdown must not launch
    // a browser just to shut it down.
    try {
      await this.chromeObject?.close?.();
    } catch {}
  }
}

function round(ms) {
  return Math.round(ms * 10) / 10;
}

/**
 * Chrome's geometry in the same shape as the native target's: `lines` are
 * `{text, x, y, w}` and `boxes` is an array of `{name, x, y, w, h}`.
 *
 * The oracle reports its named boxes as an object (`{avatar: {…}, text: null}`)
 * and its lines with `right` instead of `w`, because that is what its own
 * parity tests compare. The API promises one shape for every target, so the
 * arrays are built here and the original is kept as `chromeGeometry`.
 */
export function normalizeChromeGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") return undefined;
  const boxes = [];
  if (Array.isArray(geometry.boxes)) {
    boxes.push(...geometry.boxes);
  } else if (geometry.boxes && typeof geometry.boxes === "object") {
    for (const [name, box] of Object.entries(geometry.boxes)) {
      if (!box || typeof box !== "object") continue;
      boxes.push({ kind: "chrome", name, x: box.x, y: box.y, w: box.w, h: box.h });
    }
  }
  const lines = (Array.isArray(geometry.lines) ? geometry.lines : []).map((line) => ({
    text: line.text,
    x: line.x,
    y: line.y,
    w: line.w ?? (typeof line.right === "number" ? line.right - line.x : undefined),
    ...(line.h != null ? { h: line.h } : {}),
  }));
  if (!boxes.length && !lines.length) return undefined;
  return { lines, boxes };
}

function toBase64(png) {
  if (typeof png === "string") return png;
  if (Buffer.isBuffer(png)) return png.toString("base64");
  if (png instanceof Uint8Array) return Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64");
  return null;
}
