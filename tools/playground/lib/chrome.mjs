// The playground's Chrome target: x.com's real markup, stylesheet and fonts in
// a warm headless Chrome. Development only; nothing here ships.
//
//   const chrome = await createChrome();
//   const shot = await chrome.render({ post, options, mode: "replica" });
//   await chrome.close();
//
// `shot` is
//
//   { png: Buffer, width, height, dpr,
//     geometry: { boxes, lines },
//     ms: { total, paint, fetch, load, layout, screenshot },
//     version: { chromium, upstream, harness, ruleset, decisions, smoothing },
//     notes: [] }
//
// ## Two modes
//
// **replica** (the default) renders *any* `model::Post`: it takes X's captured
// timeline/detail cell and attachment components (`chrome-markup.mjs`), injects
// the post's data, and lets Chrome lay it out with X's stylesheet and fonts.
// `options.width` is the viewport; the post column is `min(width, 600)`.
//
// **page** (`mode: "page"`, `source: { page, id }`) renders a *captured x.com
// page* hermetically, finds the post's own cell by its permalink, and crops it.
// This is the stronger truth (`tools/ship/e2e.mjs` does the same). It answers
// the same question in the same frame, so the two can be diffed — which is what
// `tools/playground/test/oracle-parity.mjs` does.
//
// ## The frame both modes return
//
// xeet's display list is the whole post cell: `min(width, 600)` wide including
// X's 16/12 padding, with no divider. Both modes therefore screenshot the cell
// (the padded element, not the `<article>` content box) and measure every box
// relative to it, with the computed corner radius alongside (`boxes.avatarShape`
// .radius is what tells a round avatar from a square one). Chrome's cell carries
// a 1px bottom divider that xeet never draws, so it is set to `0` before
// measuring (`docs/E2E.md`'s second decision is the same one from the other
// side: it compares `article.width + 32`).
//
// ## Decisions are xeet's, layout is Chrome's
//
// Only *layout and paint* are being compared, so the replica must make the same
// choices xeet makes — which body is displayed, which ranges are hidden, whether
// the long-post cut applies, which attachment is drawn — and then let Chrome
// draw it. Those choices come from xeet itself, in this order:
//
//   1. `report` passed by the caller (`/api/render` forwards the native target's
//      `explain` output, so Chrome sees exactly what the native column saw);
//   2. else the in-process wasm build (`packages/xeet/`, ~1 ms): the same
//      `xeet-core` rules the `http` target runs;
//   3. else a small JS fallback, which is *not* the rules engine: it renders the
//      text as the server payload has it, hides a reply's leading mentions and
//      picks the attachment in X's priority order. Its results are marked
//      `version.decisions = "fallback"` so a diff is never read as truth.
//
// `version.decisions` always says which one was used.
//
// ## Options
//
// `options` is `RenderOptions` (`surface`, `width`, `theme`, `dpr`,
// `fontScale`) plus one Chrome-only setting:
//
//   `smoothing: "antialiased" | "platform"` (default `"antialiased"`).
//   `antialiased` forces `-webkit-font-smoothing: antialiased`, the
//   platform-neutral rasterization the gates compare against (`docs/e2e-raster.md`
//   §1: macOS CoreText dilates glyphs 1.13x). `platform` leaves the page as the
//   browser draws it, which is what a Mac user sees on x.com. It changes ink
//   only, never metrics, so one warm page serves both settings and
//   `version.smoothing` reports which one a render used.
//
// ## Warmth, concurrency, failure
//
// One page per (surface, theme, dpr) stays open; the viewport width is set per
// render (X's stylesheet switches at 512/768/1024 px, so a width change is a
// media-query change, not a reload). Renders are serialized per page, and a
// *queued* render is dropped when a newer one for the same page arrives — the
// UI's debounced keystrokes never wait on a stale frame. A crashed or closed
// page is recreated and the render retried once.
//
// A superseded render rejects with an `Error` whose `code` is `"superseded"`;
// every other failure rejects with a message that names the stage.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { launch, newPage, setContentAs, ROOT, VENDOR } from "../../oracle/browser.mjs";
import { BLANK_PNG, createMediaStore } from "./chrome-media.mjs";
import {
  attachmentMarkup,
  avatarSrc,
  bodySpans,
  dataUri,
  formatCount,
  formatViewsCount,
  loadTemplates,
  nestedQuoteEligible,
  nestedQuoteMarkup,
  spansHtml,
  stampLabel,
  wellFormed,
  DEFAULT_AVATAR_URL,
} from "./chrome-markup.mjs";

/** The post column's maximum, both in xeet and on x.com. */
export const MAX_CELL_WIDTH = 600;

// The version stamp every result carries (`PLAN.md` §11: a golden is only valid
// for the harness, Chrome and upstream snapshot that produced it).
const HARNESS_FILES = ["chrome.mjs", "chrome-markup.mjs"];

async function harnessHash() {
  const h = createHash("sha256");
  for (const file of HARNESS_FILES) {
    h.update(await readFile(new URL(file, import.meta.url), "utf8"));
  }
  return h.digest("hex").slice(0, 8);
}

// ------------------------------------------------------------------- state --

class Superseded extends Error {
  constructor(what) {
    super(`${what} was superseded by a newer render`);
    this.code = "superseded";
  }
}

const CRASH = /Target closed|Page crashed|crash|Protocol error|Session closed|has been closed|Target page, context or browser|Browser closed/i;

/**
 * Font smoothing, as a *page* setting rather than a per-context one.
 *
 * `antialiased` forces `-webkit-font-smoothing: antialiased`, which is what the
 * gates compare against: macOS CoreText dilates glyphs 1.13x
 * (`docs/e2e-raster.md` §1), so the reference has to be the platform-neutral
 * rasterization. `platform` leaves the page as the browser would draw it, i.e.
 * what a Mac user sees on x.com. It never changes metrics, only rasterization,
 * so a warm page switches between the two in place.
 */
export const SMOOTHING = { antialiased: "antialiased", platform: "platform" };

/**
 * Removes one model field by the path a strict parser names it with — `quote.lastQuote`,
 * `media[0].sourceAuthor`. Used only when a stale rules binary refuses a post the
 * model already carries.
 */
function stripFieldPath(post, path) {
  const parts = [];
  for (const match of String(path).matchAll(/([A-Za-z0-9_$]+)|\[(\d+)\]/g)) parts.push(match[1] ?? Number(match[2]));
  if (!parts.length) return post;
  const clone = structuredClone(post);
  let node = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    node = node?.[parts[i]];
    if (node == null || typeof node !== "object") return clone;
  }
  if (node && typeof node === "object") delete node[parts[parts.length - 1]];
  return clone;
}

function normalizeOptions(options = {}) {
  const raw = String(options.surface ?? "web-timeline");
  const surface = raw === "detail" ? "web-detail" : raw === "timeline" ? "web-timeline" : raw;
  if (surface !== "web-timeline" && surface !== "web-detail") {
    throw new Error(`chrome: unknown surface ${JSON.stringify(options.surface)}`);
  }
  const width = Number(options.width ?? MAX_CELL_WIDTH);
  if (!(width > 0)) throw new Error(`chrome: width must be positive (got ${options.width})`);
  const smoothing = String(options.smoothing ?? SMOOTHING.antialiased);
  if (!Object.values(SMOOTHING).includes(smoothing)) {
    throw new Error(`chrome: unknown smoothing ${JSON.stringify(options.smoothing)}; use ${Object.values(SMOOTHING).join(" or ")}`);
  }
  return {
    surface,
    width,
    theme: options.theme === "dark" ? "dark" : "light",
    dpr: [1, 2, 3].includes(Number(options.dpr)) ? Number(options.dpr) : 2,
    fontScale: Number(options.fontScale ?? 1) || 1,
    smoothing,
  };
}

const cellWidthFor = (width) => Math.min(width, MAX_CELL_WIDTH);

// ----------------------------------------------------------------- in-page --

/**
 * Runs in the page. Waits until the cell's pictures can actually be drawn.
 *
 * Only the cell is waited for: a captured page has a dozen more posts' images,
 * and their `loading="lazy"` ones never even start below the fold — their
 * `decode()` never settles, which hung the whole render. Inside the cell every
 * `<img>` is switched to eager (so a tall cell's lower photo starts too) and
 * decoded, and a `<video poster>` — an attribute, not an `<img>` — is decoded
 * through a throwaway image. Returns what it waited for, for the caller's notes.
 */
function settleCell() {
  const cell = document.querySelector("[data-xeet-cell]") ?? document.getElementById("xeet-holder") ?? document;
  const images = [...cell.querySelectorAll("img")];
  // Only the ones that have not arrived: writing the attribute on a decoded
  // image is a DOM mutation the raster has to notice, and a warm render repeats
  // it for nothing.
  for (const img of images) if (!img.complete) img.loading = "eager";
  const posters = [...cell.querySelectorAll("video[poster]")].map((v) => v.poster).filter(Boolean);
  return Promise.all([
    ...images.map((img) => img.decode().then(() => null, () => null)),
    ...posters.map(async (src) => {
      const probe = new Image();
      probe.src = src;
      try {
        await probe.decode();
      } catch {
        /* a poster that cannot decode paints nothing, as on x.com */
      }
      return null;
    }),
  ]).then(() => ({ images: images.length, posters: posters.length }));
}


/**
 * Runs in the page. Prepares the warm replica document: X's SVG sprite stays
 * resolvable, everything else in the captured page is hidden (it costs layout
 * and contributes nothing), and a single holder carries the cell.
 *
 * The sprite is **moved**, not copied. X serves one zero-sized `<svg>` full of
 * `<symbol>`s, and the gold badge's gradient definitions live *inside* its
 * symbol (`<defs><linearGradient id="icon-verified-business-color_a">`,
 * referenced by `fill="url(#…)"`). Copying the symbols into a fresh container
 * left the originals — and the only `<defs>` — in the hidden part of the page
 * and duplicated every id, so `url(#…)` resolved to nothing and the business
 * badge painted just its solid inner check: a thin gold tick instead of the
 * scalloped badge. Premium and government checks are flat fills
 * (`#1d9bf0`, `#829aab`), which is why only the gold one looked wrong.
 */
function initReplica({ skel, frag }) {
  window.__xeet = { skel, frag };
  const sprite = [...document.querySelectorAll("svg")].find((s) => s.querySelector("symbol")) ?? null;
  if (sprite) {
    // X's own container: out of flow, zero-sized, clipped.
    sprite.removeAttribute("style");
    sprite.setAttribute("aria-hidden", "true");
    sprite.setAttribute("class", "absolute size-0 overflow-hidden");
    sprite.id = "xeet-sprite";
    document.body.appendChild(sprite);
  }
  document.getElementById("xeet-holder")?.remove();
  const holder = document.createElement("div");
  holder.id = "xeet-holder";
  holder.style.cssText = "position:absolute;left:0;top:0;background:var(--x-bg-primary,#fff)";
  document.body.appendChild(holder);
  for (const child of [...document.body.children]) {
    if (child !== holder && child !== sprite) child.style.display = "none";
  }
  void document.body.offsetHeight;
  return { symbols: sprite ? sprite.querySelectorAll("symbol").length : 0, stylesheet: [...document.styleSheets].length };
}

/**
 * Runs in the page. Turns the forced glyph smoothing on or off for the next
 * layout. `-webkit-font-smoothing` changes rasterization only, never metrics, so
 * one warm page serves both settings.
 */
function applySmoothing({ antialiased }) {
  let style = document.getElementById("xeet-smoothing");
  if (!antialiased) {
    style?.remove();
    return { antialiased: false };
  }
  if (!style) {
    style = document.createElement("style");
    style.id = "xeet-smoothing";
    style.textContent = "*{-webkit-font-smoothing:antialiased!important}";
    document.head.appendChild(style);
  }
  return { antialiased: true };
}

/**
 * Runs in the page. Rebuilds the cell from the captured skeleton, injects the
 * post's data, and returns nothing (measurement is a separate call so the
 * caller can time them apart). Every selector is the same one the oracle's
 * `replica.mjs` uses, and a miss throws: a replica that silently skipped a
 * component would be a wrong answer that looks like a right one.
 */
function applyPlan(plan) {
  const T = window.__xeet;
  const holder = document.getElementById("xeet-holder");
  if (!T || !holder) throw new Error("chrome: replica page is not initialised");
  const miss = (what) => {
    throw new Error(`chrome: ${what} not found in the ${plan.surface} skeleton`);
  };
  const q = (root, sel, what) => root.querySelector(sel) ?? miss(what || sel);

  holder.style.width = `${plan.cellWidth}px`;
  if (plan.fontScale !== 1) {
    holder.style.setProperty("--x-font-scale", String(plan.fontScale));
    holder.style.fontSize = `${15 * plan.fontScale}px`;
  } else {
    holder.style.removeProperty("--x-font-scale");
    holder.style.removeProperty("font-size");
  }
  const skeleton = T.skel[plan.surface];
  if (!skeleton) miss(`${plan.surface} skeleton`);
  holder.innerHTML = skeleton;
  const cell = holder.firstElementChild ?? miss("cell element");
  cell.style.borderBottom = "0";
  const article = q(cell, "article", "article");

  // The context row goes first, as the article's leading child, so the
  // article's own gap spaces it from the post.
  if (plan.pinned && T.frag.socialRow) article.insertAdjacentHTML("afterbegin", T.frag.socialRow);

  // The avatar: the post's bytes when it has them, X's own default profile
  // image when it does not (`assets/vendor/default-avatar.png`, served at a
  // stable URL), and the *model's* shape — `squareAvatar` — never the shape the
  // captured skeleton happened to carry, which would make a round-avatar account
  // square just because the template came from a business account.
  const avatarImg = q(article, "[data-post-avatar] img", "avatar");
  avatarImg.setAttribute("src", plan.avatar);
  // A captured avatar carries a `srcset`, and `srcset` wins over `src`: the
  // stubbed URL would fail and leave the box empty.
  avatarImg.removeAttribute("srcset");
  const avatarShape = q(article, ".x-avatar", "avatar shape");
  avatarShape.className = avatarShape.className.replace(/rounded-\[10%\]|rounded-full/g, "");
  avatarShape.classList.add(plan.squareAvatar ? "rounded-[10%]" : "rounded-full");
  q(article, ".line-clamp-1.break-all", "name").textContent = plan.name;
  q(article, ".line-clamp-1.wrap-break-word", "handle").textContent = `@${plan.handle}`;

  // Verified badge: the sprite symbol, or the whole `gap-1` wrapper dropped so
  // the name keeps no leftover 4px gap (X only renders that wrapper when it has
  // something in it).
  const badge = article.querySelector('span[aria-label="Verified account"]');
  if (badge) {
    if (!plan.badge) (badge.closest("div.flex.shrink-0.items-center.gap-1") ?? badge).remove();
    else q(badge, "use").setAttribute("href", plan.badge);
  }

  // Affiliation square: a second `size-[1em]` image after the check.
  const affiliateAnchors = article.querySelectorAll("a[aria-label]:has(> img)");
  for (const a of affiliateAnchors) {
    if (!plan.affiliate) {
      a.remove();
      continue;
    }
    const img = q(a, "img");
    img.setAttribute("src", plan.affiliate.src);
    img.setAttribute("alt", plan.affiliate.name);
    a.setAttribute("aria-label", plan.affiliate.name);
  }
  if (plan.affiliate && !article.querySelector("a[aria-label]:has(> img)") && T.frag.affiliate) {
    const wrapper =
      article.querySelector("div.flex.shrink-0.items-center.gap-1") ?? article.querySelector(".items-center.gap-1")?.closest("div");
    if (wrapper) {
      const holderEl = document.createElement("a");
      holderEl.innerHTML = T.frag.affiliate;
      const anchor = holderEl.firstElementChild;
      if (anchor) {
        q(anchor, "img").setAttribute("src", plan.affiliate.src);
        q(anchor, "img").setAttribute("alt", plan.affiliate.name);
        anchor.setAttribute("aria-label", plan.affiliate.name);
        wrapper.appendChild(anchor);
      }
    }
  }

  // Timestamps: the captured cell carries the anchor plus the client's
  // formatting `<script>`; both go, the label stays.
  //
  // The detail view's row is `stamp · <views anchor>`, and both anchors wear
  // `data-base-ui-tooltip-trigger`, so only the header's own anchor (the one in
  // the timestamp's `inline-flex w-fit` span) takes the stamp.
  const stampRows = article.querySelectorAll("span.inline-flex.w-fit");
  let stamped = false;
  for (const row of stampRows) {
    const a = row.querySelector("a");
    if (!a || !a.hasAttribute("data-base-ui-tooltip-trigger")) continue;
    if (plan.stamp != null) a.textContent = plan.stamp;
    a.removeAttribute("data-base-ui-tooltip-trigger");
    stamped = true;
    break;
  }
  if (!stamped) {
    const a = article.querySelector("a[data-base-ui-tooltip-trigger]");
    if (a) {
      if (plan.stamp != null) a.textContent = plan.stamp;
      a.removeAttribute("data-base-ui-tooltip-trigger");
    }
  }
  for (const s of article.querySelectorAll("script")) s.remove();

  // The detail view's `N Views`: the captured post page has the element, an
  // anchor holding the bold count and the word `Views`. Without an impression
  // count the pair (and the separator before it) is dropped.
  if (plan.surface === "detail") {
    const row = article.querySelector(".text-secondary.flex.shrink");
    // The views anchor is the row's remaining tooltip trigger: the stamp's own
    // anchor lost the attribute just above.
    const views = row ? row.querySelector("a[data-base-ui-tooltip-trigger]") : null;
    if (views) {
      views.removeAttribute("data-base-ui-tooltip-trigger");
      const sep = views.previousElementSibling;
      if (plan.views == null) {
        views.remove();
        if (sep && sep.getAttribute("aria-hidden") === "true") sep.remove();
      } else {
        const [count] = String(plan.views).split(/\s*Views?$/);
        const strong = views.querySelector("div");
        if (strong) strong.textContent = count;
        else views.textContent = plan.views;
      }
    } else if (plan.views != null && row) {
      // A capture without the slot (this post had no impressions): clone the
      // row's own pieces, so the markup is X's, and keep the `·` separator
      // visible by appending after it.
      const span = document.createElement("span");
      span.className = "inline-flex w-fit";
      span.setAttribute("data-xeet-views", "");
      const inner = document.createElement("span");
      inner.className = "max-w-full text-body text-secondary";
      inner.textContent = plan.views;
      span.appendChild(inner);
      row.appendChild(span);
    }
  }

  // The body.
  const textDiv = q(article, "div.whitespace-pre-wrap[dir=auto]", "body text");
  textDiv.innerHTML = plan.bodyHtml;
  for (const c of [...textDiv.classList]) if (/^line-clamp-/.test(c)) textDiv.classList.remove(c);
  if (plan.clamp) textDiv.classList.add(`line-clamp-${plan.clamp}`);
  if (plan.showMore && T.frag.showMore) {
    if (!/(^|\s)$/.test(textDiv.textContent ?? "")) textDiv.appendChild(document.createTextNode(" "));
    textDiv.insertAdjacentHTML("beforeend", T.frag.showMore);
  }

  // Engagement counts: X omits the whole count wrapper when there is no number.
  const row = article.querySelector("[role=group]");
  if (row) {
    for (const btn of row.querySelectorAll("[data-engagement-action]")) {
      const kind = btn.getAttribute("data-engagement-action");
      const key = { reply: "replies", retweet: "reposts", like: "likes", generic: "views", bookmark: "bookmarks" }[kind];
      const num = btn.querySelector(".tabular-nums");
      if (!num) continue;
      const value = key ? plan.counts[key] : null;
      if (value == null || value === "") num.parentElement.remove();
      else q(num, ".x-animated-count-visual").textContent = value;
    }
    if (plan.countsAriaLabel) row.setAttribute("aria-label", plan.countsAriaLabel);
  }

  // The attachment slot, last: everything above selects inside the post's own
  // header, before any quoted markup exists in the DOM.
  const slot = [...article.querySelectorAll("div")].find((d) => String(d.className).includes("empty:hidden"));
  if (plan.attachmentHtml) {
    if (slot) slot.innerHTML = plan.attachmentHtml;
    else miss("attachment slot");
  } else if (slot) {
    slot.innerHTML = "";
  }
  if (!plan.attachmentHtml && !slot && plan.surface === "timeline") miss("attachment slot");
}

/**
 * Runs in the page. The cell's frame and named boxes, plus the body's line
 * boxes, all relative to the cell's border box on Chrome's 1/64 px grid.
 *
 * A line is a group of per-grapheme Range rects sharing a top edge (bidi means
 * a line's characters need not advance left to right), which is how the text
 * oracle groups them too.
 */
function measureCell({ selector, labels }) {
  const cell = document.querySelector(selector);
  if (!cell) return { error: `no ${selector}` };
  const round = (v) => Math.round(v * 64) / 64;
  const origin = cell.getBoundingClientRect();
  const cs = getComputedStyle(cell);
  const boxes = {};
  for (const [name, sel] of Object.entries(labels)) {
    const el = sel === ":scope" ? cell : cell.querySelector(sel);
    // `display: none` boxes report a 0×0 rect at the page origin, which is
    // meaningless as geometry: report absence instead.
    if (!el || getComputedStyle(el).display === "none") {
      boxes[name] = null;
      continue;
    }
    const r = el.getBoundingClientRect();
    // The corner radius is the one shape fact a box cannot show: it is what
    // distinguishes an account's round avatar from its square one.
    const cs = getComputedStyle(el);
    boxes[name] = {
      x: round(r.x - origin.x),
      y: round(r.y - origin.y),
      w: round(r.width),
      h: round(r.height),
      radius: cs.borderTopLeftRadius,
    };
  }
  const textEl = cell.querySelector(labels.text ?? "div.whitespace-pre-wrap[dir=auto]");
  const lines = [];
  if (textEl) {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
    const frags = [];
    let node;
    while ((node = walker.nextNode())) {
      for (const { segment, index } of seg.segment(node.textContent)) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + segment.length);
        const r = range.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        frags.push({ text: segment, x: r.x - origin.x, y: r.y - origin.y, w: r.width, h: r.height });
      }
    }
    for (const f of frags) {
      const line = lines.find((l) => Math.abs(l.y - f.y) < 0.5);
      if (line) {
        line.text += f.text;
        line.x = Math.min(line.x, f.x);
        line.right = Math.max(line.right, f.x + f.w);
        line.h = Math.max(line.h, f.h);
      } else {
        lines.push({ text: f.text, x: f.x, y: f.y, right: f.x + f.w, h: f.h });
      }
    }
  }
  return {
    frame: {
      width: round(origin.width),
      height: round(origin.height),
      x: round(origin.x),
      y: round(origin.y),
      padding: {
        top: parseFloat(cs.paddingTop),
        right: parseFloat(cs.paddingRight),
        bottom: parseFloat(cs.paddingBottom),
        left: parseFloat(cs.paddingLeft),
      },
      background: getComputedStyle(document.documentElement).backgroundColor,
    },
    boxes,
    // The labels the cell prints, for the UI's diff and for a harness that has
    // to reproduce the page's relative timestamp. The timestamp's wrapper also
    // holds the client's formatting `<script>`, so only its anchor is text.
    texts: {
      name: cell.querySelector(labels.name)?.textContent ?? null,
      handle: cell.querySelector(labels.handle)?.textContent ?? null,
      timestamp: cell.querySelector(`${labels.timestamp} a`)?.textContent ?? null,
      // A quoted post prints its own timestamp inside the card.
      quoteTimestamp: cell.querySelector("article article span.inline-flex.w-fit a")?.textContent ?? null,
    },
    lines: lines
      .sort((a, b) => a.y - b.y)
      .map((l) => ({ text: l.text, x: round(l.x), y: round(l.y), w: round(l.right - l.x), h: round(l.h) })),
  };
}

/** The named boxes every mode reports, so replica and page can be diffed. */
export const BOX_LABELS = {
  cell: ":scope",
  article: "article",
  pinnedRow: "article > div:first-child:has(svg[data-icon='icon-pin-fill'])",
  avatarColumn: ".relative.w-10.shrink-0",
  avatar: "[data-post-avatar]",
  avatarShape: ".x-avatar",
  contentColumn: ".min-w-0.flex-1.flex-col",
  nameBlock: "span.flex.items-center.gap-1",
  name: ".line-clamp-1.break-all",
  badge: 'span[aria-label="Verified account"]',
  affiliate: 'a[aria-label]:has(> img)',
  handle: ".line-clamp-1.wrap-break-word",
  more: 'button[aria-label="More"]',
  text: "div.whitespace-pre-wrap[dir=auto]",
  showMore: "div.whitespace-pre-wrap[dir=auto] > button",
  attachment: "div.empty\\:hidden",
  quoteCard: 'div[role="link"]',
  quoteArticle: "article article",
  quoteAvatar: "article article .x-avatar",
  quoteAvatarImage: "article article [data-post-avatar], article article .x-avatar img",
  actionRow: "[role=group]",
  reply: '[data-engagement-action="reply"]',
  like: '[data-engagement-action="like"]',
  views: '[data-engagement-action="generic"]',
  timestamp: "span.inline-flex.w-fit",
  // A nested quote preview: the same labels find it in the replica (where the
  // harness marks it) and on a captured page (where it is X's own markup).
  nestedQuote: "[data-xeet-nested], div[class*='-mx-1.5 -my-1']",
  nestedThumb: "[data-xeet-nested-thumb], div[class*='-mx-1.5 -my-1'] div.size-16",
  nestedStamp: "[data-xeet-nested-stamp], div[class*='-mx-1.5 -my-1'] span.inline-flex.w-fit a",
  nestedText: "[data-xeet-nested] div.line-clamp-2, div[class*='-mx-1.5 -my-1'] div.line-clamp-2",
  // "Post video" / "Post photo": the credit inside the media. The same label
  // finds it in the replica (marked) and on a captured page (X's own span).
  mediaSource: "[data-xeet-media-source], span.inline-flex.align-middle.ms-2",
};

// ------------------------------------------------------------- page finding --

/**
 * Runs in the page. Finds the post's *own* cell on a captured page.
 *
 * A status id appears in its own cell, in every cell that quotes it, and in the
 * occasional invisible overlay link. The pair key is the cell's own permalink:
 * the first status link in DOM order, of a top-level article, with text of its
 * own (the header timestamp). `docs/E2E.md`'s "pairing rule".
 */
function findOwnCell({ id }) {
  const ownIdOf = (article) => {
    const link = [...article.querySelectorAll('a[href*="/status/"]')].find(
      (x) => (x.closest("article") ?? article) === article && x.innerText.trim() !== "",
    );
    return link ? ((link.getAttribute("href") ?? "").match(/\/status\/(\d+)/)?.[1] ?? null) : null;
  };
  // A page is rendered for one post after another, so the previous post's mark
  // must go: two marked cells would leave `querySelector` returning the first.
  for (const el of document.querySelectorAll("[data-xeet-cell], [data-xeet-article]")) {
    el.removeAttribute("data-xeet-cell");
    el.removeAttribute("data-xeet-article");
  }
  const topLevel = [...document.querySelectorAll("article")].filter((a) => !a.parentElement?.closest("article"));
  const matches = topLevel.filter((a) => a.querySelector(`a[href*="/status/${id}"]`));
  const owning = matches.filter((a) => ownIdOf(a) === String(id));
  const article = owning.find((a) => a.getBoundingClientRect().width > 0) ?? owning[0] ?? null;
  if (!article) {
    if (matches.length) return { error: "nestedOnly", detail: "the post only appears as a quoted card on this page" };
    return { error: "notFound", detail: `no cell whose own permalink is /status/${id}` };
  }
  // The cell is the padded element around the article.
  let cell = article.parentElement;
  while (cell && !String(cell.className || "").includes("px-horizontal")) cell = cell.parentElement;
  cell = cell ?? article.parentElement ?? article;
  article.setAttribute("data-xeet-article", "");
  cell.setAttribute("data-xeet-cell", "");
  // Chrome's own divider is not part of xeet's display list.
  cell.style.setProperty("border-bottom-width", "0", "important");
  return { ok: true, measuredId: ownIdOf(article) };
}

/**
 * Runs in the page. Reveals the server render: X wraps the timeline list in
 * `display: none` until its client code runs, and the oracle blocks every
 * script. Called once when the page opens, so the first render does not have to
 * reveal *and* frame in the same pass (doing both at once left `main` at 0×0 on
 * the first cold pass, which measured as an empty cell).
 */
function revealPage() {
  for (const article of document.querySelectorAll("article")) {
    let el = article;
    while (el && el !== document.body) {
      if (getComputedStyle(el).display === "none") el.style.setProperty("display", "block", "important");
      el = el.parentElement;
    }
  }
  void document.body.offsetHeight;
  return { articles: document.querySelectorAll("article").length };
}

/**
 * Runs in the page. Frames a captured page so the post's cell *is* the frame:
 * it hides everything that is not on the cell's ancestor chain, forces the
 * column to the playground's width, and brings the cell to the frame origin
 * (the reveal itself happened when the page opened).
 *
 * All of it is the harness changing the page it compares against, not the
 * renderer: `docs/E2E.md` covers the reveal, and the rest is what makes page
 * mode answer in xeet's frame (`min(width, 600)` including the 16/12 padding)
 * instead of "a cell inside whatever the page's chrome left for the column".
 * Hiding the siblings matters for the *crop*: with X's 73 px nav rail still
 * laid out, a 600 px column overflows the document horizontally, and the
 * position of the cell then depends on the horizontal scroll — one run in ten
 * cropped the wrong region (a badge box that sampled background).
 */
function preparePage({ cellWidth }) {
  // Inlined, not a call to `revealPage`: playwright serialises this function's
  // source, so it cannot see module-level helpers.
  for (const article of document.querySelectorAll("article")) {
    let el = article;
    while (el && el !== document.body) {
      if (getComputedStyle(el).display === "none") el.style.setProperty("display", "block", "important");
      el = el.parentElement;
    }
  }
  const cell = document.querySelector("[data-xeet-cell]");
  if (!cell) return { error: "no cell" };
  // Undo the previous render's hiding: a page is reused for one post after
  // another, and hiding is destructive — a later post's cell is a *sibling* of
  // this one, so it would be hidden and measure 0 px wide.
  for (const el of window.__xeetHidden ?? []) el.style.removeProperty("display");
  window.__xeetHidden = [];
  // The cell's ancestors stay; their siblings (nav rail, sticky header, modals,
  // and the *other posts*) go. The SVG sprite must survive: a `<use>`d gradient
  // whose `<defs>` sit inside a `display: none` subtree stops resolving, and the
  // gold badge then paints only its solid inner check (the same failure as
  // copying the symbols instead of moving them — see `initReplica`).
  const isSprite = (el) => el.tagName.toLowerCase() === "svg" && el.querySelector("symbol, defs");
  for (let el = cell; el && el !== document.body; el = el.parentElement) {
    for (const sibling of el.parentElement.children) {
      if (sibling === el || isSprite(sibling)) continue;
      sibling.style.setProperty("display", "none", "important");
      window.__xeetHidden.push(sibling);
    }
  }
  // The cell's ancestors contribute no horizontal chrome of their own: a 1 px
  // divider between the nav and the main column, a container's padding. Left
  // alone, the cell lands at x=1 and its last column of pixels falls outside a
  // 600 px viewport — a crop that is silently one pixel short (or a screenshot
  // Playwright refuses). Only the *cell's own* 16 px padding is X's and stays.
  for (let el = cell.parentElement; el && el !== document.body; el = el.parentElement) {
    el.style.setProperty("border-left-width", "0", "important");
    el.style.setProperty("border-right-width", "0", "important");
    el.style.setProperty("padding-left", "0", "important");
    el.style.setProperty("padding-right", "0", "important");
    el.style.setProperty("margin-left", "0", "important");
    el.style.setProperty("margin-right", "0", "important");
  }
  let col = cell.parentElement;
  while (col && col !== document.body && !String(col.className || "").includes("x-timeline-max-width")) col = col.parentElement;
  col = col && col !== document.body ? col : cell.parentElement ?? cell;
  col.style.setProperty("width", `${cellWidth}px`, "important");
  col.style.setProperty("max-width", "none", "important");
  void document.body.offsetHeight;
  // No smooth scrolling anywhere on the way to the cell, then scroll at once.
  for (let el = cell; el; el = el.parentElement) el.style.setProperty("scroll-behavior", "auto", "important");
  for (const el of [document.documentElement, document.body]) el?.style.setProperty("scroll-behavior", "auto", "important");
  cell.scrollIntoView({ block: "start", inline: "start", behavior: "instant" });
  window.scrollTo({ top: window.scrollY, left: 0, behavior: "instant" });
  void document.body.offsetHeight;
  const r = cell.getBoundingClientRect();
  const result = {
    articles: document.querySelectorAll("article").length,
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewport: { width: innerWidth, height: innerHeight },
  };
  // The crop is only meaningful if the cell really starts at the frame origin.
  if (Math.abs(r.width - cellWidth) > 0.5 || r.x < -0.5 || r.x + r.width > innerWidth + 0.5) {
    return { ...result, error: "cell-not-framed", detail: `cell at x=${r.x} width=${r.width} in a ${innerWidth} px viewport, asked for width ${cellWidth}` };
  }
  return result;
}

/** True when the cell is taller than the viewport, so the viewport must grow. */
const needsTaller = (prepared) =>
  Boolean(prepared) && !prepared.error && prepared.height > prepared.viewport.height - 4;

// ---------------------------------------------------------------- the oracle --

/**
 * Starts the oracle: one Chrome, the captured templates, and the warm pages.
 * Call `close()` when done.
 *
 * `media` tunes how page mode fills its image boxes: `fetchOnMiss: false` makes
 * it cache-only (what an offline laptop gets), `offline` implies that too.
 */
export async function createChrome({ templates: given = null, timeoutMs = 20000, media: mediaOptions = {} } = {}) {
  const startedAt = Date.now();
  const browser = await launch();
  const harness = await harnessHash();
  const lock = JSON.parse(await readFile(join(ROOT, "assets", "upstream.lock.json"), "utf8"));
  const templates = given ?? (await loadTemplates(browser));
  const notes = [...(templates.notes ?? [])];
  const media = createMediaStore({
    offline: mediaOptions.offline ?? process.env.PLAYGROUND_OFFLINE === "1",
    fetchOnMiss: mediaOptions.fetchOnMiss ?? true,
    // A caller may point the store at its own cache directory (a test that
    // wants a cold one, without touching the shared `assets/vendor` cache).
    ...(mediaOptions.cacheDir ? { cacheDir: mediaOptions.cacheDir } : {}),
  });
  /** Whether a page render may fetch missing pictures for its cell (see `warmCellMedia`). */
  const warmMedia = mediaOptions.warm ?? true;

  // X's default profile image, for an author the post carries no bytes for.
  // Vendored by `tools/sync-upstream.mjs` and pinned in `upstream.lock.json`;
  // absent on a checkout that has not synced, in which case the replica says so
  // and draws the neutral stub instead.
  let defaultAvatar = null;
  try {
    defaultAvatar = await readFile(join(VENDOR, "default-avatar.png"));
  } catch {
    notes.push("assets/vendor/default-avatar.png is missing (run node tools/sync-upstream.mjs): an author without avatar bytes keeps a placeholder");
  }

  // The replica document is a captured page: it supplies the stylesheet link,
  // the sprite and the `html` attributes X's CSS keys on.
  const documentHtml = await readFile(join(VENDOR, "corpus", "jack-20.html"), "utf8");
  const options = { timeoutMs };
  const pages = new Map(); // key -> { promise, page, context, width }
  const queues = new Map(); // key -> { tail, pending }
  let closed = false;

  // ------------------------------------------------------------ decisions --
  //
  // The order is the contract's: the caller's report (the native target's own
  // `explain`, so Chrome sees what the native column saw), then a built
  // `xeet-render explain` (the current model, ~7 ms including process start),
  // then the in-process wasm build of `http`'s renderer, and only then the JS
  // approximation.
  let explainer = null; // { kind: "binary"|"wasm"|"none", binary?, engine?, error? }

  async function explainerLocal() {
    if (explainer) return explainer;
    const binary = findExplainBinary();
    if (binary) {
      explainer = { kind: "binary", binary };
      return explainer;
    }
    try {
      const { loadXeet } = await import("../../../packages/xeet/src/node.js");
      explainer = { kind: "wasm", engine: await loadXeet() };
    } catch (error) {
      explainer = { kind: "none", error: String(error.message ?? error).split("\n")[0] };
      notes.push(`no xeet explain source (${explainer.error}); decisions fall back to the JS approximation`);
    }
    return explainer;
  }

  function wireOptions(opts) {
    return { surface: opts.surface, width: opts.width, theme: opts.theme, dpr: opts.dpr, fontScale: opts.fontScale };
  }

  async function explainWith(post, opts, note = () => {}) {
    const local = await explainerLocal();
    if (local.kind === "binary") {
      const args = [
        "explain",
        "-",
        "--width",
        String(opts.width),
        "--surface",
        opts.surface,
        "--theme",
        opts.theme,
        "--dpr",
        String(opts.dpr),
        "--font-scale",
        String(opts.fontScale),
        "--compact",
        "--quiet",
      ];
      try {
        const out = await execExplain(local.binary, args, JSON.stringify(post));
        return { report: JSON.parse(out), source: "binary" };
      } catch (error) {
        // The model can grow a field before the binary is rebuilt (it did with
        // `media[].sourceAuthor`), and a strict parser refuses the whole post.
        // Drop exactly what it named and try once more: the layout of everything
        // else is still the shipping rules'.
        const message = String(error.message ?? error);
        const unknown = [...message.matchAll(/unknown field `([^`]+)`/g)].map((m) => m[1]);
        if (!unknown.length) throw error;
        let stripped = post;
        for (const path of unknown) stripped = stripFieldPath(stripped, path);
        const out = await execExplain(local.binary, args, JSON.stringify(stripped));
        note(`the rules binary refused ${unknown.join(", ")} (a stale build); dropped it for this render`);
        return { report: JSON.parse(out), source: "binary-stale" };
      }
    }
    if (local.kind === "wasm") {
      try {
        return { report: local.engine.explain(post, wireOptions(opts)), source: "wasm" };
      } catch (error) {
        // The committed wasm build can lag the model by a field (it did not
        // know `appVersion` when this was written). Retrying without the
        // fields it refuses keeps the rules usable, but the client-version
        // behaviour those fields select is lost — which is exactly why the
        // binary is tried first.
        const message = String(error.message ?? error);
        const unknown = [...message.matchAll(/unknown field `([^`]+)`/g)].map((m) => m[1]);
        if (unknown.length) {
          const stripped = { ...post };
          for (const key of unknown) delete stripped[key];
          try {
            const report = local.engine.explain(stripped, wireOptions(opts));
            note(`the wasm rules refused ${unknown.join(", ")} (a stale build); the binary would not`);
            return { report, source: "wasm-stale" };
          } catch {
            /* fall through */
          }
        }
        note(`explain() failed (${message.split("\n")[0]})`);
      }
    }
    return null;
  }

  async function decide(post, opts, report, note = () => {}) {
    if (report) return { report, source: "report" };
    const explained = await explainWith(post, opts, note);
    if (explained) return explained;
    return { report: fallbackReport(post, opts), source: "fallback" };
  }

  /**
   * The decisions without the rules engine: the payload's own text, a reply's
   * leading mentions hidden, X's attachment priority (poll, media, quote,
   * card). It cannot model the long-post cut or URL display forms; that is why
   * every result says where its decisions came from.
   */
  function fallbackReport(post, opts) {
    const text = String(post.text ?? "");
    const hidden = [];
    if (post.replyTo) {
      const lead = /^(?:@[A-Za-z0-9_]{1,15}\s+)+/.exec(text);
      if (lead) hidden.push({ range: [0, lead[0].length], why: "leading mentions of a reply are hidden from the body" });
    }
    const attachment = post.poll
      ? { shown: "poll", why: "the post has a poll" }
      : post.media?.length
        ? { shown: "media", why: "media is attached" }
        : post.quote
          ? { shown: "quote", why: "the post quotes another post" }
          : (() => {
              const url = Object.keys(post.links ?? {}).find((u) => post.links[u]?.card);
              return url ? { shown: "card", url, card: post.links[url].card, why: "" } : null;
            })();
    const visible = hidden.length ? text.slice(hidden[0].range[1]) : text;
    return {
      ruleset: "fallback",
      attached: Boolean(attachment),
      length: { weighted: [...text].length, limit: 280, valid: true },
      text: { lines: 0, truncated: false, showMore: post.longPost ? "inline" : null, visible },
      entities: [],
      hidden,
      attachment,
      warnings: ["decisions came from the playground's JS fallback, not from xeet's rules"],
      verifiedFor: [],
      size: { width: opts.width, height: 0 },
    };
  }

  // ---------------------------------------------------------------- pages --
  function pageKey(opts, mode) {
    return `${mode}|${opts.surface}|${opts.theme}|${opts.dpr}`;
  }

  /**
   * Serves the vendored default profile image to the replica.
   *
   * The model says "no avatar bytes" for an account that never set one, and
   * x.com draws its own default there — so the replica's `<img>` points at this
   * URL and gets the real file instead of an invented stub. Page mode handles
   * X's own `default_profile_images` URLs inside `routePageMedia`, after the
   * media cache: a captured page must use the same picture the resolver would.
   */
  async function routeDefaultAvatar(page) {
    if (!defaultAvatar) return;
    await page.route(DEFAULT_AVATAR_URL, (route) => route.fulfill({ contentType: "image/png", body: defaultAvatar }));
  }

  /**
   * Answers a captured page's image requests with real bytes.
   *
   * Without this every photo, poster frame, avatar and card image in the *truth*
   * column was a transparent 1×1 stub — the boxes were right and the pictures
   * were not there. The store reads the playground's media cache (the files
   * `resolve.mjs` already downloaded), then `source.media`'s map, then fetches
   * once per asset under that module's rules (`chrome-media.mjs`). Anything it
   * cannot get keeps the stub, so a missing picture never breaks a render.
   */
  async function routePageMedia(page, source) {
    if (source?.media) media.register(source.media);
    await page.route(/^https:\/\/pbs\.twimg\.com\//, async (route) => {
      const url = route.request().url();
      const stub = () => route.fulfill({ status: 200, contentType: "image/png", body: BLANK_PNG }).catch(() => {});
      try {
        // Cache only: a document must not wait on the network (X's pages ask
        // for every avatar on them). Missing pictures are warmed after the cell
        // is framed, and the page is reloaded once if anything arrived.
        const found = await media.bytesFor(url, { fetch: false });
        if (found) {
          await route.fulfill({
            status: 200,
            contentType: found.type ?? "image/jpeg",
            body: found.bytes,
            headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
          });
          return;
        }
        // X's own default profile image: the vendored artwork, so an account
        // without an avatar draws the same picture both columns show.
        if (/default_profile_images\/default_profile_/.test(url) && defaultAvatar) {
          await route.fulfill({ status: 200, contentType: "image/png", body: defaultAvatar });
          return;
        }
        await stub();
      } catch {
        await stub();
      }
    });
    // No video bytes and no playback: the poster frame is the picture, and a
    // `<video>` that starts buffering would make a screenshot non-deterministic.
    await page.route(/^https:\/\/video\.twimg\.com\//, (route) => route.abort());
  }

  async function openReplicaPage(opts) {
    const { page, context } = await newPage(browser, {
      width: cellWidthFor(opts.width),
      height: 900,
      dpr: opts.dpr,
      theme: opts.theme,
    });
    page.setDefaultTimeout(options.timeoutMs);
    await routeDefaultAvatar(page);
    await setContentAs(page, documentHtml, "/i/playground-replica");
    await page.evaluate((t) => {
      document.documentElement.setAttribute("data-theme", t);
      const cls = document.documentElement.className;
      document.documentElement.className = cls.replace(/\b(light|dark)-theme\b/g, "").trim() + ` ${t}-theme`;
    }, opts.theme);
    await page.evaluate(initReplica, { skel: templates.cells, frag: templates.fragments });
    await page.evaluate(applySmoothing, { antialiased: opts.smoothing !== "platform" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      void document.body.offsetHeight;
    });
    return { page, context, width: cellWidthFor(opts.width) };
  }

  /** Theme, smoothing, reveal and a font settle: everything a page needs after a load or a reload. */
  async function prepareLoadedPage(page, opts) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute("data-theme", t);
      const cls = document.documentElement.className;
      document.documentElement.className = cls.replace(/\b(light|dark)-theme\b/g, "").trim() + ` ${t}-theme`;
    }, opts.theme);
    await page.evaluate(applySmoothing, { antialiased: opts.smoothing !== "platform" });
    // Reveal before the first render: revealing and framing in the same pass
    // left `main` at 0×0 on a cold page, which measured as an empty cell.
    await page.evaluate(revealPage);
    await page.evaluate(async () => {
      await document.fonts.ready;
      void document.body.offsetHeight;
    });
  }

  async function openPagePage(source, opts) {
    const html = await readFile(source.file, "utf8");
    const { page, context } = await newPage(browser, {
      width: cellWidthFor(opts.width),
      height: 1200,
      dpr: opts.dpr,
      theme: opts.theme,
    });
    page.setDefaultTimeout(options.timeoutMs);
    await routePageMedia(page, source);
    await setContentAs(page, html, `/i/playground-page/${encodeURIComponent(source.name)}`);
    await prepareLoadedPage(page, opts);
    return { page, context, width: cellWidthFor(opts.width), url: page.url() };
  }

  /**
   * Warms the cell's own pictures and reloads once if any arrived.
   *
   * Only the cell's images — its photos, poster frames and avatars — are fetched,
   * bounded and throttled (`chrome-media.mjs`), so a page with twenty unrelated
   * posts does not become twenty network requests. A cold cell therefore costs
   * one extra load; every later render of it is a plain cache hit.
   */
  async function warmCellMedia(page, opts, opened, clock) {
    const urls = await clock.time("layout", () => page.evaluate(() => {
      const cell = document.querySelector("[data-xeet-cell]");
      if (!cell) return [];
      const out = [];
      for (const img of cell.querySelectorAll("img")) {
        // The current candidate is what Chrome would draw; take the widest from
        // `currentSrc` when it has resolved, else `src`.
        if (img.currentSrc) out.push(img.currentSrc);
        if (img.getAttribute("src")) out.push(img.getAttribute("src"));
      }
      for (const video of cell.querySelectorAll("video[poster]")) out.push(video.poster);
      return out.filter(Boolean);
    }));
    // The network itself: `fetch`. Everything below it exists because of it.
    const { fetched } = await clock.time("fetch", () => media.prefetch(urls, { budget: 10 }));
    if (!fetched) return { fetched: 0 };
    await clock.time("load", () => page.reload({ waitUntil: "load" }));
    await clock.time("load", () => prepareLoadedPage(page, opts));
    // A reload is a fresh document: the cell mark and the frame are gone, so the
    // post is found again before the caller re-frames it.
    const found = await clock.time("layout", () => page.evaluate(findOwnCell, { id: String(opened.id) }));
    if (found.error) return { fetched, error: found.detail ?? found.error };
    return { fetched };
  }

  async function getPage(mode, opts, source) {
    const key = pageKey(opts, mode) + (mode === "page" ? `|${source.name}` : "");
    let entry = pages.get(key);
    if (!entry) {
      entry = {
        promise: (async () => (mode === "page" ? openPagePage(source, opts) : openReplicaPage(opts)))(),
        width: null,
        smoothing: opts.smoothing,
      };
      pages.set(key, entry);
    }
    try {
      const opened = await entry.promise;
      // State the *page* currently has. Renders change it in place (the
      // viewport width, the forced glyph smoothing), so it lives on the entry
      // rather than on the immutable opening record.
      if (entry.width == null) entry.width = opened.width;
      return {
        key,
        page: opened.page,
        get width() {
          return entry.width;
        },
        get smoothing() {
          return entry.smoothing;
        },
        setWidth: (w) => (entry.width = w),
        setSmoothing: (s) => (entry.smoothing = s),
      };
    } catch (error) {
      pages.delete(key);
      throw error;
    }
  }

  function dropPage(key) {
    const entry = pages.get(key);
    if (!entry) return;
    pages.delete(key);
    entry.promise.then(({ context }) => context.close().catch(() => {})).catch(() => {});
  }

  /**
   * Serializes per page and drops a queued render when a newer one for the same
   * page arrives: with one debounced keystroke after another, the older frame is
   * already stale, and it would otherwise add a full render's latency.
   */
  function enqueue(key, job, { signal } = {}) {
    let slot = queues.get(key);
    if (!slot) {
      slot = { tail: Promise.resolve(), pending: null };
      queues.set(key, slot);
    }
    if (slot.pending) {
      slot.pending.superseded = true;
      slot.pending.reject(new Superseded(key));
      slot.pending = null;
    }
    return new Promise((resolve, reject) => {
      const entry = { reject, superseded: false };
      slot.pending = entry;
      const run = async () => {
        if (slot.pending === entry) slot.pending = null;
        if (entry.superseded) return;
        if (signal?.aborted) return reject(abortError());
        try {
          resolve(await job());
        } catch (error) {
          reject(error);
        }
      };
      slot.tail = slot.tail.then(run, run);
    });
  }

  function abortError() {
    const error = new Error("chrome: render aborted");
    error.code = "aborted";
    return error;
  }

  /** Retries once against a fresh page when Chrome's target died under us. */
  async function withRecovery(key, job, retried = false) {
    try {
      return await job();
    } catch (error) {
      if (retried || !CRASH.test(String(error?.message ?? error))) throw error;
      dropPage(key);
      notes.push(`recovered from a crashed page (${String(error.message).split("\n")[0]})`);
      return withRecovery(key, () => job(), true);
    }
  }

  // --------------------------------------------------------------- render --
  /**
   * Measures the cell and screenshots it, in the cell's own frame.
   *
   * The clip comes from `getBoundingClientRect` a round trip before the capture,
   * so `verify` re-measures afterwards and captures again if the cell moved in
   * between (a scroll that is still animating, a virtual list that re-spaced, a
   * late layout shift). Without it, one run in twenty produced a PNG of the
   * wrong region — a badge box that sampled background. It is bounded, so a cell
   * that never settles still returns its last capture instead of looping.
   */
  /**
   * Phase clocks for one render.
   *
   * The playground's question is "how long does *painting* this post take", so
   * the response separates the two kinds of waiting that are not painting:
   *
   *   fetch       network / asset prefetch (`media.prefetch`) and the reload a
   *               prefetch causes — data acquisition, never in `paint`
   *   load        navigation (a page opening or reloading), and every
   *               `document.fonts.ready` / `img.decode()` settle — the browser
   *               finishing work it was already given
   *   layout      Chrome writing the DOM and laying it out (the plan's
   *               `applyPlan`, the page-mode framing, `measureCell`)
   *   screenshot  the raster and PNG encode
   *
   * `paint = layout + screenshot` — everything after the HTML, fonts and images
   * are in memory and decoded. `total` is the wall clock of the whole call and
   * still includes the rules decision, `fetch` and `load`.
   */
  function clockFor() {
    const ms = { fetch: 0, load: 0, layout: 0, screenshot: 0 };
    return {
      ms,
      async time(phase, fn) {
        const t = performance.now();
        try {
          return await fn();
        } finally {
          ms[phase] += performance.now() - t;
        }
      },
    };
  }

  async function shoot(page, selector, clock, { verify = false } = {}) {
    const attempts = verify ? 3 : 1;
    let last = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const measured = await clock.time("layout", () => page.evaluate(measureCell, { selector, labels: BOX_LABELS }));
      if (measured.error) throw new Error(`chrome: ${measured.error}`);
      if (!measured.frame.width || !measured.frame.height) {
        const detail = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          const r = el?.getBoundingClientRect();
          const chain = [];
          for (let node = el; node && node !== document.body; node = node.parentElement) {
            const box = node.getBoundingClientRect();
            const cs = getComputedStyle(node);
            chain.push({
              tag: node.tagName,
              cls: String(node.className || "").slice(0, 32),
              rect: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
              display: cs.display,
              contentVisibility: cs.contentVisibility,
              hidden: (window.__xeetHidden ?? []).includes(node),
            });
            if (chain.length >= 8) break;
          }
          return {
            found: Boolean(el),
            rect: r ? [r.x, r.y, r.width, r.height] : null,
            viewport: [innerWidth, innerHeight],
            scroll: [Math.round(scrollX), Math.round(scrollY)],
            chain,
          };
        }, selector);
        throw new Error(`chrome: the cell measured ${measured.frame.width}x${measured.frame.height} (${JSON.stringify(detail)})`);
      }
      const { x, y, width, height } = measured.frame;
      let png = null;
      await clock.time("screenshot", async () => {
        png = await page.screenshot({
          clip: { x, y, width, height },
          animations: "disabled",
          caret: "hide",
          type: "png",
        });
      });
      last = { png, measured };
      if (!verify || attempt === attempts - 1) break;
      const after = await clock.time("layout", () => page.evaluate(measureCell, { selector, labels: BOX_LABELS }));
      if (after.frame && sameFrame(measured.frame, after.frame)) break;
    }
    return last;
  }

  const sameFrame = (a, b) =>
    Math.abs(a.x - b.x) < 0.02 && Math.abs(a.y - b.y) < 0.02 && Math.abs(a.width - b.width) < 0.02 && Math.abs(a.height - b.height) < 0.02;

  async function planFor(post, opts, reportIn) {
    const notes = [];
    const note = (text) => notes.push(text);
    // A quote of a quote is a *nested preview* in X's client. The rules take the
    // whole post (`max_quote_depth = 2`): the report for the outer post is what
    // this cell needs, and the preview itself is the harness's. A build that
    // predates the nested level refuses the post ("is a quote of a quote; X
    // shows only one level"), so that case is retried without it rather than
    // failing the render.
    const nestedQuote = post.quote?.quote ?? null;
    let decision;
    try {
      decision = await decide(post, opts, reportIn, note);
    } catch (error) {
      const message = String(error.message ?? error);
      if (!nestedQuote || !/quote of a quote|post\.quote\.quote/.test(message)) throw error;
      note("this build of the rules refuses a post that quotes a quote; the post is decided without the nested level and the replica draws X's nested preview");
      decision = await decide({ ...post, quote: { ...post.quote, quote: undefined } }, opts, reportIn, note);
    }
    const report = decision.report;
    const spans = bodySpans(report, post, { note });
    // The quoted post's body goes through the same rules as the cell's: the
    // engine's `visible` text, its hidden ranges, its entity display forms. A
    // quoted card has no "Show more" button (it clamps with `line-clamp-5`), so
    // the affordance's words are not added — `bodySpans` strips them — but a
    // hidden media URL leaves no ellipsis and takes the whitespace before it,
    // exactly as in the cell.
    const quoted = post.quote ? stripNestedPermalink(post.quote, nestedQuote, note) : null;
    const quoteBody = post.quote ? await quoteBodySpans(quoted, opts, note) : [];
    const nestedQuoteHtml = await nestedPreview(post, quoted, nestedQuote, opts, note);
    const attachmentHtml = attachmentMarkup({
      attachment: report.attachment,
      post,
      templates,
      width: cellWidthFor(opts.width),
      decisions: { quoteBody, nestedQuote: nestedQuoteHtml },
      note,
    });
    const author = post.author ?? {};
    const counts = {};
    const raw = post.counts ?? {};
    for (const key of ["replies", "reposts", "likes", "views", "bookmarks"]) {
      if (raw[key] != null) counts[key] = formatCount(raw[key]);
    }
    // The detail view prints the impression count in the timestamp row, the
    // timeline prints it in the action row's views pill.
    const detail = opts.surface === "web-detail";
    if (detail) delete counts.views;
    const showMore = String(report?.text?.showMore ?? "") === "inline";
    return {
      notes,
      decision: decision.source,
      ruleset: report.ruleset ?? null,
      plan: {
        surface: detail ? "detail" : "timeline",
        cellWidth: cellWidthFor(opts.width),
        smoothing: opts.smoothing,
        fontScale: opts.fontScale,
        avatar: avatarSrc(author),
        squareAvatar: author.squareAvatar === true,
        name: author.name ?? "",
        handle: author.handle ?? "",
        badge: { blue: "#icon-verified-premium-color", business: "#icon-verified-business-color", government: "#icon-verified-government-color" }[author.verified] ?? null,
        affiliate: author.affiliate
          ? {
              name: author.affiliate.name ?? "Affiliate",
              src: author.affiliate.badge ? dataUri(author.affiliate.badge) : stubSquare(),
            }
          : null,
        pinned: (post.socialContext ?? null) === "pinned",
        // The label comes from the post's own ISO strings: xeet has no clock, so
        // the replica must not have one either.
        stamp: stampLabel(post.createdAt, post.now, { detail }),
        views: detail && raw.views != null ? `${formatViewsCount(raw.views)} Views` : null,
        counts,
        countsAriaLabel: ariaLabelFor(raw),
        bodyHtml: spansHtml(spans),
        showMore,
        clamp: null,
        attachmentHtml,
      },
    };
  }

  /**
   * A quoted post's body as spans, decided by the rules and nothing else.
   *
   * The model's `quote.text` is whatever the converter kept, which is not always
   * the displayed text: a payload whose `display_text_range` the converter did
   * not apply still carries the post's own media `t.co` at the end (the resolved
   * post at `x.com/NBA/status/2120019063476785477` does). The engine's report
   * for that text says `hidden: [{range: [96, 120], why: "trailing URL replaced
   * by attached media"}]` and a `visible` string without it — the same decision
   * the cell body gets, which is why this uses `bodySpans` rather than
   * substituting entity displays by hand (that drew `… 📋 t.co/1FQn6XU9rz`,
   * with the space the hidden range exists to swallow).
   *
   * The engine runs in the non-quoted mode, so a long quoted post comes back cut
   * with the affordance's " Show more"; `bodySpans` strips those words, and the
   * captured card clamps what is left with CSS. That is what xeet draws too.
   */
  async function quoteBodySpans(quote, opts, note) {
    // The `web-detail` surface, because that is the text a quoted card prints.
    // The timeline report answers a *cell's* question — it uses `text` and cuts
    // it with an inline "Show more" — while a card shows the post's server-cut
    // body: for `x.com/NBA/status/2120019063476785477`'s quoted post the payload
    // carries `text` 400 and a 280-character body, and the captured card prints
    // 280; the detail report answers 280 and the timeline one 400. Measured on
    // every corpus post that quotes another (25 of them): the detail report's
    // `visible` is the capture's text in each case it renders.
    const decision = await decide(quote, { ...opts, surface: "web-detail" }, null, note);
    return bodySpans(decision.report, quote, { note });
  }

  /**
   * A quoted post whose trailing `t.co` is removed when it quotes a post.
   *
   * The rules already hide a trailing *status URL* on a post that quotes another
   * — measured: `hidden: [{range, why: "trailing URL replaced by the quoted
   * post"}], visible: "Look at this"` — so that case needs nothing here. A `t.co`
   * is opaque (the rules keep it: `visible: "… t.co/AbCdEf1234"`), and on a post
   * that quotes another it *is* the quoted post's permalink; X hides it, so the
   * harness trims it from the text the rules see, whitespace included.
   */
  function stripNestedPermalink(quoted, nested, note) {
    if (!nested) return quoted;
    const source = String(quoted.longPostBody ?? quoted.text ?? "");
    const match = /(?:^|\s)(https?:\/\/t\.co\/[A-Za-z0-9]+)\s*$/.exec(source);
    if (!match) return quoted;
    const disp = String(quoted.links?.[match[1]]?.display ?? "")
      .trim()
      .toLowerCase()
      .replace(/^(?:https?:\/\/)?(?:www\.|mobile\.)?/, "");
    // A t.co that resolved to an external display URL (e.g. better-auth.com/…)
    // is an author link, not the nested quote's permalink; and an x.com status
    // display URL is claimed by rules itself. Only an opaque bare t.co is
    // trimmed here.
    if (disp && !disp.startsWith("t.co/")) return quoted;
    const trimmed = source.slice(0, match.index).replace(/\s+$/, "");
    note("the quoted post's trailing t.co is treated as the nested post's permalink and hidden, as X hides it");
    return { ...quoted, text: trimmed, longPostBody: quoted.longPostBody ? trimmed : quoted.longPostBody };
  }

  /**
   * The nested preview's markup, or `null` when X would not draw one.
   *
   * The gate is X's `H` (see `nestedQuoteEligible`); the nested post's own text
   * is the rules' visible text for it, clamped to two lines by X's CSS. The
   * clock is the render's (the outer post's `now`), as for the quoted stamp.
   */
  async function nestedPreview(post, quoted, nested, opts, note) {
    if (!nested) return null;
    if (!nestedQuoteEligible({ post, quoted, nested })) {
      note("the post quotes a quote, but X draws no nested preview here (its eligibility gate says no)");
      return null;
    }
    const spans = await quoteBodySpans(nested, opts, note);
    return nestedQuoteMarkup({ nested, spans, now: post.now ?? quoted?.now ?? nested.now, note });
  }

  async function renderReplica({ post, options: raw, report, signal }) {
    if (!post || typeof post !== "object") throw new Error("chrome: render needs a post");
    const opts = normalizeOptions(raw);
    const started = performance.now();
    const clock = clockFor();
    const { plan, notes, decision, ruleset } = await planFor(post, opts, report);
    if (!post.text && !plan.attachmentHtml) notes.push("the post has no body and no attachment: the cell is a header and an action row");
    const key = pageKey(opts, "replica");
    const out = await withRecovery(key, async () => {
      // Opening the warm replica page is a navigation (cold render only).
      const slot = await clock.time("load", () => getPage("replica", opts));
      return enqueue(
        key,
        async () => {
          if (slot.width !== plan.cellWidth) {
            await clock.time("layout", async () => {
              await slot.page.setViewportSize({ width: plan.cellWidth, height: 900 });
              slot.setWidth(plan.cellWidth);
            });
          }
          if (slot.smoothing !== opts.smoothing) {
            await clock.time("layout", () => slot.page.evaluate(applySmoothing, { antialiased: opts.smoothing !== "platform" }));
            slot.setSmoothing(opts.smoothing);
          }
          await clock.time("layout", () => slot.page.evaluate(applyPlan, plan));
          // Fonts and the cell's images: data the browser already has, so this
          // is `load`, not paint.
          await clock.time("load", () => slot.page.evaluate(async () => {
            const cell = document.querySelector("#xeet-holder");
            const images = [...cell.querySelectorAll("img")];
            const posters = [...cell.querySelectorAll("video[poster]")].map((v) => v.poster).filter(Boolean);
            await Promise.all([
              // Every `<img>` is a data URI or a local route, so only the ones
              // still loading are awaited: a warm render pays for none.
              ...images.filter((i) => !i.complete).map((i) => i.decode().catch(() => null)),
              ...posters.map(async (src) => {
                const probe = new Image();
                probe.src = src;
                try {
                  await probe.decode();
                } catch {
                  /* nothing to draw */
                }
              }),
            ]);
            await document.fonts.ready;
            void document.body.offsetHeight;
          }));
          return shoot(slot.page, "#xeet-holder > *", clock);
        },
        { signal },
      );
    });
    const total = performance.now() - started;
    return finish(out, {
      dpr: opts.dpr,
      total,
      clock,
      version: { chromium: browser.version(), upstream: lock.appVersion, harness, ruleset, decisions: decision, smoothing: opts.smoothing },
      notes,
    });
  }

  async function renderPage({ post, options: raw, source, signal }) {
    const opts = normalizeOptions(raw);
    const resolved = normalizeSource(source);
    // `/api/resolve`'s bytes are registered per render, not per page: the page is
    // warm across renders and must answer the latest resolver's map (the same
    // capture can come back with different inlined media).
    if (resolved.media) media.register(resolved.media);
    const started = performance.now();
    const clock = clockFor();
    const key = pageKey(opts, "page") + `|${resolved.name}`;
    const notes = [];
    let measuredId = null;
    const out = await withRecovery(key, async () => {
      // Opening the page is a navigation (on a cold render): `load`, not paint.
      const slot = await clock.time("load", () => getPage("page", opts, resolved));
      return enqueue(
        key,
        async () => {
          const cellWidth = cellWidthFor(opts.width);
          if (slot.width !== cellWidth) {
            await clock.time("layout", async () => {
              await slot.page.setViewportSize({ width: cellWidth, height: 1200 });
              slot.setWidth(cellWidth);
            });
          }
          if (slot.smoothing !== opts.smoothing) {
            await clock.time("layout", () => slot.page.evaluate(applySmoothing, { antialiased: opts.smoothing !== "platform" }));
            slot.setSmoothing(opts.smoothing);
          }
          let found = await clock.time("layout", () => slot.page.evaluate(findOwnCell, { id: String(resolved.id) }));
          if (found.error) {
            // The cell may still be hidden: reveal, then look again.
            await clock.time("layout", () => slot.page.evaluate(preparePage, { cellWidth }));
            found = await clock.time("layout", () => slot.page.evaluate(findOwnCell, { id: String(resolved.id) }));
            if (found.error) {
              const error = new Error(`chrome: ${found.detail} on ${resolved.name}`);
              error.code = found.error === "nestedOnly" ? "nested_only" : "not_found";
              throw error;
            }
          }
          measuredId = found.measuredId ?? null;
          let prepared = await clock.time("layout", () => slot.page.evaluate(preparePage, { cellWidth }));
          for (let attempt = 0; prepared.error && attempt < 2; attempt++) {
            // Chrome's own layout can still be settling (a virtual list, a
            // font swap); one more pass is cheap and makes the frame exact.
            await clock.time("load", () => slot.page.evaluate(async () => {
              await document.fonts.ready;
              void document.body.offsetHeight;
            }));
            prepared = await clock.time("layout", () => slot.page.evaluate(preparePage, { cellWidth }));
          }
          if (prepared.error) {
            const error = new Error(`chrome: could not frame the cell on ${resolved.name}: ${prepared.detail ?? prepared.error}`);
            error.code = "not_framed";
            throw error;
          }
          // A cell taller than the viewport cannot be captured by a viewport
          // clip, so the viewport grows to hold it (height only: the horizontal
          // layout, and every media query that matters here, stay put).
          for (let attempt = 0; needsTaller(prepared) && attempt < 2; attempt++) {
            const height = Math.min(Math.ceil(prepared.height + 40), 4000);
            await clock.time("layout", () => slot.page.setViewportSize({ width: cellWidth, height }));
            prepared = await clock.time("layout", () => slot.page.evaluate(preparePage, { cellWidth }));
          }
          // Real pictures for this cell: the store answers the document load
          // from cache only, so anything missing is fetched here (bounded,
          // throttled) and the page reloaded once. Without this a cold cell was
          // all stubs, and every image box in the truth column was empty.
          const warm = warmMedia ? await warmCellMedia(slot.page, opts, { ...slot, id: resolved.id }, clock) : { fetched: 0 };
          if (warm.error) {
            const error = new Error(`chrome: could not find the cell on ${resolved.name} after loading its images: ${warm.error}`);
            error.code = "not_found";
            throw error;
          }
          if (warm.fetched) {
            notes.push(`fetched ${warm.fetched} image${warm.fetched === 1 ? "" : "s"} for this cell and reloaded the page`);
            prepared = await clock.time("layout", () => slot.page.evaluate(preparePage, { cellWidth }));
            if (prepared.error) {
              const error = new Error(`chrome: could not frame the cell on ${resolved.name} after loading its images: ${prepared.detail ?? prepared.error}`);
              error.code = "not_framed";
              throw error;
            }
          }
          // X's per-post spacer rows and the timeline's virtual list can still
          // change the cell's height after the reveal, and the routed image
          // bytes arrive asynchronously: settle before measuring.
          await clock.time("load", () => slot.page.evaluate(settleCell));
          await clock.time("load", () => slot.page.evaluate(async () => {
            await document.fonts.ready;
            void document.body.offsetHeight;
          }));
          // The cell's box has to still be the cell's box when the pixels are
          // taken: a scroll or a re-space in between is re-captured, and a frame
          // that collapsed to nothing is re-framed first.
          let shot = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              shot = await shoot(slot.page, "[data-xeet-cell]", clock, { verify: true });
              break;
            } catch (error) {
              const collapsed = /measured 0x0|not framed/.test(String(error.message));
              if (!collapsed || attempt === 1) throw error;
              notes.push("re-framed the cell: the page collapsed between framing and capture");
              await clock.time("layout", () => slot.page.evaluate(preparePage, { cellWidth }));
              await clock.time("load", () => slot.page.evaluate(async () => {
                await document.fonts.ready;
                void document.body.offsetHeight;
              }));
            }
          }
          return shot;
        },
        { signal },
      );
    });
    const total = performance.now() - started;
    return finish(out, {
      dpr: opts.dpr,
      total,
      clock,
      version: { chromium: browser.version(), upstream: lock.appVersion, harness, ruleset: null, decisions: "page", smoothing: opts.smoothing },
      notes,
      measuredId,
    });
  }

  /**
   * One result shape for both modes, so the server and the tests read one thing.
   *
   * `ms.paint` is the number a "how fast is this render" question wants: the DOM
   * update/layout plus the raster, with every byte already in memory and decoded.
   * `fetch` (network prefetch, page mode's reload) and `load` (navigation,
   * `fonts.ready`, `img.decode()`) are reported beside it, never inside it, and
   * `total` remains the wall clock of the whole call — it also carries the rules
   * decision and the queueing.
   */
  function finish(out, { dpr, total, clock, version, notes, ...extra }) {
    const phases = clock ? clock.ms : { fetch: 0, load: 0, layout: 0, screenshot: 0 };
    return {
      png: out.png,
      width: out.measured.frame.width,
      height: out.measured.frame.height,
      dpr,
      geometry: { boxes: out.measured.boxes, lines: out.measured.lines, texts: out.measured.texts },
      ms: {
        total: round1(total),
        paint: round1(phases.layout + phases.screenshot),
        fetch: round1(phases.fetch),
        load: round1(phases.load),
        layout: round1(phases.layout),
        screenshot: round1(phases.screenshot),
      },
      version,
      notes,
      frame: {
        padding: out.measured.frame.padding,
        background: out.measured.frame.background,
      },
      ...extra,
    };
  }

  return {
    render(args) {
      if (closed) return Promise.reject(new Error("chrome: the oracle is closed"));
      const mode = args?.mode === "page" ? "page" : "replica";
      return mode === "page" ? renderPage(args) : renderReplica(args);
    },
    async close() {
      if (closed) return;
      closed = true;
      const entries = [...pages.values()];
      pages.clear();
      await Promise.all(entries.map((e) => e.promise.then(({ context }) => context.close().catch(() => {})).catch(() => {})));
      await browser.close().catch(() => {});
    },
    get version() {
      return { chromium: browser.version(), upstream: lock.appVersion, harness, templates: Object.keys(templates).length };
    },
    /** Where a page mode source resolves from: a corpus or playground capture. */
    resolveSource(name) {
      return normalizeSource({ page: name, id: "0" });
    },
    stats() {
      return {
        pages: [...pages.keys()],
        startedMs: Date.now() - startedAt,
        notes,
        decisions: explainer?.kind ?? "unknown",
        // Page mode's picture budget: what the routes answered, and how much of
        // it came off disk rather than a throttled fetch.
        media: media.stats(),
      };
    },
    /**
     * Test hooks. `killPages` closes the warm pages *without* clearing the map,
     * which is what a crash looks like from the outside: the next render has to
     * notice, rebuild the page and retry.
     */
    _debug: {
      async killPages() {
        for (const entry of [...pages.values()]) {
          const { context } = await entry.promise;
          await context.close().catch(() => {});
        }
      },
      get browser() {
        return browser;
      },
    },
  };
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * The `xeet-render` binary that answers `explain` for the replica's decisions.
 *
 * `XEET_EXPLAIN_BIN` wins; otherwise the newest build in any `target/` profile
 * directory is used, the playground's own `target/playground/` first. This is the
 * same convention the oracle's other tools follow (`XEET_BIN`), so the
 * playground renders with the tree's current rules rather than whatever the
 * committed wasm build happens to contain.
 */
function findExplainBinary() {
  if (process.env.XEET_EXPLAIN_BIN) {
    return existsSync(process.env.XEET_EXPLAIN_BIN) ? process.env.XEET_EXPLAIN_BIN : null;
  }
  const targets = join(ROOT, "target");
  if (!existsSync(targets)) return null;
  let best = null;
  for (const dir of readdirSync(targets, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const root = join(targets, dir.name);
    const preferred = dir.name === "playground" ? 1e9 : 0; // the playground's own build wins ties
    for (const profile of ["release", "fast", "debug"]) {
      for (const name of ["xeet-render", "xeet"]) {
        const p = join(root, profile, name);
        if (!existsSync(p)) continue;
        const mtime = statSync(p).mtimeMs + preferred;
        if (!best || mtime > best.mtime) best = { p, mtime };
      }
    }
  }
  return best?.p ?? null;
}

let execExplainFn = null;
async function execExplain(binary, args, input) {
  if (!execExplainFn) {
    const { execFile } = await import("node:child_process");
    execExplainFn = (file, argv, stdin) =>
      new Promise((resolve, reject) => {
        const child = execFile(file, argv, { encoding: "utf8", maxBuffer: 1 << 26, timeout: 10000 }, (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || stdout || error.message).trim().split("\n").slice(0, 2).join(" ");
            reject(new Error(`xeet explain failed: ${detail}`));
            return;
          }
          resolve(stdout);
        });
        child.stdin.end(stdin);
      });
  }
  return execExplainFn(binary, args, input);
}

/**
 * A page-mode source: `{ page, id }` (the API's shape), or a path. The page is
 * looked up under `assets/vendor/playground/` (the playground's own fetches)
 * then `assets/vendor/corpus/` (the captured corpus), and a bare name works.
 */
function normalizeSource(source) {
  if (!source) throw new Error("chrome: page mode needs a source ({ page, id })");
  const page = String(source.page ?? source.file ?? "");
  if (!page) throw new Error("chrome: page mode needs source.page");
  const id = source.id ?? String(source.url ?? "").match(/\/status\/(\d+)/)?.[1] ?? null;
  if (!id) throw new Error("chrome: page mode needs the post's status id (source.id)");
  const candidates = [join(VENDOR, "playground", page), join(VENDOR, "corpus", page), page];
  // `media` is `/api/resolve`'s `{url: {file, bytes, width, height, variant}}`:
  // the bytes it already inlined, so the page column does not fetch them again.
  const media = source.media && typeof source.media === "object" ? source.media : null;
  for (const file of candidates) if (existsSync(file)) return { name: page, file, id: String(id), media };
  throw new Error(`chrome: no captured page ${JSON.stringify(page)} under assets/vendor/{playground,corpus}`);
}

/**
 * X's action-row label, from the raw counts: "12 replies, 3 reposts, 47 likes,
 * 1 bookmark, 400 views". Not layout, but it is what a snapshot of the cell
 * should carry, and it is wrong if it keeps the captured post's numbers.
 */
function ariaLabelFor(counts) {
  const parts = [];
  const push = (n, one, many) => {
    if (n == null || n === 0) return;
    parts.push(`${Number(n)} ${n === 1 ? one : many}`);
  };
  push(counts.replies, "reply", "replies");
  push(counts.reposts, "repost", "reposts");
  push(counts.likes, "like", "likes");
  push(counts.bookmarks, "bookmark", "bookmarks");
  push(counts.views, "view", "views");
  return parts.length ? parts.join(", ") : null;
}

function stubSquare() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#8b98a5"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

