// Shared pure ABI constants & frame decoder imported by both `wasm.js` and
// `wasm-worker.js` so `wasm-worker.js` never imports `wasm.js` (breaking the
// circular `new Worker()` graph in Turbopack).

import { createFontPacks, sha256Hex } from "../../packages/xeet/src/fonts.js";

export { createFontPacks, sha256Hex };

export const OP_EXPLAIN = 0;
export const OP_RENDER = 1;
export const OP_SHEET = 2;
export const OP_RENDER_RGBA = 3;
export const OP_RENDER_BATCH = 4;

const HEADER = 13;
const decoder = new TextDecoder("utf-8", { fatal: false });

export class XeetError extends Error {
  constructor(body) {
    super(body?.message ?? "xeet: the render failed");
    this.name = "XeetError";
    this.code = body?.code ?? "render_failed";
    this.status = body?.status ?? 500;
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
    let body = null;
    try {
      body = JSON.parse(decoder.decode(payload));
    } catch {}
    throw new XeetError(body ?? { message: decoder.decode(payload) || "xeet: render failed" });
  }
  return { payload, report: report ? JSON.parse(decoder.decode(report)) : null };
}
