// Link cards: what /api/resolve tells us about the URLs in a post.
//
// The server follows the redirect the way X's crawler does and answers, per
// URL, something like:
//
//   { meta: LinkMeta, chain: [...], finalUrl, tags: [...], notes: [...] }
//
// The chain's exact shape is the server's to pick, so this module normalizes
// the plausible spellings (string, array of strings, array of objects, array
// of pairs) into `{ url, status }` steps before the UI renders them.

import { urlsInText } from "./model.js";

// A bare link to a post. Anchored: `…/status/1/video/1` is a media link, not a
// quote, and only a link at the very end of the text becomes one.
const STATUS_URL =
  /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}\/status(?:es)?\/\d+|i\/(?:web\/)?status\/\d+)\/?$/i;
const STATUS_URL_ANYWHERE = /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}\/status(?:es)?\/\d+|i\/(?:web\/)?status\/\d+)\/?/i;
// X's own media links: a post's video/photo variant, or a twimg asset.
const MEDIA_URL =
  /^https?:\/\/(?:video|pbs)\.twimg\.com\//i;
const POST_MEDIA_URL =
  /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}\/status(?:es)?\/\d+|i\/(?:web\/)?status\/\d+)\/(?:video|photo)\/\d+\/?$/i;

/**
 * The status URL the post ends on, if any. X turns a post whose text ends in a
 * link to another post into a quote; the same URL mid-sentence is just a link,
 * so the position matters.
 */
export function trailingStatusUrl(text) {
  const source = String(text ?? "");
  const urls = [...source.matchAll(/https?:\/\/[^\s<>"']+/g)];
  if (!urls.length) return null;
  const last = urls[urls.length - 1];
  const raw = last[0];
  const url = raw.replace(/[),.;:!?]+$/, "");
  const end = last.index + raw.length - (raw.length - url.length);
  if (!/^\s*$/.test(source.slice(end))) return null;
  return STATUS_URL.test(url) ? url : null;
}

/** The post URL in the text, anywhere: what the quote/video modes act on. */
export function statusUrlInText(text) {
  const match = STATUS_URL_ANYWHERE.exec(String(text ?? ""));
  return match ? match[0].replace(/\/$/, "") : null;
}

/**
 * A media link in the text: `…/status/<id>/video/1`, `…/status/<id>/photo/1`,
 * or a direct `video.twimg.com` / `pbs.twimg.com` asset. X lifts these into
 * post media instead of showing a link.
 */
export function mediaUrlInText(text) {
  const urls = [...String(text ?? "").matchAll(/https?:\/\/[^\s<>"']+/g)].map((m) =>
    m[0].replace(/[),.;:!?]+$/, ""),
  );
  return urls.find((url) => POST_MEDIA_URL.test(url) || MEDIA_URL.test(url)) ?? null;
}

/** The "Post video" form of a post URL: X's own `/video/1` media variant. */
export function videoVariant(url) {
  const clean = String(url ?? "").replace(/\/$/, "");
  return /\/(?:video|photo)\/\d+$/i.test(clean) ? clean : `${clean}/video/1`;
}

/**
 * The key for "did the links change?". It is the set of URLs plus whether the
 * text ends on a status URL: typing after that URL turns a quote into a plain
 * link, so it must invalidate the cached answer.
 */
export function urlSetKey(text) {
  const urls = [...new Set(urlsInText(text))].sort().join("\n");
  const trailing = trailingStatusUrl(text);
  return trailing ? `${urls}\n[quote]${trailing}` : urls;
}

const stripScheme = (url) => String(url ?? "").replace(/^https?:\/\//, "");

function stepFrom(entry) {
  if (typeof entry === "string") {
    return { url: entry, status: null, text: entry };
  }
  if (Array.isArray(entry)) {
    const [a, b] = entry;
    return { url: typeof a === "string" ? a : null, status: Number.isFinite(Number(b)) ? Number(b) : null, text: null };
  }
  if (entry && typeof entry === "object") {
    const url = entry.url ?? entry.href ?? entry.location ?? entry.to ?? entry.target ?? null;
    const status = entry.status ?? entry.code ?? entry.statusCode ?? entry.response ?? null;
    return { url: typeof url === "string" ? url : null, status: Number.isFinite(Number(status)) ? Number(status) : null, text: null };
  }
  return null;
}

function normalizeChain(chain) {
  if (!chain) return [];
  if (typeof chain === "string") {
    // "t.co/x → 301 → vercel.com/y" or "t.co/x 301 vercel.com/y"
    return chain
      .split(/\s*(?:→|->|=>|\|)\s*/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const head = part.match(/^(\d{3})\s+(.*)$/) ?? part.match(/^(.*?)\s+(\d{3})$/);
        if (head && /^\d{3}$/.test(head[1])) return { url: head[2], status: Number(head[1]), text: null };
        if (head && /^\d{3}$/.test(head[2])) return { url: head[1], status: Number(head[2]), text: null };
        if (/^\d{3}$/.test(part)) return { url: null, status: Number(part), text: null };
        return { url: part, status: null, text: null };
      });
  }
  if (!Array.isArray(chain)) return [];
  return chain.map(stepFrom).filter(Boolean);
}

function normalizeTags(tags) {
  const short = (value) => {
    const text = String(value ?? "");
    return text.length > 70 ? text.slice(0, 69) + "…" : text;
  };
  if (!tags) return [];
  if (Array.isArray(tags)) {
    return tags
      .map((tag) => {
        if (typeof tag === "string") return short(tag);
        if (Array.isArray(tag)) return tag.length >= 2 ? `${tag[0]}: ${short(tag[1])}` : String(tag[0] ?? "");
        if (tag && typeof tag === "object") {
          if (typeof tag.tag === "string") return tag.content ? `${tag.tag}: ${short(tag.content)}` : tag.tag;
          if (typeof tag.name === "string") return tag.content ? `${tag.name}: ${short(tag.content)}` : tag.name;
          return Object.entries(tag)
            .map(([k, v]) => `${k}: ${short(v)}`)
            .join(" ");
        }
        return "";
      })
      .filter(Boolean)
      .slice(0, 8);
  }
  if (typeof tags === "object") {
    // A crawler's tag map: keep it to the head of the list, shortened.
    return Object.entries(tags)
      .slice(0, 8)
      .map(([k, v]) => `${k}: ${short(v)}`);
  }
  return [short(tags)];
}

function normalizeNotes(notes) {
  if (!notes) return [];
  if (Array.isArray(notes)) return notes.map((n) => (typeof n === "string" ? n : JSON.stringify(n))).filter(Boolean);
  if (typeof notes === "string") return [notes];
  return [];
}

/**
 * One entry of the resolver's `links` map → a flat shape the UI renders.
 * `info` may be the wrapper (`{meta, chain, …}`) or a bare LinkMeta.
 */
export function normalizeLinkInfo(url, info) {
  if (!info || typeof info !== "object") return null;
  const meta = info.meta && typeof info.meta === "object" ? info.meta : info;
  const chain = normalizeChain(info.chain ?? info.redirects ?? info.hops);
  const finalUrl =
    (typeof info.finalUrl === "string" && info.finalUrl) ||
    (typeof info.final === "string" && info.final) ||
    (chain.length ? [...chain].reverse().find((s) => s.url)?.url ?? null : null) ||
    url;
  const image = meta.image && typeof meta.image === "object" ? meta.image : null;
  return {
    url,
    finalUrl,
    chain,
    card: typeof meta.card === "string" ? meta.card : typeof info.card === "string" ? info.card : null,
    title: meta.title ?? null,
    description: meta.description ?? null,
    domain: meta.domain ?? null,
    image: image && (image.width || image.height) ? { width: image.width ?? 0, height: image.height ?? 0 } : null,
    tags: normalizeTags(info.tags ?? info.meta_tags ?? info.cardTags),
    notes: normalizeNotes(info.notes),
  };
}

/** "t.co/x → 301 → vercel.com/changelog/…" */
export function chainLabel(info, { max = 60 } = {}) {
  if (!info) return "";
  const steps = info.chain.length
    ? info.chain
    : [{ url: info.url, status: null }, { url: info.finalUrl, status: null }];
  const parts = [];
  let last = null;
  for (const step of steps) {
    if (step.url && step.url !== last) {
      const label = stripScheme(step.url);
      parts.push(label.length > max ? label.slice(0, max - 1) + "…" : label);
      last = step.url;
    }
    if (step.status && step.status >= 300 && step.status < 400) parts.push(String(step.status));
  }
  return parts.join(" → ");
}

/** Applies resolved link metadata under the user's drawer overrides. */
export function mergedLinks(base, resolved, patchLinks) {
  const links = { ...(base ?? {}) };
  for (const [url, info] of Object.entries(resolved ?? {})) {
    const meta = info?.meta ?? info;
    if (meta && typeof meta === "object") links[url] = meta;
  }
  for (const [url, meta] of Object.entries(patchLinks ?? {})) {
    if (meta && typeof meta === "object" && Object.keys(meta).length) links[url] = meta;
    else delete links[url];
  }
  return links;
}

export { stripScheme };
