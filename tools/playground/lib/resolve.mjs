// `POST /api/resolve`: one string in, a post (and maybe its source page) out.
//
// Three kinds of input, three honest paths:
//
// - **text** — the input is the post body. Nothing to validate, nothing to
//   fetch: this is the path a keystroke takes, so it must be instant.
// - **JSON** — a `Post` (or `{post, options}`) pasted from a fixture or an
//   agent. Validated by the native `explain`, which is the shipping parser:
//   strict about unknown fields, with "did you mean" suggestions. When the
//   native binary is not built yet, the shipped HTTP function validates instead
//   (same core, same answers) and the response says so.
// - **URL** — an x.com/twitter.com status link. The page is fetched logged out,
//   at most once per 1.1 s, and cached under `assets/vendor/playground/<id>.html`
//   (git-ignored with the rest of `assets/vendor`). The embedded GraphQL payload
//   is translated with `tools/ship/corpus-post.mjs`, the same converter the
//   end-to-end harness uses, so a pasted URL and a corpus run produce the same
//   post. `source.page` keys Chrome's page mode.
//
// Media bytes are not in a captured page (X blocks them for logged-out clients),
// but the payload carries the URLs X's own client would fetch, so they can be
// fetched and inlined: `lib/media.mjs` picks the variant X's `<img srcset>` /
// `<video poster>` would use for the rendered cell at the requested dpr, and
// fills `Media::data` — the *poster frame* for a video or GIF — plus the avatar,
// the affiliation badge, the quoted post and its card, and the link card image.
// `media` is on by default in the playground (`media: false` opts out, and the
// shipped function keeps it opt-in). Bytes are cached in the git-ignored
// `assets/vendor/playground/media/`; the response maps every inlined URL to its
// file in `source.media`, which page-mode Chrome uses for the same bytes.

import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { ROOT, PLAYGROUND_CACHE, upstream } from "./build.mjs";
import { resolveWithLibrary, resolverUnavailableReason } from "./resolve-lib.mjs";
import { LIMITS, imageFileFor, resolveLinks } from "./links.mjs";
import { inlinePostMedia } from "./media.mjs";
import { extractTweets } from "../../oracle/samples.mjs";
import { payloadToPost } from "../../ship/corpus-post.mjs";

const CORPUS = join(ROOT, "assets", "vendor", "corpus");
/** Where `api/_lib/links.mjs` keeps its resolutions (git-ignored, with the rest). */
export const LINKS_CACHE = join(PLAYGROUND_CACHE, "links");

/** How long a text resolve may spend on link cards before answering without them.
 *  A keystroke must not wait on someone's server; the cache makes the next one
 *  free, and the playground can send `links: false` while typing. */
const LINK_BUDGET_MS = 4000;

/** Between network requests to X: the capture tools' policy (≥1 s). */
const MIN_GAP_MS = 1100;
/** A logged-out desktop Chrome UA. X serves the same server render to any
 *  logged-out client; an obviously automated UA is likelier to be challenged. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

export class ResolveError extends Error {
  constructor(message, { status = 400, code = "resolve_failed", fields = [], warnings = [] } = {}) {
    super(message);
    this.name = "ResolveError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.warnings = warnings;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The canonical status URL shape: x.com/<handle>/status/<id> and friends. */
const STATUS_URL = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[^/?#]+|i\/web)\/status(?:es)?\/(\d+)/i;

export function statusIdOf(input) {
  const trimmed = input.trim();
  if (!/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(trimmed)) return null;
  return trimmed.match(STATUS_URL)?.[1] ?? null;
}

export function isStatusUrl(input) {
  return /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(input.trim());
}

/** `https://x.com/i/status/<id>`, the form a fetch and a cache key both use. */
export function canonicalUrl(id) {
  return `https://x.com/i/status/${id}`;
}

export function cachePaths(id) {
  return {
    page: join(PLAYGROUND_CACHE, `${id}.html`),
    meta: join(PLAYGROUND_CACHE, `${id}.json`),
  };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * @param {string} input
 * @param {object} options
 * @param {boolean} [options.media]     fetch and inline image bytes (including a card's)
 * @param {boolean} [options.offline]   never touch the network; seed from the corpus
 * @param {boolean} [options.links]     resolve the post's URLs into card metadata
 *                                      (default true; `false` skips, for typing)
 * @param {object} [options.options]     render options (`width`, `dpr`) — picks the
 *                                      image variant X's client would fetch
 * @param {(post: object, options: object|undefined) => Promise<any>} [options.validate]
 * @param {(post: object, options: object|undefined) => Promise<any>} [options.explain]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} the `/api/resolve` body
 */
export async function resolveInput(input, options = {}) {
  const { media = false, offline = false, validate, explain, links = true, refresh = false, signal, options: renderOptions } = options;
  // The rules live in `crates/xeet-resolve` now (compiled to wasm), so the
  // playground calls the library and this JS pipeline is only the fallback:
  // `XEET_RESOLVE=js` pins it, `offline` uses it (it seeds cached pages from the
  // corpus, which is a test-only path), and a build without the export falls
  // back with the reason attached.
  if (!offline && process.env.XEET_RESOLVE !== "js") {
    try {
      return await resolveWithLibrary(input, { ...options, media, links, refresh, signal, width: renderOptions?.width ?? 390, dpr: renderOptions?.dpr ?? 2 })
        .then((body) => body)
        .catch((error) => {
          if (error?.name === "ResolveFailure") {
            throw new ResolveError(error.message, { status: error.status, code: error.code, fields: error.fields });
          }
          throw error;
        });
    } catch (error) {
      if (error instanceof ResolveError || process.env.XEET_RESOLVE === "rust") throw error;
      if (!globalThis.__xeetResolveFallback) {
        globalThis.__xeetResolveFallback = true;
        console.warn(`playground: the resolver library is unavailable (${resolverUnavailableReason()}); using the JS resolver`);
      }
    }
  }
  if (typeof input !== "string" || !input.trim()) {
    throw new ResolveError("the input is empty", { code: "empty_input" });
  }
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    return resolveJson(trimmed, { validate, explain, media, offline, links, refresh, signal });
  }
  if (trimmed.startsWith("[")) {
    throw new ResolveError("a post is a JSON object, not an array", { code: "invalid_json" });
  }
  if (isStatusUrl(trimmed)) {
    return resolveUrl(trimmed, { media, offline, links, refresh, explain, signal, options: renderOptions });
  }
  const body = { kind: "text", post: { text: input } };
  await withLinks(body, { explain, media, offline, links, refresh, signal });
  return body;
}

async function resolveJson(text, { validate, explain, media, offline, links, refresh, signal }) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ResolveError(`the JSON does not parse: ${e.message}`, { code: "invalid_json" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ResolveError("expected a post object", { code: "invalid_json" });
  }
  // `{post, options}` is the shape the MCP tools and the fixtures use; a bare
  // post is what a person pastes.
  const wrapped = parsed.post && typeof parsed.post === "object" && !Array.isArray(parsed.post);
  const post = wrapped ? parsed.post : parsed;
  const options = wrapped ? parsed.options : undefined;
  if (typeof validate !== "function") {
    throw new ResolveError("no validator is available to check this post; build the native target", {
      code: "validator_unavailable",
      status: 503,
    });
  }
  let validatedBy = "native";
  try {
    const result = await validate(post, options);
    validatedBy = result?.engine ?? "native";
  } catch (e) {
    if (e.code === "validator_unavailable") {
      throw new ResolveError("no renderer is available to validate this post; build the native or http target", {
        code: "validator_unavailable",
        status: 503,
      });
    }
    throw new ResolveError(e.message ?? "the post is not valid", {
      code: e.code ?? "invalid_post",
      status: e.status && e.status >= 400 && e.status < 500 ? e.status : 400,
      fields: fieldsFromError(e),
    });
  }
  const body = {
    kind: "json",
    post,
    ...(options ? { options } : {}),
    validatedBy,
  };
  await withLinks(body, { explain, media, offline, links, signal });
  return body;
}

/**
 * Field-level problems from a renderer error.
 *
 * The core reports nested validation problems as `fields`; unknown keys are
 * refused earlier, as an `invalid_json` message with the suggestion inline, so
 * those are lifted out of the text into the same shape. The editor can then
 * underline `auther` instead of showing one long sentence.
 */
export function fieldsFromError(error) {
  if (Array.isArray(error.fields) && error.fields.length) return error.fields;
  const message = String(error.message ?? "");
  const fields = [];
  for (const line of message.split("\n")) {
    const unknown = line.match(/unknown field `([^`]+)`(?:;\s*(did you mean `([^`]+)`\?|.*))?/);
    if (unknown) {
      fields.push({ path: unknown[1], message: line.trim() });
      continue;
    }
    const named = line.match(/^([A-Za-z0-9_.\[\]]+):\s*(.+)$/);
    if (named) fields.push({ path: named[1], message: named[2].trim() });
  }
  return fields;
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

async function resolveUrl(input, { media, offline, links, refresh, explain, signal, options }) {
  const id = statusIdOf(input);
  if (!id) {
    throw new ResolveError(
      "that x.com link has no post id; paste a status URL like https://x.com/vercel/status/123",
      { code: "unsupported_url" },
    );
  }
  const warnings = [];
  let { html, source } = await pageFor(id, input, { offline, warnings });
  let tweet = extractTweets(html).find((t) => String(t.rest_id) === id);
  if (!tweet && !source.seededFromCorpus) {
    // A page can come back without the payload — a consent wall, a challenge, a
    // client-rendered shell. The corpus is the same server render, so use it
    // and say that this resolve did not come from the live site.
    if (await seedFromCorpus(id)) {
      html = await readFile(cachePaths(id).page, "utf8");
      source = sourceOf(id, input, await readJson(cachePaths(id).meta), { cached: true, seeded: true });
      tweet = extractTweets(html).find((t) => String(t.rest_id) === id);
      warnings.push("the fetched page had no payload for this post; used the captured corpus page instead");
    }
  }
  if (!tweet) {
    throw new ResolveError(
      `the page for post ${id} has no payload for it (deleted, protected, or not server-rendered)`,
      { code: "not_found", status: 404, warnings },
    );
  }
  const appVersion = html.match(/"appVersion":"([0-9a-f]+)"/)?.[1] ?? null;
  const { post, meta } = payloadToPost(tweet, { now: source.fetchedAt, appVersion });
  // A pinned post's payload is wrapped in a timeline entry whose
  // `socialContext` says `Pin`; the tweet object itself does not carry it
  // (docs/E2E.md, and `tools/ship/e2e.mjs` reads the same fact from the cell).
  // Setting it here means every column renders the row, not just Chrome's page
  // mode, which can see it in the DOM.
  const pinned = pinnedIds(html).has(id);
  if (pinned) post.socialContext = "pinned";

  // Media first: the link-card image is inlined by `withLinks` afterwards, and
  // the map below includes both.
  let mediaResult = null;
  if (media) mediaResult = await inlineMedia(post, tweet, { warnings, options, signal });

  const body = {
    kind: "url",
    post,
    source: {
      ...source,
      id,
      appVersion,
      ...(pinned ? { socialContext: "pinned" } : {}),
      // What the converter could not model from a logged-out page: the corpus
      // harness uses this to skip comparisons, and the UI can say it out loud.
      unsupported: meta.unsupported,
    },
    ...(mediaResult && Object.keys(mediaResult.map).length ? { media: mediaResult.map } : {}),
  };
  const linkResult = await withLinks(body, { explain, media, offline, links, refresh, signal });
  if (mediaResult) {
    // Card images are resolved after the post's own media; add their files to
    // the same map so one lookup serves every inlined URL.
    for (const [url, entry] of Object.entries(linkResult?.files ?? {})) mediaResult.map[url] = entry;
    if (body.source && Object.keys(mediaResult.map).length) body.source.media = mediaResult.map;
    body.media = mediaResult.stats;
  }
  if (warnings.length) body.warnings = [...(body.warnings ?? []), ...warnings];
  return body;
}

// ---------------------------------------------------------------------------
// Link cards (post.links)
// ---------------------------------------------------------------------------

/**
 * Fills `post.links` with the card metadata for the post's URLs.
 *
 * The URLs come from xeet's own entity extraction — the `entities` of a (native
 * or wasm) `explain` report — so what is resolved is exactly what the renderer
 * would treat as a link, up to `LIMITS.urls` of them. Each result is keyed by
 * the URL **as written in the text**, which is what `rules` looks up, and its
 * `display` is the unshortened form X prints (see `api/_lib/links.mjs`).
 *
 * Existing entries win on `display`: a captured post's payload carries the
 * `display_url` X actually rendered (`bit.ly/…` for a bit.ly link), and a
 * resolution must not overwrite the truth with its own guess.
 */
async function withLinks(body, { explain, media, offline, links, refresh, signal }) {
  const files = {};
  if (links === false) return { files };
  if (typeof explain !== "function") return { files };
  const post = body.post;
  if (!post || typeof post !== "object") return { files };
  // No URL in the text, no entity to extract: this is the typing path, and it
  // must not pay for an explain.
  const hasUrl = [post.text, ...(post.quote ? [post.quote.text] : [])].some(
    (text) => typeof text === "string" && /https?:\/\/\S/i.test(text),
  );
  if (!hasUrl) return { files };

  let report = null;
  try {
    const explained = await explain(post, body.options);
    report = explained?.report ?? explained ?? null;
  } catch {
    // The post could not be explained (over a limit, no renderer): a missing
    // card is better than a failed resolve.
    return { files };
  }
  const entities = Array.isArray(report?.entities) ? report.entities : [];
  const urls = [];
  for (const entity of entities) {
    if (entity?.kind !== "url" || typeof entity.text !== "string") continue;
    if (!plausibleLink(entity.text)) continue;
    if (!urls.includes(entity.text)) urls.push(entity.text);
    if (urls.length >= LIMITS.urls) break;
  }
  if (!urls.length) return { files };

  const deadline = Date.now() + LINK_BUDGET_MS;
  const resolved = await resolveLinks(urls, {
    media,
    refresh,
    network: !offline,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(LINK_BUDGET_MS)]) : AbortSignal.timeout(LINK_BUDGET_MS),
  });
  const warnings = [];
  const details = {};
  for (const url of urls) {
    if (Date.now() > deadline) {
      warnings.push(`link ${url}: ran out of time; no card this time, the next attempt will be fast`);
      continue;
    }
    const entry = resolved[url];
    if (!entry) continue;
    if (entry.error) {
      if (entry.error.code !== "not_cached") warnings.push(`link ${url}: ${entry.error.message}`);
      continue;
    }
    const meta = entry.meta ?? {};
    const existing = post.links?.[url] ?? {};
    const merged = {
      ...meta,
      // Keep what the payload said X rendered for this URL.
      ...(existing.display ? { display: existing.display } : {}),
    };
    // `model::LinkMeta` in the strict parser knows exactly these keys.
    const clean = {};
    for (const key of ["card", "title", "description", "domain", "image", "display"]) {
      if (merged[key] !== undefined && merged[key] !== null) clean[key] = merged[key];
    }
    if (clean.image) {
      clean.image = {
        width: clean.image.width ?? 0,
        height: clean.image.height ?? 0,
        ...(clean.image.data ? { data: clean.image.data } : {}),
      };
      // A card image without dimensions cannot be drawn; drop it rather than
      // make the renderer guess.
      if (!clean.image.width || !clean.image.height) delete clean.image;
    }
    if (!Object.keys(clean).length) continue;
    post.links = { ...(post.links ?? {}), [url]: clean };
    if (clean.image?.data && entry.imageUrl) {
      // The card image's file, for `source.media`: page mode serves Chrome the
      // same bytes for the page's own `twitter:image` request.
      files[entry.imageUrl] = {
        file: await imageFileFor(entry.imageUrl),
        bytes: Math.round((clean.image.data.length * 3) / 4),
        width: clean.image.width,
        height: clean.image.height,
        variant: "card",
        role: "card",
      };
    }
    // The bytes (when the caller asked for them) live in `post.links`; the
    // detail entry carries the metadata and how it was found, not a second copy
    // of the image.
    const image = entry.meta?.image ? { ...entry.meta.image } : null;
    if (image) delete image.data;
    details[url] = {
      meta: entry.meta ? { ...entry.meta, image } : entry.meta,
      chain: entry.chain,
      finalUrl: entry.finalUrl,
      tags: entry.tags,
      notes: entry.notes,
      cached: entry.cached,
      ms: entry.ms,
    };
  }
  if (Object.keys(details).length) body.links = details;
  if (warnings.length) body.warnings = [...(body.warnings ?? []), ...warnings];
  return { files };
}

/**
 * A URL worth spending a network request on: a host with a dot, and enough of a
 * path that it is not a half-typed host (`https://verce` while typing).
 */
function plausibleLink(text) {
  const match = text.trim().match(/^https?:\/\/([^/?#\s]+)([^\s]*)/i);
  if (!match) return false;
  const host = match[1].toLowerCase();
  if (!host.includes(".") && host !== "localhost") return false;
  if (host === "t.co" && match[2].length < 2) return false;
  return true;
}

/**
 * The ids of posts whose timeline entry says `Pinned`, read from a captured
 * page.
 *
 * The page embeds its payloads as escaped JSON, and the wrapper that carries
 * the context sits immediately before the post it belongs to:
 *
 *   ...\"context_type\":\"Pin\",\"text\":\"Pinned\"}...,\"tweet_results\":{...\"rest_id\":\"20\"...
 *
 * so the first `rest_id` after a `Pin` marker is the pinned post. (The marker
 * itself is `Pin`: `Pinned` is the label X draws, not the type.)
 */
export function pinnedIds(html) {
  const ids = new Set();
  const marker = '\\"context_type\\":\\"Pin\\"';
  const restId = /\\"rest_id\\":\\"(\d+)\\"/g;
  let from = 0;
  while (true) {
    const at = html.indexOf(marker, from);
    if (at < 0) break;
    from = at + marker.length;
    const window = html.slice(at, at + 800);
    restId.lastIndex = 0;
    const found = restId.exec(window);
    if (found) ids.add(found[1]);
  }
  return ids;
}

/** The captured page for an id: cache, corpus (offline or as a fallback), network. */
async function pageFor(id, input, { offline, warnings }) {
  const paths = cachePaths(id);
  if (existsSync(paths.page)) {
    const html = await readFile(paths.page, "utf8");
    const meta = await readJson(paths.meta);
    return {
      html,
      source: sourceOf(id, input, meta, { cached: true }),
    };
  }

  if (offline) {
    const seeded = await seedFromCorpus(id);
    if (!seeded) {
      throw new ResolveError(`post ${id} is not in the cache, and the server is offline`, {
        code: "not_cached",
        status: 404,
      });
    }
    const html = await readFile(paths.page, "utf8");
    return { html, source: sourceOf(id, input, await readJson(paths.meta), { cached: true, seeded: true }) };
  }

  let html;
  const url = canonicalUrl(id);
  try {
    const res = await throttledFetch(url, { accept: "text/html,application/xhtml+xml" });
    if (res.status === 429 || res.status === 403 || res.status === 401) {
      throw new ResolveError(
        `x.com answered ${res.status} for ${url}; it is throttling or blocking logged-out page loads, so try again later`,
        { code: "blocked", status: 502 },
      );
    }
    if (res.status === 404) {
      throw new ResolveError(`x.com says post ${id} does not exist (404)`, { code: "not_found", status: 404 });
    }
    if (!res.ok) {
      throw new ResolveError(`x.com answered ${res.status} for ${url}`, { code: "fetch_failed", status: 502 });
    }
    html = Buffer.from(await res.arrayBuffer()).toString("utf8");
  } catch (e) {
    if (e instanceof ResolveError) throw e;
    // Offline laptop, DNS failure, TLS error: the corpus is a legitimate
    // stand-in for the pages it already captured, and the response says so.
    const seeded = await seedFromCorpus(id);
    if (!seeded) {
      throw new ResolveError(`could not fetch ${url}: ${e.message} (and there is no cached page for it)`, {
        code: "fetch_failed",
        status: 502,
      });
    }
    warnings.push(`could not fetch ${url} (${e.message}); used the captured corpus page instead`);
    const cachedHtml = await readFile(paths.page, "utf8");
    return { html: cachedHtml, source: sourceOf(id, input, await readJson(paths.meta), { cached: true, seeded: true }) };
  }

  const meta = {
    url,
    requested: input,
    id,
    fetchedAt: new Date().toISOString(),
    appVersion: html.match(/"appVersion":"([0-9a-f]+)"/)?.[1] ?? null,
    bytes: html.length,
  };
  await savePage(paths, html, meta);
  return { html, source: sourceOf(id, input, meta, { cached: false }) };
}

function sourceOf(id, input, meta, { cached, seeded = false }) {
  const lock = upstream();
  const fetchedAt = meta?.fetchedAt ?? lock.fetchedAt ?? new Date().toISOString();
  const paths = cachePaths(id);
  return {
    url: canonicalUrl(id),
    requested: input,
    capturedAt: fetchedAt,
    fetchedAt,
    appVersion: meta?.appVersion ?? null,
    cached,
    ...(seeded ? { seededFromCorpus: true } : {}),
    // `page` is the name Chrome's page mode resolves under
    // `assets/vendor/playground/` (docs/PLAYGROUND-CHROME.md), which is how the
    // oracle looks a capture up. The absolute path and the HTTP route are there
    // for anything that would rather not guess a search path.
    page: `${id}.html`,
    pagePath: paths.page,
    pageUrl: `/api/source/${id}`,
  };
}

async function savePage(paths, html, meta) {
  await mkdir(dirname(paths.page), { recursive: true });
  await writeFile(paths.page, html);
  await writeFile(paths.meta, JSON.stringify(meta, null, 2) + "\n");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Finds a page for this post in `assets/vendor/corpus/` and copies it into the
 * playground cache. The corpus is the same captured server render the network
 * would return, so this is a legitimate offline source, not a fixture.
 *
 * The id is checked by extracting the payloads, not by grepping the HTML: a
 * captured page embeds its payload as escaped JSON inside a JSON string
 * (`\"rest_id\":\"20\"`), so a plain substring test would never match. A file
 * named for the post is tried first; only when that misses is the corpus
 * scanned (54 pages, ~90 ms, and only on a cache miss).
 */
async function seedFromCorpus(id) {
  if (!existsSync(CORPUS)) return false;
  const files = readdirSync(CORPUS).filter((f) => f.endsWith(".html"));
  const named = files.filter((f) => f === `${id}.html` || f.endsWith(`-${id}.html`));
  const ordered = [...named, ...files.filter((f) => !named.includes(f))];
  for (const file of ordered) {
    const html = await readFile(join(CORPUS, file), "utf8");
    if (!extractTweets(html).some((t) => String(t.rest_id) === id)) continue;
    const meta = {
      url: canonicalUrl(id),
      seededFrom: relative(ROOT, join(CORPUS, file)),
      id,
      fetchedAt: upstream().fetchedAt ?? new Date().toISOString(),
      appVersion: html.match(/"appVersion":"([0-9a-f]+)"/)?.[1] ?? null,
      bytes: html.length,
    };
    await savePage(cachePaths(id), html, meta);
    return true;
  }
  return false;
}

/** Reads a cached page without converting it (the `/api/source/:id` route). */
export async function cachedPage(id) {
  const paths = cachePaths(id);
  if (!existsSync(paths.page)) return null;
  return readFile(paths.page, "utf8");
}

// ---------------------------------------------------------------------------
// Network, throttled
// ---------------------------------------------------------------------------

let lastRequestAt = 0;

async function throttledFetch(url, { accept = "*/*" } = {}) {
  const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  return fetch(url, {
    headers: {
      "user-agent": UA,
      accept,
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
    },
    redirect: "follow",
  });
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * Inlines the page's image bytes: the post's images, its author's avatar, and
 * the same for the quoted post.
 *
 * Only images. A video's poster frame would make the preview look like a still
 * of a video X draws with a play button, so videos keep their placeholder (and
 * the model has no poster field). Card images are not recoverable from a
 * logged-out capture at all: the card's metadata lives in a binding the page
 * does not embed (docs/E2E.md).
 */
/**
 * Fills every image slot from the payload's own URLs (`lib/media.mjs`), and
 * returns the URL → file map for the response's `source.media`.
 */
async function inlineMedia(post, tweet, { warnings, options, signal }) {
  const { map, stats } = await inlinePostMedia(post, tweet, {
    width: options?.width ?? 600,
    dpr: options?.dpr ?? 2,
    media: true,
    warnings,
    signal,
  });
  return { map, stats };
}
