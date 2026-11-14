// The renderer on a worker thread: download, compile and every layout happen
// off the main thread, so typing stays smooth while a post is being painted.
//
// The message protocol is wasm.js's (the only client):
//
//   in   { type: "init", glueUrl, wasmUrl, wasmBytes }
//   out  { type: "progress", loadedBytes, fraction }      while the .wasm arrives
//   out  { type: "ready", upstream, encodedBytes, decodedBytes }
//   out  { type: "initFailed", error: { code, message } }
//   in   { type: "renderSuite", id, post, mode, baseLayouts, dpr }
//   out  { type: "result", id, expandable, items: [{ layout, png, report, paint }] }
//   out  { type: "failed", id, error: { code, message, status } }
//
// `png` crosses as an ArrayBuffer and is transferred, not copied. The URLs come
// from the init message rather than from a literal here because the build
// rewrites them to a content-hashed directory in the page's own files
// (tools/ship/vercel-build.mjs), and this file is copied verbatim.

import {
  OP_EXPLAIN,
  OP_RENDER_BATCH,
  XeetError,
  createFontPacks,
  sha256Hex,
  unframe,
} from "./wasm-abi.js";

const decoder = new TextDecoder("utf-8", { fatal: false });

/** The instantiated module, once `init` has run, and the promise that gets it there. */
let ready = null;
let booting = null;
/** Where the lazy font packs live, from the init message. */
let packsBase = null;
/** The pack loader for this worker, created on the first render that needs one. */
let fontPacks = null;
/** Deferred until after the first render finishes so 39 MB of background packs
 *  never compete with the initial tweet's required pack over HTTP/2. */
let backgroundPrefetchStarted = false;
/** Non-zero while `handleSuite` is actively waiting on `ensureFonts`. */
let activeFontWaiters = 0;
/** Tracks `{ loaded, total }` across every pack currently being fetched for a render,
 *  so parallel pack downloads report one strictly monotonic percentage. */
const inFlightPacks = new Map();

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message) return;
  if (message.type === "init") {
    booting = boot(message).catch((error) => {
      booting = null;
      self.postMessage({ type: "initFailed", error: describe(error) });
      throw error;
    });
    // The failure is reported above; nothing awaits this copy of it.
    booting.catch(() => {});
    return;
  }
  if (message.type === "renderSuite") {
    handleSuite(message).catch((error) => {
      self.postMessage({ type: "failed", id: message.id, error: describe(error) });
    });
  }
});

/** The error fields the main thread's `XeetError` reads. */
function describe(error) {
  return {
    code: error?.code ?? "render_failed",
    status: error?.status ?? 500,
    message: error?.message ?? String(error),
  };
}

/** Imports the glue and instantiates the module, reporting the download. */
async function boot({ glueUrl, wasmUrl, wasmBytes, packsUrl }) {
  packsBase = packsUrl;
  const mod = await import(/* webpackIgnore: true */ glueUrl);
  let sizes = { encodedBytes: 0, decodedBytes: wasmBytes || 0 };
  if (typeof mod.default === "function") {
    self.postMessage({ type: "stage", stage: "wasm-download", loadedBytes: 0, totalBytes: wasmBytes || 0, fraction: 0 });
    const fetched = await fetchWithProgress(wasmUrl, wasmBytes);
    sizes = fetched.sizes;
    // The original response, not its bytes: the browser compiles while the
    // rest is still arriving and keeps the compiled module for the next visit.
    await mod.default({ module_or_path: fetched.response });
  }
  ready = mod;
  const upstream = typeof mod.upstream_version === "function" ? mod.upstream_version() : "";
  self.postMessage({ type: "ready", upstream, ...sizes });
  return mod;
}

/**
 * Fetches the module and counts the bytes off a clone, which the browser tees
 * without holding the download back. The count is of decompressed bytes (that is
 * what a response body yields), so the total to divide by is the module's real
 * size — `wasmBytes`, written in by the build — and only then the header.
 */
async function fetchWithProgress(url, wasmBytes) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`xeet: ${url} returned ${response.status}`);
  const declared = Number(response.headers.get("content-length")) || 0;
  const decodedBytes = wasmBytes || declared;
  if (response.body) {
    let loaded = 0;
    const reader = response.clone().body.getReader();
    (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded += value.length;
        const fraction = decodedBytes ? Math.min(1, loaded / decodedBytes) : null;
        self.postMessage({
          type: "progress",
          loadedBytes: loaded,
          fraction,
        });
        self.postMessage({
          type: fraction !== null && fraction >= 1 ? "stage" : "stage",
          stage: fraction !== null && fraction >= 1 ? "wasm-compile" : "wasm-download",
          loadedBytes: loaded,
          totalBytes: decodedBytes,
          fraction,
        });
      }
      self.postMessage({ type: "stage", stage: "wasm-compile", loadedBytes: loaded, totalBytes: decodedBytes, fraction: 1 });
    })().catch(() => {});
  }
  return { response, sizes: { encodedBytes: declared, decodedBytes } };
}

/**
 * The pack loader for this worker. `packs.json` and every blob live under the
 * build's content-hashed directory; the SHA-256 in the manifest catches a
 * truncated or corrupted download before a file is registered.
 */
function getFontPacks(mod) {
  if (!packsBase) {
    return Promise.reject(
      new XeetError({
        code: "fonts_failed",
        message: "xeet: the worker has no font pack URL",
      }),
    );
  }
  if (!fontPacks) {
    fontPacks = (async () => {
      const res = await fetch(`${packsBase}/packs.json`);
      if (!res.ok) {
        throw new XeetError({
          code: "fonts_failed",
          message: `xeet: ${packsBase}/packs.json returned ${res.status}`,
        });
      }
      const manifest = await res.json();
      return createFontPacks({
        manifest,
        read: async (name) => {
          const pack = await fetch(`${packsBase}/${name}.bin`);
          if (!pack.ok) {
            throw new XeetError({
              code: "fonts_failed",
              message: `xeet: font pack \`${name}\` returned ${pack.status}`,
            });
          }
          const totalBytes = manifest?.packs?.[name]?.bytes || Number(pack.headers.get("content-length")) || 0;
          if (!pack.body) return new Uint8Array(await pack.arrayBuffer());
          const chunks = [];
          let loaded = 0;
          const entry = { loaded: 0, total: totalBytes };
          inFlightPacks.set(name, entry);
          const emitAggregate = () => {
            if (activeFontWaiters <= 0) return;
            let sumLoaded = 0;
            let sumTotal = 0;
            for (const p of inFlightPacks.values()) {
              sumLoaded += p.loaded;
              sumTotal += p.total;
            }
            const packs = [...inFlightPacks.keys()];
            const fraction = sumTotal ? Math.min(1, sumLoaded / sumTotal) : null;
            self.postMessage({
              type: "fontProgress",
              pack: packs.length === 1 ? name : "fonts",
              packs,
              loadedBytes: sumLoaded,
              totalBytes: sumTotal,
              fraction,
            });
            self.postMessage({
              type: "stage",
              stage: fraction !== null && fraction >= 1 ? "font-register" : "font-download",
              packs,
              loadedBytes: sumLoaded,
              totalBytes: sumTotal,
              fraction,
            });
          };
          try {
            const reader = pack.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              loaded += value.byteLength;
              entry.loaded = loaded;
              emitAggregate();
            }
          } finally {
            if (loaded < entry.total) entry.loaded = entry.total;
            emitAggregate();
            if ([...inFlightPacks.values()].every((p) => p.total && p.loaded >= p.total)) {
              inFlightPacks.clear();
            }
          }
          const out = new Uint8Array(loaded);
          let offset = 0;
          for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return out;
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

/** Fetches and verifies the packs `request` needs, then registers their files. */
async function ensureFonts(mod, request) {
  activeFontWaiters += 1;
  try {
    return await (await getFontPacks(mod)).ensure(request);
  } finally {
    activeFontWaiters -= 1;
  }
}

/**
 * Starts every pack at once, right after the core module is ready. The page's
 * carousel can then render its first slide without a second round trip; a
 * request that arrives sooner joins the same in-flight promises.
 */
function preloadFonts(mod) {
  getFontPacks(mod)
    .then((packs) => packs.prefetchAll())
    .catch((error) => console.warn("xeet: the font packs did not preload", error));
}

/** One post, one mode, the layouts the page asked for. */
async function handleSuite({ id, post, mode, baseLayouts, dpr, autoExpand = true, fontScale = 1 }) {
  const mod = ready ?? (booting ? await booting : null);
  if (!mod) throw new XeetError({ code: "worker_not_ready", message: "xeet: the renderer is still loading" });
  // `layoutsFor` asks `hasShowMore`, which shapes the post, so the packs must
  // be registered before it runs, not just before the paint.
  await ensureFonts(mod, { post });
  self.postMessage({ type: "stage", stage: "paint", count: (baseLayouts ?? []).length || 4 });
  const plan = layoutsFor(mod, post, baseLayouts ?? [], autoExpand, fontScale);
  const options = plan.layouts.map((layout) => {
    const scale = layout.fontScale ?? fontScale ?? 1;
    return {
      surface: layout.surface,
      width: layout.width,
      theme: mode,
      dpr: layout.dpr ?? dpr,
      ...(scale !== 1 ? { fontScale: scale } : {}),
      ...(layout.expanded ? { expanded: true } : {}),
    };
  });
  const frame = mod.call(OP_RENDER_BATCH, JSON.stringify({ op: "renderBatch", post, batch: options }));
  const { payload } = unframe(frame);
  const items = decodeBatch(payload, plan.layouts);
  const transfer = items.map((item) => item.png);
  self.postMessage({ type: "result", id, expandable: plan.expandable, items }, transfer);
  if (!backgroundPrefetchStarted) {
    backgroundPrefetchStarted = true;
    setTimeout(() => preloadFonts(mod), 60);
  }
}

/**
 * The same layout set `web/app.js` shows, from the base list the page passed in:
 * the first layout always, a fifth expanded one when the collapsed render
 * clips (web first: that is the surface the caption talks about), then the rest.
 */
function layoutsFor(mod, post, baseLayouts, autoExpand = true, fontScale = 1) {
  if (!autoExpand || !baseLayouts.length) return { layouts: baseLayouts, expandable: null };
  const scaleOpt = fontScale && fontScale !== 1 ? { fontScale } : {};
  const webIdx = baseLayouts.findIndex((l) => l.surface === "web-timeline" && !l.expanded);
  if (webIdx >= 0) {
    const base = baseLayouts[webIdx];
    const alreadyHasExpanded = baseLayouts.some(
      (l) => l.surface === "web-timeline" && l.width === base.width && l.expanded,
    );
    if (!alreadyHasExpanded && hasShowMore(mod, post, { surface: "web-timeline", width: base.width, ...scaleOpt, expanded: false })) {
      const baseLabel = base.label ?? `timeline · ${base.width}`;
      const baseSlug = base.slug ?? `timeline-${base.width}`;
      return {
        expandable: "web",
        layouts: [
          ...baseLayouts.slice(0, webIdx + 1),
          {
            ...base,
            expanded: true,
            label: `${baseLabel} · expanded`,
            slug: `${baseSlug}-expanded`,
            comment: undefined,
          },
          ...baseLayouts.slice(webIdx + 1),
        ],
      };
    }
  }
  const iosIdx = baseLayouts.findIndex((l) => l.surface === "ios-timeline" && !l.expanded);
  if (iosIdx >= 0) {
    const base = baseLayouts[iosIdx];
    const alreadyHasExpanded = baseLayouts.some(
      (l) => l.surface === "ios-timeline" && l.width === base.width && l.expanded,
    );
    if (!alreadyHasExpanded && hasShowMore(mod, post, { surface: "ios-timeline", width: base.width, ...scaleOpt, expanded: false })) {
      const baseLabel = base.label ?? `ios · ${base.width}`;
      const baseSlug = base.slug ?? `ios-${base.width}`;
      return {
        expandable: "ios",
        layouts: [
          ...baseLayouts.slice(0, iosIdx + 1),
          {
            ...base,
            expanded: true,
            label: `${baseLabel} · expanded`,
            slug: `${baseSlug}-expanded`,
            comment: undefined,
          },
          ...baseLayouts.slice(iosIdx + 1),
        ],
      };
    }
  }
  return { layouts: baseLayouts, expandable: null };
}

/** Whether the collapsed render of `post` clips, with no rasterization. */
function hasShowMore(mod, post, options) {
  const { payload } = unframe(mod.call(OP_EXPLAIN, JSON.stringify({ op: "explain", post, options })));
  return Boolean(JSON.parse(decoder.decode(payload))?.text?.hasShowMore);
}

/**
 * The `OP_RENDER_BATCH` payload (crates/xeet-wasm/src/lib.rs): a count, then per
 * item its PNG length, report length, duration in microseconds, the PNG and the
 * report. Each PNG is sliced into its own buffer so it can be transferred.
 */
function decodeBatch(payload, layouts) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = view.getUint32(0, true);
  const items = [];
  let at = 4;
  for (let i = 0; i < count; i++) {
    if (at + 12 > payload.length) throw shortBatch();
    const pngLen = view.getUint32(at, true);
    const reportLen = view.getUint32(at + 4, true);
    const durationUs = view.getUint32(at + 8, true);
    at += 12;
    if (at + pngLen + reportLen > payload.length) throw shortBatch();
    // `slice()` allocates exactly this item's bytes: a view into the frame's
    // buffer could not be transferred without sending every item along with it.
    const png = payload.slice(at, at + pngLen).buffer;
    at += pngLen;
    const report = reportLen ? JSON.parse(decoder.decode(payload.subarray(at, at + reportLen))) : null;
    at += reportLen;
    items.push({ layout: layouts[i] ?? null, png, report, paint: durationUs / 1000 });
  }
  return items;
}

function shortBatch() {
  return new XeetError({ code: "render_failed", message: "xeet: the batch frame ended before its items did" });
}
