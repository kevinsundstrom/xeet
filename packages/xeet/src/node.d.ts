import type { Xeet } from "./types.js";
export * from "./types.js";

export interface LoadOptions {
  /**
   * Start with the embedded core (Chirp + Arial) only and leave the emoji, cjk,
   * math, latin, arabic and hebrew packs to `ensureFonts`. Default false: every
   * pack is registered before the loader resolves.
   */
  lazy?: boolean;
}

/** Loads the module once per process and returns the renderer. */
export declare function loadXeet(options?: LoadOptions): Promise<Xeet>;
/** The same, synchronously. */
export declare function loadXeetSync(options?: LoadOptions): Xeet;
