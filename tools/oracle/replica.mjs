// Replica harness: X's real post markup, our data, Chrome's geometry.
//
// Development only (PLAN.md §10, layer 1). We take the server-rendered post
// markup out of a captured corpus page, replace the parts that depend on the
// post's data (avatar, name, badge, handle, timestamp, text spans, counts),
// and render the result with X's stylesheet under headless Chrome. The output
// is a geometry dump of every component box plus, optionally, a screenshot.
//
// The point is unlimited ground truth: xeet's own layout is compared against
// this, never against itself.
//
// Usage (one or more fixtures, JSON on stdout):
//
//   node tools/oracle/replica.mjs --fixtures fixtures.json [--out tmp/dir] [--shot]
//
// Round trip against a real post (the Phase 0 gate idea): read a captured
// post's data back out of the DOM, re-render it through the replica at the same
// cell width, and diff the two geometry dumps.
//
//   node tools/oracle/replica.mjs --verify jack-20.html --article 2 --width 526
//
// Fixture shape:
//
//   {
//     "name": "long name blue check",
//     "surface": "timeline" | "detail",
//     "width": 390, "theme": "light" | "dark", "dpr": 2,
//     "timeZone": "UTC",             // for the timestamp formatters
//     "post": {
//       "name": "Vercel", "handle": "vercel",
//       "verified": "none" | "blue" | "business" | "government",
//       "avatar": null,              // or {"color": "#ff8800"}
//       "timestamp": 1731000000000,  // ms since epoch
//       "now": 1794300000000,
//       "views": null,
//       "counts": {"replies": 0, "reposts": 0, "likes": 0, "views": 0, "bookmarks": 0},
//       "text": [{"kind":"plain","text":"hi "},
//                {"kind":"mention","text":"@vercel"},
//                {"kind":"url","text":"https://vercel.com/blog/x","display":"vercel.com/blog/x"}],
//       "clamp": null                // line clamp for this surface, if any
//     }
//   }

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { launch, newPage, setContentAs, VENDOR, ROOT } from "./browser.mjs";

const CORPUS = join(VENDOR, "corpus");

// ---------------------------------------------------------------- skeleton --

// Which captured page and which article inside it supply the template for each
// surface. The assertions in the page fail loudly if X's structure moves.
export const SKELETON = {
  timeline: { corpus: "jack-20.html", article: 2 },
  detail: { corpus: "jack-20.html", article: 0 },
};

/** Captured cells that cut a long post and end it with `Show more`. */
export const LONG_POST_CORPUS = [{ corpus: "Google.html" }, { corpus: "github.html" }];

/** A captured cell that carries a `Pinned` context row (profile timeline). */
export const PINNED_CORPUS = { corpus: "F1.html", article: 0 };

export function corpusPages() {
  return readdirSync(CORPUS).filter((f) => f.endsWith(".html"));
}

/** Article index for a surface, found without a browser. */
export function findArticle(html, surface) {
  const articles = [];
  let i = 0;
  while ((i = html.indexOf("<article", i)) >= 0) {
    articles.push(i);
    i += 8;
  }
  const needle = surface === "detail" ? "text-lead font-normal" : "x-middot-group";
  for (let k = 0; k < articles.length; k++) {
    const end = k + 1 < articles.length ? articles[k + 1] : html.length;
    if (html.slice(articles[k], end).includes(needle)) return k;
  }
  return -1;
}

// ------------------------------------------------------------- formatters --

// Ported from X's client bundle, function `s` in the web client chunk that
// installs `window.__xClientTextFormatters`:
//
//   let p = Math.floor((now - d) / 1000);
//   if (p <= 0) return nowLabel;                      // "Now"
//   if (p < 60) return "{p}s";
//   if (p < 3600) return "{floor(p/60)}m";
//   if (p < 86400) return "{floor(p/3600)}h";
//   same calendar year ? "Mon D" : "Mon D, YYYY"
//
// Date parts come from Intl, which is why this is a harness-only function:
// xeet reimplements the same rules in `frame/time.rs`.
export function formatRelativePastTimestamp({ timestamp, now, timeZone = "UTC", nowLabel = "Now" }) {
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds <= 0) return nowLabel;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  const d = new Date(timestamp);
  const f = new Date(now);
  const year = (x) => new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(x);
  const md = (x) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(x);
  if (year(d) === year(f)) return md(d);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }).format(d);
}

// `formatFullTimestamp`: `${hour numeric:minute 2-digit} · ${Mon D, YYYY}`.
export function formatFullTimestamp({ timestamp, timeZone = "UTC" }) {
  const d = new Date(timestamp);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(d);
  const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }).format(d);
  return `${time} · ${date}`;
}

// X's engagement count text for the action row. Verified against every
// `aria-label`/rendered pair in the corpus (464 pairs, 1..37M).
//
// The detail view's "N Views" label is a *different* formatter
// (`view-count-utils`): plain and grouped below 10,000, then compact with one
// truncated fraction digit with no length fallback.
export function formatCount(n) {
  if (n < 1000) return String(n);
  const oneDecimal = (v, suffix) => String(Math.trunc(v * 10) / 10).replace(/\.0$/, "") + suffix;
  const s = oneDecimal(n / unitOf(n), unitOf(n) === 1e9 ? "B" : unitOf(n) === 1e6 ? "M" : "K");
  // Five characters or more: retry with no fraction digit.
  if (s.length >= 5) return compactTrunc(n, 0);
  return s;
}

function unitOf(n) {
  if (n >= 1e9) return 1e9;
  if (n >= 1e6) return 1e6;
  return 1e3;
}

function compactTrunc(n, digits) {
  if (n < 1000) return String(n);
  const unit = unitOf(n);
  const suffix = unit === 1e9 ? "B" : unit === 1e6 ? "M" : "K";
  const factor = 10 ** digits;
  const value = Math.floor((n / unit) * factor) / factor;
  return String(value) + suffix;
}

/** The detail view's "N Views": plain grouped below 10,000, compact above. */
export function formatViewsCount(n) {
  if (n < 10000) return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return compactTrunc(n, 1);
}

// --------------------------------------------------------------- injection --

const SEL = {
  avatar: "[data-post-avatar] img",
  avatarShape: ".x-avatar",
  avatarColumn: ".relative.w-10.shrink-0",
  contentColumn: ".min-w-0.flex-1.flex-col",
  name: ".line-clamp-1.break-all",
  badge: 'span[aria-label="Verified account"]',
  handle: ".line-clamp-1.wrap-break-word",
  more: 'button[aria-label="More"]',
  text: "div.whitespace-pre-wrap[dir=auto]",
  actions: "[role=group]",
};

const BADGE_ICON = {
  blue: "#icon-verified-premium-color",
  business: "#icon-verified-business-color",
  government: "#icon-verified-government-color",
};

// A 1x1 PNG of one color: the avatar is a box to measure, and this keeps the
// harness hermetic (no image requests).
function solidPng(r, g, b) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crcOf = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crcOf(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = Buffer.from([0x78, 0x01, 0x01, 0x04, 0x00, 0xfb, 0xff, 0x00, r, g, b, 0x00, 0x00, 0x00, 0x01]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function hexColor(s) {
  const t = s.replace("#", "");
  return [parseInt(t.slice(0, 2), 16), parseInt(t.slice(2, 4), 16), parseInt(t.slice(4, 6), 16)];
}

// Runs in the page: builds one replica cell per fixture.
function injectCells({ fixtures, skeletons, affiliateHtml, socialHtml, showMoreHtml, pngs, sel, badges }) {
  const SEL = sel;
  const BADGE_ICON = badges;
  let current = "?";
  const q = (root, sel) => {
    const el = root.querySelector(sel);
    if (!el) throw new Error("replica: selector missed: " + sel + " (fixture " + current + ")");
    return el;
  };

  // Keep the SVG sprite resolvable: X puts it at the top of <body> and we hide
  // the rest of the document.
  const sprite = document.createElement("div");
  for (const symbol of document.querySelectorAll("svg symbol")) sprite.appendChild(symbol.cloneNode(true));
  sprite.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  document.body.appendChild(sprite);

  // Idempotent: a retry after a transient first-pass failure replaces the
  // previous attempt's host instead of stacking a second one.
  document.getElementById("xeet-replica")?.remove();

  const host = document.createElement("div");
  host.id = "xeet-replica";
  host.style.cssText = "position:absolute;left:0;top:0;display:flex;flex-direction:column;gap:40px";
  document.body.appendChild(host);
  for (const child of [...document.body.children]) {
    if (child !== host && child !== sprite) child.style.display = "none";
  }

  for (let k = 0; k < fixtures.length; k++) {
    const fx = fixtures[k];
    current = fx.name ?? String(k);
    const surface = fx.surface ?? "timeline";
    const d = fx.derived ?? {};
    const holder = document.createElement("div");
    holder.style.cssText = `width:${fx.width}px;background:var(--x-bg-primary,#fff)`;
    // X's user font-size setting multiplies every type size through this
    // inherited custom property; setting it on the holder scopes it.
    if (fx.fontScale && fx.fontScale !== 1) {
      holder.style.setProperty("--x-font-scale", String(fx.fontScale));
      // `body` computes its size from the same variable; a holder cannot, so
      // restate the inherited base size the scaled page would have.
      holder.style.fontSize = `${15 * fx.fontScale}px`;
    }
    holder.innerHTML = skeletons[surface];
    const cell = holder.firstElementChild;
    cell.style.borderBottom = "0";
    cell.dataset.xeetFixture = String(k);
    host.appendChild(holder);

    const article = q(cell, "article");
    const post = fx.post ?? {};

    // The context row goes in first, as the article's leading child, so the
    // article's own `gap-1` spaces it from the post.
    if (post.pinned && socialHtml) article.insertAdjacentHTML("afterbegin", socialHtml);

    const avatarUrl = post.avatar?.url ?? pngs[post.avatar?.color ?? "#1d9bf0"];
    q(article, SEL.avatar).setAttribute("src", avatarUrl);

    // Business accounts get `rounded-[10%]` instead of `rounded-full`
    // (`<div class="x-avatar rounded-[10%] size-10">` in NBA.html/IGN.html/
    // text-vercel.html); the skeleton comes from a normal account, so swap the
    // class when the fixture asks for a square avatar.
    if (post.squareAvatar) {
      for (const el of article.querySelectorAll(".x-avatar")) {
        el.classList.remove("rounded-full");
        el.classList.add("rounded-[10%]");
      }
    }

    q(article, SEL.name).textContent = post.name ?? "Name";

    // The affiliate square: a second `size-[1em]` image after the check, in the
    // same `gap-1` wrapper. `post.affiliate` models it; without one the element
    // is dropped so the wrapper has no leftover gap.
    if (post.affiliate && !article.querySelector("a[aria-label]:has(> img)")) {
      // This skeleton comes from an account without an affiliation; add the
      // same markup X serves for one (extracted from a captured post with it).
      const wrapper = article.querySelector(".items-center.gap-1")?.closest("div.flex.shrink-0.items-center.gap-1")
        ?? article.querySelector("div.flex.shrink-0.items-center.gap-1");
      if (wrapper && affiliateHtml) wrapper.insertAdjacentHTML("beforeend", affiliateHtml);
    }
    for (const a of article.querySelectorAll("a[aria-label]:has(img)")) {
      if (!post.affiliate) {
        a.remove();
        continue;
      }
      const img = a.querySelector("img");
      img.setAttribute("src", post.affiliate.url ?? pngs[post.affiliate.color ?? "#f0b429"]);
      img.setAttribute("alt", post.affiliate.name ?? "Affiliate");
      a.setAttribute("aria-label", post.affiliate.name ?? "Affiliate");
    }

    const badge = article.querySelector(SEL.badge);
    if (badge) {
      const icon = BADGE_ICON[post.verified];
      if (!icon) {
        // No badge: drop the whole wrapper, so the name span has no leftover
        // 4px gap. (X only renders that wrapper when there is something in it.)
        (badge.closest("div.flex.shrink-0.items-center.gap-1") ?? badge).remove();
      } else {
        q(badge, "use").setAttribute("href", icon);
      }
    }

    // X renders the at-sign as part of the handle text.
    q(article, SEL.handle).textContent = post.handle ? "@" + post.handle.replace(/^@/, "") : "@handle";

    // Timestamp(s): the captured markup carries both the timeline's relative
    // label and the detail view's full one.
    for (const a of article.querySelectorAll("a[data-base-ui-tooltip-trigger]")) {
      if (d.stamp != null) a.textContent = d.stamp;
      a.removeAttribute("data-base-ui-tooltip-trigger");
    }
    for (const s of article.querySelectorAll("script")) s.remove();
    if (surface === "detail" && d.views != null) {
      // The captured detail markup has no views slot (this post's payload has
      // no impression count), so clone the timestamp row's pieces: same
      // classes, same separator element.
      // The captured row already ends with the `·` separator (`last:hidden`,
      // so it only shows when something follows it); appending the view count
      // makes it visible. Do not add a second one.
      const row = article.querySelector(".text-secondary.flex.shrink");
      const views = document.createElement("span");
      views.className = "inline-flex w-fit";
      views.setAttribute("data-xeet-views", "");
      const inner = document.createElement("span");
      inner.className = "max-w-full text-body text-secondary";
      inner.textContent = d.views;
      views.appendChild(inner);
      row.appendChild(views);
    }

    // Text spans.
    const textDiv = q(article, SEL.text);
    if (post.text) {
      textDiv.textContent = "";
      for (const span of post.text) {
        const wrap = document.createElement("span");
        wrap.className = "max-w-full text-[length:inherit] font-[weight:inherit] text-[color:inherit]";
        if (!span.kind || span.kind === "plain") {
          wrap.textContent = span.text;
        } else {
          const a = document.createElement("a");
          a.className = "rounded-xs x-link disabled:cursor-not-allowed disabled:opacity-70 hover:underline max-w-full text-brand";
          const shown = span.display ?? span.text;
          a.textContent = shown;
          if (span.kind === "url") {
            a.setAttribute("href", span.text);
            a.setAttribute("rel", "noopener noreferrer nofollow");
            a.setAttribute("target", "_blank");
            a.setAttribute("title", span.expanded ?? span.text);
          } else {
            a.setAttribute("href", "/" + shown.replace(/^[@#$]/, ""));
          }
          wrap.appendChild(a);
        }
        textDiv.appendChild(wrap);
      }
      // A long post ends with the body's own space, then the button (the
      // captured markup has the space as a text node between the last span and
      // the `<button>`).
      if (post.showMore && showMoreHtml) {
        if (!/(^|\s)$/.test(textDiv.textContent ?? "")) textDiv.appendChild(document.createTextNode(" "));
        textDiv.insertAdjacentHTML("beforeend", showMoreHtml);
      }
    }
    for (const c of [...textDiv.classList]) if (/^line-clamp-/.test(c)) textDiv.classList.remove(c);
    if (post.clamp) textDiv.classList.add("line-clamp-" + post.clamp);

    // Counts. X omits the whole count wrapper when there is no count.
    const counts = post.counts ?? {};
    const actionRow = article.querySelector(SEL.actions);
    if (actionRow) {
      for (const btn of actionRow.querySelectorAll("[data-engagement-action]")) {
        const kind = btn.getAttribute("data-engagement-action");
        const key = { reply: "replies", retweet: "reposts", like: "likes", generic: "views", bookmark: "bookmarks" }[kind];
        const value = key ? counts[key] : null;
        const num = btn.querySelector(".tabular-nums");
        if (!num) continue;
        // X hides a number at zero; the fixture models that by leaving the
        // count out. (Zero-count rendering is not in the corpus, so this is an
        // assumption: the gate never depends on it.)
        if (value == null || value === 0) num.parentElement.remove();
        else q(num, ".x-animated-count-visual").textContent = d.counts?.[key] ?? String(value);
      }
      if (post.counts?.ariaLabel) actionRow.setAttribute("aria-label", post.counts.ariaLabel);
    }
  }
}

// ---------------------------------------------------------------- geometry --

// Runs in the page. Returns one dump per `[data-xeet-fixture]` cell, in CSS
// pixels relative to the cell's border box, rounded to Chrome's 1/64 px unit.
function measureCells({ labelsPerFixture }) {
  const round = (v) => Math.round(v * 64) / 64;
  const out = [];
  const cells = [...document.querySelectorAll("[data-xeet-fixture]")];
  for (let k = 0; k < cells.length; k++) {
    const cell = cells[k];
    const origin = cell.getBoundingClientRect();
    const labels = labelsPerFixture[k] ?? {};
    const boxes = {};
    for (const [label, sel] of Object.entries(labels.boxes)) {
      const el = [cell, ...cell.querySelectorAll("*")].find((n) => n.matches?.(sel));
      boxes[label] = el ? box(el, origin) : null;
    }
    const lines = {};
    for (const [label, sel] of Object.entries(labels.lines ?? {})) {
      const el = cell.querySelector(sel);
      lines[label] = el ? lineBoxes(el, origin) : null;
    }
    const cs = getComputedStyle(cell);
    out.push({
      frame: {
        width: round(origin.width),
        height: round(origin.height),
        padding: {
          top: parseFloat(cs.paddingTop),
          right: parseFloat(cs.paddingRight),
          bottom: parseFloat(cs.paddingBottom),
          left: parseFloat(cs.paddingLeft),
        },
        background: getComputedStyle(document.documentElement).backgroundColor,
      },
      boxes,
      lines,
    });
  }
  return out;

  function box(el, origin) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // `display: none` boxes report a 0x0 rect at the page origin, which is
    // meaningless as geometry: report absence instead.
    if (cs.display === "none") return null;
    return {
      x: round(r.x - origin.x),
      y: round(r.y - origin.y),
      w: round(r.width),
      h: round(r.height),
      display: cs.display,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      fontWeight: cs.fontWeight,
      color: cs.color,
    };
  }

  // One rect per grapheme cluster (Chrome's own segmentation), grouped into
  // line boxes by top edge. This is the DOM analogue of `inline::Fragment`.
  function lineBoxes(el, origin) {
    const seg = new Intl.Segmenter();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const frags = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      for (const { segment, index } of seg.segment(text)) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + segment.length);
        const r = range.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        frags.push({
          text: segment,
          x: round(r.x - origin.x),
          y: round(r.y - origin.y),
          w: round(r.width),
          h: round(r.height),
        });
      }
    }
    const lines = [];
    for (const f of frags) {
      const line = lines.find((l) => Math.abs(l.y - f.y) < 0.5);
      if (line) {
        line.text += f.text;
        line.x = Math.min(line.x, f.x);
        line.right = Math.max(line.right, f.x + f.w);
        line.h = Math.max(line.h, f.h);
        line.frags.push(f);
      } else {
        lines.push({ text: f.text, x: f.x, y: f.y, right: f.x + f.w, h: f.h, frags: [f] });
      }
    }
    return lines.sort((a, b) => a.y - b.y).map((l) => ({
      text: l.text,
      x: round(l.x),
      y: round(l.y),
      w: round(l.right - l.x),
      h: round(l.h),
      frags: l.frags,
    }));
  }
}

// Element selectors per surface: same components, different structure.
function labelsFor(surface) {
  const boxes = {
    cell: ":scope",
    article: "article",
    pinnedRow: "article > div:first-child:has(svg[data-icon='icon-pin-fill'])",
    pinnedIcon: "svg[data-icon='icon-pin-fill']",
    pinnedText: "article > div:first-child > span:last-child",
    // The long post's inline `Show more`, inside the body (not the header's
    // `More` button).
    showMore: "div.whitespace-pre-wrap[dir=auto] > button",
    avatarColumn: SEL.avatarColumn,
    avatar: "[data-post-avatar]",
    avatarShape: SEL.avatarShape,
    avatarImage: SEL.avatar,
    contentColumn: SEL.contentColumn,
    headerRow: ".items-start.justify-between",
    nameBlock: "span.flex.items-center.gap-1",
    name: SEL.name,
    badge: SEL.badge,
    affiliate: 'a[aria-label]:has(> img)',
    affiliateImage: 'a[aria-label] > img',
    handle: SEL.handle,
    more: SEL.more,
    text: SEL.text,
    actionRow: SEL.actions,
    reply: '[data-engagement-action="reply"]',
    replyPill: '[data-engagement-action="reply"] .x-engagement-pill',
    replyIcon: '[data-engagement-action="reply"] svg',
    replyCount: '[data-engagement-action="reply"] .tabular-nums',
    retweet: '[data-engagement-action="retweet"]',
    like: '[data-engagement-action="like"]',
    views: '[data-engagement-action="generic"]',
    bookmark: '[data-engagement-action="bookmark"] button',
    share: '[data-engagement-action="share"]',
  };
  if (surface === "timeline") {
    boxes.middotGroup = ".x-middot-group";
    boxes.timestamp = "span.inline-flex.w-fit";
    boxes.timestampLink = "span.inline-flex.w-fit a";
  } else {
    boxes.timestampRow = ".text-secondary.flex.shrink";
    boxes.timestamp = "span.inline-flex.w-fit";
    boxes.timestampLink = "span.inline-flex.w-fit a";
    boxes.timestampViews = "[data-xeet-views]";
    boxes.timestampDot = '.text-secondary.flex.shrink [aria-hidden="true"]';
  }
  const lines = { text: SEL.text, name: SEL.name, handle: SEL.handle };
  return { boxes, lines };
}

// The style probe answers "what did X's CSS decide", for the token extractor
// and for anyone debugging a mismatch.
const STYLE_PROBES = {
  name: SEL.name,
  handle: SEL.handle,
  text: SEL.text,
  count: ".tabular-nums",
  replyIcon: '[data-engagement-action="reply"] svg',
  cell: ":scope",
  avatarShape: SEL.avatarShape,
  more: SEL.more,
};

function measureStyles({ probes }) {
  const cell = document.querySelector("[data-xeet-fixture]");
  const out = {};
  for (const [label, sel] of Object.entries(probes)) {
    const el = sel === ":scope" ? cell : cell?.querySelector(sel);
    if (!el) {
      out[label] = null;
      continue;
    }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out[label] = {
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      fontWeight: cs.fontWeight,
      color: cs.color,
      fontFeatureSettings: cs.fontFeatureSettings,
      fontVariantNumeric: cs.fontVariantNumeric,
      padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft],
      margin: [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft],
      gap: cs.gap,
      borderRadius: cs.borderRadius,
      rect: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 64) / 64),
    };
  }
  return out;
}

/**
 * Extracts one cell's outerHTML (the padded container around a post) from a
 * captured page.
 */
/**
 * The affiliation badge anchor's markup, from a captured post that has one
 * (`jack`'s does). Some skeletons (timeline cells of accounts without an
 * affiliation) have no such element; injecting this one keeps the markup X
 * itself renders.
 */
/**
 * The `Pinned` context row's markup, from a captured cell that has one. The
 * row is the article's first child; a skeleton from an unpinned cell gets it
 * injected so Chrome measures the real thing.
 */
/**
 * The long post's "Show more" `<button>`, from a captured cell that has one.
 * Chrome lays it out as one atomic `inline-block` box, so the replica must
 * carry the real element (with its classes) rather than our own markup.
 */
export async function extractShowMoreHtml(browser, html) {
  const context = await browser.newContext({ viewport: { width: 600, height: 900 } });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.abort());
  await page.setContent(html, { waitUntil: "domcontentloaded" }).catch(() => {});
  const out = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Show more");
    return button?.outerHTML ?? null;
  });
  await context.close();
  return out;
}

export async function extractSocialRowHtml(browser, html, articleIndex) {
  const context = await browser.newContext({ viewport: { width: 600, height: 900 } });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.abort());
  await page.setContent(html, { waitUntil: "domcontentloaded" }).catch(() => {});
  const out = await page.evaluate((index) => {
    const article = [...document.querySelectorAll("article")][index];
    const row = [...(article?.children ?? [])].find((el) => /icon-pin-fill/.test(el.innerHTML));
    return row?.outerHTML ?? null;
  }, articleIndex);
  await context.close();
  return out;
}

export async function extractAffiliateHtml(browser, html, articleIndex) {
  const context = await browser.newContext({ viewport: { width: 600, height: 900 } });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.abort());
  await page.setContent(html, { waitUntil: "domcontentloaded" }).catch(() => {});
  const out = await page.evaluate((index) => {
    const article = [...document.querySelectorAll("article")][index];
    const anchor = article?.querySelector("a[aria-label] > img")?.closest("a");
    return anchor?.outerHTML ?? null;
  }, articleIndex);
  await context.close();
  return out;
}

export async function extractCellHtml(browser, html, articleIndex) {
  const context = await browser.newContext({ viewport: { width: 600, height: 900 } });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.abort());
  await page.setContent(html, { waitUntil: "domcontentloaded" }).catch(() => {});
  const out = await page.evaluate((index) => {
    const articles = [...document.querySelectorAll("article")];
    const article = articles[index];
    if (!article) return null;
    let cell = article.parentElement;
    while (cell && !String(cell.className || "").includes("px-horizontal")) cell = cell.parentElement;
    return (cell ?? article).outerHTML;
  }, articleIndex);
  await context.close();
  if (!out) throw new Error("replica: could not extract the cell markup");
  return out;
}

// ------------------------------------------------------------------ render --

async function skeletons(browser) {
  const out = {};
  for (const surface of Object.keys(SKELETON)) {
    const { corpus, article } = SKELETON[surface];
    const html = await readFile(join(CORPUS, corpus), "utf8");
    const index = article ?? findArticle(html, surface);
    if (index == null || index < 0) throw new Error(`replica: no ${surface} article in ${corpus}`);
    SKELETON[surface].article = index;
    out[surface] = await extractCellHtml(browser, html, index);
    out.affiliate ??= await extractAffiliateHtml(browser, html, index);
  }
  if (!out.affiliate) throw new Error("replica: no captured post has an affiliation badge to copy");
  {
    const { corpus, article } = PINNED_CORPUS;
    const html = await readFile(join(CORPUS, corpus), "utf8");
    out.social = await extractSocialRowHtml(browser, html, article ?? findArticle(html, "timeline"));
    // The long post's `Show more` button comes from a captured long post.
    for (const longPost of LONG_POST_CORPUS) {
      const longHtml = await readFile(join(CORPUS, longPost.corpus), "utf8");
      out.showMore = await extractShowMoreHtml(browser, longHtml);
      if (out.showMore) break;
    }
    if (!out.showMore) throw new Error("replica: no captured long post has a Show more button to copy");
  }
  if (!out.social) throw new Error("replica: no captured cell has a social-context row to copy");
  return out;
}

function derivedFor(fx) {
  const post = fx.post ?? {};
  const zone = fx.timeZone ?? "UTC";
  const surface = fx.surface ?? "timeline";
  const counts = {};
  for (const key of ["replies", "reposts", "likes", "views", "bookmarks"]) {
    if (post.counts?.[key] != null) counts[key] = formatCount(post.counts[key]);
  }
  return {
    stamp:
      post.timestamp == null
        ? null
        : surface === "detail"
          ? formatFullTimestamp({ timestamp: post.timestamp, timeZone: zone })
          : formatRelativePastTimestamp({ timestamp: post.timestamp, now: post.now, timeZone: zone }),
    views: (post.counts?.views ?? post.views) != null ? formatViewsCount(post.counts?.views ?? post.views) + " Views" : null,
    counts,
  };
}

/**
 * Renders `fixtures` (one page, one theme) and returns per-fixture geometry.
 * With `shotDir`, also writes a screenshot of each cell.
 */
export async function renderFixtures(browser, fixtures, { shotDir = null, skeletonsIn = null } = {}) {
  const skeletonsHtml = skeletonsIn ?? (await skeletons(browser));
  const themes = new Set(fixtures.map((f) => f.theme ?? "light"));
  if (themes.size > 1) throw new Error("replica: one page renders one theme; split the fixtures");

  // One page per (theme, viewport width). X's stylesheet has width media
  // queries from 512px up (`sm:`), and a page wide enough for the widest
  // fixture would resolve them for the narrow ones too, so each width gets its
  // own truthful viewport.
  const groups = new Map();
  fixtures.forEach((fx, index) => {
    const key = `${fx.theme ?? "light"}|${fx.width}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  });

  const results = new Array(fixtures.length);
  for (const indices of groups.values()) {
    const group = indices.map((i) => fixtures[i]);
    const theme = group[0].theme ?? "light";
    const dpr = group[0].dpr ?? 2;
    const width = group[0].width;
    const { page, context } = await newPage(browser, { width: Math.ceil(width), height: 900, dpr, theme });

    await setContentAs(page, await readFile(join(CORPUS, SKELETON.timeline.corpus), "utf8"));
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);

    const pngs = {};
    const addPng = (color) => {
      if (!pngs[color]) {
        const [r, g, b] = hexColor(color);
        pngs[color] = "data:image/png;base64," + solidPng(r, g, b).toString("base64");
      }
    };
    addPng("#1d9bf0");
    for (const fx of group) {
      if (fx.post?.avatar?.color) addPng(fx.post.avatar.color);
      if (fx.post?.affiliate?.color) addPng(fx.post.affiliate.color);
    }

    const inject = (target, fixtures, skels, images) =>
      target.evaluate(injectCells, {
        fixtures,
        skeletons: skels,
        affiliateHtml: skels.affiliate,
        socialHtml: skels.social,
        showMoreHtml: skels.showMore,
        pngs: images,
        sel: SEL,
        badges: BADGE_ICON,
      });
    const withDerived = group.map((fx) => ({ ...fx, derived: derivedFor(fx) }));
    // The injection can race the stylesheet's first pass on a cold profile
    // (a skeleton's own text div not yet queryable); retry rather than fail a
    // whole gate run.
    for (let attempt = 1; ; attempt++) {
      try {
        await inject(page, withDerived, skeletonsHtml, pngs);
        break;
      } catch (error) {
        // The page carries X's stylesheet and sprite (set once), so a reload
        // would lose both; retry the injection in place instead.
        if (attempt >= 3) throw error;
        await page.waitForTimeout(120);
      }
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
      void document.body.offsetHeight;
    });

    const labelsPerFixture = group.map((f) => labelsFor(f.surface ?? "timeline"));
    const geometry = await page.evaluate(measureCells, { labelsPerFixture });
    const styles = await page.evaluate(measureStyles, { probes: STYLE_PROBES });

    group.forEach((fx, k) => {
      results[indices[k]] = {
        fixture: { ...fx, derived: withDerived[k].derived },
        frame: geometry[k].frame,
        boxes: geometry[k].boxes,
        lines: geometry[k].lines,
        styles,
        source: { harness: "replica.mjs", skeleton: SKELETON[fx.surface ?? "timeline"], chrome: browser.version() },
      };
    });

    if (shotDir) {
      await mkdir(shotDir, { recursive: true });
      for (let k = 0; k < group.length; k++) {
        const name = (group[k].name ?? `fixture-${indices[k]}`).replace(/[^a-zA-Z0-9_.-]+/g, "-");
        const file = join(shotDir, name + ".png");
        await page.locator(`[data-xeet-fixture="${k}"]`).screenshot({ path: file });
        results[indices[k]].screenshot = file;
      }
    }

    await context.close();
  }
  return results;
}

// Reads a post's data back out of a rendered cell, in fixture form. This is
// what makes the round trip possible: deliver → data → replica → compare.
function snapshotPostInPage() {
  const cell = document.querySelector("[data-xeet-fixture]");
  const article = cell.querySelector("article");
  const name = article.querySelector(".line-clamp-1.break-all")?.textContent ?? "";
  const handle = (article.querySelector(".line-clamp-1.wrap-break-word")?.textContent ?? "").replace(/^@/, "");
  const badge = article.querySelector('span[aria-label="Verified account"] use')?.getAttribute("href") ?? "";
  const verified = badge.includes("business") ? "business" : badge.includes("government") ? "government" : badge ? "blue" : "none";
  const textEl = article.querySelector("div.whitespace-pre-wrap[dir=auto]");
  const text = [];
  if (textEl) {
    for (const child of textEl.childNodes) {
      if (child.nodeType === 3) text.push({ kind: "plain", text: child.textContent });
      else if (child.nodeType === 1) {
        const a = child.querySelector("a");
        if (!a) {
          text.push({ kind: "plain", text: child.textContent });
          continue;
        }
        const href = a.getAttribute("href") || "";
        const kind = href.startsWith("http") ? "url" : href.startsWith("/hashtag/") ? "hashtag" : href.startsWith("/search") ? "cashtag" : "mention";
        const shown = a.textContent;
        const entry = { kind, text: kind === "url" ? a.getAttribute("title") ?? shown : shown, display: kind === "url" ? shown : undefined };
        text.push(entry);
      }
    }
  }
  // Counts, from the row's aria label ("131 replies, 55 reposts, 5264 likes,
  // 47 bookmarks, 468807 views").
  const row = article.querySelector("[role=group][aria-label]");
  const counts = {};
  if (row) {
    const label = row.getAttribute("aria-label") || "";
    for (const m of label.matchAll(/([\d,]+) (replies|reposts|likes|bookmarks|views)/g)) {
      const key = { replies: "replies", reposts: "reposts", likes: "likes", bookmarks: "bookmarks", views: "views" }[m[2]];
      counts[key] = parseInt(m[1].replace(/,/g, ""), 10);
    }
  }
  const isTimeline = !!cell.querySelector(".x-middot-group");
  // A pinned cell starts with the context row.
  const pinned = !!article.firstElementChild?.querySelector("use[href='#icon-pin-fill']");
  // The affiliate square, if the account has one; its image is a stubbed box.
  const affiliateImg = article.querySelector('a[aria-label] > img');
  const affiliate = affiliateImg
    ? { name: affiliateImg.getAttribute("alt") || "Affiliate", color: "#f0b429" }
    : null;
  return { name, handle, verified, affiliate, pinned, text, counts: Object.keys(counts).length ? counts : null, isTimeline };
}

/**
 * The live check: measure a captured post as delivered, then re-render it
 * through the replica with the data read back from its own DOM, at the same
 * cell width, and diff the geometry.
 */
export async function verifyCorpus(browser, { corpus, article, width, theme = "light", dpr = 1 }) {
  const html = await readFile(join(CORPUS, corpus), "utf8");
  const index = article ?? findArticle(html, "timeline");

  // Delivered geometry, at the page's own cell width.
  const { page, context } = await newPage(browser, { width: width + 24, height: 1400, dpr, theme });
  await setContentAs(page, html);
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  await page.evaluate(async () => {
    await document.fonts.ready;
    void document.body.offsetHeight;
  });
  const delivered = await page.evaluate(({ index, labels }) => {
    const articles = [...document.querySelectorAll("article")];
    let el = articles[index];
    // Walk up to the padded cell, then force its width to the natural one.
    let cell = el.parentElement;
    while (cell && !String(cell.className || "").includes("px-horizontal")) cell = cell.parentElement;
    cell = cell ?? el;
    cell.setAttribute("data-xeet-fixture", "0");
    const w = cell.getBoundingClientRect().width;
    const snapped = el.getBoundingClientRect().width + 32;
    void w;
    return { cellWidth: Math.round(snapped * 64) / 64 };
  }, { index, labels: {} });

  const post = await page.evaluate(snapshotPostInPage);
  const isDetail = !post.isTimeline;
  const deliveredGeom = (await page.evaluate(measureCells, { labelsPerFixture: [labelsFor(isDetail ? "detail" : "timeline")] }))[0];
  if (deliveredGeom.frame.width < 100) throw new Error("replica: this article is not laid out (hidden or empty)");
  const stamps = await page.evaluate(() => {
    const cell = document.querySelector("[data-xeet-fixture]");
    const a = cell.querySelector("a[data-base-ui-tooltip-trigger], span.inline-flex.w-fit a");
    const s = a?.parentElement?.querySelector("script")?.textContent ?? "";
    const m = s.match(/__xClientTextFormatters\?\.run\("([^"]+)", "([^"]+)", (\{.*\})\)/);
    const href = a?.getAttribute("href") ?? "";
    const counts = {};
    for (const btn of cell.querySelectorAll("[data-engagement-action]")) {
      const num = btn.querySelector(".tabular-nums");
      if (num) counts[btn.getAttribute("data-engagement-action")] = num.textContent;
    }
    return { label: a?.textContent ?? null, formatter: m ? m[2] : null, args: m ? JSON.parse(m[3]) : null, href, counts };
  });
  // Name/handle/timestamp/count text is enough for the fixture; the timestamp
  // value comes from the formatter arguments, which X embeds next to the label.
  const fixture = {
    name: `${corpus}#${index}`,
    surface: isDetail ? "detail" : "timeline",
    width: deliveredGeom.frame.width,
    theme,
    dpr,
    post: {
      name: post.name,
      handle: post.handle,
      verified: post.verified,
      affiliate: post.affiliate,
      pinned: post.pinned,
      text: post.text,
      counts: post.counts,
      timestamp: stamps.args?.timestamp ?? null,
      now: null,
    },
  };
  await context.close();

  // The replica, at the delivered cell width.
  const skeletonsIn = await skeletons(browser);
  // A delivery whose label is a relative time needs a `now` that reproduces
  // it; solve for the smallest `now` that formats to the same label.
  if (fixture.post.timestamp != null) fixture.post.now = solveNow(fixture.post.timestamp, stamps.label, fixture.surface);
  const replica = (await renderFixtures(browser, [fixture], { skeletonsIn }))[0];

  return {
    fixture,
    delivered: deliveredGeom,
    replica: { frame: replica.frame, boxes: replica.boxes, lines: replica.lines },
    diff: diffGeometry(deliveredGeom, { frame: replica.frame, boxes: replica.boxes, lines: replica.lines }),
    deliveredLabel: stamps.label,
    replicaLabel: replica.fixture.derived.stamp,
    deliveredCounts: stamps.counts,
  };

  // The inverse of `formatRelativePastTimestamp`: the `now` that reproduces a
  // delivered label, solved analytically (searching would take millions of
  // Intl calls per post).
  function solveNow(ts, label, surface) {
    if (label == null || surface === "detail") return ts;
    const day = 86_400_000;
    let m = /^(\d+)s$/.exec(label);
    if (m) return ts + Number(m[1]) * 1000 + 1;
    m = /^(\d+)m$/.exec(label);
    if (m) return ts + Number(m[1]) * 60_000 + 1;
    m = /^(\d+)h$/.exec(label);
    if (m) return ts + Number(m[1]) * 3_600_000 + 1;
    // A date label: "Nov 1" needs the same calendar year, "Nov 1, 2025" a
    // different one. Two days and 400 days respectively are safe (the date
    // shown is the post's own, not now's).
    const hasYear = /,\s*\d{4}$/.test(label);
    return ts + (hasYear ? 400 : 2) * day;
  }
}

// Structural diff with the 1/64 px tolerance the Layout gate asks for.
export function diffGeometry(a, b, path = "", out = []) {
  const close = (x, y) => Math.abs(x - y) <= 1 / 64 + 1e-9;
  const compareBox = (p, x, y) => {
    if (!x || !y) {
      if (x !== y) out.push({ path: p, got: y, want: x, why: "presence" });
      return;
    }
    for (const key of ["x", "y", "w", "h"]) {
      if (!close(x[key], y[key])) out.push({ path: `${p}.${key}`, got: y[key], want: x[key], delta: Math.round((y[key] - x[key]) * 64) / 64 });
    }
  };
  for (const key of ["width", "height"]) {
    if (!close(a.frame[key], b.frame[key])) out.push({ path: `frame.${key}`, got: b.frame[key], want: a.frame[key], delta: b.frame[key] - a.frame[key] });
  }
  for (const key of Object.keys(a.boxes)) compareBox(`boxes.${key}`, a.boxes[key], b.boxes[key] ?? null);
  for (const key of Object.keys(a.lines ?? {})) {
    const l = a.lines[key] ?? [];
    const r = b.lines?.[key] ?? [];
    if (l.length !== r.length) out.push({ path: `lines.${key}.count`, got: r.length, want: l.length });
    for (let i = 0; i < Math.min(l.length, r.length); i++) {
      if (l[i].text !== r[i].text) out.push({ path: `lines.${key}[${i}].text`, got: r[i].text, want: l[i].text });
      compareBox(`lines.${key}[${i}]`, l[i], r[i]);
    }
  }
  void path;
  return out;
}

// --------------------------------------------------------------------- cli --

async function main() {
  const args = process.argv.slice(2);
  const opt = { theme: "light", width: 600, dpr: 2, surface: "timeline", out: null, shot: false, verify: null, article: null };
  const fixtures = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === "--surface") opt.surface = next();
    else if (a === "--width") opt.width = Number(next());
    else if (a === "--theme") opt.theme = next();
    else if (a === "--dpr") opt.dpr = Number(next());
    else if (a === "--name") opt.name = next();
    else if (a === "--out") opt.out = next();
    else if (a === "--shot") opt.shot = true;
    else if (a === "--verify") opt.verify = next();
    else if (a === "--article") opt.article = Number(next());
    else if (a === "--fixture" || a === "--fixtures") {
      const fx = JSON.parse(await readFile(next(), "utf8"));
      fixtures.push(...(Array.isArray(fx) ? fx : [fx]));
    } else throw new Error("unknown argument " + a);
  }
  if (opt.name) for (const f of fixtures) f.name = f.name ?? opt.name;
  if (!fixtures.length && !opt.verify) {
    fixtures.push({
      name: opt.name ?? "default",
      surface: opt.surface,
      width: opt.width,
      theme: opt.theme,
      dpr: opt.dpr,
      post: {
        name: "Vercel",
        handle: "vercel",
        verified: "blue",
        timestamp: 1762000000000,
        now: 1794300000000,
        counts: { replies: 1266, reposts: 3400000, likes: 12345678, views: 987654, bookmarks: 12 },
        text: [
          { kind: "plain", text: "We just shipped the thing.\n\nRead more: " },
          { kind: "url", text: "https://vercel.com/blog/the-thing", display: "vercel.com/blog/the-thing" },
        ],
      },
    });
  }

  const browser = await launch();
  let payload;
  if (opt.verify) {
    payload = await verifyCorpus(browser, { corpus: opt.verify, article: opt.article, width: opt.width, theme: opt.theme, dpr: opt.dpr });
  } else {
    const results = await renderFixtures(browser, fixtures, { shotDir: opt.shot ? opt.out ?? "tmp/replica-shots" : null });
    if (opt.out) {
      await mkdir(opt.out, { recursive: true });
      for (let k = 0; k < results.length; k++) {
        const name = (fixtures[k].name ?? `fixture-${k}`).replace(/[^a-zA-Z0-9_.-]+/g, "-");
        await writeFile(join(opt.out, name + ".json"), JSON.stringify(results[k], null, 2) + "\n");
      }
    }
    payload = results.length === 1 ? results[0] : results;
  }
  await browser.close();
  if (opt.out && opt.verify) await writeFile(join(opt.out, "verify.json"), JSON.stringify(payload, null, 2) + "\n");
  else console.log(JSON.stringify(payload, null, 2));
  if (opt.verify) process.exitCode = payload.diff.length ? 1 : 0;
}

if (process.argv[1]?.endsWith("replica.mjs")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { CORPUS, ROOT };
