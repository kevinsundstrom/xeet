#!/usr/bin/env node
// The xeet playground server. Development only; binds to localhost.
//
//   node tools/playground/server.mjs            → http://127.0.0.1:4177
//   PORT=4178 node tools/playground/server.mjs  (any other port)
//
// Plain `node:http`, plain ES modules, no framework and no bundler: the client
// under `public/` is served as files. Startup is "node this file and go" — the
// only expensive things (a cargo build, a wasm-bindgen run, Chrome) happen when
// someone asks for them.
//
// Routes (docs/PLAYGROUND.md has the contract):
//
//   GET  /api/targets            inventory: availability, version, staleness
//   POST /api/build              rebuild one target into target/playground/
//   POST /api/resolve            text | post JSON | x.com URL → a post
//   POST /api/render             one target, one post → PNG + report + geometry
//   GET  /api/source/:id         the captured page a URL resolve used
//   GET  /events                 server-sent events ({type:"targets"})
//   GET  /wasm/*                 packages/xeet/wasm/web, with wasm MIME types
//   GET  /wasm/fonts/*           packages/xeet/wasm/fonts (the lazy packs)
//   GET  /*                      tools/playground/public
//
// Errors are `{ error: { code, message, fields? } }` with a 4xx/5xx status.

import { createReadStream, existsSync, readFileSync, watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { Events } from "./lib/events.mjs";
import { Targets, ApiError } from "./lib/targets.mjs";
import { WEB_WASM_DIR, invalidateGit, invalidateSources, sourceSnapshot } from "./lib/build.mjs";
import { ResolveError, cachedPage, resolveInput, LINKS_CACHE } from "./lib/resolve.mjs";
import { resetResolverModule } from "./lib/resolve-lib.mjs";
import { configureLinks } from "./lib/links.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(HERE, "public");
const FONTS_DIR = join(HERE, "..", "..", "assets", "vendor", "fonts");
const PACKS_DIR = join(HERE, "..", "..", "packages", "xeet", "wasm", "fonts");
const PORT = Number(process.env.PORT ?? 4177);
const HOST = process.env.HOST ?? "127.0.0.1";
/** Generous: a post with inlined media is megabytes of base64. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

// Card resolutions live with the rest of the playground's cache, under the
// git-ignored `assets/vendor/`. The shipped function leaves this unset and gets
// a temp directory instead (`api/_lib/links.mjs`).
configureLinks({ cacheDir: LINKS_CACHE });

const events = new Events();
const targets = new Targets({
  onEvent: (event) => {
    // Builds report their own `targets` event; this keeps the callback honest
    // about what it is for.
    publishTargets(event.why ?? "build");
  },
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, x-playground-client",
  "access-control-expose-headers": "x-playground-ms",
};

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...CORS,
    ...headers,
  });
  res.end(payload);
}

/** The contract's error shape, for anything thrown on the way to a response. */
function sendError(res, error) {
  if (error instanceof ApiError || error instanceof ResolveError) {
    return sendJson(res, error.status ?? 400, {
      error: {
        code: error.code ?? "bad_request",
        message: error.message,
        ...(error.fields?.length ? { fields: error.fields } : {}),
        ...(error.warnings?.length ? { warnings: error.warnings } : {}),
      },
      ...(error.target ? { target: error.target } : {}),
    });
  }
  console.error("playground: unhandled", error);
  return sendJson(res, 500, {
    error: { code: "internal_error", message: String(error?.message ?? error) },
  });
}

async function readJsonBody(req) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    throw new ApiError(`the request body is ${declared} bytes; the limit is ${MAX_BODY_BYTES}`, {
      code: "request_too_large",
      status: 413,
    });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new ApiError(`the request body is over ${MAX_BODY_BYTES} bytes`, {
        code: "request_too_large",
        status: 413,
      });
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) throw new ApiError("the request body is empty", { code: "empty_body", status: 400 });
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ApiError(`the body is not valid JSON: ${e.message}`, { code: "invalid_json", status: 400 });
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Pre-compressed copies of the `/wasm/*` files, keyed by absolute path.
 *
 * The module is tens of megabytes of mostly image data: gzipping it costs ~180 ms
 * once and takes about 80% of it off the wire on every reload afterwards, so the
 * result is kept until the file it came from changes. Size and mtime are the
 * whole identity of the entry, and they double as the ETag: a rebuild produces a
 * new one, a reload gets `304` and no bytes.
 */
const precompressed = new Map();

function compression(full, info) {
  const hit = precompressed.get(full);
  if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit;
  const entry = {
    size: info.size,
    mtimeMs: info.mtimeMs,
    // Quoted, because an ETag is a quoted-string; the value is opaque to clients.
    etag: `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`,
    gzipped: gzipSync(readFileSync(full), { level: 1 }),
  };
  precompressed.set(full, entry);
  return entry;
}

/** Serves one file from `root`, refusing anything that escapes it. */
async function serveFile(req, res, root, urlPath, options = {}) {
  let rel;
  try {
    rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    return res.end("bad path");
  }
  if (rel.includes("\0")) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    return res.end("bad path");
  }
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    return res.end("outside the served directory");
  }
  let info;
  try {
    info = await stat(full);
  } catch {
    return notFound(req, res, `no such file: ${rel}`);
  }
  if (info.isDirectory()) return serveFile(req, res, root, join(urlPath, "index.html"), options);
  const type = MIME[extname(full).toLowerCase()] ?? "application/octet-stream";

  // The renderer's two files are the expensive ones: serve them pre-compressed,
  // and let a reload revalidate with a 304 instead of re-downloading.
  if (options.compress && (full.endsWith(".wasm") || full.endsWith(".js"))) {
    const entry = compression(full, info);
    const gzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    const headers = {
      "cache-control": "no-cache",
      // The two encodings are the same entity to us, different bytes on the
      // wire: say so, so a cache does not hand gzip to a client that cannot.
      vary: "accept-encoding",
      etag: entry.etag,
      ...CORS,
    };
    if (req.headers["if-none-match"] === entry.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const body = gzip ? entry.gzipped : await readFile(full);
    res.writeHead(200, {
      "content-type": type,
      "content-length": String(body.length),
      ...(gzip ? { "content-encoding": "gzip" } : {}),
      ...headers,
    });
    if (req.method === "HEAD") return res.end();
    return res.end(body);
  }

  res.writeHead(200, {
    "content-type": type,
    "content-length": String(info.size),
    // Development server: a rebuild must be visible on the next reload, and the
    // wasm module is requested by a JS loader that would happily cache it.
    "cache-control": "no-store",
    ...CORS,
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(full)
    .on("error", () => res.destroy())
    .pipe(res);
}

function notFound(req, res, message) {
  if ((req.url ?? "").startsWith("/api/")) {
    return sendJson(res, 404, { error: { code: "not_found", message } });
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...CORS });
  res.end(message);
}

// ---------------------------------------------------------------------------
// Target events
// ---------------------------------------------------------------------------

let publishing = false;
let republish = false;

/** Sends the current inventory to every event listener, coalesced. */
async function publishTargets(why = "change") {
  if (publishing) {
    republish = true;
    return;
  }
  publishing = true;
  try {
    const rows = await targets.list();
    events.targets(rows, why);
  } catch (e) {
    console.error("playground: could not publish targets", e);
  } finally {
    publishing = false;
    if (republish) {
      republish = false;
      setTimeout(() => publishTargets("change"), 0);
    }
  }
}

/**
 * Marks stale targets live when the source tree changes. Cargo itself writes
 * under `target/`, which is not watched, so a build does not feed itself.
 */
function watchSources() {
  if (process.env.PLAYGROUND_WATCH === "0") return;
  const dirs = [join(HERE, "..", "..", "crates"), join(HERE, "..", "..", "assets")];
  let timer = null;
  let lastNewest = sourceSnapshot().newest;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      watch(dir, { recursive: true }, (_event, filename) => {
        // Editor temp files and `.DS_Store` are noise.
        if (filename && /(^|\/)(\.#|#.*#|\.DS_Store|.*\.swp$)/.test(filename)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          invalidateSources();
          // The dirty flag comes from git, and it just became stale.
          invalidateGit();
          const newest = sourceSnapshot().newest;
          if (newest === lastNewest) return;
          lastNewest = newest;
          publishTargets("tree");
        }, 400);
      });
    } catch (e) {
      console.error(`playground: cannot watch ${dir}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** The client a request belongs to: supersession is per client and target. */
function clientOf(req, body, url) {
  return (
    (typeof body?.client === "string" && body.client) ||
    String(req.headers["x-playground-client"] ?? "") ||
    url.searchParams.get("client") ||
    "default"
  );
}

async function handleApi(req, res, url, path) {
  const method = req.method?.toUpperCase() ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (path === "/api/targets") {
    if (method !== "GET") throw new ApiError("use GET for /api/targets", { code: "method_not_allowed", status: 405 });
    return sendJson(res, 200, { targets: await targets.list() });
  }

  if (path === "/api/build") {
    if (method !== "POST") throw new ApiError("use POST for /api/build", { code: "method_not_allowed", status: 405 });
    const body = await readJsonBody(req);
    const target = body.target;
    if (typeof target !== "string") {
      throw new ApiError('the body needs `target`: "native", "http" or "wasm"', {
        code: "invalid_request",
        status: 400,
        fields: [{ path: "target", message: "is required" }],
      });
    }
    const result = await targets.build(target);
    if (result?.ok && (target === "wasm" || target === "http")) resetResolverModule();
    return sendJson(res, 200, result);
  }

  if (path === "/api/resolve") {
    if (method !== "POST") throw new ApiError("use POST for /api/resolve", { code: "method_not_allowed", status: 405 });
    const body = await readJsonBody(req);
    if (typeof body.input !== "string") {
      throw new ApiError("the body needs `input`: text, post JSON or an x.com URL", {
        code: "invalid_request",
        status: 400,
        fields: [{ path: "input", message: "is required" }],
      });
    }
    // Images are on by default (the whole point of the column is to show what X
    // shows); `media: false` (or `?media=0`) opts out, which is what the UI
    // sends while someone is typing.
    const media = body.media !== false && url.searchParams.get("media") !== "0";
    const offline = body.offline === true || process.env.PLAYGROUND_OFFLINE === "1";
    // Card resolution is on unless the client says otherwise: while someone is
    // typing, the UI sends `links: false` and asks once the text settles.
    const links = body.links !== false;
    // `refresh` re-fetches a cached card (`?refresh=1` too).
    const refresh = body.refresh === true || url.searchParams.get("refresh") === "1";
    const started = performance.now();
    // A superseded keystroke should stop the fetches it started, not finish
    // them for nobody.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const result = await resolveInput(body.input, {
      media,
      offline,
      links,
      refresh,
      options: body.options,
      signal: controller.signal,
      validate: (post, options) => targets.explain({ post, options }),
      explain: (post, options) => targets.explain({ post, options }),
    });
    return sendJson(res, 200, result, { "x-playground-ms": String(Math.round(performance.now() - started)) });
  }

  if (path === "/api/render") {
    if (method !== "POST") throw new ApiError("use POST for /api/render", { code: "method_not_allowed", status: 405 });
    const body = await readJsonBody(req);
    const started = performance.now();
    const result = await targets.render({
      target: body.target,
      post: body.post,
      options: body.options,
      mode: body.mode,
      source: body.source,
      client: clientOf(req, body, url),
    });
    return sendJson(res, 200, result, { "x-playground-ms": String(Math.round(performance.now() - started)) });
  }

  if (path.startsWith("/api/source/")) {
    const id = path.slice("/api/source/".length);
    if (!/^\d+$/.test(id)) throw new ApiError("expected a numeric status id", { code: "bad_request", status: 400 });
    const html = await cachedPage(id);
    if (html == null) {
      throw new ApiError(`no cached page for ${id}; resolve its URL first`, { code: "not_found", status: 404 });
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...CORS,
    });
    return res.end(html);
  }

  return sendJson(res, 404, { error: { code: "not_found", message: `no route for ${path}` } });
}

async function route(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/events") return events.add(res);

  if (path.startsWith("/api/")) return handleApi(req, res, url, path);

  // X's Chirp, straight from the git-ignored vendor directory: the UI uses
  // the same faces as the renders, and nothing proprietary lands in public/.
  if (path.startsWith("/fonts/")) {
    const name = url.pathname.slice("/fonts/".length);
    if (!/^Chirp-[A-Za-z]+\.[a-z-]+\.woff2$/.test(name)) return notFound(req, res, "unknown font");
    return serveFile(req, res, FONTS_DIR, name);
  }

  // The lazy font packs are large binaries; serve them from the build output
  // rather than duplicating them under `wasm/web`.
  if (path === "/wasm/fonts" || path.startsWith("/wasm/fonts/")) {
    const rel = url.pathname.slice("/wasm/fonts".length) || "/packs.json";
    return serveFile(req, res, PACKS_DIR, rel);
  }

  if (path === "/wasm" || path.startsWith("/wasm/")) {
    const rel = url.pathname.slice("/wasm".length) || "/index.html";
    return serveFile(req, res, WEB_WASM_DIR, rel, { compress: true });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return notFound(req, res, "only GET and HEAD are served here");
  }
  return serveFile(req, res, PUBLIC, url.pathname === "/" ? "/index.html" : url.pathname);
}

const server = createServer((req, res) => {
  route(req, res).catch((e) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(res, e);
  });
});

server.on("clientError", (_err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`playground: port ${PORT} is already in use; pick another with PORT=<free port>`);
  } else {
    console.error("playground: server error", e);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  console.log(`playground: http://${HOST}:${port}`);
  console.log("  GET  /api/targets   POST /api/render   POST /api/resolve   POST /api/build");
  console.log("  GET  /events        GET  /wasm/*");
  // The native process pays its font load once; doing it now means the first
  // keystroke is already warm. It is not a build: nothing is compiled here.
  targets.warm();
  // One inventory read warms the git probe and the source scan, so the first
  // render is not the request that pays for them.
  targets.list().catch((e) => console.error(`playground: could not list targets: ${e.message ?? e}`));
  watchSources();
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\nplayground: ${signal}, closing`);
  events.close();
  server.close();
  try {
    await targets.close();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (e) => console.error("playground: unhandled rejection", e));
