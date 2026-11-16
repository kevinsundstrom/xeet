// The in-browser renderer, loaded once from /wasm/xeet_wasm.js.
//
// Two ABIs are supported on purpose. The shipped module exposes
//
//   call(op, requestJson) -> framed Uint8Array
//   upstream_version() -> String
//
// where the frame is (crates/xeet-wasm/src/lib.rs):
//
//   offset 0   u8   status: 0 ok, 1 error
//   offset 1   u32  payload length (little endian)
//   offset 5   u32  report length
//   offset 9   u32  total length
//   offset 13  ...  payload, then report
//
// Some builds expose `render(postJson, optionsJson)` and
// `explain(postJson, optionsJson)` directly. Both work here; paint time is
// measured around the render call alone, never around the module load.
//
// # Two threads
//
// The page's own rendering goes through a module Worker (`wasm-worker.js`):
// the .wasm downloads, compiles and paints there, so the main thread never
// blocks on the core module. `loadWasm`/`renderWith`/`explainWith` stay as the
// main-thread path, and are what a browser without Worker support falls back to.

// The shared lazy-pack loader. `vercel-build.mjs` copies
// `packages/xeet/src/fonts.js` beside the glue and rewrites `/wasm/fonts` to
// the content-hashed directory; in the playground the dev server serves the
// same file from `/wasm/fonts.js`.
import {
  OP_EXPLAIN,
  OP_RENDER,
  OP_RENDER_BATCH,
  OP_RENDER_RGBA,
  OP_SHEET,
  XeetError,
  createFontPacks,
  sha256Hex,
  unframe,
} from "./wasm-abi.js";
import { WASM_BYTES, WASM_DIR } from "../_generated/wasm-manifest.js";

const decoder = new TextDecoder("utf-8", { fatal: false });
export { OP_EXPLAIN, OP_RENDER, OP_RENDER_BATCH, OP_RENDER_RGBA, OP_SHEET, XeetError, createFontPacks, sha256Hex, unframe };

let modulePromise = null;
const progressListeners = new Set();
const fontProgressListeners = new Set();
const stageListeners = new Set();
let loadedBytes = 0;
let lastFontProgress = null;
let lastStage = null;

// `WASM_BYTES` is imported from `../_generated/wasm-manifest.js`.

/**
 * Called while the module downloads, with the bytes received so far and the
 * fraction done (0–1), or `null` when the total is unknown.
 */
export function onWasmProgress(listener) {
  progressListeners.add(listener);
  if (loadedBytes) listener(loadedBytes, fraction());
  return () => progressListeners.delete(listener);
}

/**
 * Called while a required font pack downloads for an active render:
 * `{ pack, loadedBytes, totalBytes, fraction }`.
 */
export function onFontProgress(listener) {
  fontProgressListeners.add(listener);
  if (lastFontProgress) listener(lastFontProgress);
  return () => fontProgressListeners.delete(listener);
}

export function onLoadStage(listener) {
  stageListeners.add(listener);
  if (lastStage) listener(lastStage);
  return () => stageListeners.delete(listener);
}

function emitStage(info) {
  lastStage = info;
  if (!info) return;
  for (const listener of stageListeners) listener(info);
}

function emitProgress(bytes, done) {
  loadedBytes = Math.max(loadedBytes, bytes);
  for (const listener of progressListeners) listener(loadedBytes, done === null || done === undefined ? fraction() : done);
}

function emitFontProgress(info) {
  lastFontProgress = info;
  if (!info) return;
  for (const listener of fontProgressListeners) listener(info);
}

/** What the module cost over the wire, once something knows: `{ encodedBytes, decodedBytes }`. */
let sizeInfo = null;
const sizeListeners = new Set();
/** True once a renderer is loaded, so the page knows whether a render waits. */
let rendererReady = false;

/**
 * Called once with the module's transfer and decompressed sizes, or with `null`
 * when only the browser's own resource timings know (see `web/app.js`).
 */
export function onWasmSized(listener) {
  sizeListeners.add(listener);
  if (sizeInfo) listener(sizeInfo);
  return () => sizeListeners.delete(listener);
}

function notifySized(info) {
  if (!info || !info.decodedBytes) return;
  sizeInfo = info;
  for (const listener of sizeListeners) listener(sizeInfo);
}

function fraction() {
  return WASM_BYTES ? Math.min(1, loadedBytes / WASM_BYTES) : null;
}

// Both paths are content-hashed at build time (tools/ship/vercel-build.mjs
// rewrites them to /wasm/<hash>/…), so they can be cached as immutable: a new
// build is a new URL, never a stale file.
const GLUE_URL = `${WASM_DIR}/xeet_wasm.js`;
const WASM_URL = `${WASM_DIR}/xeet_wasm_bg.wasm`;
const FONT_BASE = `${WASM_DIR}/fonts`;

/**
 * Fetches the .wasm and hands the browser the *original* response: that is
 * what lets it compile while the bytes are still arriving, and keep the
 * compiled code for the next visit. Progress is counted on a clone, which the
 * browser tees without holding the download back.
 */
async function fetchWasm(url) {
  const res = await fetch(url);
  // Always counted, even before anyone listens: the page subscribes a moment
  // after the download starts, and catches up from the running total.
  if (res.ok && res.body) {
    const reader = res.clone().body.getReader();
    (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        loadedBytes += value.length;
        for (const listener of progressListeners) listener(loadedBytes, fraction());
      }
    })().catch(() => {});
  }
  return res;
}

/** Imports and instantiates the web build once. */
export function loadWasm() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const mod = await import(/* webpackIgnore: true */ GLUE_URL);
      if (typeof mod.default === "function") {
        await mod.default({ module_or_path: fetchWasm(WASM_URL) });
      }
      // The core is usable now; start every pack in parallel while the page
      // settles, so a carousel slide never pays for emoji or CJK on demand.
      preloadFonts(mod);
      return mod;
    })().catch((error) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

let fontPacks = null;

/**
 * The lazy-pack loader for this module instance. `packs.json` and every blob
 * live under the build's content-hashed directory, and the loader verifies the
 * SHA-256 in the manifest before registering a file.
 */
async function getFontPacks(mod) {
  if (!fontPacks) {
    fontPacks = (async () => {
      const res = await fetch(`${FONT_BASE}/packs.json`);
      if (!res.ok) {
        throw new XeetError({
          code: "fonts_failed",
          message: `xeet: ${FONT_BASE}/packs.json returned ${res.status}`,
        });
      }
      const manifest = await res.json();
      return createFontPacks({
        manifest,
        read: async (name) => {
          const pack = await fetch(`${FONT_BASE}/${name}.bin`);
          if (!pack.ok) {
            throw new XeetError({
              code: "fonts_failed",
              message: `xeet: font pack \`${name}\` returned ${pack.status}`,
            });
          }
          return new Uint8Array(await pack.arrayBuffer());
        },
        hash: sha256Hex,
        register: (file, bytes) => mod.register_font(file, bytes),
        missingPacks: (request) => mod.missing_packs(request),
      });
    })().catch((error) => {
      fontPacks = null;
      throw error;
    });
  }
  return fontPacks;
}

/** Loads the lazy packs `request` needs; resolves with their names. */
export async function ensureFonts(mod, request) {
  const packs = await getFontPacks(mod);
  return packs.ensure(request);
}

/**
 * Starts every pack at once. Called as soon as the core module is ready; the
 * carousel joins these promises through `ensureFonts` if it arrives first.
 */
export function preloadFonts(mod) {
  const work = getFontPacks(mod).then((packs) => packs.prefetchAll());
  work.catch((error) => console.warn("xeet: the font packs did not preload", error));
  return work;
}

export function upstreamVersion(mod) {
  try {
    const value = mod?.upstream_version?.();
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** The render, plus the report when the module carries one. */
export function renderWith(mod, post, options) {
  const started = performance.now();
  if (typeof mod.render === "function") {
    const png = mod.render(JSON.stringify(post), JSON.stringify(options));
    const paint = performance.now() - started;
    let report = null;
    try {
      report = JSON.parse(mod.explain(JSON.stringify(post), JSON.stringify(options)));
    } catch {
      report = null;
    }
    return { png, report, paint };
  }
  const frame = mod.call(OP_RENDER, JSON.stringify({ op: "render", post, options }));
  const paint = performance.now() - started;
  const { payload, report } = unframe(frame);
  return { png: payload, report, paint };
}

export function explainWith(mod, post, options) {
  if (typeof mod.explain === "function") {
    return JSON.parse(mod.explain(JSON.stringify(post), JSON.stringify(options)));
  }
  const { payload } = unframe(mod.call(OP_EXPLAIN, JSON.stringify({ op: "explain", post, options })));
  return JSON.parse(decoder.decode(payload));
}

export function hasShowMoreWith(mod, post, options) {
  const collapsed = options ? { ...options, expanded: false } : { expanded: false };
  return Boolean(explainWith(mod, post, collapsed)?.text?.hasShowMore);
}

// ---------------------------------------------------------------------------
// The worker: the path the page actually uses
// ---------------------------------------------------------------------------

/** Resolved once, so the worker gets absolute URLs it can import and fetch. */
function absolute(path) {
  try {
    return new URL(path, location.href).href;
  } catch {
    return path;
  }
}

let worker = null;
/** False once the worker has proven it cannot load: every call renders here. */
let workerUsable = true;
/** The request the worker is executing, or null. */
let inFlight = null;
/** The newest request that arrived while `inFlight` was running. */
let queued = null;
let nextId = 1;

function ensureWorker() {
  if (worker) return worker;
  if (!workerUsable || typeof Worker === "undefined") return null;
  let created;
  try {
    created = new Worker(new URL("./wasm-worker.js", import.meta.url), { type: "module" });
  } catch {
    workerUsable = false;
    return null;
  }
  created.addEventListener("message", (event) => onWorkerMessage(created, event));
  created.addEventListener("error", (event) => {
    // A worker that cannot even load its script is not a failed renderer: drop
    // it, finish whatever was pending on this thread, and stop using it.
    console.warn("xeet: the render worker failed, rendering on the main thread", event?.message ?? event);
    dropWorker();
  });
  worker = created;
  // The build rewrites the two paths in this file to a content-hashed
  // directory, so the worker has to be told what they are; it never guesses.
  created.postMessage({
    type: "init",
    glueUrl: absolute(GLUE_URL),
    wasmUrl: absolute(WASM_URL),
    wasmBytes: WASM_BYTES,
    packsUrl: absolute(FONT_BASE),
  });
  return created;
}

/**
 * Starts the download and compilation now, on a worker thread, instead of on
 * the first render. Safe to call more than once.
 */
export function preloadWorker() {
  if (typeof Worker === "undefined") {
    // No workers here: warm the main-thread path the same way instead.
    loadWasm().catch(() => {});
    return false;
  }
  return Boolean(ensureWorker());
}

/** Whether a renderer is loaded, so a render would not wait on the download. */
export function wasmReady() {
  return rendererReady;
}

/**
 * Renders a post at every layout the page shows, on the worker thread:
 * `{ expandable, results: [{ layout, png, paint, report }] }`, with `png` a
 * `Uint8Array` over its own transferred buffer.
 *
 * Rapid typing never builds a backlog: while one request is executing, only the
 * newest newcomer is kept, and the ones it replaced resolve as
 * `{ cancelled: true }`.
 */
export function renderSuiteInWorker(post, mode, baseLayouts, dpr, extra = {}) {
  const { autoExpand = true, fontScale = 1 } = extra;
  const target = typeof Worker === "undefined" ? null : ensureWorker();
  if (!target) return renderSuiteLocally(post, mode, baseLayouts, dpr, { autoExpand, fontScale });
  return new Promise((resolve, reject) => {
    const request = { id: nextId++, post, mode, baseLayouts, dpr, autoExpand, fontScale, resolve, reject };
    if (inFlight) {
      // The newest input wins; what it replaces is stale by definition.
      if (queued) queued.resolve({ cancelled: true });
      queued = request;
      return;
    }
    send(target, request);
  });
}

function send(target, request) {
  inFlight = request;
  const { id, post, mode, baseLayouts, dpr, autoExpand, fontScale } = request;
  try {
    target.postMessage({ type: "renderSuite", id, post, mode, baseLayouts, dpr, autoExpand, fontScale });
  } catch (error) {
    // The post is not structured-cloneable (a proxy, a function): render it here.
    inFlight = null;
    renderSuiteLocally(post, mode, baseLayouts, dpr, { autoExpand, fontScale }).then(request.resolve, request.reject);
  }
}

function onWorkerMessage(target, event) {
  const message = event.data;
  if (!message) return;
  if (message.type === "progress") {
    emitProgress(message.loadedBytes ?? 0, message.fraction ?? null);
    return;
  }
  if (message.type === "fontProgress") {
    emitFontProgress({
      pack: message.pack ?? "font",
      loadedBytes: message.loadedBytes ?? 0,
      totalBytes: message.totalBytes ?? 0,
      fraction: message.fraction ?? null,
    });
    return;
  }
  if (message.type === "stage") {
    emitStage(message);
    return;
  }
  if (message.type === "ready") {
    rendererReady = true;
    if (message.decodedBytes) loadedBytes = message.decodedBytes;
    notifySized({ encodedBytes: message.encodedBytes ?? 0, decodedBytes: message.decodedBytes ?? 0 });
    return;
  }
  if (message.type === "initFailed") {
    dropWorker();
    return;
  }
  if (message.type !== "result" && message.type !== "failed") return;

  const request = inFlight;
  inFlight = null;
  lastFontProgress = null;
  lastStage = null;
  // Start the newcomer before settling this one: the worker never idles
  // between two keystrokes.
  const next = queued;
  queued = null;
  if (next) send(target ?? worker, next);
  if (!request) return;
  if (message.type === "failed") {
    request.reject(new XeetError(message.error ?? { message: "xeet: the render failed" }));
    return;
  }
  request.resolve({ expandable: message.expandable ?? null, results: reviveItems(message.items ?? []) });
}

/** The worker's transferred PNG buffers as views; nothing is copied. */
function reviveItems(items) {
  return items.map((item) => ({
    layout: item.layout,
    png: item.png instanceof ArrayBuffer ? new Uint8Array(item.png) : item.png,
    paint: item.paint,
    report: item.report,
  }));
}

/** Gives up on the worker and finishes whatever it was holding on this thread. */
function dropWorker() {
  workerUsable = false;
  const pending = [inFlight, queued].filter(Boolean);
  inFlight = null;
  queued = null;
  try {
    worker?.terminate();
  } catch {}
  worker = null;
  for (const request of pending) {
    renderSuiteLocally(request.post, request.mode, request.baseLayouts, request.dpr, {
      autoExpand: request.autoExpand,
      fontScale: request.fontScale,
    }).then(request.resolve, request.reject);
  }
}

/**
 * The same suite on the main thread: the fallback for a browser without
 * module workers, and for a worker that failed. It renders the layouts one at a
 * time with `OP_RENDER`, so each result carries its own paint time.
 */
async function renderSuiteLocally(post, mode, baseLayouts, dpr, { autoExpand = true, fontScale = 1 } = {}) {
  const mod = await loadWasm();
  // `layoutsFor` asks `hasShowMore`, which shapes the post: the packs have to
  // be in place before that, not just before the paint.
  await ensureFonts(mod, { post });
  rendererReady = true;
  notifySizedFromTiming();
  const plan = layoutsFor(mod, post, baseLayouts, autoExpand, fontScale);
  const results = plan.layouts.map((layout) => {
    const scale = layout.fontScale ?? fontScale ?? 1;
    const options = {
      surface: layout.surface,
      width: layout.width,
      theme: mode,
      dpr: layout.dpr ?? dpr,
      ...(scale !== 1 ? { fontScale: scale } : {}),
      ...(layout.expanded ? { expanded: true } : {}),
    };
    return { layout, ...renderWith(mod, post, options) };
  });
  return { expandable: plan.expandable, results };
}

/** The same layout set the worker builds; see `web/js/wasm-worker.js`. */
function layoutsFor(mod, post, baseLayouts, autoExpand = true, fontScale = 1) {
  if (!autoExpand || !baseLayouts.length) return { layouts: baseLayouts, expandable: null };
  const scaleOpt = fontScale && fontScale !== 1 ? { fontScale } : {};
  const webIdx = baseLayouts.findIndex((l) => l.surface === "web-timeline" && !l.expanded);
  if (webIdx >= 0) {
    const base = baseLayouts[webIdx];
    const already = baseLayouts.some((l) => l.surface === "web-timeline" && l.width === base.width && l.expanded);
    if (!already && hasShowMoreWith(mod, post, { surface: "web-timeline", width: base.width, ...scaleOpt, expanded: false })) {
      const baseLabel = base.label ?? `timeline · ${base.width}`;
      const baseSlug = base.slug ?? `timeline-${base.width}`;
      return {
        expandable: "web",
        layouts: [
          ...baseLayouts.slice(0, webIdx + 1),
          { ...base, expanded: true, label: `${baseLabel} · expanded`, slug: `${baseSlug}-expanded`, comment: undefined },
          ...baseLayouts.slice(webIdx + 1),
        ],
      };
    }
  }
  const iosIdx = baseLayouts.findIndex((l) => l.surface === "ios-timeline" && !l.expanded);
  if (iosIdx >= 0) {
    const base = baseLayouts[iosIdx];
    const already = baseLayouts.some((l) => l.surface === "ios-timeline" && l.width === base.width && l.expanded);
    if (!already && hasShowMoreWith(mod, post, { surface: "ios-timeline", width: base.width, ...scaleOpt, expanded: false })) {
      const baseLabel = base.label ?? `ios · ${base.width}`;
      const baseSlug = base.slug ?? `ios-${base.width}`;
      return {
        expandable: "ios",
        layouts: [
          ...baseLayouts.slice(0, iosIdx + 1),
          { ...base, expanded: true, label: `${baseLabel} · expanded`, slug: `${baseSlug}-expanded`, comment: undefined },
          ...baseLayouts.slice(iosIdx + 1),
        ],
      };
    }
  }
  return { layouts: baseLayouts, expandable: null };
}

/** The main-thread fallback's only source of sizes: the browser's own record. */
function notifySizedFromTiming() {
  try {
    const entry = performance.getEntriesByType("resource").find((e) => e.name.endsWith("xeet_wasm_bg.wasm"));
    if (entry?.decodedBodySize) notifySized({ encodedBytes: entry.encodedBodySize ?? 0, decodedBytes: entry.decodedBodySize });
  } catch {
    // no resource timing: the page falls back to no size line
  }
}

