// Types for the xeet package. They mirror the Rust model in
// crates/xeet-core/src/model.rs (camelCase on the wire).

export type Surface = "web-timeline" | "web-detail" | "ios-timeline" | "ios-detail";
export type Theme = "light" | "dark";
export type Verified = "none" | "blue" | "business" | "government";

/** Where and how the post is shown. Every field is optional. */
export interface RenderOptions {
  /** The timeline cell, or the post's own page. Default "web-timeline". */
  surface?: Surface;
  /** Viewport width in CSS pixels, 100 to 1200. The post column is at most 600. Default 600. */
  width?: number;
  /** Default "light". */
  theme?: Theme;
  /** Device pixel ratio, 1 to 3. The PNG is `width × dpr` wide. Default 2. */
  dpr?: number;
  /** X's font size setting, as a multiplier. Default 1. */
  fontScale?: number;
  /** Render with "Show more" toggled on: shows the full post body in place. Default false. */
  expanded?: boolean;
}

export interface Author {
  name?: string;
  handle?: string;
  verified?: Verified;
  /** Base64 image bytes. Without it, X's default profile picture is drawn. */
  avatar?: string;
  /** Organizations have square avatars on X. */
  squareAvatar?: boolean;
  protected?: boolean;
  /** The organization badge shown after the name. `badge` is base64 image bytes. */
  affiliate?: { name: string; badge?: string };
}

export interface Media {
  kind: "image" | "gif" | "video";
  width: number;
  height: number;
  /** Base64 bytes. Without them a placeholder of the right size is drawn. */
  data?: string;
  alt?: string;
  /** Seconds, shown in the video's duration pill. */
  duration?: number;
  /** For a "Post video": who posted the original. */
  sourceAuthor?: Author;
}

export interface LinkMeta {
  /** "summary" or "summary_large_image". Without it the URL is a plain link. */
  card?: string;
  title?: string;
  description?: string;
  domain?: string;
  /** The shortened form X displays. */
  display?: string;
  image?: { width: number; height: number; data?: string };
}

/** A post. Only `text` is required. */
export interface Post {
  text: string;
  author?: Author;
  /** Up to 20 carousel items, or one video or GIF. */
  media?: Media[];
  /** Card metadata by URL, as it appears in `text`. `resolve` fills this in. */
  links?: Record<string, LinkMeta>;
  /** A quoted post. Quotes nest two levels deep. */
  quote?: Post;
  /** Up to four choices. Votes make it a finished poll. */
  poll?: { choices: string[]; votes?: number[]; secondsLeft?: number };
  counts?: { replies?: number; reposts?: number; likes?: number; views?: number; bookmarks?: number };
  /** ISO timestamp. */
  createdAt?: string;
  /** ISO timestamp that pins the clock, so "2h" renders the same every time. */
  now?: string;
  /** "dismissed" hides the link card, as X's composer allows. */
  cardState?: "auto" | "dismissed";
  replyToHandle?: string;
}

/** What was drawn, and why. */
export interface Report {
  /** The rules the decisions came from, e.g. "x-web@55591fe0". */
  ruleset: string;
  /** Size in CSS pixels; the PNG is this times `dpr`. */
  size: { width: number; height: number };
  /** X's character count: a URL counts 23, an emoji 2. */
  length: { weighted: number; limit: number; valid: boolean };
  text: {
    lines: number;
    truncated: boolean;
    /** True when this render displays a "Show more" control (`showMore !== null`). */
    hasShowMore: boolean;
    /** "inline" (a long post cut by X) or "clamped" (a line clamp). */
    showMore: "inline" | "clamped" | null;
    /** The text as displayed. */
    visible: string;
  };
  entities: { kind: "url" | "mention" | "hashtag" | "cashtag"; range: [number, number]; text: string; display?: string }[];
  hidden: { range: [number, number]; why: string }[];
  attachment: { kind: "card" | "media" | "quote" | "poll"; [key: string]: unknown } | null;
  warnings: string[];
}

/** The network the resolver uses. Build one with `whatwgHost`. */
export interface Host {
  fetch(request: { url: string; method?: string; headers?: Record<string, string>; maxBytes?: number }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
    truncated?: boolean;
  }>;
  lookup?(host: string): Promise<string[]>;
  cacheGet?(key: string): Promise<{ value: string; storedAt: number } | null>;
  cacheSet?(key: string, value: string, storedAt: number): Promise<void> | void;
  now?(): number;
}

export interface ResolveOptions {
  /** Inline image bytes (media, avatars, badges, card images). Default false. */
  media?: boolean;
  /** The cell image variants are chosen for. Defaults 600 and 2. */
  width?: number;
  dpr?: number;
  /** How many of the post's URLs to resolve. Default 4. */
  maxLinks?: number;
}

export interface Resolved {
  post: Post;
  links: Record<string, unknown>;
  media: Record<string, unknown>;
  source: { id?: string; url?: string; [key: string]: unknown };
  warnings: string[];
}

export interface Xeet {
  /** The version of X's web app whose rules and assets this build carries. */
  readonly upstream: string;
  /** A PNG and its report. Synchronous; never touches the network. */
  render(post: Post, options?: RenderOptions): { png: Uint8Array; report: Report };
  /** Raw straight-alpha RGBA8 pixels and the report, skipping PNG encoding. */
  renderRgba(post: Post, options?: RenderOptions): { width: number; height: number; rgba: Uint8Array; report: Report };
  /** Renders multiple option sets while parsing and validating `post` once. */
  renderMany(post: Post, optionsList: RenderOptions[]): { png: Uint8Array; report: Report; paint: number }[];
  /** The PNG bytes alone. */
  renderPng(post: Post, options?: RenderOptions): Uint8Array;
  /** The report alone, with no pixels. */
  explain(post: Post, options?: RenderOptions): Report;
  /** True when `post` would render with a "Show more" control under `options` (no rasterization). */
  hasShowMore(post: Post, options?: RenderOptions): boolean;
  /** One labelled PNG with the post at every width and theme. */
  sheet(request: { post: Post; widths?: number[]; themes?: Theme[]; dpr?: number }): Uint8Array;
  /** Post text, an x.com link or post JSON, to a complete post. */
  resolve(input: string, options?: ResolveOptions, host?: Host): Promise<Resolved>;
  /** The card one URL would produce. */
  resolveLinks(url: string, options?: ResolveOptions, host?: Host): Promise<unknown>;
  /** Builds a `Host` from a standard fetch. */
  whatwgHost(parts?: Partial<Omit<Host, "fetch">> & { fetch?: typeof fetch }): Host;
  /**
   * Loads the lazy font packs a request needs and resolves with their names.
   * Present on the Node entry point and the browser loader; a bare `bind()`
   * has no way to fetch, so it is optional here.
   */
  ensureFonts?(request: { post: Post; options?: RenderOptions }): Promise<string[]>;
  /** `ensureFonts` for a caller that cannot await. */
  ensureFontsSync?(request: { post: Post; options?: RenderOptions }): string[];
  /** Every lazy pack a request needs, whether loaded or not. */
  packsFor?(request: { post: Post; options?: RenderOptions }): string[];
  /** The lazy packs registered so far. */
  loadedPacks?(): string[];
  /** The lazy pack names this build ships. */
  fontPacks?(): string[];
}

/** An error the renderer reported, naming every problem field at once. */
export declare class XeetError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: { path: string; message: string; suggestion?: string }[];
  readonly notes: string[];
}

/** Wraps an initialized WebAssembly module (browsers, workers). */
export declare function bind(wasm: unknown): Xeet;
export declare function fromModule(wasm: unknown): Xeet;
