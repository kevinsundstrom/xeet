// The playground's adapter onto the resolver library (`crates/xeet-resolve`).
//
// The rules — the crawler's user agent, the hop limit, robots.txt, the card
// tags, the image variants, the quote rule — all live in Rust now, compiled to
// WebAssembly and exported by `packages/xeet/wasm`. This file supplies the four
// things that cannot live there:
//
//   1. `fetch`: Node's fetch with `redirect: "manual"`, so the library owns the
//      chain and the address guard runs on every hop. Sized reads, a per-request
//      abort, and no cookies.
//   2. `lookup`: `node:dns`, so the guard can refuse a hostname that resolves to
//      a private address.
//   3. `cache`: the disk cache under `assets/vendor/playground/`, which is
//      git-ignored (the repo stays small; media bytes never enter git).
//   4. files: the library returns bytes; the adapter writes them where the
//      renderer and the oracle expect them, and hands back the
//      `source.media` map (`{url: {file, bytes, width, height, variant, role}}`).
//
// The response shape is the one `resolveInput` has always returned, so the
// server, the UI and the oracle do not change.

import { createRequire } from "node:module";
import { lookup as dnsLookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PLAYGROUND_CACHE, ROOT } from "./build.mjs";

const require = createRequire(import.meta.url);

/** Where the glue and the module are (same directory the ship build writes). */
export const WASM_GLUE = join(ROOT, "packages", "xeet", "wasm", "xeet_wasm.js");
/** The disk cache. `XEET_LINKS_CACHE_DIR` is the seam the smoke test uses to
 * keep a fixture's cards out of the playground's own cache. */
export const LINKS_DIR = process.env.XEET_LINKS_CACHE_DIR ?? join(PLAYGROUND_CACHE, "links");
export const MEDIA_DIR = join(PLAYGROUND_CACHE, "media");
/** The page HTML Chrome's page mode reads, one file per post id. */
export const PAGE_DIR = PLAYGROUND_CACHE;

const SHA = (text) => createHash("sha256").update(text).digest("hex");
const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

let glue = null;
let glueError = null;

/** Drops the cached WASM glue so a fresh `/api/build` takes effect immediately. */
export function resetResolverModule() {
  glue = null;
  glueError = null;
  try {
    delete require.cache[require.resolve(WASM_GLUE)];
  } catch {}
}

/** The library, or `null` when this checkout's build predates the export. */
export function resolverModule() {
  if (glue || glueError) return glue;
  try {
    const module = require(WASM_GLUE);
    if (typeof module.resolve !== "function") {
      glueError = new Error(
        `${WASM_GLUE} has no resolve export; rebuild with node tools/ship/build-wasm.mjs`,
      );
      return null;
    }
    glue = module;
    return glue;
  } catch (error) {
    glueError = error;
    return null;
  }
}

/** Why the library is unavailable, for a log line or a test.
 * @returns {string | null} */
export function resolverUnavailableReason() {
  return resolverModule() ? null : String(glueError?.message ?? "unknown");
}

/**
 * @param {string} input text, an x.com URL, or post JSON
 * @param {{media?: boolean, width?: number, dpr?: number, links?: boolean,
 *          maxLinks?: number, refresh?: boolean, now?: string,
 *          signal?: AbortSignal}} options
 */
export async function resolveWithLibrary(input, options = {}) {
  const module = resolverModule();
  if (!module) throw new Error(`the resolver library is unavailable: ${resolverUnavailableReason()}`);

  const signal = options.signal;
  const media = options.media !== false;
  const maxLinks = options.links === false ? 0 : (options.maxLinks ?? 4);
  const wire = {
    media,
    width: options.width ?? 600,
    dpr: options.dpr ?? 2,
    surface: options.surface ?? "web-timeline",
    maxLinks,
    now: options.now ?? new Date().toISOString(),
    nowMs: Date.now(),
    refresh: options.refresh === true,
    // Test seam only (see `allowHosts`): the offline fixture listens on
    // 127.0.0.1, which the library refuses by design.
    ...(allowHosts(options).length ? { allowHosts: allowHosts(options) } : {}),
  };

  const host = createHost({ signal, refresh: options.refresh === true });
  const started = performance.now();
  let json;
  try {
    json = await module.resolve(input, JSON.stringify(wire), host);
  } catch (rejection) {
    // The library rejects with its error object as a JSON string
    // (`{code, status, message, fields?}`); hand it on as an Error whose fields
    // the caller can read, so the playground's handler needs no special case.
    const body = asErrorBody(rejection);
    const error = new Error(body.message ?? "resolution failed");
    error.name = "ResolveFailure";
    error.code = body.code ?? "resolve_failed";
    error.status = body.status ?? 502;
    error.fields = body.fields ?? [];
    error.resolver = "rust";
    throw error;
  }
  const resolved = JSON.parse(json);
  const elapsed = performance.now() - started;

  const files = await writeMediaFiles(resolved.media ?? {});
  const source = { ...(resolved.source ?? {}) };
  delete source.pageHtml;
  if (Object.keys(files).length) source.media = files;

  // A page-mode render needs the page on disk, the same way the JS resolver
  // left it, and the id/url so `normalizeSource` can find it again.
  const pageHtml = resolved.source?.pageHtml;
  if (pageHtml && source.id) {
    await mkdir(PAGE_DIR, { recursive: true });
    const name = `${source.id}.html`;
    const path = join(PAGE_DIR, name);
    await writeFile(path, pageHtml);
    source.page = name;
    source.pagePath = path;
    source.pageUrl = `https://x.com/i/status/${source.id}`;
  }

  // The card image's bytes live in `post.links[url].image.data`, which is what
  // the cell draws; the per-URL detail entry keeps the metadata and the size.
  const links = withoutLinkBytes(resolved.links);

  const body = {
    kind: source.id ? "url" : /^\s*[{[]/.test(input) ? "json" : "text",
    post: resolved.post,
    source,
    ...(links && Object.keys(links).length ? { links } : {}),
    ...(resolved.warnings?.length ? { warnings: resolved.warnings } : {}),
    ms: Math.round(elapsed * 10) / 10,
    resolver: "rust",
  };
  return body;
}

/**
 * Drops the duplicate base64 copy of a card image from the detail entries.
 *
 * `resolved.links[url].image` is the asset the crawler fetched; the bytes it
 * carries are the same string as `post.links[url].image.data`, which is the one
 * the renderer draws (`app.js` prefers it). Keeping both would double the
 * response body and every copy the browser keeps of it. `lib/resolve.mjs`
 * applies the same rule to its own detail entries.
 */
function withoutLinkBytes(links) {
  if (!links || typeof links !== "object") return links;
  const out = {};
  for (const [url, entry] of Object.entries(links)) {
    if (!entry || typeof entry !== "object") {
      out[url] = entry;
      continue;
    }
    const next = { ...entry };
    if (next.image && typeof next.image === "object") {
      const image = { ...next.image };
      delete image.data;
      next.image = image;
    }
    out[url] = next;
  }
  return out;
}

/**
 * The media bytes, written once per URL, plus the map the oracle reads.
 *
 * Files are named by the URL's SHA-256, so a URL has exactly one file and a
 * variant change (dpr, width) writes a new name rather than overwriting another
 * column's pixels. The writes are asynchronous: a resolve can inline several
 * megabytes, and the event loop serves the next keystroke meanwhile.
 */
async function writeMediaFiles(media) {
  const map = {};
  const urls = Object.keys(media);
  if (!urls.length) return map;
  await mkdir(MEDIA_DIR, { recursive: true });
  for (const url of urls) {
    const asset = media[url];
    if (!asset?.data) continue;
    const bytes = Buffer.from(asset.data, "base64");
    const extension = extensionOf(bytes);
    const file = join(MEDIA_DIR, `${SHA(url)}.${extension}`);
    if (!existsSync(file)) await writeFile(file, bytes);
    map[url] = {
      file,
      bytes: bytes.length,
      width: asset.width,
      height: asset.height,
      variant: asset.variant,
      role: asset.role,
    };
  }
  return map;
}

/** The library's rejection, as an object. */
function asErrorBody(rejection) {
  if (rejection && typeof rejection === "object") return rejection;
  if (typeof rejection === "string") {
    try {
      return JSON.parse(rejection);
    } catch {
      return { message: rejection };
    }
  }
  return { message: String(rejection) };
}

function extensionOf(bytes) {
  if (bytes.length > 12 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes.length > 8 && bytes.subarray(0, 4).toString("latin1") === "RIFF") return "webp";
  if (bytes.length > 4 && bytes.subarray(0, 3).toString("latin1") === "GIF") return "gif";
  return "png";
}

/**
 * Hosts the address guard should let through: the caller's own list plus the
 * test seam the JS resolver has always had (`XEET_LINKS_ALLOW_PRIVATE`). The
 * offline fixture server listens on 127.0.0.1, which the library refuses by
 * design, and no shipped wrapper sets this.
 */
function allowHosts(options) {
  const fromEnv = String(process.env.XEET_LINKS_ALLOW_PRIVATE ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return [...new Set([...(options.allowHosts ?? []), ...fromEnv])];
}

/**
 * The four injected pieces. Everything network-facing here is deliberately
 * literal: manual redirects, no cookies, a byte cap, an abort on the caller's
 * signal, and a DNS answer the library can police.
 */
function createHost({ signal, refresh }) {
  // `XEET_LINKS_HOST_MAP=host=127.0.0.1:port,…` sends a name to a local server:
  // the same seam `api/_lib/links.mjs` has, for the offline smoke fixtures. No
  // shipped wrapper sets it.
  const hostMap = Object.fromEntries(
    String(process.env.XEET_LINKS_HOST_MAP ?? "")
      .split(",")
      .map((pair) => pair.split("=").map((part) => part.trim()))
      .filter(([from, to]) => from && to),
  );
  const mapUrl = (href) => {
    const url = new URL(href);
    const target = hostMap[url.hostname.toLowerCase()] ?? hostMap[url.host.toLowerCase()];
    if (!target) return href;
    const [host, port] = target.split(":");
    url.hostname = host;
    // The mapped target is a local fixture, which speaks plain HTTP even when
    // the original URL was `https://x.com/…`.
    url.protocol = "http:";
    if (port) url.port = port;
    return url.href;
  };
  return {
    async fetch(request) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("timed out")), request.timeoutMs ?? 5000);
      const forward = () => controller.abort(new Error("cancelled"));
      if (signal) {
        if (signal.aborted) forward();
        else signal.addEventListener("abort", forward, { once: true });
      }
      try {
        const headers = {};
        for (const [name, value] of Object.entries(request.headers ?? {})) headers[name] = value;
        const response = await fetch(mapUrl(request.url), {
          method: request.method ?? "GET",
          headers,
          redirect: "manual",
          signal: controller.signal,
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        const maxBytes = request.maxBytes ?? buffer.length;
        const truncated = buffer.length > maxBytes;
        const body = truncated ? buffer.subarray(0, maxBytes) : buffer;
        const headersOut = {};
        response.headers.forEach((value, name) => {
          headersOut[name.toLowerCase()] = value;
        });
        return { status: response.status, headers: headersOut, body, truncated };
      } finally {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", forward);
      }
    },

    async lookup(host) {
      // A mapped host (the offline fixture) resolves to what it is mapped to, so
      // the guard and the fetch agree about where the request goes.
      const mapped = hostMap[host.toLowerCase()];
      if (mapped) return [mapped.split(":")[0]];
      const answers = await dnsLookup(host, { all: true, verbatim: true });
      return answers.map((answer) => answer.address);
    },

    async cacheGet(key) {
      if (refresh) return null;
      try {
        const entry = JSON.parse(await readFile(join(LINKS_DIR, `${SHA(key)}.json`), "utf8"));
        return { value: entry.value, storedAt: entry.storedAt };
      } catch {
        return null;
      }
    },

    async cacheSet(key, value, storedAt) {
      await mkdir(LINKS_DIR, { recursive: true });
      await writeFile(join(LINKS_DIR, `${SHA(key)}.json`), JSON.stringify({ key, value, storedAt }));
    },

    now() {
      return Date.now();
    },
  };
}

export { EXTENSIONS };
