// The in-browser target: wasm-bindgen's web build of xeet-wasm, loaded once.
//
// The module returns a framed buffer (crates/xeet-wasm/src/lib.rs):
//
//   offset 0  u8   status: 0 ok, 1 error
//   offset 1  u32  payload length (little endian)   PNG, or JSON for explain
//   offset 5  u32  report length  (little endian)
//   offset 9  u32  total length   (little endian)
//   offset 13 ...  payload, then report

import { createFontPacks, sha256Hex } from "/wasm/fonts.js";

export const OP_EXPLAIN = 0;
export const OP_RENDER = 1;
export const OP_SHEET = 2;
const FONT_BASE = "/wasm/fonts";

const HEADER = 13;
const decoder = new TextDecoder("utf-8", { fatal: false });

export class XeetError extends Error {
  constructor(body) {
    super(body?.message ?? "xeet: the render failed");
    this.name = "XeetError";
    this.code = body?.code ?? "render_failed";
    this.status = body?.status ?? 500;
    this.fields = body?.fields ?? [];
    this.notes = body?.notes ?? [];
  }
}

export function unframe(buf) {
  if (!buf || buf.length < HEADER) throw new XeetError({ message: "xeet: the module returned a short frame" });
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const status = buf[0];
  const payloadLen = view.getUint32(1, true);
  const reportLen = view.getUint32(5, true);
  const total = view.getUint32(9, true);
  if (total !== buf.length) {
    throw new XeetError({ message: `xeet: frame says ${total} bytes, got ${buf.length}` });
  }
  const payload = buf.subarray(HEADER, HEADER + payloadLen);
  const report = reportLen ? buf.subarray(HEADER + payloadLen, HEADER + payloadLen + reportLen) : null;
  if (status !== 0) {
    let body;
    try {
      body = JSON.parse(decoder.decode(payload));
    } catch {
      body = { message: decoder.decode(payload) || "xeet: the render failed" };
    }
    throw new XeetError(body);
  }
  return { payload, report: report ? JSON.parse(decoder.decode(report)) : null };
}

let modulePromise = null;
let fontPacks = null;

function getFontPacks(mod) {
  if (!fontPacks) {
    fontPacks = (async () => {
      const res = await fetch(`${FONT_BASE}/packs.json`);
      if (!res.ok) {
        throw new XeetError({ message: `xeet: ${FONT_BASE}/packs.json returned ${res.status}` });
      }
      const manifest = await res.json();
      return createFontPacks({
        manifest,
        read: async (name) => {
          const pack = await fetch(`${FONT_BASE}/${name}.bin`);
          if (!pack.ok) {
            throw new XeetError({ message: `xeet: font pack \`${name}\` returned ${pack.status}` });
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

/**
 * Loads the lazy packs a request needs. The dev server serves the packs from
 * `packages/xeet/wasm/fonts`; the loader verifies each SHA-256 before
 * registering its files.
 */
export async function ensureWasmFonts(mod, request) {
  return (await getFontPacks(mod)).ensure(request);
}

/** Starts every pack in parallel; `ensureWasmFonts` joins these promises. */
export function preloadWasmFonts(mod) {
  getFontPacks(mod)
    .then((packs) => packs.prefetchAll())
    .catch((error) => console.warn("xeet: the font packs did not preload", error));
}

/** Imports and instantiates the web build once. */
export function loadWasm() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const mod = await import("/wasm/xeet_wasm.js");
      await mod.default();
      preloadWasmFonts(mod);
      return mod;
    })().catch((error) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

/** Calls the module and returns the raw frame. */
function call(mod, op, request) {
  return mod.call(op, JSON.stringify(request));
}

/** A PNG (Uint8Array) and its report, with the time the call took. */
/** A render whose time is strictly the module's render call (no load, no setup). */
export function renderWasm(mod, post, options) {
  const started = performance.now();
  const frame = call(mod, OP_RENDER, { op: "render", post, options });
  const paintMs = performance.now() - started;
  const { payload, report } = unframe(frame);
  return { png: payload, report, ms: paintMs, paintMs, upstream: moduleUpstream(mod) };
}

export function explainWasm(mod, post, options) {
  const started = performance.now();
  const frame = call(mod, OP_EXPLAIN, { op: "explain", post, options });
  const ms = performance.now() - started;
  const { payload } = unframe(frame);
  return { report: JSON.parse(decoder.decode(payload)), ms, upstream: moduleUpstream(mod) };
}

let upstreamCache = null;
function moduleUpstream(mod) {
  if (upstreamCache === null) {
    try {
      upstreamCache = mod.upstream_version();
    } catch {
      upstreamCache = "";
    }
  }
  return upstreamCache;
}

export function resetWasm() {
  modulePromise = null;
  upstreamCache = null;
  fontPacks = null;
}
