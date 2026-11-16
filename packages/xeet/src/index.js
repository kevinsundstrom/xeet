// Loading the renderer, for Node and for browsers.
//
// The module is wasm-bindgen output. `tools/ship/build-wasm.mjs` builds two
// flavours from the same `.wasm`:
//
//   --target nodejs   wasm/xeet_wasm.js  (CommonJS, loads the .wasm from disk)
//   --target web      wasm/web/…         (ESM + an init() that fetches the .wasm)
//
// Node uses the first; a browser build uses the second. Both expose `call` and
// `upstream_version`, which is all `bind` needs, so the object every host gets
// is identical.

import { bind, XeetError, OP_EXPLAIN, OP_RENDER, OP_SHEET, OP_RENDER_RGBA, OP_RENDER_BATCH, unframe } from "./abi.js";

export { bind, XeetError, OP_EXPLAIN, OP_RENDER, OP_SHEET, OP_RENDER_RGBA, OP_RENDER_BATCH, unframe } from "./abi.js";

/**
 * Wraps an already-instantiated wasm-bindgen module.
 * @param {{ call: Function, upstream_version: Function }} wasm
 */
export function fromModule(wasm) {
  return bind(wasm);
}
