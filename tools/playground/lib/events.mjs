// Server-sent events: one tiny hub, no dependency.
//
// The UI listens on `/events` and re-renders and refreshes badges when a build
// finishes or the source tree changes (docs/PLAYGROUND.md). Events are advisory
// — the payload carries the current target list so a client that missed one
// still converges, and a client that cares can always GET /api/targets.
//
// Frames are `data: <json>\n\n`, plus a comment line shortly after connect so
// the browser's `open` event fires immediately and a proxy cannot sit on an
// idle stream.

const HEARTBEAT_MS = 15_000;

export class Events {
  constructor() {
    /** @type {Set<import("node:http").ServerResponse>} */
    this.clients = new Set();
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) res.write(": ping\n\n");
    }, HEARTBEAT_MS);
    // A dev server must not keep the process alive on its own.
    this.heartbeat.unref?.();
    this.sent = 0;
  }

  /** Attaches a response as an event stream. Returns a detach function. */
  add(res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      // Chrome buffers an SSE stream behind a proxy without this.
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    const detach = () => this.clients.delete(res);
    res.on("close", detach);
    res.on("error", detach);
    return detach;
  }

  /** Sends one event to every listener. */
  send(event) {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    this.sent++;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  /** The event the UI acts on: something about the targets changed. */
  targets(targets, why) {
    this.send({ type: "targets", why, at: new Date().toISOString(), targets });
  }

  close() {
    clearInterval(this.heartbeat);
    for (const res of this.clients) {
      try {
        res.end();
      } catch {}
    }
    this.clients.clear();
  }
}
