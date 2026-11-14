// Image bytes for the Chrome target, in both directions.
//
// Development only. Two jobs:
//
// 1. **Page mode** renders a captured x.com page hermetically, and that page
//    asks `pbs.twimg.com` for its photographs, video poster frames, avatars,
//    badges and card images. Those requests are answered from bytes we already
//    have — `source.media`, the playground's media cache — and, on a miss, from
//    the same fetch the resolver uses. Without this every image in the truth
//    column was a transparent 1×1 stub, which makes "does the picture land in
//    the right box" unanswerable.
//
// 2. **Replica mode** needs the same bytes for the `<img>`/`<video poster>` it
//    injects; `dataUri()` in `chrome-markup.mjs` handles that side from the
//    post's own base64.
//
// ## Whose rules these are
//
// Not mine. `api/_lib/links.mjs` already fetches and caches X's images for the
// other targets — `fetchImageAsset` checks the host against its allow-list, asks
// robots, caps the bytes, enforces a per-host politeness gap of one request a
// second (chained per host, so a burst cannot interleave), and stores the file
// under `sha256(url)` in one git-ignored directory with LRU eviction. This module
// calls it rather than repeating it, so page mode and the resolver share the
// process-wide gap *and* the cache: a picture `/api/resolve` downloaded is
// already on disk for the truth column, and whatever a render fetches is there
// for the next resolve.
//
// Two things are ours, because only a page has them: an *asset key* (a page asks
// for `…/media/ABC?format=webp&name=large` while an older resolve cached
// `…/media/ABC.jpg`, and both are the same picture), and a budget (a page asks
// for every avatar on it, and a render must not turn into a minute of network).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { configureLinks, fetchImageAsset, imageFileFor } from "./links.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The playground's own cache root: `assets/vendor/playground` (git-ignored). */
const CACHE_ROOT = process.env.XEET_LINKS_CACHE_DIR ?? join(HERE, "..", "..", "..", "assets", "vendor", "playground");
/** Where `api/_lib/links.mjs` stores image bytes: next to its cache, in `media/`. */
export const MEDIA_CACHE = process.env.XEET_LINKS_IMAGE_DIR ?? join(CACHE_ROOT, "media");

// Point the shared module at the playground's cache. Same call `server.mjs` makes;
// it is idempotent, and it only matters when this module is used without the
// server (a test run), where the default would be a temp directory nobody reads.
if (!process.env.XEET_LINKS_CACHE_DIR && !process.env.XEET_LINKS_IMAGE_DIR) {
  configureLinks({ cacheDir: join(CACHE_ROOT, "links") });
}

/** A transparent 1×1 PNG: what an image box gets when we have nothing better. */
export const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/** Per oracle instance, so a long session cannot grow without bound. */
const MAX_FETCHES = 400;
/** Consecutive network failures before the store stops trying (offline laptop). */
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;

const TYPE_BY_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif" };

/**
 * The identity of an image, independent of the variant a browser picked.
 *
 * `https://pbs.twimg.com/media/ABC?format=webp&name=large` and
 * `https://pbs.twimg.com/media/ABC.jpg` are the same picture;
 * `…/profile_images/1/x_normal.jpg` and `…/x_200x200.jpg` are the same avatar
 * at two sizes.
 */
export function assetKey(url) {
  try {
    const u = new URL(url);
    let path = u.pathname.replace(/\.(jpe?g|png|webp|gif|avif)$/i, "");
    path = path.replace(/_(normal|mini|bigger|400x400|200x200|\d+x\d+)$/i, "");
    return `${u.host}${path}`;
  } catch {
    return null;
  }
}

/**
 * `…/media/ABC?format=webp&name=large` -> `https://pbs.twimg.com/media/ABC.jpg`.
 *
 * The path extension is always `.jpg` when the URL has none, whatever `format`
 * asks for: X serves the *path* at `.jpg`/`.png` and the encoding through the
 * query, so `/media/ABC.webp` is a 404 (measured). This is also the form
 * `media_url_https` has, which is what older resolves cached under.
 */
function canonicalUrl(url) {
  try {
    const u = new URL(url);
    const named = /\.(jpe?g|png|webp|gif|avif)$/i.test(u.pathname);
    return `${u.origin}${u.pathname}${named ? "" : ".jpg"}`;
  } catch {
    return null;
  }
}

/** The bytes' own type, so a JPEG served for a `format=webp` request is labelled right. */
export function sniffType(bytes, url = "") {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length > 4 && bytes.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (bytes.length > 12 && bytes.toString("ascii", 4, 8) === "ftyp") return "image/avif";
  const ext = (url.split(".").pop() ?? "").toLowerCase();
  return TYPE_BY_EXT[ext] ?? "image/jpeg";
}

const hash = (url) => createHash("sha256").update(url).digest("hex");

/**
 * A cache of image bytes, indexed by asset, that can answer route handlers.
 *
 * `bytesFor(url)` is async because a miss may fetch; the route handler awaits it
 * before fulfilling. Everything is best-effort: a miss that cannot be filled
 * returns `null`, and the caller draws the blank stub exactly as before.
 */
export function createMediaStore({ cacheDir = MEDIA_CACHE, fetchOnMiss = true, offline = false } = {}) {
  const byAsset = new Map(); // assetKey -> { file?, base64? }
  const byUrl = new Map(); // exact url -> { file?, base64? }
  const memory = new Map(); // assetKey -> { bytes, type }
  const inflight = new Map(); // assetKey -> Promise
  const stats = { hits: 0, misses: 0, fetched: 0, failed: 0, bytes: 0, skipped: 0 };
  let consecutiveFailures = 0;
  let disabled = false;
  let total = 0;

  /**
   * Registers `/api/resolve`'s `source.media` map: `{url: {file, bytes, width,
   * height, variant}}`, keyed by the variant URL the resolver inlined.
   */
  function register(sourceMedia) {
    if (!sourceMedia || typeof sourceMedia !== "object") return 0;
    let added = 0;
    for (const [url, entry] of Object.entries(sourceMedia)) {
      if (!url || !entry) continue;
      // `file` is a path under the media directory, but a caller may hand over
      // any path it can read.
      const file = entry.file
        ? [entry.file, join(cacheDir, entry.file)].find((p) => existsSync(p)) ?? join(cacheDir, entry.file)
        : undefined;
      const record = { file, base64: entry.data ?? entry.base64 };
      const key = assetKey(url);
      // The resolver's map is authoritative for the render it came with: it
      // outranks anything this session has cached for the same asset.
      if (key) {
        byAsset.set(key, record);
        memory.delete(key);
      }
      byUrl.set(url, record);
      added++;
    }
    return added;
  }

  function cachedFile(url) {
    for (const ext of Object.keys(TYPE_BY_EXT)) {
      const file = join(cacheDir, `${hash(url)}.${ext}`);
      if (existsSync(file)) return file;
    }
    return null;
  }

  /**
   * Every cache key this request could be stored under: the exact URL, the
   * canonical (query-less) one, and both with the extension variants X uses.
   * The resolver caches the variant URL it fetched, the page asks for the same
   * variant when the slot is the same — but a capture asks `?format=…` where an
   * older resolve cached `media_url_https`.
   */
  function candidateCacheUrls(url) {
    const set = new Set([url]);
    const canonical = canonicalUrl(url);
    if (canonical) set.add(canonical);
    for (const base of [url, canonical]) {
      if (!base) continue;
      const bare = base.split("?")[0];
      const stem = bare.replace(/\.(jpe?g|png|webp|gif|avif)$/i, "");
      for (const ext of ["jpg", "png", "webp", "gif"]) set.add(`${stem}.${ext}`);
    }
    return [...set];
  }

  async function fromDisk(url) {
    const direct = byUrl.get(url) ?? byAsset.get(assetKey(url));
    if (direct?.base64) return { bytes: Buffer.from(direct.base64, "base64"), type: null };
    const files = [];
    if (direct?.file && existsSync(direct.file)) files.push(direct.file);
    // The shared module's own cache, by the exact URL (its `sha256(url)` key).
    const shared = await imageFileFor(url).catch(() => null);
    if (shared && existsSync(shared) && !files.includes(shared)) files.push(shared);
    for (const candidate of candidateCacheUrls(url)) {
      const file = cachedFile(candidate);
      if (file && !files.includes(file)) files.push(file);
    }
    if (!files.length) return null;
    const bytes = await readFile(files[0]);
    return { bytes, type: null };
  }

  /**
   * Fetches one image through `api/_lib/links.mjs` (host allow-list, robots, cap,
   * one request a second per host, shared cache). The query-less URL is tried
   * after the request's own, for the captures that ask for a variant the CDN no
   * longer answers.
   */
  async function fetchBytes(url) {
    if (disabled || stats.fetched >= MAX_FETCHES || total >= MAX_TOTAL_BYTES) {
      stats.skipped++;
      return null;
    }
    let host = null;
    try {
      host = new URL(url).host;
    } catch {
      return null;
    }
    if (host !== "pbs.twimg.com" && host !== "abs.twimg.com") {
      stats.skipped++;
      return null;
    }
    for (const target of [url, canonicalUrl(url)].filter((v, i, all) => v && all.indexOf(v) === i)) {
      try {
        const asset = await fetchImageAsset(target);
        consecutiveFailures = 0;
        stats.fetched++;
        stats.bytes += asset.bytes.length;
        total += asset.bytes.length;
        return { bytes: asset.bytes, type: sniffType(asset.bytes, target) };
      } catch (error) {
        stats.lastError = String(error.message ?? error).split("\n")[0];
        // A variant the CDN refuses is worth one more try at the plain path; a
        // network failure is not.
        if (!/answered 4\d\d|not JPG/.test(stats.lastError)) break;
      }
    }
    stats.failed++;
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      disabled = true;
      stats.disabled = true;
    }
    return null;
  }

  /**
   * `{ bytes, type }` for an image URL, or null. Never throws.
   *
   * `fetch: false` is cache-only: that is what a page's *load* uses, so a cold
   * cell never makes the document wait on the network. `prefetch()` warms the
   * cache for the cell's own images afterwards.
   */
  async function bytesFor(url, { fetch: mayFetch = true } = {}) {
    if (typeof url !== "string" || !url) return null;
    const key = assetKey(url) ?? url;
    const hit = memory.get(key);
    if (hit) {
      stats.hits++;
      return hit;
    }
    let pending = inflight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const disk = await fromDisk(url);
          if (disk) {
            const entry = { bytes: disk.bytes, type: disk.type ?? sniffType(disk.bytes, url) };
            memory.set(key, entry);
            stats.hits++;
            return entry;
          }
          stats.misses++;
          if (!mayFetch || !fetchOnMiss || offline) return null;
          const fetched = await fetchBytes(url);
          if (!fetched) return null;
          const entry = { bytes: fetched.bytes, type: fetched.type ?? sniffType(fetched.bytes, url) };
          memory.set(key, entry);
          return entry;
        } catch (error) {
          stats.failed++;
          stats.lastError = String(error.message ?? error).split("\n")[0];
          return null;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, pending);
    }
    return pending;
  }

  /**
   * Fetches whatever is missing among `urls`, one at a time (the shared module
   * paces them), and reports how many arrived. Bounded by `budget` so a page's
   * twenty avatars cannot turn one render into a minute of network.
   */
  async function prefetch(urls, { budget = 8 } = {}) {
    const wanted = [...new Set((urls ?? []).filter(Boolean))];
    const missing = wanted.filter((url) => !memory.has(assetKey(url) ?? url)).slice(0, budget);
    let fetched = 0;
    for (const url of missing) {
      const key = assetKey(url) ?? url;
      if (memory.has(key) || disabled) continue;
      const before = stats.fetched;
      await bytesFor(url);
      if (stats.fetched > before) fetched++;
    }
    return { wanted: wanted.length, attempted: missing.length, fetched, disabled };
  }

  /** Synchronous cache-only lookup: is there anything for this URL right now? */
  function cached(url) {
    const key = assetKey(url) ?? url;
    if (memory.has(key)) return memory.get(key);
    for (const candidate of candidateCacheUrls(url)) if (cachedFile(candidate)) return { bytes: null, type: null };
    return (byUrl.get(url) ?? byAsset.get(key)) ? { bytes: null, type: null } : null;
  }

  return {
    register,
    bytesFor,
    prefetch,
    cached,
    stats: () => ({ ...stats }),
    get size() {
      return memory.size;
    },
  };
}
