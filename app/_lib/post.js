// The Post on the wire (crates/xeet-core/src/model.rs, camelCase), the text
// mechanics the composer needs, and the cleaner that keeps a draft inside the
// renderer's strict schema (unknown fields are an error, not a note).

const STATUS =
  String.raw`https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}\/status(?:es)?\/\d+|i\/(?:web\/)?status\/\d+)`;
const STATUS_ANY = new RegExp(STATUS, "i");
const STATUS_FULL = new RegExp(`${STATUS}(?:\\/(?:video|photo)\\/\\d+)?`, "i");
const STATUS_EXACT = new RegExp(`^${STATUS}\\/?$`, "i");
const STATUS_PREFIX = new RegExp(`^${STATUS}(?:[/?#].*)?$`, "i");
const STATUS_MEDIA = new RegExp(`^${STATUS}\\/(?:video|photo)\\/\\d+\\/?$`, "i");
const MEDIA_URL = /^https?:\/\/(?:video|pbs)\.twimg\.com\//i;
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;

/** The URL text, without the punctuation a sentence leaves behind. */
export function urlsInText(text) {
  const found = String(text ?? "").match(URL_IN_TEXT) ?? [];
  return [...new Set(found.map((url) => url.replace(/[),.;:!?]+$/, "")))];
}

/** The first x.com post URL in the text, if there is one. */
export function statusUrlInText(text) {
  const match = STATUS_ANY.exec(String(text ?? ""));
  return match ? match[0].replace(/\/$/, "") : null;
}

/** The post URL the text ends on (the one X turns into a quote). */
export function trailingStatusUrl(text) {
  const source = String(text ?? "");
  const urls = [...source.matchAll(new RegExp(URL_IN_TEXT.source, "g"))];
  if (!urls.length) return null;
  const last = urls[urls.length - 1];
  const url = last[0].replace(/[),.;:!?]+$/, "");
  if (!/^\s*$/.test(source.slice(last.index + last[0].length))) return null;
  return STATUS_EXACT.test(url) ? url.replace(/\/$/, "") : null;
}

export function isStatusUrl(url) {
  return STATUS_PREFIX.test(String(url ?? ""));
}

export function isMediaStatusUrl(url) {
  return STATUS_MEDIA.test(String(url ?? ""));
}

/** `…/status/1` → `…/status/1/video/1`; an existing variant is left alone. */
export function videoVariant(url) {
  const clean = String(url ?? "").replace(/\/$/, "");
  return /\/(?:video|photo)\/\d+$/i.test(clean) ? clean : `${clean}/video/1`;
}

export function statusHandle(url) {
  return /\.com\/([A-Za-z0-9_]+)\/status/i.exec(String(url ?? ""))?.[1] ?? "";
}

/** text | json | url — what the paste box holds, decided without the server. */
export function classify(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return "text";
  if (trimmed[0] === "{" || trimmed[0] === "[") return "json";
  if (STATUS_PREFIX.test(trimmed)) return "url";
  return "text";
}

// ---------------------------------------------------------------------------
// X's weighted length, locally. The report is the source of truth once a render
// lands; this keeps the ring honest while typing. URLs count 23; wide and emoji
// code points count 2; marks that attach to a previous character count 0.

function isWide(cp) {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f000 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  );
}

function isMark(cp) {
  return cp === 0x200d || cp === 0xfe0e || cp === 0xfe0f || (cp >= 0x0300 && cp <= 0x036f);
}

function weigh(text) {
  let n = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (isMark(cp)) continue;
    n += isWide(cp) ? 2 : 1;
  }
  return n;
}

export function weightedLength(text) {
  const source = String(text ?? "");
  let total = 0;
  let cursor = 0;
  for (const match of source.matchAll(URL_IN_TEXT)) {
    total += weigh(source.slice(cursor, match.index));
    total += 23;
    cursor = match.index + match[0].length;
  }
  return total + weigh(source.slice(cursor));
}

// ---------------------------------------------------------------------------
// Cleaning. Only the fields the renderer knows survive; empty strings are
// dropped so a draft never carries `"title": ""` into a strict validator.

const str = (value) => (typeof value === "string" && value.length ? value : undefined);
const posInt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};

export function cleanAuthor(author) {
  if (!author || typeof author !== "object") return undefined;
  const out = {};
  if (str(author.name)) out.name = author.name;
  if (str(author.handle)) out.handle = String(author.handle).replace(/^@/, "");
  if (["blue", "business", "government"].includes(author.verified)) out.verified = author.verified;
  else if (author.verified === "none") out.verified = "none";
  if (str(author.avatar)) out.avatar = author.avatar;
  if (author.squareAvatar) out.squareAvatar = true;
  if (author.protected) out.protected = true;
  if (author.affiliate && (str(author.affiliate.name) || str(author.affiliate.badge))) {
    out.affiliate = {};
    if (str(author.affiliate.name)) out.affiliate.name = author.affiliate.name;
    if (str(author.affiliate.badge)) out.affiliate.badge = author.affiliate.badge;
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanMedia(media) {
  return [].concat(media ?? []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const out = {
      kind: item.kind === "gif" || item.kind === "video" ? item.kind : "image",
      width: posInt(item.width) ?? 0,
      height: posInt(item.height) ?? 0,
    };
    if (!out.width || !out.height) return [];
    if (str(item.alt)) out.alt = item.alt;
    if (str(item.data)) out.data = item.data;
    const duration = Number(item.duration);
    if (Number.isFinite(duration) && duration > 0) out.duration = duration;
    const source = cleanAuthor(item.sourceAuthor);
    if (source) out.sourceAuthor = source;
    return [out];
  });
}

function cleanLink(meta) {
  if (!meta || typeof meta !== "object") return null;
  const out = {};
  if (str(meta.card)) out.card = meta.card;
  if (str(meta.title)) out.title = meta.title;
  if (str(meta.description)) out.description = meta.description;
  if (str(meta.domain)) out.domain = meta.domain;
  if (str(meta.display)) out.display = meta.display;
  if (meta.image && (posInt(meta.image.width) || posInt(meta.image.height))) {
    out.image = { width: posInt(meta.image.width) ?? 0, height: posInt(meta.image.height) ?? 0 };
    if (str(meta.image.data)) out.image.data = meta.image.data;
  }
  return Object.keys(out).length ? out : null;
}

export function cleanLinks(links) {
  if (!links || typeof links !== "object") return undefined;
  const out = {};
  for (const [url, meta] of Object.entries(links)) {
    const cleaned = cleanLink(meta);
    if (cleaned) out[url] = cleaned;
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanPoll(poll) {
  if (!poll || typeof poll !== "object") return null;
  const choices = [].concat(poll.choices ?? []).map((c) => String(c ?? "").trim()).filter(Boolean);
  if (choices.length < 2) return null;
  const out = { choices };
  const votes = [].concat(poll.votes ?? []).map((v) => Math.max(0, Math.round(Number(v) || 0)));
  if (votes.length === choices.length && votes.some((v) => v > 0)) out.votes = votes;
  const secondsLeft = Number(poll.secondsLeft);
  if (Number.isFinite(secondsLeft) && secondsLeft > 0) out.secondsLeft = Math.round(secondsLeft);
  return out;
}

function cleanCounts(counts) {
  if (!counts || typeof counts !== "object") return undefined;
  const out = {};
  for (const key of ["replies", "reposts", "likes", "views", "bookmarks"]) {
    const n = Number(counts[key]);
    if (Number.isFinite(n) && n > 0) out[key] = Math.round(n);
  }
  return Object.keys(out).length ? out : undefined;
}

/** A quoted post, cleaned like the top-level one, two levels deep at most. */
export function cleanQuote(raw, depth = 0) {
  if (!raw || typeof raw !== "object") return null;
  const out = { text: String(raw.text ?? "") };
  const author = cleanAuthor(raw.author);
  if (author) out.author = author;
  const media = cleanMedia(raw.media);
  if (media.length) out.media = media;
  const links = cleanLinks(raw.links);
  if (links) out.links = links;
  if (raw.entityLabels && typeof raw.entityLabels === "object" && Object.keys(raw.entityLabels).length) {
    out.entityLabels = { ...raw.entityLabels };
  }
  if (Array.isArray(raw.mediaTags) && raw.mediaTags.length) out.mediaTags = [...raw.mediaTags];
  if (str(raw.createdAt)) out.createdAt = raw.createdAt;
  if (str(raw.now)) out.now = raw.now;
  const counts = cleanCounts(raw.counts);
  if (counts) out.counts = counts;
  const poll = cleanPoll(raw.poll);
  if (poll) out.poll = poll;
  if (raw.cardState === "dismissed") out.cardState = "dismissed";
  if (str(raw.socialContext)) out.socialContext = raw.socialContext;
  if (typeof raw.longPost === "boolean") out.longPost = raw.longPost;
  if (str(raw.longPostBody)) out.longPostBody = raw.longPostBody;
  if (str(raw.appVersion)) out.appVersion = raw.appVersion;
  if (str(raw.replyTo)) out.replyTo = raw.replyTo;
  if (str(raw.replyToHandle)) out.replyToHandle = raw.replyToHandle;
  if (depth + 1 < 2 && raw.quote) {
    const nested = cleanQuote(raw.quote, depth + 1);
    if (nested) out.quote = nested;
  }
  return out;
}

/** The renderer-safe form of any Post. */
export function cleanPost(raw) {
  const out = { text: String(raw?.text ?? "") };
  const author = cleanAuthor(raw?.author);
  if (author) out.author = author;
  const media = cleanMedia(raw?.media);
  if (media.length) out.media = media;
  const links = cleanLinks(raw?.links);
  if (links) out.links = links;
  if (raw?.entityLabels && typeof raw.entityLabels === "object" && Object.keys(raw.entityLabels).length) {
    out.entityLabels = { ...raw.entityLabels };
  }
  if (raw?.cardState === "dismissed") out.cardState = "dismissed";
  if (raw?.quote) {
    const quote = cleanQuote(raw.quote);
    if (quote) out.quote = quote;
  }
  const poll = cleanPoll(raw?.poll);
  if (poll) out.poll = poll;
  if (str(raw?.createdAt)) out.createdAt = raw.createdAt;
  if (str(raw?.now)) out.now = raw.now;
  const counts = cleanCounts(raw?.counts);
  if (counts) out.counts = counts;
  if (typeof raw?.longPost === "boolean") out.longPost = raw.longPost;
  if (str(raw?.longPostBody)) out.longPostBody = raw.longPostBody;
  if (str(raw?.appVersion)) out.appVersion = raw.appVersion;
  if (str(raw?.replyTo)) out.replyTo = raw.replyTo;
  if (str(raw?.replyToHandle)) out.replyToHandle = raw.replyToHandle;
  if (str(raw?.socialContext)) out.socialContext = raw.socialContext;
  if (Array.isArray(raw?.mediaTags) && raw.mediaTags.length) {
    out.mediaTags = raw.mediaTags.map((tag) => String(tag).trim()).filter(Boolean);
  }
  return out;
}

/** Remove the first x.com status URL from the body (quote mode). */
export function withoutStatusUrl(text) {
  return String(text ?? "")
    .replace(STATUS_FULL, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}$/, "\n\n")
    .trimEnd();
}

/** The body a mode implies, before any resolution. */
export function bodyForMode(text, statusUrl, mode) {
  if (!statusUrl || !mode) return String(text ?? "");
  if (mode === "quote") return withoutStatusUrl(text);
  if (mode === "video") {
    return String(text ?? "").replace(STATUS_FULL, (found) => videoVariant(found));
  }
  return String(text ?? "");
}

/**
 * The draft → Post. `resolved` carries what the network added: `quote`,
 * `media`, `links`. Everything here is synchronous and deterministic.
 */
export function composePost(draft, resolved = {}) {
  const statusUrl = draft.statusUrl ?? null;
  const mode = draft.mode ?? null;
  const body = bodyForMode(draft.text ?? "", statusUrl, mode);
  const post = { text: body };

  const author = cleanAuthor(draft.author);
  if (author) post.author = author;

  if (draft.createdAt) post.createdAt = draft.createdAt;
  if (draft.now) post.now = draft.now;
  const counts = cleanCounts(draft.counts);
  if (counts) post.counts = counts;

  const draftLinks = cleanLinks(draft.links) ?? {};
  const liveLinks = cleanLinks(resolved.links) ?? {};
  const links = { ...draftLinks };
  for (const [url, meta] of Object.entries(liveLinks)) {
    const base = draftLinks[url];
    if (!base) {
      links[url] = meta;
    } else if (meta.card) {
      links[url] = { ...base, ...meta, image: meta.image?.data ? meta.image : (meta.image ?? base.image) };
    } else {
      links[url] = { ...meta, ...base, ...(meta.display ? { display: meta.display } : {}) };
    }
  }
  if (Object.keys(links).length) post.links = links;

  if (resolved.author?.avatar && post.author && !post.author.avatar) {
    post.author.avatar = resolved.author.avatar;
  }

  if (mode === "quote" && resolved.quote) {
    const quote = cleanQuote(resolved.quote);
    if (quote) post.quote = quote;
  }

  if (mode === "video" && resolved.media) {
    const media = cleanMedia([resolved.media]);
    if (media.length) post.media = media;
  } else if (draft.media) {
    const media = cleanMedia(draft.media);
    if (media.length) post.media = media;
  }

  const poll = cleanPoll(draft.poll);
  if (poll) post.poll = poll;

  if (draft.cardDismissed) post.cardState = "dismissed";
  if (draft.replyToHandle) {
    post.replyTo = "1";
    post.replyToHandle = String(draft.replyToHandle).replace(/^@/, "");
  }
  return cleanPost(post);
}

/** Does this Post have a card that a `Card ×` could dismiss? */
export function hasCard(post) {
  return Object.values(post?.links ?? {}).some((meta) => typeof meta?.card === "string" && meta.card.length > 0);
}

/** URL → card metadata, in the shape /resolve returns. */
export function cardLinks(post) {
  return Object.entries(post?.links ?? {}).filter(([, meta]) => meta?.card);
}
