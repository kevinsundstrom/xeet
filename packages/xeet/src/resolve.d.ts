import type { Host } from "./types.js";

export declare const RESOLVE_DEFAULTS: Readonly<{
  media: boolean;
  width: number;
  dpr: number;
  surface: string;
  maxLinks: number;
  refresh: boolean;
}>;
export declare function whatwgHost(parts?: Partial<Omit<Host, "fetch">> & { fetch?: typeof fetch }): Host;
export declare function memoryCache(): Pick<Host, "cacheGet" | "cacheSet">;
export declare function noCache(): Pick<Host, "cacheGet" | "cacheSet">;
