#!/usr/bin/env node
// Development-only static server for tools/playground/public.
//
// pg-server owns tools/playground/server.mjs; this exists so the front end can
// be built and verified before (and independently of) that server: it serves
// the page, the wasm web build at /wasm/* and X's fonts at /fonts/*, and
// answers /api/* with a clear 503 — which is what ?mock replaces.
//
//   node tools/playground/public/dev/serve.mjs        → http://127.0.0.1:4179
//   PORT=4180 node tools/playground/public/dev/serve.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..");
const ROOT = join(PUBLIC, "..", "..", "..");
const WASM = join(ROOT, "packages", "xeet", "wasm", "web");
const FONTS = join(ROOT, "assets", "vendor", "fonts");
const PORT = Number(process.env.PORT ?? 4179);
const HOST = process.env.HOST ?? "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
};

function safeJoin(base, rel) {
  const full = normalize(join(base, rel));
  if (!full.startsWith(base)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

function send(res, status, body, type = MIME[".json"]) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);
  const path = decodeURIComponent(url.pathname);

  if (path.startsWith("/api/")) {
    return send(
      res,
      503,
      JSON.stringify({
        error: {
          code: "no_server",
          message: "this is the static dev server; use the playground server or add ?mock",
        },
      }),
    );
  }
  if (path === "/events") {
    res.writeHead(501, { "content-type": "text/plain" });
    return res.end("no server");
  }

  try {
    if (path.startsWith("/wasm/")) {
      const file = safeJoin(WASM, path.slice("/wasm/".length));
      if (!file) return send(res, 404, "not found", "text/plain");
      return send(res, 200, await readFile(file), MIME[extname(file)] ?? "application/octet-stream");
    }
    if (path.startsWith("/fonts/")) {
      const file = safeJoin(FONTS, path.slice("/fonts/".length));
      if (!file) return send(res, 404, "not found", "text/plain");
      return send(res, 200, await readFile(file), MIME[extname(file)] ?? "application/octet-stream");
    }
    const file = safeJoin(PUBLIC, path === "/" ? "index.html" : path.slice(1));
    if (!file) return send(res, 404, "not found", "text/plain");
    return send(res, 200, await readFile(file), MIME[extname(file)] ?? "application/octet-stream");
  } catch (error) {
    console.error(error);
    return send(res, 500, String(error.message ?? error), "text/plain");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`playground static dev server: http://${HOST}:${PORT}/  (?mock for the mock API)`);
});
