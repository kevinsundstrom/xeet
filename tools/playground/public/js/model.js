// The Post model on the wire (crates/xeet-core/src/model.rs, camelCase) and
// the merge between what the input resolved to and what the details drawer
// overrode. The renderer is strict about extra fields, so everything here
// drops empty strings instead of sending them.

import { deepClone } from "./util.js";

const X_URL =
  /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}\/status(?:es)?\/\d+|i\/(?:web\/)?status\/\d+)(?:[?#][^\s]*)?$/i;

export const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;

/** text | json | url — what the paste box holds, decided without the server. */
export function classify(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return "text";
  if (trimmed[0] === "{" || trimmed[0] === "[") return "json";
  if (X_URL.test(trimmed)) return "url";
  return "text";
}

/** URLs written in the text, without trailing punctuation. */
export function urlsInText(text) {
  const found = String(text ?? "").match(URL_IN_TEXT) ?? [];
  return [...new Set(found.map((u) => u.replace(/[),.;:!?]+$/, "")))];
}

const str = (v) => (typeof v === "string" && v.length ? v : undefined);
const posInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};

function cleanMedia(media) {
  return [].concat(media ?? []).map((m) => {
    const out = {
      kind: m?.kind === "gif" || m?.kind === "video" ? m.kind : "image",
      width: posInt(m?.width) ?? 0,
      height: posInt(m?.height) ?? 0,
    };
    if (str(m?.alt)) out.alt = m.alt;
    if (str(m?.data)) out.data = m.data;
    if (Number.isFinite(Number(m?.duration)) && Number(m?.duration) > 0) out.duration = Number(m.duration);
    // Media lifted out of another post keeps its attribution: X credits the
    // original author on the video pill instead of quoting the post.
    const source = cleanAuthor(m?.sourceAuthor);
    if (source) out.sourceAuthor = source;
    return out;
  });
}

function cleanLink(meta) {
  if (!meta || typeof meta !== "object") return null;
  const out = {};
  if (typeof meta.card === "string" && meta.card.length) out.card = meta.card;
  if (str(meta.title)) out.title = meta.title;
  if (str(meta.description)) out.description = meta.description;
  if (str(meta.domain)) out.domain = meta.domain;
  if (str(meta.display)) out.display = meta.display;
  if (meta.image && (posInt(meta.image.width) || posInt(meta.image.height) || str(meta.image.data))) {
    out.image = { width: posInt(meta.image.width) ?? 0, height: posInt(meta.image.height) ?? 0 };
    if (str(meta.image.data)) out.image.data = meta.image.data;
  }
  // No card type means "this page has no valid card", which is what the
  // renderer needs to know; keep the entry only when there is something to say.
  return Object.keys(out).length ? out : null;
}

function cleanAuthor(author) {
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

function cleanPoll(poll) {
  if (!poll) return null;
  const choices = [].concat(poll.choices ?? []).map((c) => String(c ?? "").trim()).filter(Boolean);
  if (choices.length < 2) return null;
  const out = { choices };
  const votes = [].concat(poll.votes ?? []).map((v) => Math.max(0, Math.round(Number(v) || 0)));
  if (votes.length === choices.length && votes.some((v) => v > 0)) out.votes = votes;
  const left = Number(poll.secondsLeft);
  if (Number.isFinite(left) && left > 0) out.secondsLeft = Math.round(left);
  return out;
}

function cleanCounts(counts) {
  if (!counts) return undefined;
  const out = {};
  for (const key of ["replies", "reposts", "likes", "views", "bookmarks"]) {
    const n = Number(counts[key]);
    if (Number.isFinite(n) && n > 0) out[key] = Math.round(n);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * A quoted post, cleaned the same way as the top-level post. Quotes are being
 * extended to two levels (`post.quote.quote`), and every field the model has
 * must survive a round trip through the drawer's overrides.
 */
function cleanQuotePost(raw, depth = 0) {
  if (!raw || typeof raw !== "object") return null;
  const out = { text: String(raw.text ?? "") };
  const author = cleanAuthor(raw.author);
  if (author) out.author = author;
  if (Array.isArray(raw.media)) out.media = cleanMedia(raw.media);
  if (raw.links && typeof raw.links === "object") {
    const links = {};
    for (const [url, meta] of Object.entries(raw.links)) {
      const cleaned = cleanLink(meta);
      // A link with no card still matters on a quote: it carries the display form.
      if (cleaned) links[url] = cleaned;
    }
    if (Object.keys(links).length) out.links = links;
  }
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
  if (raw.socialContext) out.socialContext = raw.socialContext;
  if (typeof raw.longPost === "boolean") out.longPost = raw.longPost;
  if (str(raw.longPostBody)) out.longPostBody = raw.longPostBody;
  if (str(raw.appVersion)) out.appVersion = raw.appVersion;
  if (str(raw.replyTo)) out.replyTo = raw.replyTo;
  if (str(raw.replyToHandle)) out.replyToHandle = raw.replyToHandle;
  // Two levels: the quoted post, and the post it quotes.
  if (depth + 1 < 2 && raw.quote) {
    const nested = cleanQuotePost(raw.quote, depth + 1);
    if (nested) out.quote = nested;
  }
  return out;
}

/**
 * The post to render: the resolved base with the drawer's overrides on top.
 * A section is an override only when its key is present in `patch`.
 */
export function composePost(base, patch = {}) {
  const post = { text: "" };
  if (base && typeof base === "object") Object.assign(post, deepClone(base));
  if (!Array.isArray(post.media)) post.media = [];

  const author = cleanAuthor(patch.author);
  if (author) post.author = author;

  const counts = cleanCounts(patch.counts);
  if (counts) post.counts = counts;

  if ("createdAt" in patch) {
    if (str(patch.createdAt)) post.createdAt = patch.createdAt;
    else delete post.createdAt;
  }
  if ("now" in patch) {
    if (str(patch.now)) post.now = patch.now;
    else delete post.now;
  }

  if (Array.isArray(patch.media)) post.media = cleanMedia(patch.media);

  if (patch.links && typeof patch.links === "object") {
    const links = { ...(post.links ?? {}) };
    for (const [url, meta] of Object.entries(patch.links)) {
      const cleaned = cleanLink(meta);
      if (cleaned) links[url] = cleaned;
      else delete links[url];
    }
    post.links = links;
  }

  if ("quote" in patch) {
    if (patch.quote) {
      const quote = cleanQuotePost(patch.quote);
      if (quote) post.quote = quote;
      else delete post.quote;
    } else {
      delete post.quote;
    }
  }

  if ("poll" in patch) {
    const poll = cleanPoll(patch.poll);
    if (poll) post.poll = poll;
    else delete post.poll;
  }

  if ("cardState" in patch) {
    if (patch.cardState === "dismissed") post.cardState = "dismissed";
    else delete post.cardState;
  }
  if ("socialContext" in patch) {
    if (patch.socialContext) post.socialContext = patch.socialContext;
    else delete post.socialContext;
  }
  for (const key of ["replyTo", "replyToHandle", "appVersion", "longPostBody"]) {
    if (key in patch) {
      if (str(patch[key])) post[key] = patch[key];
      else delete post[key];
    }
  }
  if ("longPost" in patch) {
    if (patch.longPost === true || patch.longPost === false) post.longPost = patch.longPost;
    else delete post.longPost;
  }
  if ("mediaTags" in patch) {
    const tags = [].concat(patch.mediaTags ?? []).map((t) => String(t).trim()).filter(Boolean);
    if (tags.length) post.mediaTags = tags;
    else delete post.mediaTags;
  }
  if ("entityLabels" in patch) {
    if (patch.entityLabels && Object.keys(patch.entityLabels).length) post.entityLabels = patch.entityLabels;
    else delete post.entityLabels;
  }

  return post;
}

/** Media the renderer will refuse: more than four images, or video mixed with images. */
export function mediaProblem(media) {
  const list = [].concat(media ?? []);
  const videos = list.filter((m) => m.kind === "video" || m.kind === "gif");
  if (videos.length > 1) return "one video or GIF per post";
  if (videos.length === 1 && list.length > 1) return "a video or GIF cannot share the post with images";
  if (list.length > 4) return "at most four images";
  return null;
}

/** Short description of what was detected, for the chip under the paste box. */
export function describeInput(kind, post, source, error) {
  if (error) return error;
  if (kind === "url") {
    if (!source) return "resolving x.com link…";
    const handle = post?.author?.handle ? `@${post.author.handle}` : "post";
    const id = source.id ? ` · ${source.id}` : "";
    return `${handle}${id}${source.capturedAt ? " · captured " + source.capturedAt.slice(0, 10) : ""}`;
  }
  if (kind === "json") {
    if (!post) return "validating JSON…";
    const bits = [];
    if (post.media?.length) bits.push(`${post.media.length} media`);
    if (post.links && Object.keys(post.links).length) bits.push(`${Object.keys(post.links).length} link`);
    if (post.quote) bits.push("quote");
    if (post.poll) bits.push("poll");
    return bits.length ? "Post JSON · " + bits.join(" · ") : "Post JSON";
  }
  return post ? `${post.text.length} chars` : "";
}

/** The URL that keys page-mode renders, when the input came from a link. */
export function pageKey(source) {
  return source?.page ?? null;
}

/**
 * The core has no clock, so a post without times renders differently in every
 * target (Chrome stamps its own "now", the core prints "Now"). Give drafts one
 * instant for both `createdAt` and `now`; resolved posts keep what the payload
 * and the capture provided.
 */
export function withClock(post, at) {
  if (!at || Number.isNaN(Date.parse(at))) return post;
  if (!post.createdAt) post.createdAt = at;
  if (!post.now) post.now = at;
  return post;
}

/**
 * Turns a resolved post into drawer overrides, so a URL fills every section
 * the user may then tweak. Values are identical to the resolved post, so the
 * render does not change until something is edited.
 */
export function patchFromPost(post) {
  const patch = {};
  if (!post || typeof post !== "object") return patch;
  if (post.author && Object.keys(post.author).length) patch.author = deepClone(post.author);
  if (post.counts) patch.counts = deepClone(post.counts);
  if (post.createdAt) {
    patch.createdAt = post.createdAt;
    patch.now = post.now ?? new Date().toISOString();
  }
  if (post.media?.length) patch.media = deepClone(post.media);
  if (post.links && Object.keys(post.links).length) patch.links = deepClone(post.links);
  if (post.quote) patch.quote = deepClone(post.quote);
  if (post.poll) patch.poll = deepClone(post.poll);
  if (post.cardState) patch.cardState = post.cardState;
  if (post.socialContext) patch.socialContext = post.socialContext;
  if (typeof post.longPost === "boolean") patch.longPost = post.longPost;
  if (post.replyTo) patch.replyTo = post.replyTo;
  if (post.replyToHandle) patch.replyToHandle = post.replyToHandle;
  if (post.mediaTags?.length) patch.mediaTags = deepClone(post.mediaTags);
  if (post.appVersion) patch.appVersion = post.appVersion;
  return patch;
}
