// Node entry point: loads the wasm bindings once and hands back the renderer.
//
//   import { loadXeet } from "xeet/node";
//   const xeet = await loadXeet();
//   const { png, report } = xeet.render({ text: "We shipped." }, { width: 390, theme: "dark", dpr: 3 });
//   writeFileSync("post.png", png);
//
// The wasm module embeds only Chirp and Arial. The other faces are separate
// packs (emoji, cjk, math, latin, arabic, hebrew) under `wasm/fonts/`; the
// loader verifies each pack's SHA-256 before calling `register_font`. The
// default entry points load every pack, so existing callers keep working. Pass
// `{ lazy: true }` to start with the core only and load packs with
// `await xeet.ensureFonts(request)`.
//
// The generated glue is CommonJS and reads `xeet_wasm_bg.wasm` from its own
// directory, so it is loaded through `createRequire` rather than imported. It
// needs no initialization call, which is why the sync loader is synchronous.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bind, XeetError } from "./abi.js";
import { createFontPacks } from "./fonts.js";
import { fromModule } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Where `tools/ship/build-wasm.mjs` writes the glue and the module. */
export const WASM_DIR = join(HERE, "..", "wasm");
export const GLUE_PATH = join(WASM_DIR, "xeet_wasm.js");
export const DEFAULT_WASM_PATH = join(WASM_DIR, "xeet_wasm_bg.wasm");
export const FONTS_DIR = join(WASM_DIR, "fonts");
export const PACKS_PATH = join(FONTS_DIR, "packs.json");

const hashSync = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The lazy-pack loader, or a no-op when this tree predates the packs. */
function makeFonts(wasm) {
  if (!existsSync(PACKS_PATH)) {
    return {
      names: [],
      loaded: () => [],
      load: async () => {},
      loadSync: () => {},
      ensure: async () => [],
      ensureSync: () => [],
      loadAll: async () => {},
      loadAllSync: () => {},
    };
  }
  const manifest = JSON.parse(readFileSync(PACKS_PATH, "utf8"));
  return createFontPacks({
    manifest,
    read: (name) => readFileSync(join(FONTS_DIR, `${name}.bin`)),
    hash: hashSync,
    register: (file, bytes) => wasm.register_font(file, bytes),
    missingPacks: (request) => wasm.missing_packs(request),
  });
}

let cached = null;

function getRenderer() {
  if (cached) return cached;
  const loadCjs = createRequire(import.meta.url);
  const wasm = loadCjs("../wasm/xeet_wasm.js");
  const fonts = makeFonts(wasm);
  const renderer = bind(wasm);

  /** Loads the packs a request needs; resolves with their names. */
  renderer.ensureFonts = (request) => fonts.ensure(request);
  /** [`ensureFonts`] for a caller that cannot await. */
  renderer.ensureFontsSync = (request) => fonts.ensureSync(request);
  /** Every pack a request needs, loaded or not. */
  renderer.packsFor = (request) => JSON.parse(wasm.packs_for(JSON.stringify(request)));
  /** The packs registered so far. */
  renderer.loadedPacks = () => fonts.loaded();
  /** The pack names this build ships. */
  renderer.fontPacks = () => fonts.names;

  cached = { renderer, fonts };
  return cached;
}

/**
 * Loads the renderer. By default every font pack is registered before this
 * resolves; `{ lazy: true }` leaves them for `ensureFonts`.
 *
 * @param {{ lazy?: boolean }} [options]
 */
export async function loadXeet(options = {}) {
  const { renderer, fonts } = getRenderer();
  if (!options.lazy) await fonts.loadAll();
  return renderer;
}

/**
 * Synchronous load, cached: one instance per process, which is what a
 * long-lived HTTP function or agent wants. Pack files are read and verified
 * synchronously, so this is still a single blocking call.
 *
 * @param {{ lazy?: boolean }} [options]
 */
export function loadXeetSync(options = {}) {
  const { renderer, fonts } = getRenderer();
  if (!options.lazy) fonts.loadAllSync();
  return renderer;
}

export { bind, fromModule, XeetError };
