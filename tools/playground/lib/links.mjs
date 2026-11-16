// Link metadata resolution: follow a URL the way X's crawler does and read the
// card tags off the page.
//
// PLAN.md §6: "Link metadata is an input. The renderer is a pure function and
// never fetches a URL. A separate, optional resolver (outside the trusted core)
// can fetch a page and read its card tags the way X's crawler does." This is
// that resolver: the only network code in `api/`, deliberately outside
// `xeet-core`, shared by the HTTP function (`POST /resolve-links`) and the
// playground (`/api/resolve`).
//
// ## What X's crawler does, and the evidence
//
// X's card docs went offline on 2026-11-02 (they now redirect to
// docs.x.com); the quotes are from the archived copies, with the live
// observation next to each claim.
//
// - **User agent.** "Twitter uses the User-Agent of Twitterbot (with version,
//   such as Twitterbot/1.0)" (*Troubleshooting Cards*,
//   https://web.archive.org/web/20251231142717/https://developer.x.com/en/docs/x-for-websites/cards/guides/troubleshooting-cards).
//   Verified 2026-11-10: `https://t.co/jO01BMGwXr` answers
//   `301 Location: https://vercel.com/changelog/vercel-daemons-is-now-in-public-beta`
//   to `Twitterbot/1.0`, but `200` with a 351-byte HTML interstitial
//   (`<META http-equiv="refresh" content="0;URL=…">`) to a browser UA. The UA
//   decides whether a card exists at all, and the interstitial is why meta
//   refresh must be followed.
// - **robots.txt.** "Twitterbot implements Google's robots.txt specification";
//   a page it disallows gets no card. This resolver fetches `/robots.txt` per
//   origin (cached an hour) and honours the `Twitterbot` group, else `*`, with
//   Google's longest-match rule.
// - **Page size.** "Twitter's crawler has a limit of 2 MB for page responses."
//   We read at most `LIMITS.htmlBytes` (1 MB): the tags are in the `<head>`, and
//   `www.pcgamer.com/games/the-top-100-pc-games-2026/` (2.59 MB live) resolves
//   because its first kilobyte carries them.
// - **Images.** JPG, PNG, WEBP or GIF, "under 5 MB", "SVG is not supported",
//   minimum 144×144 (*Cards markup*,
//   https://web.archive.org/web/20260201012312/https://developer.x.com/en/docs/x-for-websites/cards/overview/markup,
//   plus the troubleshooting page). Anything else is dropped, with a note.
// - **Tag fallbacks.** The markup reference gives them per tag:
//   `twitter:title`←`og:title`, `twitter:description`←`og:description`,
//   `twitter:image`←`og:image`, `twitter:image:alt`←`og:image:alt`;
//   `twitter:site` has no Open Graph equivalent; X reads `property` as well as
//   `name`. Verified on `www.bellingcat.com`: the page sets
//   `twitter:card=summary_large_image` but no `twitter:*` text or image, and the
//   captured post's card carries the `og:title` and `og:description`.
// - **No `twitter:card`, OG present.** The same table: "If an og:type, og:title
//   and og:description exist in the markup but twitter:card is absent, then a
//   summary card may be rendered." That is the only documented rule, so it is
//   what is implemented (a `summary` card), and the result says it was inferred.
// - **Redirects.** Undocumented. X follows chains: a captured link
//   `https://t.co/V7GErf6DS1` reaches its carded page only through
//   `t.co → nyti.ms → trib.al → nytimes.com?smid=tw-nytimes… → nytimes.com/…`
//   (five 301s, verified live). We follow up to `LIMITS.hops` (10) of
//   301/302/303/307/308, and `<meta http-equiv="refresh">`.
// - **Cache.** The crawler "re-indexes the Card tag information on your page
//   roughly every seven days"; ours is one hour (`refresh: true` bypasses it).
//
// ## Display form
//
// X prints `display_url`, not the URL as typed. For a link it is the
// *unshortened* form: `text-ProductHunt.html` has an entity whose
// `expanded_url` is still `https://t.co/CzX7ZkCvUz` while its `display_url` is
// `producthunt.com/products/produ…`. So `display` is derived from the final URL
// with `xeet-text`'s rule (strip scheme and `www.`, keep the host and 15
// characters of the tail, ellipsis — documented with 122 corpus pairs in
// `crates/xeet-text/src/display.rs`).
//
// ## Safety
//
// This runs server-side on user input. Every hop is checked before it is
// fetched:
//
// - `http:`/`https:` only, default ports (80/443) only;
// - the hostname is resolved and **every** address must be public — loopback,
//   private, CGNAT, link-local (including `169.254.169.254`), multicast,
//   reserved, unique-local, and IPv4-mapped/6to4/NAT64 forms of those are
//   refused. Re-resolved per hop, so a rebinding DNS answer does not survive a
//   redirect (a residual TOCTOU window needs a pinned dispatcher to close and is
//   noted as such);
// - 5 s per URL, 10 hops, 1 MB of HTML, 5 MB per image, `content-type` checked
//   before parsing or decoding;
// - no cookies, no credentials; one request per second per host (the capture
//   tools' policy);
// - connection resets are retried twice: `vercel.com` resets undici's pooled
//   sockets intermittently (2 of 3 live attempts), and a card must not depend on
//   that.
//
// A test-only allow-list (`configureLinks({allowHosts})` or
// `XEET_LINKS_ALLOW_PRIVATE`) exempts named hosts from the address and port
// checks so the offline smoke test can serve a fixture from `127.0.0.1`. It is
// never set by the shipped function.

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Every limit in one place, so the HTTP function can publish them. */
export const LIMITS = {
  userAgent: "Twitterbot/1.0",
  /** URLs resolved per post or per request. */
  urls: 4,
  /** Redirect hops, including meta refresh. */
  hops: 10,
  /** Bytes of HTML read per page (X's own cap is 2 MB; the tags are earlier). */
  htmlBytes: 1024 * 1024,
  /** Image cap, from the card docs ("under 5 MB"). */
  imageBytes: 5 * 1024 * 1024,
  /** Wall clock per URL. */
  timeoutMs: 5000,
  cacheTtlMs: 60 * 60 * 1000,
  /** Failures are cached briefly so typing does not hammer a dead link. */
  errorTtlMs: 10 * 60 * 1000,
  hostGapMs: 1000,
  imageMinSize: 144,
  titleChars: 70,
  descriptionChars: 200,
  altChars: 420,
};

const CARD_TYPES = new Set(["summary", "summary_large_image", "app", "player"]);
const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "mobile.x.com"]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);
/** Connection-level failures that are worth a retry (see the module docs). */
const RETRYABLE = new Set([
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_GOAWAY_SESSION",
  "UND_ERR_CONNECT_TIMEOUT",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

/** A failed resolution, with a stable code the API can return. */
export class LinksError extends Error {
  constructor(code, message, { status = 502, notes = [] } = {}) {
    super(message);
    this.name = "LinksError";
    this.code = code;
    this.status = status;
    this.notes = notes;
  }
}

const config = {
  cacheDir: null,
  /** Where image bytes live; defaults to a `media` directory next to the cache. */
  imageDir: null,
  /** Bytes allowed in the image directory (LRU eviction); 0 disables. */
  imageCacheBytes: null,
  allowHosts: new Set(),
  /** hostname → "ip:port", a test seam (see `configureLinks`). */
  hostMap: {},
  /** origin → {at, check}; robots.txt rules, cached for an hour. */
  robots: new Map(),
};

/**
 * @param {{cacheDir?: string, allowHosts?: string[], hostMap?: Record<string,string>,
 *   imageDir?: string, imageCacheBytes?: number}} [options]
 *
 * `allowHosts` and `hostMap` are for the offline smoke test, which serves a
 * fixture on `127.0.0.1:<random port>` under a name with a real TLD (xeet's own
 * entity extraction does not treat `127.0.0.1` as a URL, so the test cannot use
 * an IP literal in a post's text). Nothing sets them in `api/index.mjs`.
 */
export function configureLinks({ cacheDir, allowHosts, hostMap, imageDir, imageCacheBytes } = {}) {
  if (cacheDir) config.cacheDir = cacheDir;
  if (allowHosts) for (const host of allowHosts) config.allowHosts.add(String(host).toLowerCase());
  if (hostMap) for (const [host, target] of Object.entries(hostMap)) config.hostMap[host.toLowerCase()] = target;
  if (imageDir) config.imageDir = imageDir;
  if (imageCacheBytes != null) config.imageCacheBytes = imageCacheBytes;
}

function allowHosts() {
  const fromEnv = String(process.env.XEET_LINKS_ALLOW_PRIVATE ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...config.allowHosts, ...fromEnv]);
}

function hostMap() {
  const map = { ...config.hostMap };
  for (const pair of String(process.env.XEET_LINKS_HOST_MAP ?? "").split(",")) {
    const [host, target] = pair.split("=").map((s) => s?.trim());
    if (host && target) map[host.toLowerCase()] = target;
  }
  return map;
}

function cacheDir() {
  return config.cacheDir ?? process.env.XEET_LINKS_CACHE_DIR ?? join(tmpdir(), "xeet-links");
}

/**
 * Where image bytes live: next to the link cache, in a directory called
 * `media` (so the playground's `assets/vendor/playground/links` puts them in
 * `assets/vendor/playground/media`, the one directory the playground and the
 * oracle share). Git-ignored, capped, LRU (see `enforceImageCacheCap`).
 */
function imageDir() {
  return config.imageDir ?? process.env.XEET_LINKS_IMAGE_DIR ?? join(dirname(cacheDir()), "media");
}

/** The cap on the shared image directory. 0 or negative disables eviction. */
function imageCacheCap() {
  const raw = process.env.XEET_MEDIA_CACHE_BYTES ?? config.imageCacheBytes;
  const bytes = Number(raw ?? 500 * 1024 * 1024);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** True when the URL is an X post (or another X page): X never cards those. */
function isXHost(href) {
  try {
    return X_HOSTS.has(new URL(href).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** A resolution that deliberately has no card (an X link), with its display form. */
function noCardValue({ url, finalUrl, chain = [], notes = [] }) {
  return {
    url,
    finalUrl,
    chain,
    tags: {},
    meta: {
      card: null,
      title: null,
      description: null,
      domain: new URL(finalUrl).hostname,
      image: null,
      display: displayUrl(finalUrl),
    },
    imageUrl: null,
    notes,
    resolvedAt: new Date().toISOString(),
  };
}

/**
 * Resolves one URL.
 *
 * @param {string} rawUrl
 * @param {{media?: boolean, refresh?: boolean, signal?: AbortSignal,
 *   timeoutMs?: number, network?: boolean}} [options]
 *   `network: false` answers from the cache only (the playground's offline mode).
 * @returns {Promise<{url: string, finalUrl: string, chain: {url: string, status: number}[],
 *   tags: Record<string,string>, meta: object, imageUrl: string|null,
 *   notes: string[], cached: boolean, ms: number}>}
 */
export async function resolveLink(rawUrl, options = {}) {
  const started = performance.now();
  const url = normalizeUrl(rawUrl);
  if (!url) {
    throw new LinksError("invalid_url", `${JSON.stringify(rawUrl)} is not an http(s) URL`, { status: 400 });
  }
  const { media = false, refresh = false, signal, timeoutMs = LIMITS.timeoutMs, network = true } = options;

  // The playground asks twice for the same link (the post resolve and the
  // dedicated card pass, 400 ms apart). One in-flight resolution serves both, so
  // the second waits instead of queueing a duplicate request behind the gap.
  const key = `${media ? "media" : "meta"}\u0000${url}`;
  const inFlight = pending.get(key);
  if (inFlight && !refresh) {
    const value = await waitFor(inFlight, signal);
    return { ...value, ms: Math.round((performance.now() - started) * 10) / 10 };
  }
  const job = resolveUncached(url, { media, refresh, signal, timeoutMs, network, started });
  pending.set(key, job);
  try {
    return await job;
  } finally {
    if (pending.get(key) === job) pending.delete(key);
  }
}

/** `${media?}\0${url}` → the resolution in progress. */
const pending = new Map();

function waitFor(promise, signal) {
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      if (signal.aborted) return reject(new LinksError("timeout", "the request was abandoned"));
      signal.addEventListener("abort", () => reject(new LinksError("timeout", "the request was abandoned")), {
        once: true,
      });
    }),
  ]);
}

async function resolveUncached(url, { media, refresh, signal, timeoutMs, network, started }) {
  const cached = refresh ? null : await readCache(url);
  if (cached) {
    if (cached.error) {
      throw new LinksError(cached.error.code, cached.error.message, { status: cached.error.status ?? 502 });
    }
    return finish(cached, { cached: true, started, media, network, signal });
  }
  if (!network) {
    throw new LinksError("not_cached", `${url} is not in the link cache and the resolver is offline`, { status: 404 });
  }

  // A link to an X post has no card, and X does not crawl its own pages for
  // one: answer without a request.
  if (isXHost(url)) {
    const value = noCardValue({ url, finalUrl: url, notes: ["a link to an X post has no card"] });
    await writeCache(url, value);
    return finish(value, { cached: false, started, media, network, signal });
  }

  const deadline = Date.now() + timeoutMs;
  const notes = [];
  let current = url;
  let page = null;
  const chain = [];
  try {
    for (let hop = 0; hop <= LIMITS.hops; hop++) {
      await assertFetchable(current);
      await assertRobotsAllowed(current, { deadline, signal });
      const response = await fetchCapped(current, {
        deadline,
        signal,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        maxBytes: LIMITS.htmlBytes,
      });
      chain.push({ url: current, status: response.status });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new LinksError("bad_redirect", `${current} answered ${response.status} with no Location`);
        const next = new URL(location, current).href;
        if (next === current) throw new LinksError("redirect_loop", `${current} redirects to itself`);
        current = next;
        // The redirect already answers the question: an X destination has no
        // card, and X does not fetch it either. Stop here, with the chain.
        if (isXHost(current)) {
          const value = noCardValue({
            url,
            finalUrl: current,
            chain,
            notes: ["the link resolves to an X post; X shows no card for it"],
          });
          await writeCache(url, value);
          return finish(value, { cached: false, started, media, network, signal });
        }
        continue;
      }
      if (response.status === 404) throw new LinksError("not_found", `${current} answered 404`, { status: 404 });
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        throw new LinksError("blocked", `${current} answered ${response.status}`, { status: 502 });
      }
      if (response.status < 200 || response.status >= 300) {
        throw new LinksError("http_status", `${current} answered ${response.status}`);
      }

      const contentType = mediaType(response.headers.get("content-type"));
      if (!HTML_TYPES.has(contentType)) {
        throw new LinksError("not_html", `${current} returned ${contentType || "no content-type"}, which is not a page`);
      }
      const html = decodeText(response.body, response.headers.get("content-type"));
      if (response.truncated) {
        notes.push(`the page is larger than ${LIMITS.htmlBytes} bytes; its beginning was parsed`);
      }

      const refreshed = metaRefreshTarget(html, current);
      if (refreshed && refreshed !== current && hop < LIMITS.hops) {
        notes.push("followed a <meta http-equiv=refresh> redirect");
        current = refreshed;
        continue;
      }
      page = { html };
      break;
    }
    if (!page) throw new LinksError("too_many_redirects", `${url} did not settle within ${LIMITS.hops} redirects`);

    const { meta, tags, imageUrl } = cardsFromHtml(page.html, current, notes);
    const value = { url, finalUrl: current, chain, tags, meta, imageUrl, notes, resolvedAt: new Date().toISOString() };
    if (meta.card && imageUrl) {
      await hydrateImage(value, { deadline, signal, media, notes });
    }
    await writeCache(url, value);
    return finish(value, { cached: false, started, media, network, signal });
  } catch (error) {
    const failure = asLinksError(error);
    // Only the failures a retry would not fix are cached; a reset or a timeout
    // should be tried again on the next keystroke.
    if (["not_found", "blocked", "not_html", "bad_redirect", "private_address", "robots"].includes(failure.code)) {
      await writeCache(url, {
        url,
        error: { code: failure.code, message: failure.message, status: failure.status },
        resolvedAt: new Date().toISOString(),
      });
    }
    throw failure;
  }
}

/**
 * Resolves up to `LIMITS.urls` URLs. One dead link never loses the others: each
 * entry is either the resolution or `{error: {code, message, status}}`.
 */
export async function resolveLinks(urls, options = {}) {
  const list = [...new Set((urls ?? []).filter((u) => typeof u === "string" && u.trim()))].slice(0, LIMITS.urls);
  const entries = await Promise.all(
    list.map(async (url) => {
      try {
        return [url, await resolveLink(url, options)];
      } catch (error) {
        const failure = asLinksError(error);
        return [
          url,
          { url, error: { code: failure.code, message: failure.message, status: failure.status }, notes: failure.notes ?? [] },
        ];
      }
    }),
  );
  return Object.fromEntries(entries);
}

/** True when the URL can possibly carry a card (and is worth resolving). */
export function looksLikeLink(value) {
  return typeof value === "string" && /^https?:\/\/[^\s/]+/i.test(value.trim());
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

/** The response shape; hydrates the image bytes when `media` asks for them. */
async function finish(value, { cached, started, media, network, signal }) {
  const notes = [...(value.notes ?? [])];
  // A deep-enough copy that hydrating media never mutates what the cache holds.
  const meta = value.meta
    ? { ...value.meta, ...(value.meta.image ? { image: { ...value.meta.image } } : {}) }
    : null;
  if (meta?.image && media) {
    delete meta.image.data;
    const bytes = await imageBytes(value.imageUrl, {
      notes,
      signal,
      fetch: network,
      deadline: Date.now() + LIMITS.timeoutMs,
    });
    if (bytes) {
      meta.image.data = bytes.toString("base64");
      const size = imageSize(bytes);
      if (size) {
        meta.image.width = size.width;
        meta.image.height = size.height;
      }
    }
  }
  return {
    url: value.url,
    finalUrl: value.finalUrl,
    chain: value.chain ?? [],
    tags: value.tags ?? {},
    meta,
    imageUrl: value.imageUrl ?? null,
    notes,
    cached,
    ms: Math.round((performance.now() - started) * 10) / 10,
  };
}

function asLinksError(error) {
  if (error instanceof LinksError) return error;
  const code = error?.cause?.code ?? error?.code ?? "";
  return new LinksError(RETRYABLE.has(code) ? "network_error" : "resolve_failed", error?.message ?? String(error));
}

// ---------------------------------------------------------------------------
// URL normalization and safety
// ---------------------------------------------------------------------------

/** An absolute http(s) href, or null. */
export function normalizeUrl(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  url.hash = "";
  return url.href;
}

/** Refuses anything that is not a public http(s) destination. */
async function assertFetchable(href) {
  const url = new URL(href);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LinksError("private_address", `only http and https are fetched, not ${url.protocol}`, { status: 400 });
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const allowed = allowHosts();
  if (allowed.has(host) || allowed.has(url.host.toLowerCase())) return;
  if (hostMap()[host]) return;

  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (port !== "80" && port !== "443") {
    throw new LinksError("private_address", `${host}:${port} is not a default port`, { status: 400 });
  }
  if (isIpLiteral(host)) {
    if (isPrivateAddress(host)) {
      throw new LinksError("private_address", `${host} is a private or reserved address`, { status: 400 });
    }
    return;
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new LinksError("dns_failed", `${host} does not resolve (${error.code ?? error.message})`);
  }
  if (!addresses.length) throw new LinksError("dns_failed", `${host} has no addresses`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new LinksError("private_address", `${host} resolves to ${address}, which is not a public address`, {
        status: 400,
      });
    }
  }
}

function isIpLiteral(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/**
 * True for every address that is not a public unicast destination.
 *
 * IPv4: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local and the
 * cloud metadata endpoint), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24,
 * 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4.
 * IPv6: ::, ::1, fc00::/7, fe80::/10, ff00::/8, 2001:db8::/32, and any
 * IPv4-mapped / NAT64 / 6to4 address whose embedded IPv4 is private.
 */
export function isPrivateAddress(address) {
  if (!address) return true;
  const v6 = String(address).toLowerCase();
  if (!v6.includes(":")) return isPrivateV4(v6);
  const embedded = embeddedIpv4(v6);
  if (embedded) return isPrivateV4(embedded);
  return isPrivateV6(v6);
}

function embeddedIpv4(address) {
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (address.startsWith("64:ff9b::") || address.startsWith("2002:")) {
    const groups = address.replace(/%.*$/, "").split(":");
    const a = parseInt(groups.at(-2) || "0", 16);
    const b = parseInt(groups.at(-1) || "0", 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

function isPrivateV4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateV6(address) {
  const v = address.replace(/%.*$/, "");
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("fc") || v.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(v)) return true;
  if (v.startsWith("ff")) return true;
  if (v.startsWith("2001:db8")) return true;
  if (v.startsWith("2001:0:")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// robots.txt (Google's specification, which X's crawler implements)
// ---------------------------------------------------------------------------

async function assertRobotsAllowed(href, { deadline, signal }) {
  const url = new URL(href);
  const check = await robotsFor(url.origin, { deadline, signal });
  if (!check(url.pathname)) {
    throw new LinksError("robots", `robots.txt for ${url.origin} disallows ${url.pathname} for Twitterbot`, {
      status: 502,
    });
  }
}

async function robotsFor(origin, { deadline, signal }) {
  const cached = config.robots.get(origin);
  if (cached && Date.now() - cached.at < LIMITS.cacheTtlMs) return cached.check;
  let text = "";
  try {
    const response = await fetchCapped(`${origin}/robots.txt`, {
      deadline,
      signal,
      accept: "text/plain,*/*",
      maxBytes: 64 * 1024,
      polite: false,
    });
    if (response.status === 401 || response.status === 403) {
      // Google's spec: an unauthorised robots.txt means "stay out".
      const check = () => false;
      config.robots.set(origin, { at: Date.now(), check });
      return check;
    }
    if (response.status >= 200 && response.status < 300) text = decodeText(response.body, "text/plain");
  } catch {
    // Unreachable robots.txt means allow (Google's rule for 4xx), which is also
    // the only sane behaviour for a dev tool.
  }
  const check = robotsMatcher(text);
  config.robots.set(origin, { at: Date.now(), check });
  return check;
}

/**
 * A Google-style robots matcher: the `Twitterbot` group if there is one, `*`
 * otherwise; the longest matching rule wins; `Allow` wins a tie; `*` and a
 * trailing `$` are honoured.
 */
export function robotsMatcher(text) {
  const groups = [];
  let current = null;
  let inRules = false;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const index = line.indexOf(":");
    if (index < 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (key === "user-agent") {
      if (!current || inRules) {
        current = { agents: [], rules: [] };
        groups.push(current);
        inRules = false;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    if (key === "disallow" || key === "allow") {
      inRules = true;
      if (value === "") continue;
      current.rules.push({ allow: key === "allow", pattern: value });
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a.startsWith("twitterbot")));
  const rules = specific.length
    ? specific.flatMap((g) => g.rules)
    : groups.filter((g) => g.agents.includes("*")).flatMap((g) => g.rules);
  return (target) => {
    let best = null;
    for (const rule of rules) {
      if (!robotsPatternMatches(rule.pattern, target)) continue;
      const length = rule.pattern.replace(/[*$]/g, "").length;
      if (!best || length > best.length || (length === best.length && rule.allow)) {
        best = { length, allow: rule.allow };
      }
    }
    return best ? best.allow : true;
  };
}

function robotsPatternMatches(pattern, target) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = new RegExp(
    "^" + body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""),
  );
  return regex.test(target);
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** host → the tail of that host's request chain. */
const hostChains = new Map();
/** host → when its last request started. */
const hostLast = new Map();

/**
 * Runs `fn` with the per-host politeness gap: one request a second, chained per
 * host so a burst cannot interleave. A request that is aborted while waiting
 * does not consume a slot (`hostLast` is only set when the fetch starts), so
 * typing does not push the next real request behind a queue of cancelled ones.
 */
async function withHostSlot(host, signal, fn) {
  const previous = hostChains.get(host) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      const wait = (hostLast.get(host) ?? 0) + LIMITS.hostGapMs - Date.now();
      if (wait > 0) await sleepAbortable(wait, signal);
      hostLast.set(host, Date.now());
      return fn();
    });
  hostChains.set(host, run.catch(() => {}));
  return run;
}

function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LinksError("timeout", "the request was abandoned"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LinksError("timeout", "the request was abandoned"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One GET: no cookies, manual redirects, a capped body, retried on connection
 * errors. `polite: false` (robots.txt only) skips the per-host gap.
 */
async function fetchCapped(href, { deadline, signal, accept, maxBytes, polite = true }) {
  const url = new URL(href);
  const attemptOnce = async () => {
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new LinksError("timeout", `${url.href} did not answer in time`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await fetch(target.href, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            // X's crawler identifies itself; this is what makes t.co redirect.
            "user-agent": LIMITS.userAgent,
            accept,
            "accept-language": "en-US,en;q=0.9",
            // undici pools sockets and some CDNs reset idle ones.
            connection: "close",
          },
        });
        const { body, truncated } = await readCapped(response, maxBytes);
        return { status: response.status, headers: response.headers, body, truncated };
      } catch (error) {
        const code = error?.cause?.code ?? error?.code ?? "";
        if (attempt < 2 && RETRYABLE.has(code)) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          continue;
        }
        if (error?.name === "AbortError" || code === "UND_ERR_ABORTED") {
          throw new LinksError("timeout", `${url.href} did not answer in time`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
  };
  // A test seam: connect this hostname to a local address (never set in the
  // shipped function). The URL keeps its name for `display` and `domain`.
  const mapped = hostMap()[url.hostname.toLowerCase()];
  const target = mapped ? new URL(url.href) : url;
  if (mapped) target.host = mapped;
  return polite ? withHostSlot(url.host, signal, attemptOnce) : attemptOnce();
}

async function readCapped(response, maxBytes) {
  if (!response.body) return { body: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - total;
    if (value.byteLength >= remaining) {
      chunks.push(Buffer.from(value.subarray(0, remaining)));
      total += remaining;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(Buffer.from(value));
    total += value.byteLength;
  }
  return { body: Buffer.concat(chunks, total), truncated };
}

function mediaType(header) {
  return String(header ?? "").split(";")[0].trim().toLowerCase();
}

function decodeText(buffer, contentType) {
  const charset = String(contentType ?? "").match(/charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(buffer);
    } catch {
      // An unknown label: UTF-8 loses less than a refusal.
    }
  }
  return buffer.toString("utf8");
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * The card X would read from this page: `{meta, tags, imageUrl}` where `meta` is
 * `model::LinkMeta` and `tags` is what the markup actually said.
 */
export function cardsFromHtml(html, finalUrl, notes = []) {
  const tags = collectMeta(html);
  const pick = (...keys) => {
    for (const key of keys) {
      const value = tags.get(key);
      if (value) return value;
    }
    return null;
  };

  const rawCard = pick("twitter:card")?.trim().toLowerCase() ?? null;
  let card = null;
  if (rawCard && CARD_TYPES.has(rawCard)) {
    card = rawCard;
  } else if (rawCard) {
    notes.push(`twitter:card ${JSON.stringify(rawCard)} is not a card type; X shows nothing for it`);
  } else if (pick("og:type") && pick("og:title") && pick("og:description")) {
    // X's documented fallback (quoted in the module docs).
    card = "summary";
    notes.push("no twitter:card; X may render a summary card from og:type/og:title/og:description");
  }

  const url = new URL(finalUrl);
  if (card && X_HOSTS.has(url.hostname.toLowerCase())) {
    notes.push("the link resolves to an X post; X shows no card for it");
    card = null;
  }
  if (card === "player" && !pick("twitter:player")) {
    notes.push("a player card with no twitter:player; X shows nothing for it");
    card = null;
  }
  if (card === "app" && ![...tags.map.keys()].some((key) => key.startsWith("twitter:app:name:"))) {
    notes.push("an app card with no twitter:app:name:*; X shows nothing for it");
    card = null;
  }

  const title = clamp(pick("twitter:title", "og:title"), LIMITS.titleChars, notes, "title");
  const description = clamp(pick("twitter:description", "og:description"), LIMITS.descriptionChars, notes, "description");
  const imageAlt = clamp(pick("twitter:image:alt", "og:image:alt"), LIMITS.altChars, notes, "image alt");
  let imageUrl = card ? absoluteUrl(pick("twitter:image", "twitter:image:src", "og:image", "og:image:url"), finalUrl) : null;
  if (card && !imageUrl && pick("twitter:image", "twitter:image:src", "og:image", "og:image:url")) {
    notes.push("the card image is not an absolute http(s) URL; dropped");
  }
  if (!card) imageUrl = null;

  const meta = {
    card,
    title,
    description,
    // X keeps the final host verbatim, `www.` included: the corpus payloads say
    // `domain=www.nytimes.com` and `domain=github.blog`.
    domain: url.hostname,
    image: imageUrl ? { width: 0, height: 0 } : null,
    display: displayUrl(finalUrl),
  };
  // The source tags that matter for a card, so the response stays small and
  // diagnosable rather than carrying every `<meta>` on the page.
  const relevant = Object.fromEntries(
    [...tags.map].filter(([key]) => key.startsWith("twitter:") || key.startsWith("og:")),
  );
  return { meta, tags: relevant, imageUrl };
}

/**
 * Every `<meta>` tag as `name|property → content`, last occurrence winning
 * (X's behaviour for a duplicate tag) and values decoded (`&amp;` in an image
 * URL is markup, not part of the URL).
 */
export function collectMeta(html) {
  const map = new Map();
  for (const match of html.matchAll(/<meta\s+([^>]*?)\/?>/gi)) {
    const attrs = parseAttributes(match[1]);
    const key = (attrs.name ?? attrs.property ?? attrs.itemprop ?? "").trim().toLowerCase();
    if (!key || attrs.content === undefined) continue;
    map.set(key, decodeEntities(attrs.content));
  }
  return { map, get: (key) => map.get(String(key).toLowerCase()) ?? null };
}

function parseAttributes(text) {
  const attrs = {};
  for (const match of text.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? "";
  }
  return attrs;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(value) {
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

function clamp(value, max, notes, what) {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= max) return text;
  notes.push(`the card ${what} is ${text.length} characters; X's documented maximum is ${max}`);
  return text.slice(0, max);
}

function absoluteUrl(value, base) {
  if (!value) return null;
  try {
    const url = new URL(value.trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** `<meta http-equiv="refresh" content="0; url=…">`, which t.co serves browsers. */
export function metaRefreshTarget(html, base) {
  const head = html.slice(0, 16 * 1024);
  const match = head.match(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/i);
  if (!match) return null;
  const content = parseAttributes(match[0].slice(5)).content ?? "";
  const target = content.match(/url\s*=\s*['"]?([^'"]+)/i)?.[1]?.trim();
  if (!target) return null;
  try {
    return new URL(target, base).href;
  } catch {
    return null;
  }
}

/**
 * X's display form, as `xeet-text` implements it: strip the scheme and `www.`,
 * keep the host, keep 15 characters of the tail, ellipsis. The 15 comes from 122
 * `(expanded_url, display_url)` pairs in the corpus; see
 * `crates/xeet-text/src/display.rs`.
 */
export function displayUrl(href) {
  let rest = String(href ?? "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "");
  if (!rest) return rest;
  const chars = [...rest];
  const hostEnd = chars.findIndex((c) => c === "/" || c === "?" || c === "#");
  const hostLen = hostEnd < 0 ? chars.length : hostEnd;
  if (chars.length <= hostLen + 15) return rest;
  return chars.slice(0, hostLen + 15).join("") + "…";
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** Fetches the card image, caches its bytes and records its size. */
async function hydrateImage(value, { deadline, signal, media, notes }) {
  const url = value.imageUrl;
  if (!url) return;
  let bytes = await imageBytes(url, { deadline, signal, notes, fetch: true });
  if (!bytes) {
    value.meta.image = null;
    return;
  }
  const size = imageSize(bytes);
  if (!size) {
    notes.push(`the card image at ${url} is not a readable JPG, PNG, WEBP or GIF; dropped`);
    value.meta.image = null;
    return;
  }
  if (size.width < LIMITS.imageMinSize || size.height < LIMITS.imageMinSize) {
    // "Images should be a minimum of 144 x 144 pixels" (troubleshooting page).
    notes.push(`the card image is ${size.width}×${size.height}; X needs 144×144, so it is dropped`);
    value.meta.image = null;
    return;
  }
  value.meta.image.width = size.width;
  value.meta.image.height = size.height;
  if (media) value.meta.image.data = bytes.toString("base64");
}

/**
 * The image's bytes from the cache, or (with `fetch`) from the network after
 * the same safety checks as a page. Cached bytes are always used when present.
 */
async function imageBytes(url, { notes = [], deadline, signal, fetch: shouldFetch = false } = {}) {
  if (!url) return null;
  const hit = await readImageCache(url);
  if (hit) return hit.bytes;
  if (!shouldFetch) return null;
  try {
    const asset = await fetchImageAsset(url, {
      signal,
      timeoutMs: Math.max(1, (deadline ?? Date.now() + LIMITS.timeoutMs) - Date.now()),
      notes,
    });
    return asset.bytes;
  } catch (error) {
    notes.push(`the card image could not be fetched: ${asLinksError(error).message}`);
    return null;
  }
}

/** Intrinsic size of a JPG, PNG, GIF or WEBP, or null. */
export function imageSize(bytes) {
  if (!bytes || bytes.length < 10) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (bytes.length < 24) return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  const head = bytes.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    const chunk = bytes.subarray(12, 16).toString("latin1");
    if (chunk === "VP8X" && bytes.length >= 30) {
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    }
    if (chunk === "VP8 " && bytes.length >= 30) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function cacheKey(url) {
  return createHash("sha256").update(url).digest("hex");
}

async function readCache(url) {
  const path = join(cacheDir(), `${cacheKey(url)}.json`);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    const age = Date.now() - Date.parse(value.resolvedAt ?? 0);
    const ttl = value.error ? LIMITS.errorTtlMs : LIMITS.cacheTtlMs;
    if (!Number.isFinite(age) || age < 0 || age > ttl) return null;
    return value;
  } catch {
    return null;
  }
}

async function writeCache(url, value) {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(join(cacheDir(), `${cacheKey(url)}.json`), JSON.stringify({ ...value, url }, null, 2) + "\n");
  } catch {
    // A cache that cannot be written is not a failed resolution.
  }
}

async function readImageCache(url) {
  for (const ext of IMAGE_TYPES.values()) {
    const path = join(imageDir(), `${cacheKey(url)}.${ext}`);
    if (!existsSync(path)) continue;
    try {
      const bytes = await readFile(path);
      // LRU: a hit makes the file the most recently used.
      const now = new Date();
      await utimes(path, now, now).catch(() => {});
      return { bytes, file: path, ext };
    } catch {
      return null;
    }
  }
  return null;
}

async function writeImageCache(url, bytes, ext) {
  try {
    await mkdir(imageDir(), { recursive: true });
    const file = join(imageDir(), `${cacheKey(url)}.${ext}`);
    await writeFile(file, bytes);
    await enforceImageCacheCap();
    return file;
  } catch {
    return null;
  }
}

let lastCapCheck = 0;

/**
 * Keeps the shared image directory under `imageCacheCap()` by deleting the
 * least recently used files (mtime, refreshed on every hit). Runs at most once
 * every five seconds, and only after a write.
 */
export async function enforceImageCacheCap({ force = false } = {}) {
  const cap = imageCacheCap();
  if (!cap) return { evicted: 0, bytes: 0 };
  if (!force && Date.now() - lastCapCheck < 5000) return { evicted: 0, bytes: 0 };
  lastCapCheck = Date.now();
  let entries;
  try {
    entries = await readdir(imageDir(), { withFileTypes: true });
  } catch {
    return { evicted: 0, bytes: 0 };
  }
  const files = [];
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(imageDir(), entry.name);
    try {
      const info = await stat(path);
      files.push({ path, size: info.size, mtime: info.mtimeMs });
      total += info.size;
    } catch {}
  }
  if (total <= cap) return { evicted: 0, bytes: total };
  files.sort((a, b) => a.mtime - b.mtime);
  // Evict to 90% of the cap, so eviction is occasional rather than per write.
  const target = cap * 0.9;
  let evicted = 0;
  for (const file of files) {
    if (total <= target) break;
    try {
      await unlink(file.path);
      total -= file.size;
      evicted++;
    } catch {}
  }
  return { evicted, bytes: total };
}

/**
 * An image's bytes, from the shared cache or the network, with the crawler's
 * safety checks and the same per-host politeness as a page.
 *
 * @returns {Promise<{bytes: Buffer, width: number, height: number, ext: string,
 *   file: string|null, cached: boolean}|null>}
 */
export async function fetchImageAsset(url, { signal, timeoutMs = LIMITS.timeoutMs, notes = [] } = {}) {
  const cached = await readImageCache(url);
  if (cached) {
    const size = imageSize(cached.bytes) ?? { width: 0, height: 0 };
    return { bytes: cached.bytes, ...size, ext: cached.ext, file: cached.file, cached: true };
  }
  await assertFetchable(url);
  await assertRobotsAllowed(url, { deadline: Date.now() + timeoutMs, signal });
  const response = await fetchCapped(url, {
    deadline: Date.now() + timeoutMs,
    signal,
    accept: "image/*",
    maxBytes: LIMITS.imageBytes,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new LinksError("image_status", `${url} answered ${response.status}`);
  }
  const type = mediaType(response.headers.get("content-type"));
  const ext = IMAGE_TYPES.get(type);
  if (!ext) throw new LinksError("image_type", `${url} is ${type || "untyped"}, not JPG/PNG/WEBP/GIF`);
  if (response.truncated) throw new LinksError("image_too_large", `${url} is over ${LIMITS.imageBytes} bytes`);
  const size = imageSize(response.body);
  if (!size) throw new LinksError("image_invalid", `${url} is not a readable image`);
  const file = await writeImageCache(url, response.body, ext);
  return { bytes: response.body, ...size, ext, file, cached: false };
}

/**
 * The cached file for an image URL, if it is on disk. The playground's resolve
 * response maps every inlined URL to its file so a page-mode consumer can serve
 * the same bytes to Chrome.
 */
export async function imageFileFor(url) {
  const hit = await readImageCache(url);
  return hit?.file ?? null;
}

/** Drops the cached resolution of one URL; `refresh: true` skips reading it. */
export async function forgetLink(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return false;
  try {
    await unlink(join(cacheDir(), `${cacheKey(url)}.json`));
    return true;
  } catch {
    return false;
  }
}
