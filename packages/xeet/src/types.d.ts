// Types for `@xeet/core`. Mirrors the Rust wire model in
// `crates/xeet-core/src/model.rs` and `crates/xeet-resolve/src/lib.rs` (camelCase).

export type Surface = "web-timeline" | "web-detail" | "ios-timeline" | "ios-detail";
export type Theme = "light" | "dark";
export type Verified = "none" | "blue" | "business" | "government";

/** Where and how the post is shown. Every field is optional. */
export interface RenderOptions {
  /** The timeline cell, or the post's own page. Default `"web-timeline"`. */
  surface?: Surface;
  /** Viewport width in CSS pixels, 100 to 1200. The post column is `min(width, 600)`. Default `600`. */
  width?: number;
  /** Default `"light"`. */
  theme?: Theme;
  /** Device pixel ratio, 1 to 4. Output PNG dimensions are `ceil(size.width × dpr)` × `ceil(size.height × dpr)`. Default `2`. */
  dpr?: number;
  /** X's font-size setting as a multiplier. Default `1`. */
  fontScale?: number;
  /** Render with "Show more" toggled on: shows the full post body in place. Default `false`. */
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
  /** Base64 bytes (JPEG, PNG, or WebP; poster frame for video/GIF). Without them a sized placeholder is drawn. */
  data?: string;
  alt?: string;
  /** Video duration in seconds, shown in the duration pill. */
  duration?: number;
  /** Original author when embedded from another post ("Post video" / "Post photo"). */
  sourceAuthor?: Author;
}

export interface LinkMeta {
  /** `"summary"`, `"summary_large_image"`, `"player"`, or `"app"`. Without it no card is drawn. */
  card?: string;
  title?: string;
  description?: string;
  domain?: string;
  /** The shortened form X displays (`scheme` and `www.` stripped). */
  display?: string;
  image?: { width: number; height: number; data?: string };
}

export interface Poll {
  choices: string[];
  /** Vote counts per choice; omitted for an open poll. */
  votes?: number[];
  /** Seconds remaining; omitted for `"Final results"`. */
  secondsLeft?: number;
}

export interface Counts {
  replies?: number;
  reposts?: number;
  likes?: number;
  views?: number;
  bookmarks?: number;
}

/** A post. Only `text` is required. */
export interface Post {
  text: string;
  author?: Author;
  /** Up to 20 carousel images, or one video or GIF. */
  media?: Media[];
  /** Card metadata keyed by URL as written in `text`. `resolve()` fills this in. */
  links?: Record<string, LinkMeta>;
  /** Display overrides keyed by source token (e.g. canonical casing for mentions). */
  entityLabels?: Record<string, string>;
  /** A quoted post. Quotes nest up to two levels deep. */
  quote?: Post;
  /** Up to four choices. `votes` makes it a finished poll. */
  poll?: Poll;
  counts?: Counts;
  /** ISO 8601 post timestamp. */
  createdAt?: string;
  /** ISO 8601 reference clock so relative timestamps (`"2h"`) render deterministically. */
  now?: string;
  /** `"dismissed"` hides the link card, matching X's composer toggle. */
  cardState?: "auto" | "dismissed";
  /** Status ID this post replies to (hides leading reply mentions when set). */
  replyTo?: string;
  /** Handle shown in `Replying to @handle` context (without `@`). */
  replyToHandle?: string;
  /** Display names tagged in media (`"Name and 2 others"`). */
  mediaTags?: string[];
  /** Context row drawn above the post on a profile timeline. */
  socialContext?: "pinned";
}

export interface Entity {
  kind: "url" | "mention" | "hashtag" | "cashtag";
  /** UTF-16 `[start, end]` code-unit offsets into `Post.text`. */
  range: [number, number];
  text: string;
  /** Shortened display URL when `kind === "url"`. */
  display?: string;
}

export interface Hidden {
  /** UTF-16 `[start, end]` code-unit offsets stripped from visible text. */
  range: [number, number];
  /** Reason the range was hidden (e.g. `"reply_mentions"`, `"quote_url"`, `"media_url"`). */
  why: string;
}

export interface Attachment {
  /** Winning attachment kind after X's precedence rules. */
  shown: "card" | "media" | "quote" | "poll";
  /** Winning card URL when `shown === "card"`. */
  url?: string | null;
  /** Rule explanation for why this attachment won. */
  why: string;
}

/** Structured layout and rule-decision report returned by `render()` and `explain()`. */
export interface Report {
  /** Upstream ruleset version, e.g. `"x-web@55591fe0"`. */
  ruleset: string;
  /** Surfaces verified against this ruleset. */
  verifiedFor: Surface[];
  /** Layout box in CSS pixels; PNG pixel dimensions are `ceil(width × dpr)` × `ceil(height × dpr)`. */
  size: { width: number; height: number };
  /** X's weighted character count (URL = 23, emoji = 2, CJK = 2; standard limit = 280). */
  length: { weighted: number; limit: number; valid: boolean };
  text: {
    lines: number;
    truncated: boolean;
    /** `true` when this render shows a `"Show more"` control (`showMore !== null`). */
    hasShowMore: boolean;
    /** `"inline"` (long-post UTF-16 cut on web) or `"clamped"` (9-line clamp on iOS), or `null`. */
    showMore: "inline" | "clamped" | null;
    /** Final visible text after hidden ranges, URL shortening, and truncation. */
    visible: string;
  };
  entities: Entity[];
  hidden: Hidden[];
  attachment: Attachment | null;
  warnings: string[];
}

/** Return value of `xeet.render(post, options?)`. */
export interface RenderResult {
  /** Encoded PNG bytes (`width × dpr` by `height × dpr` device pixels). */
  png: Uint8Array;
  /** Layout and rule-decision report for this render. */
  report: Report;
}

/** Return value of `xeet.renderRgba(post, options?)`. */
export interface RgbaResult {
  /** Raster width in device pixels (`ceil(report.size.width × dpr)`). */
  width: number;
  /** Raster height in device pixels (`ceil(report.size.height × dpr)`). */
  height: number;
  /** Straight-alpha RGBA8 pixel buffer (`width × height × 4` bytes). */
  rgba: Uint8Array;
  /** Layout and rule-decision report for this render. */
  report: Report;
}

/** One item returned by `xeet.renderMany(post, optionsList)`. */
export interface BatchItem {
  /** Encoded PNG bytes for this option set. */
  png: Uint8Array;
  /** Layout and rule-decision report for this option set. */
  report: Report;
  /** Native/WASM paint + PNG encode duration in milliseconds. */
  paint: number;
}

/** Network, DNS, and cache callbacks injected into `resolve()` / `resolveLinks()`. */
export interface Host {
  fetch(request: { url: string; method?: string; headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number }): Promise<{
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
  /** Download and base64-inline image bytes (media, avatars, badges, card images). Default `false`. */
  media?: boolean;
  /** Viewport width & DPR used to pick X `srcset` variants (`small` / `medium` / `large`). Defaults `600` and `2`. */
  width?: number;
  dpr?: number;
  surface?: Surface;
  /** Maximum URLs in `post.text` to crawl for link cards. Default `4`. */
  maxLinks?: number;
  /** ISO 8601 reference timestamp stamped onto `post.now`. */
  now?: string;
  /** Bypass `host.cacheGet` and re-fetch upstream resources. Default `false`. */
  refresh?: boolean;
}

export interface Hop {
  url: string;
  status: number;
}

/** Metadata and optional base64 bytes for one resolved image asset. */
export interface MediaAsset {
  /** Variant chosen from X's `srcset` (`"small"`, `"medium"`, `"large"`, `"_x96"`, `"bigger"`, `"card"`, `"original"`). */
  variant: string;
  /** Raw byte length (0 when `media: false`). */
  bytes: number;
  width: number;
  height: number;
  /** Slot filled (`"media:0"`, `"avatar"`, `"badge"`, `"card"`, `"quoted media:0"`, …). */
  role: string;
  /** Base64 image bytes when resolved with `{ media: true }`. */
  data?: string | null;
}

/** Return value of `xeet.resolveLinks(url, options?, host?)` and entries in `Resolved.links`. */
export interface ResolvedLink {
  /** Normalized card metadata ready for `Post.links[url]`. */
  meta: LinkMeta;
  /** Redirect hop chain (`[{ url, status }]`); the last hop is the parsed page. */
  chain: Hop[];
  /** Final canonical URL after redirects. */
  finalUrl: string;
  /** Raw `twitter:*` and `og:*` `<meta>` tags extracted from the page. */
  tags: Record<string, string>;
  /** Card image URL discovered in `<meta>` tags, if any. */
  imageUrl: string | null;
  /** Downloaded card image when `{ media: true }` is enabled. */
  image?: MediaAsset;
  /** Crawler diagnostic notes (e.g. robots/redirect/fallback decisions). */
  notes: string[];
  /** `true` when served from `host.cacheGet`. */
  cached: boolean;
}

/** Provenance metadata when `resolve()` was given an `x.com` status URL. */
export interface Source {
  url: string | null;
  id: string | null;
  appVersion: string | null;
  pageHtml?: string;
  pinned: boolean;
}

/** Return value of `xeet.resolve(input, options?, host?)`. */
export interface Resolved {
  /** Complete `Post` ready to pass directly into `xeet.render(resolved.post, options)`. */
  post: Post;
  /** Crawl results keyed by each URL as written in `post.text`. */
  links: Record<string, ResolvedLink>;
  /** Fetched image assets keyed by concrete CDN URL. */
  media: Record<string, MediaAsset>;
  /** Upstream status metadata when resolved from an `x.com` URL. */
  source: Source;
  /** Non-fatal resolution warnings. */
  warnings: string[];
}

export interface Xeet {
  /** Upstream X web-client build embedded in this module (e.g. `"55591fe0"`). */
  readonly upstream: string;
  /** Renders `post` to PNG bytes + layout `Report`. Synchronous; zero network I/O. */
  render(post: Post, options?: RenderOptions): RenderResult;
  /** Renders `post` to raw straight-alpha RGBA8 pixels + `Report`, skipping PNG encoding. */
  renderRgba(post: Post, options?: RenderOptions): RgbaResult;
  /** Renders `post` across multiple `RenderOptions`, decoding shared images once. */
  renderMany(post: Post, optionsList: RenderOptions[]): BatchItem[];
  /** Renders `post` and returns only the encoded PNG bytes. */
  renderPng(post: Post, options?: RenderOptions): Uint8Array;
  /** Runs rules and layout without rasterizing pixels and returns the `Report`. */
  explain(post: Post, options?: RenderOptions): Report;
  /** Returns `true` when `post` renders with a `"Show more"` control under `options` (collapsed). */
  hasShowMore(post: Post, options?: RenderOptions): boolean;
  /** Renders a labeled `widths × themes` contact sheet as one PNG. */
  sheet(request: { post: Post; widths?: number[]; themes?: Theme[]; dpr?: number }): Uint8Array;
  /** Resolves draft text, an `x.com` status URL, or post JSON into a complete `Resolved` envelope. */
  resolve(input: string, options?: ResolveOptions, host?: Host): Promise<Resolved>;
  /** Crawls a single URL as `Twitterbot/1.0` and returns its `ResolvedLink` card metadata. */
  resolveLinks(url: string, options?: ResolveOptions, host?: Host): Promise<ResolvedLink>;
  /** Wraps a WHATWG `fetch` (plus optional DNS `lookup` and cache) as a `Host`. */
  whatwgHost(parts?: Partial<Omit<Host, "fetch">> & { fetch?: typeof fetch }): Host;
  /** Loads any lazy font packs needed by `request` and returns the newly loaded pack names. */
  ensureFonts?(request: { post: Post; options?: RenderOptions }): Promise<string[]>;
  /** Synchronous counterpart to `ensureFonts` (Node only). */
  ensureFontsSync?(request: { post: Post; options?: RenderOptions }): string[];
  /** Lists every lazy font pack `request` requires, whether already loaded or not. */
  packsFor?(request: { post: Post; options?: RenderOptions }): string[];
  /** Lists the lazy font packs registered in this instance so far. */
  loadedPacks?(): string[];
  /** Lists all lazy font pack names shipped with this build. */
  fontPacks?(): string[];
}

/** Validation, limit, or stage error thrown by `render` / `explain` / `sheet`. */
export declare class XeetError extends Error {
  /** Machine-readable code (`"invalid_post"`, `"invalid_json"`, `"text_too_long"`, `"work_budget_exceeded"`, `"render_failed"`, …). */
  readonly code: string;
  /** Suggested HTTP status (`400`, `413`, `500`, `503`). */
  readonly status: number;
  /** Every offending input field at once, with typo suggestions when applicable. */
  readonly fields: { path: string; message: string; suggestion?: string }[];
  readonly notes: string[];
}

/** Error thrown by `resolve()` / `resolveLinks()` when upstream fetching or validation fails. */
export interface ResolveError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: { path: string; message: string }[];
}

/** Wraps an initialized WebAssembly module (browsers, workers). */
export declare function bind(wasm: unknown): Xeet;
export declare function fromModule(wasm: unknown): Xeet;
