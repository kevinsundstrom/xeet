// Replica markup for the playground's Chrome (truth) target.
//
// Development only. This module owns one job: turning a `model::Post` into the
// **markup x.com's server would have written**, by mutating the markup X
// really served (captured in `assets/vendor/corpus/`) rather than by writing
// our own. Chrome then lays that out with X's real stylesheet and fonts, so
// `tools/playground/lib/chrome.mjs` measures X's own component, not xeet's idea
// of it.
//
// ## Where every piece of markup comes from
//
// `TEMPLATES` names one captured post per component. `loadTemplates()` pulls
// the component's element out of the captured page once, at startup, and
// everything after that is string surgery with `swap()` — which throws unless
// its pattern matches exactly once, so a change in X's markup fails loudly
// instead of silently producing a wrong replica.
//
// | template | source | what it supplies |
// |---|---|---|
// | `cell.timeline` | `jack-20.html` art 2 | the whole timeline cell (avatar column, header, text, action row) |
// | `cell.detail` | `jack-20.html` art 0 | the whole detail cell (`text-lead`, full timestamp row) |
// | `slot.media1` | `text-OurWorldInData.html` art 1 | one photo: aspect-ratio box, `View media` overlay, ALT badge |
// | `slot.video` | `github.html` art 2 | one video: poster, play button, duration pill |
// | `slot.carousel` | `NASA.html` art 0 | the image carousel, one cell per image (4 cells) |
// | `slot.cardLarge` | `nytimes.html` art 0 | `summary_large_image`: 1.91 image, title bar, `From domain` |
// | `slot.quoteFull` | `XDevelopers.html` art 3 | a quoted post, full form (24 px avatar, media below text) |
// | `slot.quoteCompact` | `NBA.html` art 0 | a quoted post, compact form (16 px avatar, 96 px thumb) |
// | `slot.poll` | `poll-musk.html` art 0 | the poll result list and its `votes · Final results` footer |
// | `fragments.*` | see each entry | the `Show more` button, `Pinned` row, affiliation badge, video/GIF badges, `Replying to` row, tag line |
//
// ## What is ours, and what that means for the parity run
//
// Two things in the output are not X's: the *text* and *numbers* injected into
// the components, and the container sizes X's server computes on the client's
// behalf (`aspect-ratio`, the carousel's `padding-bottom`, the 510 px cap).
// Those sizes come from the client bundle's own formulas, ported in
// `carouselLayout()` below; `tools/playground/test/oracle-parity.mjs` then
// checks the whole replica against the same post rendered as the *captured
// page itself* (page mode), so a wrong formula shows up as a height or box
// mismatch rather than as quiet agreement.
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { VENDOR } from "../../oracle/browser.mjs";
// `formatCount`/`formatViewsCount` are X's own counters, borrowed from the
// oracle's replica harness; timestamps are the local port below, because they
// must come from the post and never from a clock.
import { formatCount, formatViewsCount } from "../../oracle/replica.mjs";

export const CORPUS = join(VENDOR, "corpus");

/** The single media box's height cap (`max-height: 510px` in the client). */
export const MAX_MEDIA_HEIGHT = 510;

/**
 * Where the replica's `<img>` looks for an author it has no bytes for. The page
 * answers this URL with `assets/vendor/default-avatar.png` (X's own default
 * profile image), so the cell carries X's real pixels instead of an invented
 * stub; see `routeDefaultAvatar` in `chrome.mjs`.
 */
export const DEFAULT_AVATAR_URL = "https://x.com/__xeet/default-avatar.png";

// --------------------------------------------------------------- templates --

/**
 * One captured post per component. `article` indexes the *top-level* articles
 * of that page (quoted posts are nested and never counted).
 *
 * The detail skeleton is `poll-musk.html` rather than the timeline's own page
 * because a detail cell only carries an attachment slot when its post has an
 * attachment: a post page with a poll is the only capture that shows where X
 * puts that slot (between the body and the timestamp row) and how it is
 * wrapped. Every detail post, with or without an attachment, then uses the same
 * skeleton.
 */
export const TEMPLATES = {
  "cell.timeline": { file: "IGN.html", article: 1, kind: "cell" },
  "cell.detail": { file: "poll-musk.html", article: 0, kind: "cell" },
  "slot.media1": { file: "text-OurWorldInData.html", article: 1, kind: "slot" },
  "slot.video": { file: "github.html", article: 2, kind: "slot" },
  "slot.carousel": { file: "NASA.html", article: 0, kind: "slot" },
  "slot.cardLarge": { file: "nytimes.html", article: 0, kind: "slot" },
  "slot.quoteFull": { file: "XDevelopers.html", article: 3, kind: "slot" },
  "slot.quoteCompact": { file: "NBA.html", article: 0, kind: "quote" },
  // A quoted card whose media is a *carousel*: the wrapper X puts it in differs
  // from the timeline's (`mx-auto` + `mx-3 mb-3`, so the images are inset by 12
  // and the carousel's percentage is taken from a narrower box).
  "slot.quoteCarousel": { file: "MrBeast.html", id: "2117003477079761397", kind: "quoteMedia" },
  "slot.poll": { file: "poll-musk.html", article: 0, kind: "slot" },
  "fragments.showMore": { file: "Google.html", kind: "showMore" },
  "fragments.pinned": { file: "F1.html", article: 0, kind: "social" },
  "fragments.affiliate": { file: "poll-musk.html", article: 0, kind: "affiliate" },
  "fragments.quoteReply": { file: "text-karpathy.html", article: 3, kind: "replyRow" },
  "fragments.tagLine": { file: "NASA.html", article: 2, kind: "tagLine" },
  "fragments.altBadge": { file: "text-OurWorldInData.html", article: 1, kind: "altBadge" },
  "fragments.videoBadges": { file: "github.html", article: 2, kind: "videoBadges" },
};

/**
 * Runs in the page. Extracts the requested element of one captured article.
 * The page is not laid out (every request aborts, no stylesheet), which is why
 * this is cheap: the server-rendered markup is all we need.
 */
function extractInPage({ article, id, kind }) {
  const topLevel = [...document.querySelectorAll("article")].filter((a) => !a.parentElement?.closest("article"));
  const ownIdOf = (a) => {
    const link = [...a.querySelectorAll('a[href*="/status/"]')].find(
      (x) => (x.closest("article") ?? a) === a && x.innerText.trim() !== "",
    );
    return link ? ((link.getAttribute("href") ?? "").match(/\/status\/(\d+)/)?.[1] ?? null) : null;
  };
  // A template is named by the *post* it comes from when it can be: an article
  // index silently points at a different post once a capture is refreshed.
  const art = id ? topLevel.find((a) => ownIdOf(a) === String(id)) : topLevel[article ?? 0];
  const fail = (why) => ({ error: why });
  if (!art && kind !== "showMore") return fail(`no top-level article ${id ?? article} (have ${topLevel.length})`);

  // The attachment slot: the first element whose class list mentions
  // `empty:hidden` (X hides the slot when nothing is attached).
  const slot = art ? [...art.querySelectorAll("div")].find((d) => String(d.className).includes("empty:hidden")) : null;
  const cell = (() => {
    let el = art;
    while (el && !String(el.className || "").includes("px-horizontal")) el = el.parentElement;
    return el ?? art?.parentElement ?? null;
  })();

  switch (kind) {
    case "cell":
      return { html: cell?.outerHTML ?? fail("no cell") };
    case "slot":
      // The slot's inner wrapper is the component's own root; the outer div is
      // the cell's slot. Returning the inner one keeps the nesting X used.
      return { html: slot?.firstElementChild?.outerHTML ?? slot?.outerHTML ?? fail("no attachment slot") };
    case "quote": {
      const wrapper = slot?.firstElementChild?.lastElementChild ?? null;
      return { html: wrapper?.querySelector("article") ? wrapper.outerHTML : fail("no quoted card") };
    }
    case "quoteMedia": {
      // The quoted card's media wrapper: `mx-auto` (a full-width carousel or a
      // single box) or the compact form's 96 px thumbnail.
      const inner = art?.querySelector("article") ?? null;
      const wrapper = [...(inner?.querySelectorAll("div") ?? [])].find(
        (d) =>
          /(^|\s)mx-auto(\s|$)/.test(String(d.className)) ||
          /(^|\s)w-24(\s|$)/.test(String(d.className)) ||
          /^relative mx-auto$/.test(String(d.className)),
      );
      return { html: wrapper?.outerHTML ?? fail("no quoted media wrapper") };
    }
    case "showMore": {
      const button = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Show more");
      return { html: button?.outerHTML ?? fail("no Show more button") };
    }
    case "social": {
      const row = [...(art?.children ?? [])].find((el) => /icon-pin-fill/.test(el.innerHTML));
      return { html: row?.outerHTML ?? fail("no social-context row") };
    }
    case "affiliate": {
      const anchor = art?.querySelector("a[aria-label] > img")?.closest("a") ?? null;
      return { html: anchor?.outerHTML ?? fail("no affiliation badge") };
    }
    case "replyRow": {
      // The quoted post's `Replying to @handle` row, inside the nested article.
      const inner = art?.querySelector("article") ?? null;
      const row = [...(inner?.querySelectorAll("div") ?? [])].find((d) => /^Replying to\s/.test(d.textContent.trim()));
      return { html: row?.outerHTML ?? fail("no Replying to row") };
    }
    case "tagLine": {
      const line = [...(slot?.querySelectorAll("div") ?? [])].find((d) => /text-subtext2[^"]*mt-1/.test(String(d.className)));
      return { html: line?.outerHTML ?? fail("no media tag line") };
    }
    case "altBadge": {
      const badge = [...(art?.querySelectorAll("div") ?? [])].find(
        (d) => String(d.className).includes("inset-s-3") && String(d.className).includes("bottom-3"),
      );
      return { html: badge?.outerHTML ?? fail("no ALT badge container") };
    }
    case "videoBadges": {
      // The *centred* play control, not the full-size hit area: that container
      // is a sibling of this one and also holds the duration badge, so carrying
      // it would draw a second pill wherever the fragment is placed.
      const centred = [...(art?.querySelectorAll("div") ?? [])].find((d) => {
        const cls = String(d.className || "");
        return cls.includes("pointer-events-none") && cls.includes("inset-0") && cls.includes("items-center justify-center") && d.querySelector('button[aria-label="Play"]');
      });
      const play = centred ?? art?.querySelector("button[aria-label='Play']")?.parentElement ?? null;
      const duration = [...(art?.querySelectorAll("div") ?? [])].find(
        (d) => String(d.className).includes("inline-flex h-5") && /^\d+:\d\d$/.test(d.textContent.trim()),
      );
      return {
        play: play?.outerHTML ?? null,
        duration: duration?.outerHTML ?? null,
        error: duration ? undefined : "no duration pill",
      };
    }
    default:
      return fail(`unknown kind ${kind}`);
  }
}

/**
 * Loads every template. One page load per captured file (not per template),
 * with all requests aborted: this reads markup, so it needs neither the
 * stylesheet nor the fonts and costs a few milliseconds each.
 */
export async function loadTemplates(browser) {
  const byFile = new Map();
  for (const [name, spec] of Object.entries(TEMPLATES)) {
    if (!byFile.has(spec.file)) byFile.set(spec.file, []);
    byFile.get(spec.file).push(name);
  }
  const context = await browser.newContext({ viewport: { width: 600, height: 900 } });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.abort());
  const templates = { notes: [] };
  try {
    for (const [file, names] of byFile) {
      const html = await readFile(join(CORPUS, file), "utf8");
      await page.setContent(html, { waitUntil: "domcontentloaded" }).catch(() => {});
      for (const name of names) {
        const spec = TEMPLATES[name];
        const out = await page.evaluate(extractInPage, { article: spec.article, id: spec.id, kind: spec.kind });
        if (out.error) {
          templates.notes.push(`${name}: ${out.error}`);
          continue;
        }
        templates[name] = out.html ?? out;
      }
    }
  } finally {
    await context.close();
  }
  for (const name of Object.keys(TEMPLATES)) {
    if (!templates[name]) throw new Error(`chrome: template ${name} could not be extracted (${templates.notes.join("; ")})`);
  }
  const vb = templates["fragments.videoBadges"] ?? {};
  templates["fragments.videoPlay"] = vb.play ?? null;
  templates["fragments.videoDuration"] = vb.duration ?? null;
  // Two views of the same extraction: the cells the replica rebuilds from, and
  // the fragments it splices in.
  templates.cells = { timeline: templates["cell.timeline"], detail: templates["cell.detail"] };
  templates.fragments = {
    showMore: templates["fragments.showMore"],
    socialRow: templates["fragments.pinned"],
    affiliate: templates["fragments.affiliate"],
  };
  return templates;
}

// ----------------------------------------------------------------- helpers --

export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Drops unpaired surrogates: they are not valid JSON and cannot be laid out. */
export function wellFormed(s) {
  return String(s ?? "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/**
 * Replaces the single occurrence of `pattern`, or throws. Every mutation of a
 * captured template goes through this: a silent no-op would produce a replica
 * that is quietly not X's markup.
 */
export function swap(html, pattern, value, label) {
  const rx = new RegExp(pattern.source, "g" + (pattern.flags.replace(/g/g, "") ?? ""));
  const count = [...html.matchAll(rx)].length;
  if (count !== 1) throw new Error(`chrome-markup: ${label ?? pattern} matched ${count} times`);
  return html.replace(pattern, typeof value === "function" ? value : () => value);
}

/** Replaces every occurrence (0 allowed), e.g. an attribute that may repeat. */
export function swapAll(html, pattern, value) {
  return html.replace(pattern, typeof value === "function" ? value : () => value);
}

/** The `aspect-ratio` CSS value X writes for a media box, plus its 510 px cap. */
export function aspectStyle(ar, { centered = false } = {}) {
  const safe = Number.isFinite(ar) && ar > 0 ? ar : 16 / 9;
  const parts = [`aspect-ratio:${ratioNumber(safe)}`];
  if (safe < 1) parts.push(`max-width:${ratioNumber(MAX_MEDIA_HEIGHT * safe)}px`);
  return parts.join(";");
}

/** CSS number formatting: shortest round-trip, never exponent notation. */
export function ratioNumber(v) {
  const s = String(v);
  return s.includes("e") ? v.toFixed(6) : s;
}

const MIME = {
  "/9j/": "image/jpeg",
  iVBOR: "image/png",
  UklGR: "image/webp",
  R0lGO: "image/gif",
  AAAA: "image/avif",
  Qk0: "image/bmp",
};

/**
 * A data URI for the post's own bytes, or null. The declared type is only a
 * hint — Chrome content-sniffs `<img>` sources — but getting it right keeps the
 * data URI readable in a DOM dump.
 */
export function dataUri(base64) {
  if (!base64) return null;
  const head = String(base64).slice(0, 5);
  const type = MIME[head] ?? "image/jpeg";
  return `data:${type};base64,${base64}`;
}

// ------------------------------------------------------- carousel layout --
//
// Port of the client's `mediaCarouselLayout` (`DIdg36-I.js`), the same model
// `crates/xeet-core/src/cards/media.rs` uses. It has to run here because X's
// server writes the result *into the markup* (`padding-bottom` on the
// carousel's box, `aspect-ratio` on each cell): without it the replica would
// have to keep the captured post's sizes, which belong to another post's images.

const GAP = 4;
const BASE = 0.68;
const MAX_CELL = 0.8;
const PEEK = 0.67;
const FALLBACK = 1.24446;
const COMPACT_BASE = 0.85;
const COMPACT_FALLBACK = 0.66;
const SPARE = 0.33;
const SPARE_2 = 0.33;

const R = (ratio, offset = 0) => ({ ratio, offset });
const minR = (a, b) => (a.ratio <= b.ratio ? a : b);
const maxR = (a, b) => (a.ratio >= b.ratio ? a : b);
const cellRatio = (height, ar) => (ar == null ? height : Math.min(height * ar, MAX_CELL));

function fit(ars) {
  if (ars.some((a) => a == null)) return null;
  const numeric = ars.filter((a) => a != null);
  if (numeric.length < 2 || numeric.some((a) => a <= 0)) return null;
  const gaps = GAP * (numeric.length - 1);
  let rest = numeric;
  let dropped = 0;
  for (;;) {
    const sum = rest.reduce((x, y) => x + y, 0);
    if (sum <= 0) return null;
    const height = (1 - dropped * MAX_CELL) / sum;
    if (height <= 0) return null;
    const keep = rest.filter((a) => height * a <= MAX_CELL);
    if (keep.length === rest.length) return R(height, -gaps * height);
    dropped += rest.length - keep.length;
    if (keep.length === 0) return null;
    rest = keep;
  }
}

function peek(ars) {
  const ar0 = ars[0] ?? 1;
  const ar1 = ars[1] ?? 1;
  if (ar0 <= 0 || ar1 <= 0) return null;
  const has0 = ars[0] != null;
  const has1 = ars[1] != null;
  const candidates = [];
  const push = (num, den) => {
    if (den > 0) {
      const r = num / den;
      if (r > 0) candidates.push(R(r, -GAP * r));
    }
  };
  const den = ar0 + PEEK * ar1;
  const h1 = den > 0 ? 1 / den : 0;
  if (h1 > 0 && (!has0 || h1 * ar0 <= MAX_CELL) && (!has1 || h1 * ar1 <= MAX_CELL)) push(1, den);
  if (has0) {
    const d = PEEK * ar1;
    const h = d > 0 ? 0.2 / d : 0;
    if (h > 0 && h * ar0 >= MAX_CELL && (!has1 || h * ar1 <= MAX_CELL)) push(0.2, d);
  }
  if (has1) {
    const d = ar0;
    const h = d > 0 ? (1 - PEEK * MAX_CELL) / d : 0;
    if (h > 0 && h * ar1 >= MAX_CELL && (!has0 || h * ar0 <= MAX_CELL)) push(1 - PEEK * MAX_CELL, d);
  }
  return candidates.length ? candidates.reduce(minR) : null;
}

function secondVisible(e, ars) {
  const n = cellRatio(e.ratio, ars[0] ?? null);
  const r = cellRatio(e.ratio, ars[1] ?? null);
  if (r <= 0) return 0;
  return Math.min(Math.max(1 - n, 0), r) / r;
}

function limited(ars, n) {
  let limit = Infinity;
  let any = false;
  for (const a of ars.slice(0, n)) {
    if (a != null && a > 0) {
      limit = Math.min(limit, MAX_CELL / a);
      any = true;
    }
  }
  return any ? R(limit, 0) : null;
}

function preferFit(e, ars, fallback) {
  const f = fit(ars);
  return f && f.ratio >= e.ratio ? minR(f, fallback) : e;
}

function two(e, ars) {
  const f = fit(ars);
  return f && f.ratio < e.ratio && secondVisible(e, ars) >= SPARE_2 ? f : e;
}

function many(e, ars, fallback) {
  if (1 - secondVisible(e, ars) >= SPARE) return e;
  const p = peek(ars);
  if (!p) return e;
  let best = minR(p, fallback);
  const cap = limited(ars, 2);
  if (cap) best = minR(best, maxR(cap, e));
  return best.ratio > e.ratio ? best : e;
}

/**
 * The carousel's height (`ratio` × slot width, plus `offset` px) and each
 * cell's width/height ratio, for a list of image aspect ratios.
 */
export function carouselLayout(ars, compact = false) {
  const list = ars.map((a) => (Number.isFinite(a) && a > 0 ? a : null));
  const base = compact ? BASE * COMPACT_BASE : BASE;
  const fallback = compact ? R(COMPACT_FALLBACK, 0) : R(FALLBACK, 0);
  const anchor = list.some((a) => a == null) ? minR(fallback, R(MAX_CELL, 0)) : fallback;
  const start = minR(R(base, 0), anchor);
  const e0 = preferFit(start, list, anchor);
  const chosen = list.length <= 1 ? e0 : list.length === 2 ? two(e0, list) : many(e0, list, anchor);
  const h = chosen.ratio;
  const itemAspects = list.map((a) => cellRatio(h, a) / h);
  return {
    heightRatio: chosen.ratio,
    heightOffset: chosen.offset,
    itemAspects,
    overflows: chosen.ratio * itemAspects.reduce((x, y) => x + y, 0) > 1.000001,
  };
}

/** X's `padding-bottom` value for the carousel box. */
export function carouselPaddingBottom(dims) {
  const pct = Number((dims.heightRatio * 100).toFixed(4));
  const pctText = `${pct}`;
  const offset = Number(Math.abs(dims.heightOffset).toFixed(3));
  return offset > 0 ? `calc(${pctText}% - ${offset}px)` : `${pctText}%`;
}

// ------------------------------------------------------------------ media --

/** Replaces the first occurrence only (0 allowed). */
export function swapFirst(html, pattern, value, label) {
  const at = new RegExp(pattern.source, pattern.flags).exec(html);
  if (!at) return html;
  void label;
  return html.slice(0, at.index) + (typeof value === "function" ? value(...at) : value) + html.slice(at.index + at[0].length);
}

// ------------------------------------------- media attribution ("Post video") --
//
// When a post embeds another user's video or photo (X's `source_user_results`,
// the model's `media[].sourceAuthor`), X credits them inside the media: a 13 px
// avatar and a white name in the bottom-left pill of a photo, or appended to the
// duration pill of a video after the clock (`ESPN.html:2120005259485425936`,
// `text-ProductHunt.html` for the photo pill in its hover controls).

/**
 * The source author X would credit, or `null`.
 *
 * Three conditions, X's: the field is present and has a name or a handle; and
 * when both handles are known they differ — a post crediting its own author is
 * not an attribution (`@ESPN` embedding `@ESPN`'s own video shows nothing).
 */
export function mediaSourceOf(media, ownerHandle) {
  const source = media?.sourceAuthor;
  if (!source) return null;
  const name = String(source.name ?? "").trim();
  const handle = String(source.handle ?? "").trim();
  if (!name && !handle) return null;
  const owner = String(ownerHandle ?? "").trim().toLowerCase();
  if (handle && owner && handle.toLowerCase() === owner) return null;
  return source;
}

/** The 13 px avatar + white name + verification icon both pills share. */
function mediaSourceInner(source) {
  const handle = String(source.handle ?? "");
  const avatar = dataUri(source.avatar) ?? DEFAULT_AVATAR_URL;
  const shape = source.squareAvatar ? "rounded-[10%]" : "rounded-full";
  const icon = { blue: "#icon-verified-premium-color", business: "#icon-verified-business-color", government: "#icon-verified-government-color" }[source.verified];
  const badge = icon
    ? `<div class="max-w-full text-subtext2 font-normal text-primary flex shrink-0 items-center gap-1">` +
      `<span aria-label="Verified account" class="flex items-center" role="img">` +
      `<svg fill="none" viewBox="0 0 24 24" display="flex" role="img" width="1em" height="1em" aria-hidden="true" class="size-[1em] shrink-0">` +
      `<use href="${icon}"></use></svg></span></div>`
    : "";
  return (
    `<span class="inline-flex size-[13px] shrink-0">` +
    `<div class="x-avatar ${shape} size-full" aria-hidden="true">` +
    `<img draggable="false" alt="${escapeHtml(handle ? `@${handle}` : "")}" class="size-full object-cover" src="${escapeHtml(avatar)}"/></div></span>` +
    `<div class="flex items-center gap-1 min-w-0">` +
    `<span class="max-w-full min-w-0 flex shrink-0 items-center gap-1">` +
    `<div class="max-w-full text-subtext2 font-normal text-white line-clamp-1 break-all min-w-0">${escapeHtml(source.name?.trim() || handle)}</div>` +
    badge +
    `</span></div>`
  );
}

/** The attribution appended to a video's duration pill, after the clock. */
function videoSourceSpan(source) {
  return `<span class="inline-flex min-w-0 items-center gap-1 align-middle ms-2" data-xeet-media-source="1">${mediaSourceInner(source)}</span>`;
}

/** A photo's own attribution: the bottom-left pill (`bg-black/70`, `rounded-[6px]`). */
function photoSourceBadge(source) {
  return (
    `<div class="pointer-events-none absolute z-20 flex bottom-3 start-3">` +
    `<a class="rounded-xs x-link group inline-flex max-w-full" href="#media-source">` +
    `<span class="text-subtext2 inline-flex max-w-full min-w-0 items-center rounded-[6px] bg-black/70 py-1 ps-1 pe-2" data-xeet-media-source="1">${mediaSourceInner(source)}</span>` +
    `</a></div>`
  );
}

/**
 * Puts a photo's credit inside the photo box (`relative overflow-hidden`), where
 * X's own pill lives — not on the block around it, which is not positioned and
 * would leave the pill at the cell's bottom-left corner.
 */
function withPhotoSource(html, source, note) {
  // The single-photo box (`relative overflow-hidden`), else a carousel cell's
  // inner `relative h-full w-full` (whose cell clips the rounded corners).
  const range = divRangeAfter(html, "relative overflow-hidden") ?? divRangeAfter(html, "relative h-full w-full");
  if (!range) {
    note("media source attribution: the photo box was not found; the credit is not drawn");
    return html;
  }
  const end = range[1] - "</div>".length;
  return html.slice(0, end) + photoSourceBadge(source) + html.slice(end);
}

/** Puts the attribution inside a duration pill, right after its clock span. */
function withVideoSource(html, source, note) {
  const range = divRangeAfter(html, "inline-flex h-5 items-center gap-1 rounded-sm px-2 font-medium");
  if (!range) {
    note("media source attribution: the duration pill was not found; the credit is not drawn");
    return html;
  }
  const end = range[1] - "</div>".length;
  return html.slice(0, end) + videoSourceSpan(source) + html.slice(end);
}

function cellMarkup(template, media, templates, index, owner) {
  const ar = media.width > 0 && media.height > 0 ? media.width / media.height : 16 / 9;
  const src = dataUri(media.data) ?? stubSvg(media, ar);
  // A video cell carries two ratios (the cell's and the player's); only the
  // cell's own `style` attribute is the carousel's.
  let html = swapFirst(template, /style="aspect-ratio:[^"]*"/, `style="aspect-ratio:${ratioNumber(ar)}"`, "cell aspect");
  html = swapFirst(html, /(<img[^>]*\ssrc=")[^"]*"/, (_m, pre) => `${pre}${escapeHtml(src)}"`, "carousel cell src");
  html = swapFirst(html, /(<img[^>]*\ssrcset=")[^"]*"/, (_m, pre) => `${pre}${escapeHtml(src)} 1x"`, "carousel cell srcset");
  html = swapFirst(html, /(<img[^>]*\swidth=")\d+"/, (_m, pre) => `${pre}${media.width || 1000}"`, "carousel cell width");
  html = swapFirst(html, /(<img[^>]*\sheight=")\d+"/, (_m, pre) => `${pre}${media.height || 1000}"`, "carousel cell height");
  html = swapFirst(html, /(<img[^>]*\salt=")[^"]*"/, (_m, pre) => `${pre}${escapeHtml(media.alt ?? "")}"`, "carousel cell alt");
  html = swapAll(html, /(<video[^>]*\sposter=")[^"]*"/g, (_m, pre) => `${pre}${escapeHtml(src)}"`);
  html = swapFirst(html, /(<a aria-label="View media"[^>]*href=")[^"]*"/, (_m, pre) => `${pre}#media-${index + 1}"`, "cell link");
  if (!media.alt) html = dropAltBadge(html, templates);
  else html = withAltBadge(html, templates);
  const source = mediaSourceOf(media, owner);
  if (media.kind === "video" || media.kind === "gif") {
    html = withVideoBadges(html, media, templates);
    if (source) html = withVideoSource(html, source, () => {});
  } else if (source) {
    // The ALT badge and the credit both sit bottom-left; X shows the credit.
    html = dropAltBadge(html, templates);
    html = withPhotoSource(html, source, () => {});
  }
  return html;
}

/** A gray box with the media's dimensions, so the layout is honest without bytes. */
export function stubSvg(media, ar = 16 / 9) {
  const w = media.width || 1200;
  const h = media.height || Math.round(w / ar);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="#cfd9de"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function dropAltBadge(html, templates) {
  const badge = templates["fragments.altBadge"];
  if (!badge) return html;
  if (html.includes(badge)) return html.replace(badge, "");
  // The badge inside a carousel cell has the same classes but a different id.
  return swapAll(html, /<div class="absolute inset-s-3 bottom-3 z-10 flex max-w-\[calc\(100%-24px\)\] items-center gap-1">(?:(?!<div).)*?<\/div>\s*/g, "");
}

function withAltBadge(html, templates) {
  const badge = templates["fragments.altBadge"];
  if (!badge || html.includes(badge)) return html;
  // A cell that came without one (a skeleton cell) gets the captured badge,
  // after the `View media` overlay when there is one, otherwise just inside the
  // cell's closing tags.
  const after = swapFirst(html, /(<a aria-label="View media"[^>]*>\s*<\/a>)/, (m) => `${m}${badge}`, "alt badge insertion");
  if (after !== html) return after;
  const end = html.lastIndexOf("</div>");
  return end < 0 ? html : html.slice(0, end) + badge + html.slice(end);
}

/**
 * The duration badge's label, transcribed from X's client:
 * `unit-duration-to-video-timestamp-FqoFhlvP` in `BEV1NdT5.js`
 * (sha256 `b616c69066203ef22484…`), called as `(0, d.n)(seconds, "seconds")`
 * by the badge component. Truncates to whole seconds, prints hours only once
 * they are non-zero, and pads every part to two digits — minutes included.
 * No duration (or a nonsense one) is the zero state: `00:00`.
 */
/** A badge label in captured markup: `00:00`, `1:26`, `01:02:03`. */
const VIDEO_CLOCK = />\d+(?::\d\d){1,2}</g;
const VIDEO_CLOCK_ONE = />\d+(?::\d\d){1,2}</;

function videoTimestamp(seconds) {
  const s = Math.floor(Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? Number(seconds) : 0);
  const pad = (v) => String(v).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const rest = [pad(Math.floor((s % 3600) / 60)), pad(s % 60)];
  return (h ? [pad(h), ...rest] : rest).join(":");
}

function withVideoBadges(html, media, templates) {
  const duration = templates["fragments.videoDuration"];
  if (media.kind === "gif") {
    // A GIF autoplays: X shows the `GIF` pill and no play control.
    let out = swapAll(html, /<button type="button" aria-label="Play"[\s\S]*?<\/button>/g, "");
    if (duration) out = swapAll(out, VIDEO_CLOCK, ">GIF<");
    return out;
  }
  if (!duration) return html;
  // X's formatter, not ours: `unit-duration-to-video-timestamp-FqoFhlvP` in
  // `assets/vendor/upstream/js/BEV1NdT5.js` (see SPEC.md §9, "Media duration").
  // The badge is always there; with no duration it shows the zero state, which
  // is exactly how the captured server render has it before the player's
  // metadata arrives.
  const label = videoTimestamp(media.duration);
  return swapAll(html, VIDEO_CLOCK, `>${label}<`);
}

/**
 * The attachment slot's contents for a post's media: one photo/video box, or
 * the carousel for two to four items, plus the `mt-1` tag line when accounts
 * are tagged. Returns the slot's inner wrapper (as X nests it).
 */
export function mediaMarkup(media, templates, { tags = [], compact = false, owner = undefined, note = () => {} } = {}) {
  const items = media.slice(0, 4);
  let body;
  if (items.length <= 1) {
    const m = items[0];
    const ar = m.width > 0 && m.height > 0 ? m.width / m.height : 16 / 9;
    if (m.kind === "video" || m.kind === "gif") {
      body = videoMarkup(m, templates, ar, note, owner);
    } else {
      const src = dataUri(m.data) ?? stubSvg(m, ar);
      body = swap(templates["slot.media1"], /style="aspect-ratio:[^"]*"/, `style="${aspectStyle(ar)}"`, "media aspect");
      body = swap(body, /(<img[^>]*\ssrc=")[^"]*"/, (_m, pre) => `${pre}${escapeHtml(src)}"`, "media src");
      body = swap(body, /(<img[^>]*\ssrcset=")[^"]*"/, (_m, pre) => `${pre}${escapeHtml(src)} 1x"`, "media srcset");
      body = swap(body, /(<img[^>]*\swidth=")\d+"/, (_m, pre) => `${pre}${m.width || 1000}"`, "media width");
      body = swap(body, /(<img[^>]*\sheight=")\d+"/, (_m, pre) => `${pre}${m.height || 1000}"`, "media height");
      body = swap(body, /(<img[^>]*\salt=")[^"]*"/, (_m, pre) => `${pre}${escapeHtml(m.alt ?? "")}"`, "media alt");
      body = swap(body, /(<a aria-label="View media"[^>]*href=")[^"]*"/, (_m, pre) => `${pre}#media-1"`, "media link");
      if (!m.alt) body = dropAltBadge(body, templates);
      // "Post photo": the credit sits bottom-left, where the ALT badge would be.
      const source = mediaSourceOf(m, owner);
      if (source) {
        // The credit takes the ALT badge's corner; X shows one or the other.
        body = dropAltBadge(body, templates);
        body = withPhotoSource(body, source, note);
      }
    }
  } else {
    body = carouselMarkup(items, templates, { compact, owner, note });
  }
  if (tags.length) {
    const label = tagLabel(tags);
    let line = swap(
      templates["fragments.tagLine"],
      /(<a class="rounded-xs x-link[^"]*"[^>]*>)[^<]*(<\/a>)/,
      (_m, open, close) => `${open}${escapeHtml(label)}${close}`,
      "tag line label",
    );
    line = swap(line, /(href=")[^"]*"/, (_m, pre) => `${pre}#media-tags"`, "tag line href");
    body = appendToWrapper(body, line, note);
  }
  return body;
}

function videoMarkup(m, templates, ar, note, owner = undefined) {
  let body = templates["slot.video"];
  // X caps a tall box with `max-width: 510 × ar` on the outer element and
  // leaves the inner one at the plain ratio (the same pair the image box uses).
  let first = true;
  body = swapAll(body, /style="aspect-ratio:[0-9.]+"/g, () => {
    const next = first ? `style="${aspectStyle(ar)}"` : `style="aspect-ratio:${ratioNumber(ar)}"`;
    first = false;
    return next;
  });
  const poster = dataUri(m.data) ?? stubSvg(m, ar);
  body = swapAll(body, /(<video[^>]*\sposter=")[^"]*"/g, (_m, pre) => `${pre}${escapeHtml(poster)}"`);
  body = swapAll(body, /(<img[^>]*\ssrc=")[^"]*"/g, (_m, pre) => `${pre}${escapeHtml(poster)}"`);
  if (m.kind === "gif") {
    // A GIF autoplays: X draws the frame with the `GIF` pill instead of the
    // play control. The console has no GIF capture, so the pill is the video's
    // own duration badge with its label replaced, and the play overlay removed.
    note("GIF drawn with the video box (the corpus has no GIF capture): no play control, a `GIF` pill instead");
    const overlay = divRangeAfter(body, "pointer-events-none absolute inset-0 z-10 flex items-center justify-center");
    if (overlay) body = body.slice(0, overlay[0]) + body.slice(overlay[1]);
    body = swapAll(body, /(aria-label=")Play(")/g, (_m, a, b) => `${a}GIF${b}`);
  }
  // The duration badge sits above the poster. In X's server render the badge is
  // `z-1` and the overlay that holds the poster copy is `z-10`, so the badge is
  // covered until the client raises it on hover — the replica draws what the
  // client shows (and what xeet's display list draws: `bottom_badge`).
  body = swapAll(body, /class="pointer-events-none absolute z-1 flex bottom-3 start-3"/g, 'class="pointer-events-none absolute z-20 flex bottom-3 start-3"');
  if (m.kind === "gif") {
    body = swapAll(body, VIDEO_CLOCK, ">GIF<");
  } else {
    // X's formatter (videoTimestamp); an unknown duration is the zero state.
    body = swapAll(body, VIDEO_CLOCK, `>${videoTimestamp(m.duration)}<`);
  }
  // "Post video": the credit rides in the duration pill, after the clock.
  const source = mediaSourceOf(m, owner);
  if (source) body = withVideoSource(body, source, note);
  return body;
}

function carouselMarkup(items, templates, { compact, owner = undefined, note }) {
  return patchCarousel(templates["slot.carousel"], items, templates, { compact, owner, note });
}

/**
 * Patches a captured carousel for `items`: its `padding-bottom` (computed for
 * these aspect ratios), one cell per item, and each cell's own data. Works on
 * the timeline's carousel and on a quoted card's, whose wrappers differ but
 * whose innards are the same component.
 */
function patchCarousel(template, items, templates, { compact, owner = undefined, note }) {
  const dims = carouselLayout(
    items.map((m) => (m.width > 0 && m.height > 0 ? m.width / m.height : null)),
    compact,
  );
  const cells = splitCells(template);
  if (cells.length < 2) throw new Error("chrome-markup: carousel template has no cells");
  const built = items.map((m, i) => cellMarkup(cells[Math.min(i, cells.length - 1)], m, templates, i, owner));
  let out = replaceRange(template, cells[0], cells[cells.length - 1], built.join(""));
  out = swap(out, /padding-bottom:[^"]*"/, () => `padding-bottom:${carouselPaddingBottom(dims)}"`, "carousel padding");
  if (compact) note("carousel sized with the quoted-post variant (66% base, 0.85 of it)");
  return out;
}

/** The carousel's per-image cell elements, in document order. */
function splitCells(html) {
  const open = '<div class="border-normal h-full min-h-0 min-w-[auto]';
  const out = [];
  let i = 0;
  while ((i = html.indexOf(open, i)) >= 0) {
    let depth = 0;
    let j = i;
    for (;;) {
      const nextOpen = html.indexOf("<div", j + 1);
      const nextClose = html.indexOf("</div>", j + 1);
      if (nextClose < 0) break;
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth++;
        j = nextOpen;
      } else {
        if (depth === 0) {
          j = nextClose + "</div>".length;
          break;
        }
        depth--;
        j = nextClose;
      }
    }
    out.push(html.slice(i, j));
    i = j;
  }
  return out;
}

/** Replaces the span from the start of `first` to the end of `last` with `next`. */
function replaceRange(html, first, last, next) {
  const start = html.indexOf(first);
  const end = html.indexOf(last, start);
  if (start < 0 || end < 0) throw new Error("chrome-markup: carousel cell range not found");
  return html.slice(0, start) + next + html.slice(end + last.length);
}

/** Inserts `inner` as the last child of the slot's inner wrapper. */
function appendToWrapper(wrapper, inner, note) {
  const end = wrapper.lastIndexOf("</div>");
  if (end < 0) {
    note("could not place the media tag line");
    return wrapper;
  }
  return wrapper.slice(0, end) + inner + wrapper.slice(end);
}

/** "A", "A and B", "A and 6 others" — X's label for the accounts tagged in media. */
export function tagLabel(tags) {
  const names = tags.map((t) => String(t).trim()).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

// ------------------------------------------------------------------- card --

/**
 * A link card. `summary_large_image` is the captured component; `summary` is
 * built by `cards-markup.mjs` from the client's own component code (the corpus
 * has no such card); `player` and `app` are drawn with the large-image shape,
 * because no capture shows them — recorded as a note rather than guessed at.
 */
export function cardMarkup({ card, title, domain, image, url }, templates, note) {
  const cleanDomain = String(domain ?? "").replace(/^www\./i, "");
  const kind = card ?? "summary_large_image";
  if (kind === "summary") return summaryCardMarkup({ title, domain: cleanDomain, image }, templates, note);
  if (kind !== "summary_large_image") note(`card \"${kind}\" is drawn with the summary_large_image component (no capture of it)`);
  const ar = image?.width > 0 && image?.height > 0 ? image.width / image.height : 1.91;
  // X always draws this card's image at 1.91; a different image is cropped.
  const boxAr = 1.91;
  // The resolver's own bytes when the post carries them, a labelled box
  // otherwise: the card must show the page's picture, not a placeholder.
  const src = dataUri(image?.data) ?? stubSvg({ width: image?.width ?? 1200, height: image?.height ?? 628 }, ar);
  let html = templates["slot.cardLarge"];
  html = swap(html, /style="aspect-ratio:[0-9.]+"/, `style="aspect-ratio:${ratioNumber(boxAr)}"`, "card aspect");
  html = swap(html, /(<img[^>]*\ssrc=")[^"]*"/, (_m, pre) => `${pre}${escapeHtml(src)}"`, "card image");
  // A `srcset` would win over `src`, and a stale one would fetch a stubbed URL.
  html = swapAll(html, /(<img[^>]*?)\ssrcset="[^"]*"/g, (_m, pre) => pre);
  html = swap(html, /(<img[^>]*\swidth=")\d+"/, (_m, pre) => `${pre}${image?.width ?? 1200}"`, "card image width");
  html = swap(html, /(<img[^>]*\sheight=")\d+"/, (_m, pre) => `${pre}${image?.height ?? 628}"`, "card image height");
  html = swap(html, /(<img[^>]*\salt=")[^"]*"/, (_m, pre) => `${pre}${escapeHtml(title ?? "")}"`, "card image alt");
  html = swap(html, /(<div class="max-w-full text-subtext2 font-normal line-clamp-1 text-ellipsis text-white">)[^<]*(<\/div>)/, (_m, a, b) => `${a}${escapeHtml(title ?? "")}${b}`, "card title");
  html = swap(html, /(<div class="max-w-full text-subtext2 font-normal text-secondary line-clamp-1">)From [^<]*(<\/div>)/, (_m, a, b) => `${a}From ${escapeHtml(cleanDomain)}${b}`, "card domain");
  html = swapAll(html, /(href=")[^"]*"/g, (_m, pre) => `${pre}${escapeHtml(url ?? "#")}"`);
  return html;
}

/** `thumbnail-detail`: the 90 px square thumbnail card (`summary`). */
function summaryCardMarkup({ title, domain, image }, templates, note) {
  void templates;
  void note;
  const img = dataUri(image?.data) ?? stubSvg({ width: image?.width ?? 90, height: image?.height ?? 90 }, 1);
  const html =
    `<div class="flex flex-col gap-3 empty:hidden"><div class="flex flex-col gap-3 empty:hidden">` +
    `<a class="border-normal bg-secondary flex cursor-pointer overflow-hidden rounded-md border">` +
    `<div class="border-normal relative aspect-square w-[90px] shrink-0 overflow-hidden border-e sm:w-[130px]">` +
    `<div style="aspect-ratio:fill" class="h-full w-full"><img class="object-cover h-full w-full" src="${escapeHtml(img)}"/></div></div>` +
    `<div class="flex min-w-0 flex-1 flex-col justify-center gap-0.5 p-3">` +
    `<div class="max-w-full text-subtext2 font-normal text-secondary line-clamp-1">${escapeHtml(domain ?? "")}</div>` +
    `<div class="max-w-full text-body font-normal text-primary line-clamp-2 sm:line-clamp-1">${escapeHtml(title ?? "")}</div>` +
    `</div></a></div></div>`;
  return html;
}

/**
 * An author's picture: the post's own bytes when it has them, else X's default
 * profile image (`DEFAULT_AVATAR_URL`, answered with the vendored file). Both
 * surfaces — the post's own avatar and a quoted post's — go through this, so a
 * payload without bytes looks the same in both columns.
 */
export function avatarSrc(author) {
  return dataUri(author?.avatar) ?? DEFAULT_AVATAR_URL;
}

const quoteAuthorAvatar = avatarSrc;

// ------------------------------------------------------------------ quote --

/**
 * A quoted post. Two forms, chosen by the *quoting* post: the compact one
 * (16 px avatar, 96 px thumbnail beside the text) when the quoting post has
 * media of its own, the full one otherwise. Both come from captured markup;
 * the quoted post's text, author, timestamp, media and (when it is itself a
 * reply) its `Replying to @handle` row are injected.
 */
// ------------------------------------------------- nested quote previews --
//
// A quote of a quote. X draws it as a small block *inside* the quote card
// (`nested-quote-preview-SIs_tkfq`, `assets/vendor/upstream/js/dfWSwB9n.js`),
// gated by `H(outer, quoted, nested)` in that module. The gate is X's, mapped
// onto the model; the markup is that module's `ve`, with its literal classes.
//
// The catalogue of pieces, for the reader of the gate:
//   I(t) — has media (and is not sensitive)          -> `media.length > 0`
//   L(t) — renders media of its own: media, article, jetfuel, a card
//                                                    -> media, or a card in `links`
//   z(t) — same minus jetfuel                        -> same as L for the model
//   ie(t) — anything X will not preview: a card, an article, an unsupported
//          media type, a sensitive-media warning      -> card or unknown media kind
//   ae(outer) — crowded (a reply, promoted, mid-conversation) + rendersMedia
//                                                    -> `replyTo` + L(post)

/** X's `K`: the media types a post can carry (`photo`/`video`/`animated_gif`). */
const NESTED_MEDIA_KINDS = new Set(["image", "video", "gif"]);

/** `L(t)` / `z(t)`: does this post render media of its own (not its quote's)? */
function rendersOwnMedia(post) {
  if (!post) return false;
  const hasMedia = (post.media?.length ?? 0) > 0;
  const hasCard = Object.values(post.links ?? {}).some((link) => link?.card);
  return hasMedia || hasCard;
}

/** `ie(t)`: what X refuses to put in a preview. */
function nestedUnsafe(nested) {
  if (Object.values(nested.links ?? {}).some((link) => link?.card)) return true;
  if ((nested.media ?? []).some((m) => !NESTED_MEDIA_KINDS.has(m.kind))) return true;
  return false;
}

/**
 * X's `H(outer, quoted, nested)` — may this quote card show a nested preview?
 *
 * X compares *user ids*; the model has handles, so the two self-quote tests
 * compare handles when they are present (the lead's mapping). Everything else
 * is verbatim: a reply never carries one (`ae().isCrowded`), the nested post
 * must have an author and must not be a card, and at most **one** of the three
 * levels may render media of its own — `[L(outer), z(quoted), I(nested)]`.
 *
 * The subtlety the lead flagged: `L(outer)` is about the outer post's *own*
 * media/poll/card, not about the fact that it quotes something. A post that
 * only quotes (no media, no card) has `rendersMedia === false`.
 */
export function nestedQuoteEligible({ post, quoted, nested }) {
  if (!post || !quoted || !nested) return false;
  const outer = { crowded: Boolean(post.replyTo), rendersMedia: rendersOwnMedia(post) };
  if (outer.crowded) return false;
  const handle = (value) => String(value ?? "").toLowerCase();
  const outerHandle = handle(post.author?.handle);
  const quotedHandle = handle(quoted.author?.handle);
  const nestedHandle = handle(nested.author?.handle);
  if (!nestedHandle) return false;
  if (outerHandle && outerHandle === quotedHandle) return false;
  if (quotedHandle && quotedHandle === nestedHandle) return false;
  if (nestedUnsafe(nested)) return false;
  const mediaLevels = [outer.rendersMedia, rendersOwnMedia(quoted), (nested.media?.length ?? 0) > 0].filter(Boolean).length;
  return mediaLevels <= 1;
}

/** One verification badge, in the captured shape (`size-[1em]`, `<use>`). */
function nestedBadge(verified) {
  const icon = { blue: "#icon-verified-premium-color", business: "#icon-verified-business-color", government: "#icon-verified-government-color" }[verified];
  if (!icon) return "";
  return (
    `<span aria-label="Verified account" class="flex items-center" role="img">` +
    `<svg fill="none" viewBox="0 0 24 24" display="flex" role="img" width="1em" height="1em" aria-hidden="true" ` +
    `class="size-[1em] shrink-0"><use href="${icon}"></use></svg></span>`
  );
}

/** The nested post's 64 px thumbnail: X's box, its `+N` and play overlays. */
function nestedThumb(media) {
  const first = media[0];
  const extra = media.length - 1;
  const src = dataUri(first.data) ?? stubSvg(first, 1);
  const alt = escapeHtml(first.alt ?? "Image");
  const play =
    '<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" data-icon="icon-player-play" viewBox="0 0 24 24" display="flex" role="img" width="1em" height="1em" aria-hidden="true" class="size-3.5">' +
    '<path d="M6 17.93V6.07a2 2 0 0 1 3.05-1.7l9.67 5.92a2 2 0 0 1 0 3.42l-9.67 5.92A2 2 0 0 1 6 17.93"></path></svg>';
  const overlay =
    extra > 0
      ? `<div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40"><span class="text-subtext1 font-bold text-white">+${extra}</span></div>`
      : first.kind === "video"
        ? `<div class="pointer-events-none absolute inset-0 flex items-center justify-center"><span class="flex size-6 items-center justify-center rounded-full bg-black/60 text-white">${play}</span></div>`
        : "";
  return (
    `<div class="border-normal bg-secondary relative size-16 shrink-0 overflow-hidden rounded-sm border" data-xeet-nested-thumb="1">` +
    `<a class="size-full" aria-label="View media" href="#nested-media">` +
    `<div class="block size-full" role="img" aria-label="${alt}">` +
    `<img alt="${alt}" class="h-full w-full object-cover" decoding="async" loading="lazy" src="${escapeHtml(src)}"/>` +
    `</div></a>${overlay}</div>`
  );
}

/**
 * X's `ve`: the nested preview block, verbatim classes.
 *
 * `spans` are the nested post's own displayed spans (the rules' visible text,
 * entities as text — `render-entity-as-text-MJ9TZj26` renders every entity as a
 * `<span>` with an inherited colour, so no anchors here), clamped to two lines by
 * CSS exactly as X clamps them.
 *
 * The header row is `ce`/`ge`/`w.r`/`w.t`/`f.s` in the module — hashed design
 * system exports (`eT`/`oM` from `ZmTPkOMI.js`, `M_` from `user-name-MWOay3Xo`,
 * `EH` from `condensed-media-bWilVP1J`) whose rendered class lists cannot be
 * resolved inside the vendored bundle. It is built from X's *captured* quote-card
 * header (the same components on the server: `x-middot-group`, the name/`@handle`
 * row, the `inline-flex w-fit shrink-0 whitespace-nowrap` timestamp) at the
 * preview's own sizes: the header is `text-body` (15/20, the middot group's own
 * size) with a `size-4` avatar (`size: "xs"`), and only the clamped body is
 * `text-subtext1` (14/16).
 */
export function nestedQuoteMarkup({ nested, spans, now, note = () => {} }) {
  const author = nested.author ?? {};
  const avatar = avatarSrc(author);
  const shape = author.squareAvatar ? "rounded-[10%]" : "rounded-full";
  const handle = String(author.handle ?? "");
  const stamp = stampLabel(nested.createdAt, now ?? nested.now, { detail: false });
  const href = handle ? `/${encodeURIComponent(handle)}/status/nested` : "#nested";
  const affiliate = author.affiliate
    ? `<a class="rounded-xs x-link max-w-full text-brand flex items-center" aria-label="${escapeHtml(author.affiliate.name ?? "Affiliate")}" href="#affiliate">` +
      `<img alt="${escapeHtml(author.affiliate.name ?? "Affiliate")}" class="border-normal block size-[1em] shrink-0 overflow-hidden rounded-xs border object-cover" loading="lazy" src="${escapeHtml(dataUri(author.affiliate.badge) ?? stubSvg({ width: 32, height: 32 }, 1))}"/></a>`
    : "";
  const header =
    `<div class="flex min-w-0 items-center gap-1">` +
    `<div class="x-avatar ${shape} size-4 shrink-0 overflow-hidden"><img draggable="false" alt="@${escapeHtml(handle)}" class="size-full object-cover" decoding="async" loading="lazy" src="${escapeHtml(avatar)}"/></div>` +
    `<div class="x-middot-group max-w-full text-body font-normal text-secondary min-w-0">` +
    `<div class="flex items-center gap-1 min-w-0">` +
    `<span class="max-w-full min-w-0 flex shrink-0 items-center gap-1">` +
    `<a class="rounded-xs x-link max-w-full min-w-0" href="/${escapeHtml(handle)}">` +
    `<div class="max-w-full text-body font-bold text-primary line-clamp-1 break-all min-w-0">${escapeHtml(author.name ?? "")}</div></a>` +
    `<div class="max-w-full text-body font-normal text-primary flex shrink-0 items-center gap-1">${nestedBadge(author.verified)}${affiliate}</div>` +
    `</span>` +
    `<span class="flex max-w-full min-w-0 items-center gap-2"><a class="rounded-xs x-link max-w-full min-w-0" href="/${escapeHtml(handle)}">` +
    `<span class="max-w-full text-body font-normal text-secondary line-clamp-1 wrap-break-word">@${escapeHtml(handle)}</span></a></span>` +
    `</div>` +
    `<span class="inline-flex w-fit shrink-0 whitespace-nowrap"><a class="rounded-xs x-link max-w-full text-body text-secondary inline-flex w-fit" data-xeet-nested-stamp="1" href="${escapeHtml(href)}">${escapeHtml(stamp)}</a></span>` +
    `</div>` +
    `</div>`;
  const text =
    `<div class="text-subtext1 line-clamp-2 whitespace-pre-wrap wrap-anywhere">` +
    spans.map((span) => `<span class="max-w-full text-[length:inherit] font-[weight:inherit] text-[color:inherit]">${escapeHtml(span.text)}</span>`).join("") +
    `</div>`;
  const media = nested.media ?? [];
  const body = media.length
    ? `<div class="flex min-w-0 items-center gap-2">${nestedThumb(media)}<div class="min-w-0 flex-1">${text}</div></div>`
    : text;
  return (
    `<div class="outline-focus transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 [--media-overhang-end:0px] [--media-overhang-start:0px] cursor-pointer hover:bg-black-03 dark:hover:bg-white-03 relative -mx-1.5 -my-1 rounded-[9px] px-1.5 py-1" data-href="${escapeHtml(href)}" data-xeet-nested="quote" tabindex="0">` +
    `<span class="sr-only">Quote</span>` +
    `<div class="flex">` +
    `<div aria-hidden="true" class="bg-tertiary w-[3px] shrink-0 rounded-full"></div>` +
    `<div class="flex min-w-0 flex-1 flex-col gap-2 py-1 ps-3">${header}${body}</div>` +
    `</div></div>`
  );
}

export function quoteMarkup(quote, templates, { compact = false, body = [], now = undefined, nested = null, note = () => {} } = {}) {
  let html = templates[compact ? "slot.quoteCompact" : "slot.quoteFull"];
  const art = nestedArticleRange(html);
  if (!art) throw new Error("chrome-markup: quoted card has no <article>");
  let inner = html.slice(art[0], art[1]);

  const author = quote.author ?? {};
  // The quoted author's picture: its own bytes, else X's default profile image.
  const avatar = quoteAuthorAvatar(author);
  inner = swap(inner, /(<div class="x-avatar[^"]*">\s*<img[^>]*\ssrc=")[^"]*"/, (_m, pre) => `${pre}${escapeHtml(avatar)}"`, "quote avatar");
  // A captured avatar carries a `srcset`, and `srcset` wins over `src`.
  inner = swapAll(inner, /(<div class="x-avatar[^"]*">\s*<img[^>]*?)\ssrcset="[^"]*"/g, (_m, pre) => pre);
  // The shape is the model's `squareAvatar`, never the template's (which came
  // from some other account) and never inferred from the badge.
  inner = swapAll(inner, /(<div class="x-avatar[^"]*">)/g, (_m, pre) =>
    pre.replace(/rounded-\[10%\]|rounded-full/g, author.squareAvatar ? "rounded-[10%]" : "rounded-full"),
  );
  if (author.name) {
    inner = swap(inner, /(<div class="max-w-full text-body font-bold text-primary line-clamp-1 break-all[^"]*">)[^<]*(<\/div>)/, (_m, a, b) => `${a}${escapeHtml(author.name)}${b}`, "quote name");
  }
  if (author.handle) {
    inner = swap(inner, /(<span class="max-w-full text-body font-normal text-secondary line-clamp-1 wrap-break-word[^"]*">)@[^<]*(<\/span>)/, (_m, a, b) => `${a}@${escapeHtml(author.handle)}${b}`, "quote handle");
    inner = swapAll(inner, /(href=")\/[^"]*"/g, (_m, pre) => `${pre}/i/quote"`);
  }
  inner = applyBadge(inner, author.verified, { required: false });
  inner = applyAffiliate(inner, author.affiliate, templates);

  // Timestamp: the captured `data-base-ui-tooltip-trigger` anchor plus the
  // inline `<script>` X's client uses to format it.
  //
  // The *instant* is the quoted post's own `createdAt`, but the *reference
  // clock* is the post being rendered (`post.now`), not the quote's: `now` is
  // the render clock the caller passes once, and a quoted post almost never
  // carries one. Reading `quote.now` here made every quote print "Now" — three
  // different `createdAt` values produced byte-identical PNGs — which is the
  // one bug a label port cannot catch on its own. `now` (the caller's clock) is
  // passed in by `attachmentMarkup`; `quote.now` is only the fallback when the
  // outer post has none.
  {
    const stamp = stampLabel(quote.createdAt, now ?? quote.now, { detail: false });
    inner = swapAll(inner, /(<a[^>]*data-base-ui-tooltip-trigger[^>]*>)[^<]*(<\/a>)/g, (_m, a, b) => `${a}${escapeHtml(stamp)}${b}`);
  }
  inner = swapAll(inner, /<script\b[\s\S]*?<\/script>/g, "");
  inner = swapAll(inner, /\sdata-base-ui-tooltip-trigger=""/g, "");

  // The quoted post's body: its own text, entities as brand-coloured links,
  // no hidden ranges (a quoted post is never truncated inline).
  if (body.length) inner = replaceQuoteText(inner, body);
  else inner = replaceQuoteText(inner, []);

  // `Replying to @handle`, when the quoted post is itself a reply.
  const replyRow = templates["fragments.quoteReply"];
  const replyPattern = /<div class="text-body[^"]*"><span[^>]*>Replying to <\/span>[\s\S]*?<\/div>/;
  if (quote.replyToHandle && replyRow) {
    if (replyPattern.test(inner)) {
      inner = inner.replace(replyPattern, () => replyRow.replace(/@?\w+\s*<\/a>/, `@${escapeHtml(quote.replyToHandle)}</a>`));
      inner = swapAll(inner, /(href=")\/[^"]*"/g, (_m, pre) => `${pre}/i/reply"`);
    } else {
      inner = swap(inner, /(<div class="max-w-full text-body font-normal text-primary line-clamp-5)/, (m) => `${replyRow}${m}`, "reply row insertion");
    }
  } else {
    inner = inner.replace(replyPattern, "");
  }

  let withMedia = quotedMedia(inner, quote, templates, { compact, owner: quote.author?.handle, note });
  // The nested quote preview goes at the end of the quoted card's content
  // column, after the quoted post's text and media — X mounts it as the card's
  // `children` (`(<Y result… children={preview}/>)` in the client), so it sits
  // inside the card, aligned with the quoted text, not outside it.
  if (nested) withMedia = insertNestedPreview(withMedia, nested, note);
  // The card keeps X's own wrapper (`role="link"`, the border and radius) and,
  // like every other attachment, sits in the slot's inner wrapper.
  return wrapSlot([html.slice(0, art[0]) + withMedia + html.slice(art[1])]);
}

/** Byte range of the nested `<article>` inside a quoted card. */
function nestedArticleRange(html) {
  const start = html.indexOf("<article>");
  if (start < 0) return null;
  let depth = 0;
  let i = start;
  for (;;) {
    const open = html.indexOf("<article", i + 1);
    const close = html.indexOf("</article>", i + 1);
    if (close < 0) return null;
    if (open >= 0 && open < close) {
      depth++;
      i = open;
    } else {
      if (depth === 0) return [start, close + "</article>".length];
      depth--;
      i = close;
    }
  }
}

/** Replaces the quoted post's text element contents with the body's spans. */
/**
 * Puts the nested preview at the end of the quoted `<article>`, wrapped the way
 * X wraps it (`A_` in `DtaLJItK.js`):
 *
 *     <div class="p-3 [:first-child+&]:pt-0">{children}</div>
 *
 * as the card's last child, *after* the quoted post's media — X's `A_` renders
 * `[header+text, card frame, media, card, …, preview]`. The selector is what
 * makes the top padding conditional: X's DOM puts the quoted media between the
 * text block and this wrapper, so `:first-child + &` matches only when the
 * quoted post draws nothing in between, and then the top padding is 0.
 *
 * The captured quote card has the same shape — the quoted media is the article's
 * second child, a sibling of the `p-3` header+text block — so placing the
 * wrapper after it makes the selector resolve exactly as it does on x.com:
 * 12 px above the preview when the quoted post drew media, 0 when it did not.
 */
function insertNestedPreview(inner, nestedHtml, note) {
  const end = inner.lastIndexOf("</article>");
  if (end < 0) {
    note("nested quote preview: the quoted card has no closing </article>; the preview is not drawn");
    return inner;
  }
  return inner.slice(0, end) + `<div class="p-3 [:first-child+&]:pt-0">${nestedHtml}</div>` + inner.slice(end);
}

function replaceQuoteText(inner, spans) {
  const pattern = /(<div class="max-w-full text-body font-normal text-primary line-clamp-5[^"]*"[^>]*>)([\s\S]*?)(<\/div>)/;
  const html = spans.length ? spansHtml(spans) : "";
  return swap(inner, pattern, (_m, open, _old, close) => `${open}${html}${close}`, "quote body");
}

/**
 * The quoted post's own media.
 *
 * X wraps a quoted card's media differently from a timeline cell's: a full-width
 * carousel sits in `div.relative.mx-auto > div.flex.flex-col.mx-3.mb-3`, so its
 * images are inset by 12 px and its `padding-bottom` percentage is taken from a
 * box 24 px narrower — 15.84 px of height at 600 px wide that a timeline-shaped
 * wrapper gets wrong. Both wrappers are captured (`slot.quoteCarousel` for the
 * carousel, the quote template's own box for the single forms), and the media
 * inside them is patched, never re-shaped.
 */
function quotedMedia(inner, quote, templates, { compact, owner = undefined, note }) {
  const media = quote.media ?? [];
  // The wrapper the captured card carries: the compact thumbnail, the full
  // form's single box, or the full form's carousel.
  const range =
    divRangeAfter(inner, "w-24 shrink-0 relative overflow-hidden") ??
    divRangeAfter(inner, "mx-auto relative overflow-hidden") ??
    divRangeAfter(inner, 'relative mx-auto') ??
    null;
  if (!media.length) {
    if (!range) return inner;
    return inner.slice(0, range[0]) + inner.slice(range[1]);
  }
  const [m] = media;
  const ar = m.width > 0 && m.height > 0 ? m.width / m.height : 16 / 9;
  const src = dataUri(m.data) ?? stubSvg(m, ar);

  if (compact) {
    if (!range) {
      note("quoted post's compact media box not found; the quoted media is not drawn");
      return inner;
    }
    let box = inner.slice(range[0], range[1]);
    box = swapAll(box, /(<img[^>]*\ssrc=")[^"]*"/g, (_m, pre) => `${pre}${escapeHtml(src)}"`);
    box = swapAll(box, /\s(srcset)="[^"]*"/g, "");
    if (m.kind === "video") box = swapAll(box, VIDEO_CLOCK, `>${videoTimestamp(m.duration)}<`);
    if (media.length > 1) note("a quoted post's carousel is drawn with one thumbnail in the compact form");
    return inner.slice(0, range[0]) + box + inner.slice(range[1]);
  }

  if (media.length > 1) {
    const built = patchCarousel(templates["slot.quoteCarousel"], media, templates, { compact: true, note });
    if (range) return inner.slice(0, range[0]) + built + inner.slice(range[1]);
    note("quoted post's media wrapper not found; the carousel is dropped");
    return inner;
  }

  if (!range) {
    note("quoted post's media box not found; the quoted media is not drawn");
    return inner;
  }
  let box = inner.slice(range[0], range[1]);
  box = swapAll(box, /style="aspect-ratio:[^"]*"/g, `style="${aspectStyle(ar, { centered: true })}"`);
  box = swapAll(box, /(<img[^>]*\ssrc=")[^"]*"/g, (_m, pre) => `${pre}${escapeHtml(src)}"`);
  box = swapAll(box, /\s(srcset)="[^"]*"/g, "");
  box = swapAll(box, /(<img[^>]*\swidth=")\d+"/g, (_m, pre) => `${pre}${m.width || 1000}"`);
  box = swapAll(box, /(<img[^>]*\sheight=")\d+"/g, (_m, pre) => `${pre}${m.height || 1000}"`);
  if (m.kind === "video" || m.kind === "gif") {
    // The full form's captured box is a photo. A video or GIF needs what X's
    // video component draws over the poster: the play control (or the GIF pill)
    // and the duration. Both come from the captured video markup, so the
    // classes, sizes and corners are X's.
    box = addVideoBadges(box, m, templates);
    const source = mediaSourceOf(m, owner);
    if (source) box = withVideoSource(box, source, note);
  }
  return inner.slice(0, range[0]) + box + inner.slice(range[1]);
}

/**
 * Puts X's play control (or `GIF` pill) and duration badge over a media box that
 * was captured as a photo. The fragments are the ones the captured video cell
 * carries; only the label changes.
 */
function addVideoBadges(box, media, templates) {
  // The captured overlay also carries the *captured post's* poster `<img>`; the
  // box already has this post's poster, so only the control is wanted here.
  const play = media.kind === "gif" ? null : (templates["fragments.videoPlay"] ?? "").replace(/<img[^>]*>/g, "");
  const pill = templates["fragments.videoDuration"];
  let out = box;
  if (play) {
    // X's own overlay wrapper: centred, non-interactive, above the poster.
    out = swapFirst(
      out,
      /(<div class="relative h-full w-full">)/,
      (m) => `${m}${play}`,
      "play overlay",
    );
  }
  if (pill) {
    const label = media.kind === "video" ? videoTimestamp(media.duration) : "GIF";
    const badge = pill.replace(VIDEO_CLOCK_ONE, `>${label}<`);
    // The wrapper the captured video uses to place the badge bottom-left.
    const wrap = `<div class="pointer-events-none absolute z-20 flex bottom-3 start-3" style="opacity:1"><div class="pointer-events-auto flex min-w-0"><div class="flex min-w-0 items-center gap-0.5">${badge}</div></div></div>`;
    const end = out.lastIndexOf("</div>");
    out = end < 0 ? out + wrap : out.slice(0, end) + wrap + out.slice(end);
  }
  return out;
}

/**
 * The `[start, end)` range of the first `<div>` whose class list starts with
 * `classPrefix`, found by counting nested `<div>` tags. The captured wrappers
 * hold only divs, so the count is exact.
 */
function divRangeAfter(html, classPrefix) {
  const at = html.indexOf(`<div class="${classPrefix}`);
  if (at < 0) return null;
  return tagRange(html, at, "div");
}

/** Replaces the contents of the first `<span>` carrying `classFragment`. */
function replaceInnerOfSpan(html, classFragment, inner, label) {
  const needle = classFragment.startsWith("class=") ? classFragment : `class="${classFragment}"`;
  const open = html.indexOf(needle);
  if (open < 0) throw new Error(`chrome-markup: ${label ?? classFragment} not found`);
  const start = html.lastIndexOf("<span", open);
  const range = tagRange(html, start, "span");
  if (!range) throw new Error(`chrome-markup: ${label ?? classFragment} is not closed`);
  const openEnd = html.indexOf(">", start) + 1;
  return html.slice(0, openEnd) + inner + html.slice(range[1] - "</span>".length);
}

/** The `[start, end)` range of the element that opens at `at` with `tag`. */
function tagRange(html, at, tag) {
  if (at < 0) return null;
  const openTag = `<${tag}`;
  const closeTag = `</${tag}>`;
  let depth = 0;
  let i = at;
  for (;;) {
    const open = html.indexOf(openTag, i + 1);
    const close = html.indexOf(closeTag, i + 1);
    if (close < 0) return null;
    if (open >= 0 && open < close) {
      depth++;
      i = open;
    } else {
      if (depth === 0) return [at, close + closeTag.length];
      depth--;
      i = close;
    }
  }
}

// ------------------------------------------------------------------- poll --

/**
 * The poll result list: one pill per choice, the share as a background width,
 * the percentage right-aligned, the winner in bold. X's captured markup is
 * kept and its numbers substituted; a shape the substitutions do not cover
 * (an open poll without results) keeps the captured markup and says so.
 */
export function pollMarkup(poll, templates, note) {
  const template = templates["slot.poll"];
  const choices = (poll.choices ?? []).slice(0, 4);
  const votes = Array.isArray(poll.votes) ? poll.votes : null;
  if (!choices.length) throw new Error("chrome-markup: a poll with no choices");
  const total = votes ? votes.reduce((a, b) => a + Number(b || 0), 0) : 0;
  const shares = votes && total > 0 ? choices.map((_, i) => Number(votes[i] || 0) / total) : null;
  const best = shares ? shares.indexOf(Math.max(...shares)) : -1;
  if (choices.length > 2) note(`poll with ${choices.length} choices: the third and fourth reuse the captured row`);

  const rows = splitPollRows(template);
  if (!rows.length) throw new Error("chrome-markup: poll template has no rows");
  const rowTemplate = rows[0].html;
  const head = template.slice(0, rows[0].start);
  // Between rows the capture has only whitespace (or nothing); the closing tags
  // of the list live after the last row, in `tail`.
  const gap = template.slice(rows[0].end, rows[1]?.start ?? rows[0].end) || "";
  let tail = template.slice(rows[rows.length - 1].end);
  const footerOpen = '<div class="x-middot-group max-w-full text-subtext2 font-normal text-secondary">';
  if (!tail.includes(footerOpen)) note("poll footer not found; the vote count and status are missing");

  const built = choices.map((label, i) => {
    let row = rowTemplate;
    const share = shares ? shares[i] : 0;
    row = swap(row, /--poll-choice-share:[0-9.]+/, `--poll-choice-share:${ratioNumber(share)}`, "poll share");
    row = swap(row, /data-label="[^"]*"/, `data-label="${escapeHtml(label)}"`, "poll label");
    row = swap(
      row,
      /(<span class="text-primary col-start-1 row-start-1 self-center transition-opacity duration-200 motion-reduce:transition-none)( opacity-[01])?(">)[^<]*(<\/span>)/,
      (_m, a, _o, c, d) => `${a} opacity-100${c}${escapeHtml(label)}${d}`,
      "poll label text",
    );
    if (shares) {
      const text = formatPercent(share * 100);
      row = swap(row, /(<span class="sr-only">)[^<]*(<\/span>)/, (_m, a, b) => `${a}${text}%${b}`, "poll percent (screen reader)");
      row = replaceInnerOfSpan(row, 'class="flex select-none"', percentSpans(text), "poll percent digits");
      // The winner's percentage is bold, the rest are not.
      row = swap(row, /(justify-self-end ps-3[^"]*?)( font-bold)?(")/, (_m, a, _b, c) => `${a}${i === best ? " font-bold" : ""}${c}`, "poll winner");
    }
    return row;
  });

  if (votes) {
    tail = swapAll(tail, /(<span>)[^<]*votes?(<\/span>)/, (_m, a, b) => `${a}${formatVotes(total)} votes${b}`);
  }
  const status = pollStatus(poll);
  if (status) tail = swapAll(tail, /(<span>)(Final results|[^<]*left)(<\/span>)/, (_m, a, _b, c) => `${a}${escapeHtml(status)}${c}`);
  return head + built.join(gap) + tail;
}

/** The poll's footer label: `Final results`, or the time left. */
export function pollStatus(poll) {
  const left = poll.secondsLeft;
  if (left == null) return "Final results";
  const unit = (n, one, many) => `${n} ${n === 1 ? one : many} left`;
  const seconds = Number(left);
  if (!Number.isFinite(seconds) || seconds <= 0) return "Final results";
  if (seconds < 60) return unit(Math.max(1, Math.round(seconds)), "second", "seconds");
  if (seconds < 3600) return unit(Math.round(seconds / 60), "minute", "minutes");
  if (seconds < 86400) return unit(Math.round(seconds / 3600), "hour", "hours");
  return unit(Math.round(seconds / 86400), "day", "days");
}

/** `splitPollRows`: the `role="listitem"` wrappers of the poll template. */
function splitPollRows(html) {
  const open = '<div class="outline-focus rounded-full';
  const out = [];
  let i = 0;
  while ((i = html.indexOf(open, i)) >= 0) {
    let depth = 0;
    let j = i;
    for (;;) {
      const nextOpen = html.indexOf("<div", j + 1);
      const nextClose = html.indexOf("</div>", j + 1);
      if (nextClose < 0) return out;
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth++;
        j = nextOpen;
      } else {
        if (depth === 0) {
          j = nextClose + 6;
          break;
        }
        depth--;
        j = nextClose;
      }
    }
    out.push({ start: i, end: j, html: html.slice(i, j) });
    i = j;
  }
  return out;
}

/**
 * X's share label. It walks the result with one decimal during the count-up
 * animation and lands on one decimal for the final state (`57.5%`), except a
 * whole number, which it prints without `.0`.
 */
export function formatPercent(pct) {
  const one = Math.round(pct * 10) / 10;
  return Number.isInteger(one) ? String(one) : one.toFixed(1);
}

/** The animated percentage: one `<span>` per digit, `.` and `%` pre-spaced. */
function percentSpans(text) {
  const lead = `<span class="invisible w-0">0</span>`;
  const parts = [...text].map((ch) => (ch === "." ? `<span class="whitespace-pre">${ch}</span>` : `<span>${ch}</span>`));
  return lead + parts.join("") + `<span class="whitespace-pre">%</span>`;
}

export function formatVotes(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ------------------------------------------------------------------- body --

/**
 * The post's body as X's spans: plain runs and `text-brand` anchors.
 *
 * `report` is the decisions source (`xeet explain`): `text.visible` is the
 * body the cell shows (hidden ranges removed, URLs shortened, the long-post
 * cut applied) and `entities` carries each token's display form. This rebuilds
 * the spans by walking the source text and checking, at every step, that what
 * it has assembled is a prefix of `text.visible` — so a rules change that this
 * walk does not model falls back to plain text with a note, instead of
 * rendering a body X never drew.
 */
export function bodySpans(report, post, { note = () => {} } = {}) {
  const showMore = String(report?.text?.showMore ?? "") === "inline";
  let visible = wellFormed(report?.text?.visible ?? post.text ?? "");
  // `report.text.visible` includes the affordance's own words: frame lays the
  // `<button>` as a span of the body, so " Show more" is appended to the text it
  // reports. The markup carries it as the captured `<button>`, not as text.
  if (showMore && visible.endsWith(" Show more")) visible = visible.slice(0, -" Show more".length);
  if (!visible) return [];
  const source = wellFormed(post.longPostBody ?? post.text ?? "");
  const entities = [...(report?.entities ?? [])].sort((a, b) => a.range[0] - b.range[0]);
  const hidden = [...(report?.hidden ?? [])].sort((a, b) => a.range[0] - b.range[0]);
  const hiddenAt = (i) => hidden.find((h) => h.range[0] <= i && i < h.range[1]) ?? null;
  const entityAt = (i) => entities.find((e) => e.range[0] === i) ?? null;

  const spans = [];
  let emitted = "";
  let i = hidden.length && hidden[0].range[0] === 0 ? hidden[0].range[1] : 0;
  const start = i;
  const ok = () => visible.startsWith(emitted);
  while (i < source.length) {
    if (!ok()) break;
    const h = hiddenAt(i);
    if (h) {
      i = h.range[1];
      continue;
    }
    const e = entityAt(i);
    if (e) {
      const display = wellFormed(entityDisplay(e, source, post));
      if (emitted.length + display.length <= visible.length) {
        spans.push({ kind: e.kind, text: display, href: entityHref(e, source) });
        emitted += display;
        i = e.range[1];
        continue;
      }
    }
    // A plain run: as far as the next hidden range, entity or the end.
    let j = i + 1;
    while (j < source.length && !hiddenAt(j) && !entityAt(j)) j++;
    let run = wellFormed(source.slice(i, j));
    // Clip the run to the visible remainder (the cut can land inside it).
    const room = visible.length - emitted.length;
    if (run.length > room) run = run.slice(0, room);
    if (run) {
      spans.push({ kind: "plain", text: run });
      emitted += run;
      i = i + run.length;
    } else {
      i = j;
    }
    if (emitted.length >= visible.length) break;
  }
  if (emitted !== visible) {
    let at = 0;
    while (at < Math.min(emitted.length, visible.length) && emitted[at] === visible[at]) at++;
    note(
      `body span rebuild did not reproduce the displayed body (diverges at ${at}: ` +
        `${JSON.stringify(visible.slice(at, at + 24))} shown vs ${JSON.stringify(emitted.slice(at, at + 24))} rebuilt); rendered as plain text`,
    );
    return [{ kind: "plain", text: visible }];
  }
  if (start > 0) note(`body starts at ${start}: leading mentions hidden`);
  return spans;
}

/**
 * The text X prints for an entity. A URL's display form is the one the payload
 * named for the token (`links[token].display`, the `display_url`), falling back
 * to the form the ruleset computed, falling back to the token itself.
 */
function entityDisplay(e, source, post) {
  const token = source.slice(e.range[0], e.range[1]);
  if (e.kind === "url") return post.links?.[token]?.display ?? e.display ?? token;
  return post.entityLabels?.[token] ?? e.display ?? token;
}

function entityHref(e, source) {
  const token = source.slice(e.range[0], e.range[1]);
  if (e.kind === "url") return token;
  if (e.kind === "mention") return `/${token.replace(/^@/, "")}`;
  if (e.kind === "hashtag") return `/hashtag/${encodeURIComponent(token.replace(/^#/, ""))}`;
  if (e.kind === "cashtag") return `/search?q=%23${encodeURIComponent(token.replace(/^\$/, ""))}`;
  return token;
}

/**
 * The body's markup: every span wrapped exactly as X wraps it (`max-w-full
 * text-[length:inherit] …`), entities as `text-brand` anchors.
 */
export function spansHtml(spans) {
  return spans
    .map((s) => {
      if (!s.kind || s.kind === "plain") {
        return `<span class="max-w-full text-[length:inherit] font-[weight:inherit] text-[color:inherit]">${escapeHtml(s.text)}</span>`;
      }
      const attrs =
        s.kind === "url"
          ? ` href="${escapeHtml(s.href)}" rel="noopener noreferrer nofollow" target="_blank" title="${escapeHtml(s.href)}"`
          : ` href="${escapeHtml(s.href)}"`;
      return (
        `<span class="max-w-full text-[length:inherit] font-[weight:inherit] text-[color:inherit]">` +
        `<a class="rounded-xs x-link disabled:cursor-not-allowed disabled:opacity-70 hover:underline max-w-full text-brand"${attrs}>${escapeHtml(s.text)}</a>` +
        `</span>`
      );
    })
    .join("");
}

// -------------------------------------------------------------- badges/rows --

/** Sets the verified badge's sprite, or removes the wrapper when there is none. */
export function applyBadge(html, verified, { required = true } = {}) {
  const icon = { blue: "#icon-verified-premium-color", business: "#icon-verified-business-color", government: "#icon-verified-government-color" }[verified];
  const pattern = /<span aria-label="Verified account"[^>]*>[\s\S]*?<\/span>/;
  if (!/\bspan aria-label="Verified account"/.test(html) && required) return html;
  if (!icon) {
    // Drop the badge and its `gap-1` wrapper, so the name keeps no leftover gap.
    const wrapped = /<div class="max-w-full text-body font-normal text-primary flex shrink-0 items-center gap-1">\s*<span aria-label="Verified account"[\s\S]*?<\/span>\s*<\/div>/;
    if (wrapped.test(html)) return html.replace(wrapped, "");
    return html.replace(pattern, "");
  }
  return html.replace(pattern, (m) => m.replace(/#icon-verified-[a-z]+-color/, icon));
}

/** Sets the affiliation square (a second `size-[1em]` image) or removes it. */
export function applyAffiliate(html, affiliate, templates) {
  const existing = /<a aria-label="[^"]*"[^>]*>[\s\S]*?size-\[1em\][\s\S]*?<\/a>/;
  if (!affiliate) return existing.test(html) ? html.replace(existing, "") : html;
  const fragment = templates["fragments.affiliate"];
  const src = dataUri(affiliate.badge) ?? stubSvg({ width: 32, height: 32 }, 1);
  const name = escapeHtml(affiliate.name ?? "Affiliate");
  if (existing.test(html)) {
    return html.replace(existing, (m) =>
      m
        .replace(/(<img[^>]*\ssrc=")[^"]*"/, (_x, pre) => `${pre}${escapeHtml(src)}"`)
        .replace(/(<img[^>]*\salt=")[^"]*"/, (_x, pre) => `${pre}${name}"`)
        .replace(/(aria-label=")[^"]*"/, (_x, pre) => `${pre}${name}"`),
    );
  }
  if (!fragment) return html;
  const badge =
    `<a aria-label="${name}" class="rounded-xs x-link max-w-full text-brand flex items-center" href="#affiliate">` +
    `<img alt="${name}" class="border-normal block size-[1em] shrink-0 overflow-hidden rounded-xs border object-cover" src="${escapeHtml(src)}"/></a>`;
  // The name block's `gap-1` wrapper is where X puts it, right after the check.
  const wrapper = /(<div class="max-w-full text-body font-normal text-primary flex shrink-0 items-center gap-1">[\s\S]*?)(<\/div>)/;
  if (wrapper.test(html)) return html.replace(wrapper, (_m, a, b) => `${a}${badge}${b}`);
  return html;
}

// ------------------------------------------------------------------ stamps --
//
// The timestamp comes from the post and from nothing else: `post.createdAt` and
// `post.now`, both ISO 8601. This is a port of xeet's own
// `frame::time::{label, relative, full}` (which is in turn X's
// `__xClientTextFormatters` with `precision: "Hours"` and `nowLabel: "Now"`), so
// the Chrome column *cannot* disagree with the native column about the clock:
//
//   * no `createdAt`, or one that does not parse -> "Now" on **both** surfaces
//     (xeet has no clock; before this the replica used `Date.now()` here and the
//     detail surface read "5:04 PM · Nov 10, 2026" for a post xeet called "Now");
//   * detail -> `5:04 PM · Nov 10, 2026`, formatted in the offset the ISO string
//     carries (`…T17:04:00-05:00` is 5:04 PM, not 10:04 PM UTC);
//   * timeline -> "3h" / "Nov 9" / "Nov 9, 2025", with a missing `now` (or one
//     at or before `createdAt`) also reading "Now".

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * xeet's `Instant::parse`: `YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM|±HHMM]`, and a
 * bare `YYYY-MM-DD`. Returns `{ ms, offset }` (epoch milliseconds, and the
 * offset in minutes east of UTC that the string was written in), or `null` for
 * anything else — which the caller turns into "Now", like xeet.
 */
export function parseInstant(text) {
  if (typeof text !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, hh = "00", mi = "00", ss = "00", frac = "", zone = ""] = m;
  const [year, month, day, hour, minute, second] = [y, mo, d, hh, mi, ss].map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const millis = Number(frac.padEnd(3, "0").slice(0, 3));
  let offset = 0;
  if (zone && zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const offHours = Number(digits.slice(0, 2));
    const offMinutes = Number(digits.slice(2, 4));
    if (offHours > 23 || offMinutes > 59) return null;
    offset = sign * (offHours * 60 + offMinutes);
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millis) - offset * 60_000;
  return Number.isFinite(ms) ? { ms, offset } : null;
}

/** The UTC civil fields of an instant (which the caller has already shifted). */
function civil(ms) {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** X's `formatFullTimestamp` in the instant's own offset: `8:50 PM · Mar 21, 2006`. */
export function fullLabel(created) {
  const wall = civil(created.ms + created.offset * 60_000);
  const hour12 = wall.hour % 12 === 0 ? 12 : wall.hour % 12;
  const meridiem = wall.hour < 12 ? "AM" : "PM";
  return `${hour12}:${String(wall.minute).padStart(2, "0")} ${meridiem} · ${MONTHS[wall.month - 1]} ${wall.day}, ${wall.year}`;
}

/** X's `formatRelativePastTimestamp` at `precision: "Hours"`. */
export function relativeLabel(created, now) {
  if (!now) return "Now";
  // Rust truncates toward zero, and a post from the future reads "Now".
  const seconds = Math.trunc((now.ms - created.ms) / 1000);
  if (seconds <= 0) return "Now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.trunc(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.trunc(minutes / 60);
  if (hours < 24) return `${hours}h`;
  // The calendar branch is compared in the *post's* offset, as xeet shifts both
  // instants into the display zone before asking which day it was.
  const shift = created.offset * 60_000;
  const then = civil(created.ms + shift);
  const today = civil(now.ms + shift);
  const date = `${MONTHS[then.month - 1]} ${then.day}`;
  return then.year === today.year ? date : `${date}, ${then.year}`;
}

/**
 * The label the cell prints, from the model's ISO strings and nothing else.
 * `detail` picks the detail surface's absolute form.
 */
export function stampLabel(createdAt, now, { detail = false } = {}) {
  const created = parseInstant(createdAt);
  if (!created) return "Now";
  return detail ? fullLabel(created) : relativeLabel(created, parseInstant(now));
}

export { formatCount, formatViewsCount };

/**
 * Builds the attachment slot's contents for a post, or `null` when the
 * decisions say nothing is attached. Never throws: a component the builders do
 * not cover is skipped with a note, so the Chrome column always renders.
 */
export function attachmentMarkup({ attachment, post, templates, width, decisions, note }) {
  if (!attachment) return null;
  const shown = String(attachment.shown ?? attachment);
  try {
    if (shown === "poll" && post.poll) return pollMarkup(post.poll, templates, note);
    if (shown === "media" && post.media?.length) {
      const media = mediaMarkup(post.media, templates, { tags: post.mediaTags ?? [], owner: post.author?.handle, note });
      // A post with media *and* a quote draws both: `gap-3` between them.
      if (post.quote) return wrapSlot([stripWrapper(media), stripWrapper(quoteMarkup(post.quote, templates, { compact: true, body: decisions.quoteBody, nested: decisions.nestedQuote ?? null, now: post.now ?? post.quote.now, note })) ]);
      return media;
    }
    if (shown === "quote" && post.quote) return quoteMarkup(post.quote, templates, { compact: false, body: decisions.quoteBody, nested: decisions.nestedQuote ?? null, now: post.now ?? post.quote.now, note });
    if (shown === "card" && attachment.url) {
      const link = post.links?.[attachment.url] ?? {};
      return cardMarkup({ card: attachment.card ?? link.card, title: link.title, domain: link.domain ?? hostOf(attachment.url), image: link.image, url: attachment.url }, templates, note);
    }
  } catch (error) {
    note(`attachment (${shown}) could not be built: ${String(error.message).split("\n")[0]}`);
    return null;
  }
  note(`attachment (${shown}) is not modelled by the replica`);
  return null;
}

/** The slot's inner wrapper, as X nests it. */
function wrapSlot(inner) {
  return `<div class="flex flex-col gap-3 empty:hidden">${inner.join("")}</div>`;
}

/** The *contents* of a slot's inner wrapper (dropping X's own wrapper div). */
function stripWrapper(slotHtml) {
  const start = slotHtml.indexOf(">") + 1;
  const end = slotHtml.lastIndexOf("</div>");
  return slotHtml.slice(start, end);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
