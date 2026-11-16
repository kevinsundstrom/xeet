// Cards parity: my `cards::layout` block against Chrome rendering X's own
// markup with X's own stylesheet. Development only.
//
//   node tools/oracle/cards-parity.mjs                 # every fixture
//   node tools/oracle/cards-parity.mjs media-4         # one fixture
//   node tools/oracle/cards-parity.mjs --widths 320,390
//   XEET_CARDS_BIN=target/agent-cards/fast/examples/cards_dump node tools/oracle/cards-parity.mjs
//
// Two kinds of fixture:
//
//   corpus     a real post from `assets/vendor/corpus/`. The page is rendered
//              at the target viewport width, exactly as X served it, so the
//              media overhang, the column width and every breakpoint are real.
//   synthetic  the two components the corpus lacks (`summary` card, poll),
//              whose markup is copied from the client component code and
//              dropped into a slot of the same width. These prove the layout
//              of the reconstructed markup, not that the markup is X's.
//
// For each fixture and viewport width the tool measures every painted box in
// the attachment subtree (backgrounds, borders — real and `::after` — images,
// icons, text lines) and asks the Rust side for the same list. Boxes must
// match within 1/64 px, radii within 1/64 px, corner shapes and colors
// exactly.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, launch, newPage, setContentAs } from "./browser.mjs";
import { largeCard, nestedPreview, photoAttributed, quoteCard, summaryCard, videoAttributed } from "./cards-markup.mjs";

export const EPS = 1 / 64;
// An `<img>`'s box is the one thing Chrome does not decide from the markup
// alone: once the bytes decode, Chrome lays the element out from its intrinsic
// ratio as well, and the element ends up 2-4/64 px wider than the container's
// aspect box (measured on `quote-reply`: 308 → 308.0312, 444 → 444.0562).
// Whether the decode lands before the measurement is a race, so image rects are
// compared at 1/16 px; every layout box (fills, strokes, icons, text) stays at
// Chrome's 1/64 layout unit.
export const IMAGE_EPS = 1 / 16;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const WIDTHS = opt("widths", "320,390,600").split(",").map(Number);
const THEMES = opt("themes", "light,dark").split(",");
const FLAGS = new Set(["--widths", "--themes"]);
const ONLY = args.find((a, i) => !a.startsWith("--") && !FLAGS.has(args[i - 1]));

// ---------------------------------------------------------------- images
//
// Corpus pages reference pbs.twimg.com images. Fetching them once into
// `tmp/cards-img-cache/` and serving them from there keeps the run offline,
// deterministic and fast; `canonical` strips the transform parameters so the
// same artwork is only downloaded once.

const IMG_CACHE = join(ROOT, "tmp", "cards-img-cache");
const imageCache = new Map();

function canonical(url) {
  return url.split("?")[0];
}

async function serveImage(url) {
  const key = canonical(url);
  if (imageCache.has(key)) return imageCache.get(key);
  await mkdir(IMG_CACHE, { recursive: true });
  const file = join(IMG_CACHE, createHash("sha1").update(key).digest("hex"));
  let body;
  if (existsSync(file)) {
    body = await readFile(file);
  } else {
    const res = await fetch(`${key}?format=jpg&name=large`, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`image ${res.status} ${key}`);
    body = Buffer.from(await res.arrayBuffer());
    await writeFile(file, body);
  }
  const entry = { type: "image/jpeg", body };
  imageCache.set(key, entry);
  return entry;
}

function cardsBinary() {
  if (process.env.XEET_CARDS_BIN) return process.env.XEET_CARDS_BIN;
  const candidates = [
    "target/agent-cards/fast/examples/cards_dump",
    "target/agent-cards/release/examples/cards_dump",
    "target/agent-cards/debug/examples/cards_dump",
  ];
  for (const c of candidates) if (existsSync(join(ROOT, c))) return c;
  throw new Error("build it first: CARGO_TARGET_DIR=target/agent-cards cargo build --profile fast -p xeet-core --example cards_dump");
}

// ------------------------------------------------------------------ fixtures

const FIXTURES = [
  // Single media. A media tag (X's `mt-1` line naming a tagged account) is not
  // in the model, so these come from posts that have none; the portrait case
  // exercises the 510 px height cap (`max-width: 408px` on a 0.8 image).
  { name: "media-1", kind: "media", file: "text-OurWorldInData.html", article: 1 },
  { name: "media-1-square", kind: "media", file: "text-OurWorldInData.html", article: 2 },
  { name: "media-1-portrait", kind: "media", file: "netflix.html", article: 4 },
  // A single image with a `Learn With …` tag line under it.
  { name: "media-tag", kind: "media", file: "NASA.html", article: 2 },
  { name: "media-tag-one", kind: "media", file: "Google.html", article: 0 },
  { name: "video", kind: "media", file: "github.html", article: 2 },
  // Carousels: what X renders for two, three and four images.
  { name: "media-2", kind: "media", file: "github.html", article: 0 },
  { name: "media-3", kind: "media", file: "text-Microsoft.html", article: 3 },
  { name: "media-4", kind: "media", file: "NASA.html", article: 0 },
  { name: "media-4-mixed", kind: "media", file: "text-TheAtlantic.html", article: 1 },
  // Link cards.
  { name: "card-large", kind: "card", file: "nytimes.html", article: 0 },
  { name: "card-large-2", kind: "card", file: "verge.html", article: 2 },
  // Quoted posts.
  { name: "quote-media", kind: "quote", file: "XDevelopers.html", article: 3 },
  { name: "quote-2-media", kind: "quote", file: "text-levelsio.html", article: 3 },
  // A video with a `media_tags` line under it (NASA). Chrome's slot is 32 px
  // taller than the video: the tag line (16) + `mt-1` (4) + `gap-3` (12).
  {
    name: "video-tag",
    kind: "media",
    file: "NASA.html",
    article: 1,
    // The video's own dimensions (the markup only carries the server's rounded
    // `aspect-ratio:1.77778`, which is 8/64 px short of 16/9 at this width).
    input: { media: [{ kind: "video", width: 3840, height: 2160 }] },
  },
  // A portrait video (864×1080): 408×510, the 510 px height cap, not the
  // slot's width.
  { name: "video-portrait", kind: "media", file: "NBA.html", article: 4 },
  // Media *and* a quoted post in one slot, and the quote's own video drawn in
  // the compact form (96 px thumbnail beside the text, 16 px avatar).
  { name: "media-quote", kind: "media", file: "NBA.html", article: 0 },
  // A text-only post quoting a *landscape* video: the quote keeps the
  // full-width form (24 px avatar, video below the text), unlike the compact
  // one above, which is a quote drawn under a post that has media.
  {
    name: "quote-full-video",
    kind: "quote",
    file: "XDevelopers.html",
    article: 4,
    // The quoted video's own size; the markup only has the rounded
    // `aspect-ratio:1.77778` (see `video-tag`).
    quoteAspect: [1920, 1080],
  },
  // The compact form with a *photo* (portrait 2160×2700) under a post with its
  // own photo: the same 96 px thumbnail, no duration badge.
  { name: "media-quote-photo", kind: "media", file: "NBA.html", article: 2 },
  // A quoted post that is itself a reply: the `Replying to @handle` row.
  { name: "quote-reply", kind: "quote", file: "text-karpathy.html", article: 3 },
  // A real poll: two choices, closed, votes shown ("Final results"). X
  // renders poll posts only on the post page, which is what this capture is.
  { name: "poll-2", kind: "poll", file: "poll-musk.html", article: 0 },
  // `summary_large_image` with a title that just fits its pill: the pill is the
  // title's advance plus `px-2`, and the title must be drawn whole (the bug this
  // pair pins down painted "The thing,…" inside a pill Chrome fills).
  {
    name: "card-large-fit",
    kind: "card",
    cardType: "summary_large_image",
    // One glyph run on the pill line: the title whole, no ellipsis run. Chrome
    // paints one run too (its ellipsis would be generated, not a DOM node).
    runs: [1, 1],
    synthetic: ({ slot }) =>
      largeCard({
        title: "The thing, shipped",
        domain: "vercel.com",
        image: "https://pbs.twimg.com/card_img/2119889822756007938/z60u_Azo?format=webp&name=medium",
        width: 3000,
        height: 1688,
      }).replace('<div class="flex flex-col gap-3 empty:hidden">', `<div style="width:${slot}px"><div class="flex flex-col gap-3 empty:hidden">`),
    input: {
      links: {
        "https://example.com/a": {
          card: "summary_large_image",
          title: "The thing, shipped",
          domain: "vercel.com",
          image: { width: 3000, height: 1688 },
        },
      },
    },
  },
  // The same card with a title longer than the card: the pill takes the whole
  // `inset-s-3 inset-e-3` box and the title is clamped to one line.
  {
    name: "card-large-long",
    kind: "card",
    cardType: "summary_large_image",
    // The pill line has the text run plus the "…" run; the `From …` line is
    // one run.
    runs: [2, 1],
    synthetic: ({ slot }) =>
      largeCard({
        title: "A headline about a vote on impeachment that runs past the width of the card at every width we test",
        domain: "nytimes.com",
        image: "https://pbs.twimg.com/card_img/2119889822756007938/z60u_Azo?format=webp&name=medium",
        width: 3000,
        height: 1688,
      }).replace('<div class="flex flex-col gap-3 empty:hidden">', `<div style="width:${slot}px"><div class="flex flex-col gap-3 empty:hidden">`),
    input: {
      links: {
        "https://example.com/a": {
          card: "summary_large_image",
          title: "A headline about a vote on impeachment that runs past the width of the card at every width we test",
          domain: "nytimes.com",
          image: { width: 3000, height: 1688 },
        },
      },
    },
  },


  // X's "Post video" / "Post photo" source attribution: @espn quoting @NFL's
  // video (`ESPN.html`, 2120005259485425936 — the pill's markup is verbatim),
  // and a photo with the same badge (`BNn3ozGQ.js`'s `ie`, `rounded-[6px]
  // bg-black/70 py-1 ps-1 pe-2`).
  {
    name: "video-attributed",
    kind: "media",
    synthetic: ({ slot }) =>
      `<div style="width:${slot}px">${videoAttributed({ name: "NFL", verified: "business", square: true })}</div>`,
    input: {
      text: "x",
      author: { name: "ESPN", handle: "espn", verified: "blue", squareAvatar: true },
      createdAt: "2026-11-11T09:00:00Z",
      now: "2026-11-11T12:00:00Z",
      media: [
        {
          kind: "video",
          width: 1280,
          height: 720,
          duration: 24,
          sourceAuthor: { name: "NFL", handle: "NFL", verified: "business", squareAvatar: true },
        },
      ],
    },
  },
  {
    name: "video-attributed-long",
    kind: "media",
    // The name cannot fit at any of the three widths: the pill must be exactly
    // `rect.w - 12` wide, which is Chrome's clamped pill and only reproducible if
    // the name clamps at the same point.
    synthetic: ({ slot }) =>
      `<div style="width:${slot}px">${videoAttributed({ name: "Buffalo Bills Football Club of Western New York, Southern Ontario and Beyond", verified: "none", square: false })}</div>`,
    input: {
      text: "x",
      author: { name: "ESPN", handle: "espn" },
      createdAt: "2026-11-11T09:00:00Z",
      now: "2026-11-11T12:00:00Z",
      media: [
        {
          kind: "video",
          width: 1280,
          height: 720,
          duration: 24,
          sourceAuthor: {
            name: "Buffalo Bills Football Club of Western New York, Southern Ontario and Beyond",
            handle: "BuffaloBills",
            verified: "none",
          },
        },
      ],
    },
  },
  {
    name: "photo-attributed",
    kind: "media",
    synthetic: ({ slot }) =>
      `<div style="width:${slot}px">${photoAttributed({ name: "Polygon", verified: "blue", square: false, alt: true })}</div>`,
    input: {
      text: "x",
      author: { name: "ESPN", handle: "espn" },
      createdAt: "2026-11-11T09:00:00Z",
      now: "2026-11-11T12:00:00Z",
      media: [
        {
          kind: "image",
          width: 1200,
          height: 628,
          alt: "5 Most Ambitious Sci-Fi Books Of all Time, Ranked",
          sourceAuthor: { name: "Polygon", handle: "Polygon", verified: "blue" },
        },
      ],
    },
  },
  // X's nested quote preview: the quoted post (q1) itself quotes a post (q2),
  // and q2 gets a compact card of its own (`nested-quote-preview-SIs_tkfq`).
  // The corpus has no depth-2 quote, so these five render X's own markup with
  // our data, exactly like `card-summary`.
  {
    name: "quote-nested-text",
    kind: "quote",
    synthetic: ({ slot }) =>
      `<div style="width:${slot}px">${quoteCard({
        name: "Celeste",
        handle: "celestepoasts",
        stamp: "3h",
        text: "Cool eval. Simply ask an LLM “Land or Water?” and give it a latitude and longitude coordinate as text.",
        nested: nestedPreview({
          name: "Andrej Karpathy",
          handle: "karpathy",
          stamp: "5h",
          text: "results for all claudes, with the @karpathy eval harness and a note about how the maps were rendered from the raw coordinates",
        }),
      })}</div>`,
    input: {
      text: "the nesting is getting deep",
      author: { name: "Tony", handle: "tony", verified: "blue" },
      createdAt: "2026-11-11T09:00:00Z",
      now: "2026-11-11T12:00:00Z",
      quote: {
        text: "Cool eval. Simply ask an LLM “Land or Water?” and give it a latitude and longitude coordinate as text.",
        author: { name: "Celeste", handle: "celestepoasts", verified: "blue" },
        createdAt: "2026-11-11T09:00:00Z",
        now: "2026-11-11T12:00:00Z",
        quote: {
          text: "results for all claudes, with the @karpathy eval harness and a note about how the maps were rendered from the raw coordinates",
          author: { name: "Andrej Karpathy", handle: "karpathy", verified: "blue" },
          createdAt: "2026-11-11T07:00:00Z",
          now: "2026-11-11T12:00:00Z",
        },
      },
    },
  },
  {
    name: "quote-nested-photo",
    kind: "quote",
    synthetic: ({ slot }) =>
      `<div style="width:${slot}px">${quoteCard({
        name: "Celeste",
        handle: "celestepoasts",
        stamp: "3h",
        text: "Cool eval. Simply ask an LLM “Land or Water?”",
        nested: nestedPreview({
          name: "Andrej Karpathy",
          handle: "karpathy",
          stamp: "5h",
          text: "the map, in full",
          media: { count: 1, video: false },
        }),
      })}</div>`,
    input: {
      text: "the nesting is getting deep",
      author: { name: "Tony", handle: "tony", verified: "blue" },
      createdAt: "2026-11-11T09:00:00Z",
      now: "2026-11-11T12:00:00Z",
      quote: {
        text: "Cool eval. Simply ask an LLM “Land or Water?”",
        author: { name: "Celeste", handle: "celestepoasts", verified: "blue" },
        createdAt: "2026-11-11T09:00:00Z",
        now: "2026-11-11T12:00:00Z",
        quote: {
          text: "the map, in full",
          author: { name: "Andrej Karpathy", handle: "karpathy", verified: "blue" },
          createdAt: "2026-11-11T07:00:00Z",
          now: "2026-11-11T12:00:00Z",
          media: [{ kind: "image", width: 2250, height: 1785 }],
        },
      },
    },
  },
  {
    name: "quote-nested-multi",
    kind: "quote",
    synthetic: ({ slot }) =>
      `<div style="width:${slot}px">${quoteCard({
        name: "Celeste",
        handle: "celestepoasts",
        stamp: "3h",
        text: "Cool eval. Simply ask an LLM “Land or Water?”",
        nested: nestedPreview({
          name: "Andrej Karpathy",
          handle: "karpathy",
          stamp: "5h",
          text: "three maps, one per model family",
          media: { count: 3, video: false },
        }),
      })}</div>`,
    input: {
      text: "the nesting is getting deep",
      author: { name: "Tony", handle: "tony", verified: "blue" },
      createdAt: "2026-11-11T09:00:00Z",
      now: "2026-11-11T12:00:00Z",
      quote: {
        text: "Cool eval. Simply ask an LLM “Land or Water?”",
        author: { name: "Celeste", handle: "celestepoasts", verified: "blue" },
        createdAt: "2026-11-11T09:00:00Z",
        now: "2026-11-11T12:00:00Z",
        quote: {
          text: "three maps, one per model family",
          author: { name: "Andrej Karpathy", handle: "karpathy", verified: "blue" },
          createdAt: "2026-11-11T07:00:00Z",
          now: "2026-11-11T12:00:00Z",
          media: [
            { kind: "image", width: 2250, height: 1785 },
            { kind: "image", width: 2250, height: 1785 },
            { kind: "image", width: 2250, height: 1785 },
          ],
        },
      },
    },
  },
  {
    name: "quote-nested-video",
    kind: "quote",
    synthetic: ({ slot }) =>
      `<div style="width:${slot}px">${quoteCard({
        name: "Celeste",
        handle: "celestepoasts",
        stamp: "3h",
        text: "Cool eval. Simply ask an LLM “Land or Water?”",
        nested: nestedPreview({
          name: "Andrej Karpathy",
          handle: "karpathy",
          stamp: "5h",
          text: "and the walkthrough",
          media: { count: 1, video: true },
        }),
      })}</div>`,
    input: {
      text: "the nesting is getting deep",
      author: { name: "Tony", handle: "tony", verified: "blue" },
      createdAt: "2026-11-11T09:00:00Z",
      now: "2026-11-11T12:00:00Z",
      quote: {
        text: "Cool eval. Simply ask an LLM “Land or Water?”",
        author: { name: "Celeste", handle: "celestepoasts", verified: "blue" },
        createdAt: "2026-11-11T09:00:00Z",
        now: "2026-11-11T12:00:00Z",
        quote: {
          text: "and the walkthrough",
          author: { name: "Andrej Karpathy", handle: "karpathy", verified: "blue" },
          createdAt: "2026-11-11T07:00:00Z",
          now: "2026-11-11T12:00:00Z",
          media: [{ kind: "video", width: 1920, height: 1080, duration: 42 }],
        },
      },
    },
  },
  {
    name: "quote-nested-q1-media",
    kind: "quote",
    synthetic: ({ slot }) =>
      `<div style="width:${slot}px">${quoteCard({
        name: "Celeste",
        handle: "celestepoasts",
        stamp: "3h",
        text: "Cool eval. Simply ask an LLM “Land or Water?”",
        media: { ar: "1.2605042016806722" },
        nested: nestedPreview({
          name: "Andrej Karpathy",
          handle: "karpathy",
          stamp: "5h",
          text: "the map, and a note about what it measures",
        }),
      })}</div>`,
    input: {
      text: "the nesting is getting deep",
      author: { name: "Tony", handle: "tony", verified: "blue" },
      createdAt: "2026-11-11T09:00:00Z",
      now: "2026-11-11T12:00:00Z",
      quote: {
        text: "Cool eval. Simply ask an LLM “Land or Water?”",
        author: { name: "Celeste", handle: "celestepoasts", verified: "blue" },
        createdAt: "2026-11-11T09:00:00Z",
        now: "2026-11-11T12:00:00Z",
        media: [{ kind: "image", width: 2250, height: 1785 }],
        quote: {
          text: "the map, and a note about what it measures",
          author: { name: "Andrej Karpathy", handle: "karpathy", verified: "blue" },
          createdAt: "2026-11-11T07:00:00Z",
          now: "2026-11-11T12:00:00Z",
        },
      },
    },
  },
  {
    name: "card-summary",
    kind: "card",
    synthetic: ({ slot }) =>
      summaryCard({
        domain: "example.com",
        title: "A title that is long enough to wrap onto a second line in the mobile card",
        image: undefined,
      }).replace('<div class="flex flex-col gap-3 empty:hidden">', `<div style="width:${slot}px"><div class="flex flex-col gap-3 empty:hidden">`),
    input: {
      links: {
        "https://example.com/a": {
          card: "summary",
          title: "A title that is long enough to wrap onto a second line in the mobile card",
          domain: "example.com",
        },
      },
    },
  },
];

// ------------------------------------------------------------- measurement

/**
 * In-page measurement. Returns painted boxes and text lines for the attachment
 * subtree of article `idx`, plus the input the Rust side needs.
 */
function measureInPage({ idx, kind, synthetic, debugLines }) {
  window.__xeetKeepLineDebug = !!debugLines;
  const visible = (el) => {
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.display === "none" || s.visibility === "hidden") return false;
      // `opacity: 0` paints nothing: the voted-check slot in a poll the viewer
      // has not voted in is such an icon.
      if (parseFloat(s.opacity) === 0) return false;
    }
    return el.getBoundingClientRect().width > 0 || el.getBoundingClientRect().height > 0;
  };
  const arts = synthetic
    ? [document.getElementById("root")]
    : // Only top-level posts: a quoted post is an <article> inside another one.
      [...document.querySelectorAll("article")].filter((a) => !a.parentElement?.closest("article"));
  const art = arts[idx];
  if (!art) return { error: `no article ${idx} (have ${arts.length})` };
  // Force the SSR shell's hidden branch visible so it can be measured. X's
  // server CSS hides the timeline list with `display: none !important`, which a
  // plain inline `display: block` loses to — and then every rect in the article
  // is 0 and the fixture measures nothing, at random. The inline declaration
  // must be `!important` too.
  for (let p = art; p && p !== document.body; p = p.parentElement) {
    if (getComputedStyle(p).display === "none") p.style.setProperty("display", "block", "important");
  }
  // The attachment slot is the first box whose class list contains
  // `empty:hidden` (X hides it when there is nothing to show). Matching on the
  // class string rather than a selector keeps the escape handling out of it.
  const att = synthetic
    ? art.firstElementChild ?? art
    : [...art.querySelectorAll("div")].find((d) => String(d.className).includes("empty:hidden")) ?? art;
  let attBox = att.getBoundingClientRect();
  // A poll sits in a `-m-1` / `p-1` pair: the visible box is the inner
  // content box, which is exactly the attachment slot.
  const pollList = att.querySelector('div[role="list"]');
  if (kind === "poll" && pollList) {
    const wrap = pollList.closest("div.p-1") ?? att;
    const s2 = getComputedStyle(wrap);
    const r = wrap.getBoundingClientRect();
    const pl = parseFloat(s2.paddingLeft), pt = parseFloat(s2.paddingTop);
    const pr = parseFloat(s2.paddingRight), pb = parseFloat(s2.paddingBottom);
    attBox = { x: r.x + pl, y: r.y + pt, width: r.width - pl - pr, height: r.height - pt - pb };
  }

  const num = (v) => Math.round(v * 1e4) / 1e4;
  const boxes = [];
  const lines = [];
  const seen = new Set();

  const border = (s) =>
    Math.max(
      parseFloat(s.borderTopWidth) || 0,
      parseFloat(s.borderRightWidth) || 0,
      parseFloat(s.borderBottomWidth) || 0,
      parseFloat(s.borderLeftWidth) || 0,
    );
  const radius = (s) => parseFloat(s.borderTopLeftRadius) || 0;
  const colorOf = (css) => {
    const m = css.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    const [r, g, b] = parts;
    const a = parts.length > 3 ? parts[3] : 1;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
  };
  const push = (t, r, s, extra = {}, el = null) =>
    boxes.push({
      t,
      x: num(r.x - attBox.x),
      y: num(r.y - attBox.y),
      w: num(r.width),
      h: num(r.height),
      tag: el ? el.tagName.toLowerCase() : undefined,
      cls: el ? String(el.className || "").slice(0, 40) : undefined,
      ...extra,
    });

  const walk = (el) => {
    if (el !== att && !visible(el)) return;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      for (const c of el.children) walk(c);
      return;
    }
    const tag = el.tagName.toLowerCase();
    if (tag !== "script" && tag !== "style") {
      const bw = border(s);
      const after = getComputedStyle(el, "::after");
      const afterBorder = parseFloat(after.borderTopWidth) || 0;
      const bg = s.backgroundColor;
      const hasBg = bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
      if (hasBg && el !== att) push("fill", r, s, { r: radius(s), squircle: s.getPropertyValue("corner-shape") === "squircle", color: colorOf(bg) }, el);
      // X's verified badge is an <img> sprite sized `1em`; it is the display
      // list's `Icon`, and its 1 px ring is a paint detail, not a box.
      const inAffiliation = el.closest?.("a[aria-label]") != null && tag === "img";
      const isBadge = tag === "img" && String(el.className).includes("size-[1em]") && !inAffiliation;
      if (bw > 0 && !isBadge) {
        const uniform = [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].every(
          (v) => v === s.borderTopWidth,
        );
        if (uniform) {
          push("stroke", r, s, { r: radius(s), squircle: s.getPropertyValue("corner-shape") === "squircle", color: colorOf(s.borderTopColor) }, el);
        } else if (parseFloat(s.borderRightWidth) > 0) {
          // `border-e`: a 1 px line at the inline end.
          push("stroke", { x: r.right - 1, y: r.y, width: 1, height: r.height }, s, { r: 0, squircle: false, color: colorOf(s.borderRightColor) });
        } else if (parseFloat(s.borderTopWidth) > 0) {
          push("stroke", { x: r.x, y: r.y, width: r.width, height: 1 }, s, { r: 0, squircle: false, color: colorOf(s.borderTopColor) });
        }
      }
      else if (afterBorder > 0) push("stroke", r, s, { r: radius(s), squircle: s.getPropertyValue("corner-shape") === "squircle", color: colorOf(after.borderTopColor) });
      if (isBadge) {
        push("icon", r, s, {}, el);
      } else if (tag === "img" || tag === "video") {
        // The image occupies its container's content box, so its border box is
        // what the renderer draws: no adjustment for ancestor borders.
        if (!seen.has(`img${Math.round(r.x)},${Math.round(r.y)}`)) {
          seen.add(`img${Math.round(r.x)},${Math.round(r.y)}`);
          // Whether this image belongs to the quoted post — and whether it is one
          // level deeper still, inside the *nested* quote preview (X's
          // `-mx-1.5 -my-1 rounded-[9px]` hover wrapper marks that subtree). The display list must
          // point each box at the right post's bytes: `ImageRef::Quote(..)` for a
          // quote, `Quote(Quote(..))` inside the preview, never at the outer
          // post's media, whose index collides.
          const owner = el.closest?.("article");
          const inQuote = owner != null && owner !== art;
          let nested = false;
          for (let p = el; p && p !== art; p = p.parentElement) {
            if (String(p.className || "").includes("rounded-[9px]")) {
              nested = true;
              break;
            }
          }
          push("image", r, s, { inQuote, nested }, el);
        }
      }
      // An affiliation badge (the small logo of the account's organization) is
      // not in the model; every other inline svg — the verified check, a play
      // control, a card's fallback glyph — is an `Icon`.
      const aff = el.closest?.("a[aria-label]");
      const affiliation = aff != null && (aff.getAttribute("aria-label") || "") !== "Verified account";
      if (tag === "svg" && !affiliation) push("icon", r, s, {}, el);
    }
    for (const c of el.children) walk(c);
  };
  walk(att);

  // Text lines. A line is the set of range rectangles that share a top (within
  // 1.5 px): that groups the separate text nodes of one visual line — a
  // header's name, handle, `·` and timestamp, or a row of badges — while
  // separate lines stay apart. Only the leftmost start and the number of lines
  // are compared: the *vertical* text position comes from the font-metric model
  // that this tool verifies separately over the whole type scale (13/16, 14/16,
  // 15/20, 17/20 and 20/24 all put the font box at the same offset), because a
  // range rectangle is shifted by a tenth of a pixel inside a
  // `-webkit-line-clamp` box and so is not a line box at all.
  const tw = document.createTreeWalker(att, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = tw.nextNode())) {
    if (!node.nodeValue.trim()) continue;
    if (!visible(node.parentElement)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const clipped = (rect) => {
      for (let a = node.parentElement; a && a !== att.parentElement; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowY === "hidden" || cs.overflow === "hidden") {
          const box = a.getBoundingClientRect();
          const visible = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
          if (visible < rect.height / 2) return true;
        }
      }
      return false;
    };
    for (const r of range.getClientRects()) {
      if (r.width <= 0 || r.height <= 0) continue;
      if (clipped(r)) continue;
      const top = num(r.top - attBox.y);
      const left = num(r.left - attBox.x);
      const right = num(r.right - attBox.x);
      const found = lines.find((l) => Math.abs(l.y - top) < 1.5);
      if (found) {
        found.x = Math.min(found.x, left);
        found.w = Math.max(found.x + found.w, right) - found.x;
        found.runs = (found.runs ?? 1) + 1;
        found.xs.push(left);
      } else {
        lines.push({ x: left, y: top, w: right - left, h: num(r.height), runs: 1, xs: [left] });
      }
    }
  }
  // A poll label is painted by a generated `::before { content:
  // attr(data-label) }` box while the real text node is opacity-0, so no text
  // node carries it. Its element box stands in for the line it draws.
  for (const el of att.querySelectorAll("[data-label]")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const found = lines.find((l) => Math.abs(l.y - (r.top - attBox.y)) < 1.5);
    const left = num(r.left - attBox.x);
    if (found) found.x = Math.min(found.x, left);
    else lines.push({ x: left, y: num(r.top - attBox.y), w: num(r.width), h: num(r.height) });
  }
  lines.sort((a, b) => a.y - b.y);
  for (const l of lines) l.xs.sort((a, b) => a - b);

  // The input the Rust renderer needs, read off the same DOM.
  const input = { media: [], quote: null, card: null };
  const cells = [...att.querySelectorAll('[style*="aspect-ratio"], img, video')].filter((el) =>
    el.matches("img,video") ? true : false,
  );
  // Media items: one per cell (carousel) or per single media box.
  // Media items: prefer the width/height X put on the tag, then the
  // aspect-ratio its server computed for the box, then the decoded image.
  const dimsOf = (img) => {
    const w = Number(img.getAttribute("width"));
    const h = Number(img.getAttribute("height"));
    if (w > 0 && h > 0) return { width: w, height: h };
    for (let el = img; el && el !== att.parentElement; el = el.parentElement) {
      const ar = el.style?.aspectRatio;
      if (ar) {
        const n = ar.includes("/") ? Number(ar.split("/")[0]) / Number(ar.split("/")[1]) : Number(ar);
        if (Number.isFinite(n) && n > 0) return { width: 1e6, height: Math.round(1e6 / n) };
      }
    }
    return { width: img.naturalWidth || 0, height: img.naturalHeight || 0 };
  };
  const imgs = [...att.querySelectorAll("img")].filter(
    (el) =>
      visible(el) &&
      !el.src.includes("card_img") &&
      !el.src.includes("profile_images") &&
      // A quoted post's own images are measured as part of the quote.
      !(el.closest("article") && el.closest("article") !== art),
  );
  for (const img of imgs) {
    const d = dimsOf(img);
    const alt = (img.getAttribute("alt") ?? "").trim();
    const inVideo = img.closest("div.bg-black") != null;
    input.media.push({ width: d.width, height: d.height, alt: alt || null, video: inVideo });
  }
  // The tag line under media that tags accounts. The rendered label encodes
  // the count ("A", "A and B", "A and 6 others"), so it is turned back into a
  // tag list that reproduces it.
  const tagLink = att.querySelector('a[href$="/media_tags"]');
  if (tagLink) {
    const td = tagLink.parentElement.getBoundingClientRect();
    const r = tagLink.getBoundingClientRect();
    input.tagBox = {
      div: [num(td.y - attBox.y), num(td.height)],
      anchor: [num(r.y - attBox.y), num(r.height)],
    };
    const text = tagLink.textContent.trim();
    const others = text.match(/^(.*) and (\d+) others$/);
    if (others) {
      const n = Number(others[2]);
      input.mediaTags = [others[1], ...Array.from({ length: n }, (_, i) => `tag${i + 2}`)];
    } else if (/ and /.test(text)) {
      input.mediaTags = text.split(/ and /);
    } else {
      input.mediaTags = [text];
    }
  }

  const qArt = att.querySelector("article");
  if (qArt) {
    const inner = qArt.querySelector("div.p-3") ?? qArt;
    const nameEl = inner.querySelector("div.font-bold, span.font-bold");
    const bold = nameEl?.textContent?.trim() ?? "";
    const handleEl = [...inner.querySelectorAll("span")].find((sp) => /^@[\w]/.test(sp.textContent.trim()));
    const textEl = inner.querySelector("div.whitespace-pre-wrap");
    const stampEl = [...inner.querySelectorAll("a")].find((a) => /^([A-Z][a-z]{2} \d|\d+[smhd]$|now)/.test(a.textContent.trim()));
    const qImgs = [...qArt.querySelectorAll("img")].filter((el) => !el.src.includes("profile_images"));
    const headerRow = inner.querySelector("div.flex.items-center.gap-1");
    const headerBoxes = [];
    if (headerRow) {
      for (const el of headerRow.querySelectorAll("a, div, span, img")) {
        const r = el.getBoundingClientRect();
        if (r.width < 1) continue;
        headerBoxes.push([el.tagName.toLowerCase(), num(r.x - attBox.x), num(r.width), el.textContent.trim().slice(0, 16)]);
      }
    }
    const affiliateEl = [...inner.querySelectorAll("a[aria-label]")].find(
      (a) => a.querySelector("img") && a.getAttribute("aria-label") !== "Verified account",
    );
    // A quoted post that is itself a reply carries `Replying to @handle` above
    // its text.
    const replyRow = [...inner.querySelectorAll("div")].find((d) => /^Replying to\s/.test(d.textContent.trim()));
    const replyTo = replyRow?.querySelector("a[href]")?.getAttribute("href")?.replace(/^\//, "") ?? null;
    input.quote = {
      headerBoxes,
      replyTo,
      affiliate: affiliateEl ? affiliateEl.getAttribute("aria-label") : null,
      name: bold,
      handle: (handleEl?.textContent ?? "").trim().replace(/^@/, ""),
      text: textEl?.textContent ?? "",
      stamp: stampEl?.textContent?.trim() ?? "",
      verified: (inner.querySelector("svg use")?.getAttribute("href") ?? "").replace("#icon-verified-", "").replace("-color", ""),
      media: qImgs.map((img) => {
        const d = dimsOf(img);
        // A quoted video's poster is an `amplify_video_thumb`; its container
        // carries the duration badge ("00:11").
        const video = img.src.includes("amplify_video_thumb");
        const badge = img.closest("div.relative")?.querySelector("div.inline-flex.h-5")?.textContent?.trim();
        const mmss = String(badge ?? "").match(/^(\d+):(\d{2})$/);
        const duration = mmss ? Number(mmss[1]) * 60 + Number(mmss[2]) : undefined;
        return { width: d.width, height: d.height, video, duration };
      }),
    };
  }
  if (pollList) {
    const rows = [...pollList.querySelectorAll("div")].filter(
      (d) => d.style.getPropertyValue("--poll-choice-share") !== "",
    );
    input.poll = {
      choices: rows.map((r) => r.querySelector("[data-label]")?.getAttribute("data-label") ?? ""),
      shares: rows.map((r) => parseFloat(r.style.getPropertyValue("--poll-choice-share"))),
      minH: rows.length ? parseFloat(getComputedStyle(rows[0]).minHeight) : null,
      rowH: rows.map((r) => num(r.getBoundingClientRect().height)),
      boxes: rows.slice(0, 1).map((r) => {
        const rr = r.getBoundingClientRect();
        return [r, ...r.querySelectorAll("*")]
          .filter((el) => el.getBoundingClientRect().width > 0.5)
          .map((el) => {
            const b = el.getBoundingClientRect();
            return [el.tagName.toLowerCase(), num(b.x - rr.x), num(b.y - rr.y), num(b.width), num(b.height), String(el.className || "").slice(0, 24)];
          });
      }),
      footer: (() => {
        const f = att.querySelector("div.x-middot-group");
        if (!f) return null;
        const b = f.getBoundingClientRect();
        return {
          y: num(b.y - attBox.y),
          h: num(b.height),
          text: f.textContent,
          spans: [...f.querySelectorAll(":scope > span")].map((sp) => {
            const sb = sp.getBoundingClientRect();
            return [num(sb.x - attBox.x), num(sb.width), sp.textContent];
          }),
          font: getComputedStyle(f).fontSize,
        };
      })(),
    };
  }
  const cardImg = att.querySelector('img[src*="card_img"]');
  if (cardImg) {
    input.card = {
      title: att.querySelector('div[class*="bg-black/75"] div')?.textContent?.trim() ?? "",
      domain: ([...att.querySelectorAll("div")].find((d) => d.className.includes("text-subtext2") && /^From /.test(d.textContent))?.textContent ?? "").replace(/^From /, ""),
      width: dimsOf(cardImg).width,
      height: dimsOf(cardImg).height,
    };
  }
  return { attBox: { w: num(attBox.width), h: num(attBox.height) }, attClass: String(att.className).slice(0, 40), boxes, lines, input };
}

// ------------------------------------------------------------------ helpers

function runCardsDump(bin, payload) {
  const r = spawnSync(join(ROOT, bin), { input: JSON.stringify(payload), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cards_dump failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** A Post JSON for a fixture, from what the page showed. */
function postFor(fixture, seen) {
  const f = fixture;
  if (f.input && !seen) return f.input;
  const post = { ...(fixture.input ?? {}) };
  // `model::Post` is camelCase on the wire.
  if (seen?.input?.mediaTags?.length && !post.mediaTags) {
    post.mediaTags = seen.input.mediaTags;
  }
  if (seen?.input?.media?.length && !post.media) {
    post.media = seen.input.media.map((m) => ({
      kind: m.video ? "video" : "image",
      width: m.width,
      height: m.height,
      alt: m.alt ?? undefined,
    }));
  }
  if (seen?.input?.quote) {
    const q = seen.input.quote;
    const now = "2026-11-10T12:00:00.000Z";
    post.quote = {
      text: q.text,
      author: {
        name: q.name,
        handle: q.handle,
        verified: q.verified === "business" ? "business" : q.verified === "government" ? "government" : q.verified === "premium" ? "blue" : "none",
        affiliate: q.affiliate ? { name: q.affiliate } : undefined,
      },
      createdAt: stampToIso(q.stamp, now),
      replyToHandle: q.replyTo ?? undefined,
      now,
    };
    if (seen.input.quote.media?.length) {
      post.quote.media = seen.input.quote.media.map((m) => ({
        kind: m.video ? "video" : "image",
        width: m.width,
        height: m.height,
        duration: m.duration,
      }));
    }
  }
  if (seen?.input?.poll && f.kind === "poll") {
    const p = seen.input.poll;
    const m = String(p.footer?.spans?.[0]?.[2] ?? "").match(/^([\d,]+) votes?$/);
    const total = m ? Number(m[1].replace(/,/g, "")) : 0;
    const votes = p.shares.map((sh) => Math.round(sh * total));
    post.poll = { choices: p.choices, votes: total > 0 ? votes : undefined };
  }
  if (seen?.input?.card && f.kind === "card") {
    post.links = {
      [f.input?.url ?? "https://example.com/"]: {
        card: f.cardType ?? "summary_large_image",
        title: seen.input.card.title,
        domain: seen.input.card.domain,
        image: { width: seen.input.card.width, height: seen.input.card.height },
      },
    };
  }
  if (f.quoteAspect && post.quote?.media?.length === 1) {
    const [w, h] = f.quoteAspect;
    post.quote.media[0].width = w;
    post.quote.media[0].height = h;
  }
  if (f.input) Object.assign(post, f.input);
  return post;
}

/** Turns "3h" / "Nov 8" / "Jul 6, 2025" into an ISO string relative to `now`. */
function stampToIso(label, now) {
  const nowMs = Date.parse(now);
  let m;
  if ((m = label.match(/^(\d+)m$/))) return new Date(nowMs - m[1] * 60_000).toISOString();
  if ((m = label.match(/^(\d+)h$/))) return new Date(nowMs - m[1] * 3_600_000).toISOString();
  if ((m = label.match(/^(\d+)s$/))) return new Date(nowMs - m[1] * 1000).toISOString();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if ((m = label.match(/^([A-Z][a-z]{2}) (\d+), (\d{4})$/))) {
    return `${m[3]}-${String(months.indexOf(m[1]) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}T12:00:00.000Z`;
  }
  if ((m = label.match(/^([A-Z][a-z]{2}) (\d+)$/))) {
    const year = new Date(nowMs).getUTCFullYear();
    return `${year}-${String(months.indexOf(m[1]) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}T12:00:00.000Z`;
  }
  return now;
}

const round = (v) => Math.round(v * 1e4) / 1e4;

/** Compares two probe sets of one type. Returns {count, max} or a failure. */
function compareType(chromeBoxes, rustBoxes, type, checkRadius = true, eps = EPS) {
  const a = chromeBoxes.filter((b) => b.t === type).sort((p, q) => p.y - q.y || p.x - q.x || p.h - q.h);
  const b = rustBoxes.filter((x) => x.t === type).sort((p, q) => p.y - q.y || p.x - q.x || p.h - q.h);
  if (a.length !== b.length) {
    return { fail: `count ${type}: chrome ${a.length} vs xeet ${b.length}`, a, b };
  }
  let max = 0;
  const problems = [];
  for (let i = 0; i < a.length; i++) {
    for (const k of ["x", "y", "w", "h"]) {
      const d = Math.abs(a[i][k] - b[i][k]);
      if (d > max) max = d;
      if (d > eps) problems.push(`${type}[${i}].${k} chrome ${round(a[i][k])} vs xeet ${round(b[i][k])} (${round(d)})`);
    }
    // Border radius is clamped by the browser to half the shorter side, so
    // `9999px` on a 24 px pill and my `12` are the same shape.
    const eff = (r, b) => (r == null ? r : Math.min(r, Math.min(b.w, b.h) / 2));
    if (checkRadius && a[i].r != null && Math.abs(eff(a[i].r, a[i]) - eff(b[i].r, b[i])) > EPS) {
      problems.push(`${type}[${i}].radius chrome ${a[i].r} vs xeet ${b[i].r}`);
    }
    if (checkRadius && a[i].squircle != null && a[i].squircle !== b[i].squircle) {
      problems.push(`${type}[${i}].corner chrome ${a[i].squircle} vs xeet ${b[i].squircle}`);
    }
    if (a[i].color && b[i].color && a[i].color !== b[i].color) {
      problems.push(`${type}[${i}].color chrome ${a[i].color} vs xeet ${b[i].color}`);
    }
  }
  return { count: a.length, max, problems };
}

// --------------------------------------------------------------------- main

const browser = await launch();
const bin = cardsBinary();
const rows = [];

for (const fx of FIXTURES) {
  if (ONLY && fx.name !== ONLY) continue;
  let html = null;
  if (fx.file) html = await readFile(join(ROOT, "assets/vendor/corpus", fx.file), "utf8");

  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      const slot = width - 80; // the frame's text column: 16 + 40 + 8 + 16
      const { page } = await newPage(browser, { width, height: 1400, dpr: 1, theme, allowImages: false });
      page.setDefaultTimeout(20000);
      let seen = null;
      try {
      const page_ = fx.synthetic ? fx.synthetic({ slot }) : html;
      const doc = fx.synthetic
        ? `<!DOCTYPE html><html data-theme="${theme}" class="${theme}-theme"><head><meta charset="utf-8"><link rel="stylesheet" href="https://abs.twimg.com/x-web/x-web/assets/styles-CaGKZNWE.css"></head><body class="bg-primary"><div id="root" style="padding:0"></div><script></script></body></html>`
        : page_;
      // Prefetch (and cache) every image the document references, so no route
      // handler has to wait on the network while the page is loading.
      const imgUrls = [...String(doc).matchAll(/https:\/\/pbs\.twimg\.com\/[^"'& ]+/g)].map((m) => m[0]);
      await Promise.all([...new Set(imgUrls)].map((u) => serveImage(u).catch(() => null)));
      page.setDefaultNavigationTimeout(25000);
      await page.route(/^https:\/\/pbs\.twimg\.com\//, async (route) => {
        try {
          const entry = await serveImage(route.request().url());
          await route.fulfill({ contentType: entry.type, body: entry.body });
        } catch {
          await route.abort();
        }
      });
      await setContentAs(page, doc, "/i/cards-parity");
      // X animates several boxes in (`transition-[width]` on a poll bar,
      // `transition-[grid-template-columns]` on a poll row, `transition-opacity`
      // on the label swaps). Measuring after the animation would be a race, so
      // the final state is pinned instead.
      await page.addStyleTag({
        content: "*,*::before,*::after{transition:none!important;animation:none!important}",
      });
      if (fx.synthetic) {
        await page.evaluate((markup) => {
          document.getElementById("root").innerHTML = markup;
        }, fx.synthetic({ slot }));
        await page.evaluate(async () => {
          void document.body.offsetHeight;
          await document.fonts.ready;
          void document.body.offsetHeight;
        });
      }
      await page.evaluate(async () => {
        // Fonts decide every text box; images must *not* be waited for. Every
        // media box in X's markup is sized by an inline `aspect-ratio` or by the
        // image's `width`/`height` attributes, so the box is the same before and
        // after decode — but a decoded image lets Chrome lay it out from its
        // intrinsic ratio, which is a hair (2-3/64 px) wider than the ratio the
        // server rounded, and whether the decode lands before the measurement is
        // a race. Measuring before it makes the gate deterministic.
        await document.fonts.ready;
        void document.body.offsetHeight;
      });
      seen = await page.evaluate(measureInPage, {
        idx: fx.article ?? 0,
        kind: fx.kind,
        synthetic: !!fx.synthetic,
        debugLines: !!process.env.SHOW_LINES,
      });
      await page.context().close();
      } catch (err) {
        rows.push({ fixture: fx.name, width, theme, verdict: `CHROME FAIL ${String(err.message).split("\n")[0].slice(0, 90)}` });
        try { await page.context().close(); } catch {}
        continue;
      }
      if (!seen || seen.error) {
        rows.push({ fixture: fx.name, width, theme, verdict: `ERROR ${seen?.error ?? "no measurement"}` });
        continue;
      }
      const body = {
        kind: fx.kind,
        // The slot is whatever width X's own column has at this viewport, so
        // the comparison never depends on our idea of the page chrome.
        width: seen.attBox.w,
        post: postFor(fx, seen),
        opts: { theme, width, dpr: 1, surface: "web-timeline", fontScale: 1 },
      };
      if (fx.kind === "card") {
        const url = Object.keys(body.post.links ?? {})[0] ?? "https://example.com/";
        body.card = { url, card: body.post.links?.[url]?.card ?? fx.cardType ?? "summary_large_image" };
      }
      if (process.env.VERBOSE && process.env.SHOW_INPUT) console.log(fx.name, JSON.stringify(seen.input));
      if (process.env.SHOW_INPUT) console.log(fx.name, JSON.stringify(seen.input));
      if (process.env.SHOW_POST) console.log(fx.name, "post", JSON.stringify(body.post), "w", body.width);
      let rust;
      try {
        rust = runCardsDump(bin, body);
      } catch (err) {
        rows.push({ fixture: fx.name, width, theme, verdict: `RUST FAIL ${err.message.split("\n")[0]}` });
        if (process.env.VERBOSE) console.log("post:", JSON.stringify(body.post), "err:", err.message.slice(0, 300));
        continue;
      }
      const parts = [];
      let failed = false;
      for (const t of ["fill", "stroke", "image", "icon"]) {
        const r = compareType(seen.boxes, rust.boxes, t, true, t === "image" ? IMAGE_EPS : EPS);
        if (r.fail) {
          failed = true;
          parts.push(r.fail);
          if (process.env.VERBOSE) {
            console.log(`\n${fx.name} ${width} ${theme} ${t}`);
            console.log("chrome:", JSON.stringify(r.a));
            console.log("xeet:  ", JSON.stringify(r.b));
          }
        } else {
          if (r.problems.length) {
            failed = true;
            if (process.env.VERBOSE) {
              console.log(`\n${fx.name} ${width} ${theme} ${t} (values)`);
              console.log("chrome:", JSON.stringify(r.a));
              console.log("xeet:  ", JSON.stringify(r.b));
            }
            parts.push(...r.problems.slice(0, 4));
          }
          parts.push(`${t}:${r.count}@${round(r.max)}`);
        }
      }
      // Every image box must draw the *right* post's bytes, at the right depth.
      // Chrome says how deep in the quote nesting an `<img>` is; our display list
      // says which `ImageRef` it draws. A quoted video emitted as
      // `ImageRef::Media(i)` has the same index as the outer post's media, and a
      // nested preview's thumbnail has the same index as the quote's, so the name
      // alone cannot tell them apart — the number of `quote:` hops can.
      const byPos = (p, q) => p.y - q.y || p.x - q.x || p.h - q.h;
      const cImg = seen.boxes.filter((b) => b.t === "image").sort(byPos);
      const rImg = rust.boxes.filter((b) => b.t === "image" && b.ref != null).sort(byPos);
      if (cImg.length === rImg.length) {
        const used = new Map();
        for (let i = 0; i < cImg.length; i++) {
          const ref = String(rImg[i].ref);
          const hops = (ref.match(/quote:/g) ?? []).length;
          const want = cImg[i].inQuote ? (cImg[i].nested ? 2 : 1) : 0;
          if (hops !== want) {
            failed = true;
            parts.push(
              `image[${i}].ref ${ref} has ${hops} quote hop(s), the box is at depth ${want}` +
                (cImg[i].nested ? " (nested preview)" : ""),
            );
          }
          used.set(ref, (used.get(ref) ?? 0) + 1);
        }
        for (const [ref, n] of used) {
          if (n > 1) {
            failed = true;
            parts.push(`image ref ${ref} used ${n} times`);
          }
        }
      }

      // Text lines: compare left edge and advance width, in order.
      if (process.env.SHOW_LINES) console.log(fx.name, width, theme, "chrome", JSON.stringify(seen.lines), "xeet", JSON.stringify(rust.lines));
      const chLines = seen.lines;
      const ruLines = rust.lines;
      if (chLines.length !== ruLines.length) {
        failed = true;
        parts.push(`lines: chrome ${chLines.length} vs xeet ${ruLines.length}`);
        if (process.env.VERBOSE) {
          console.log(`\n${fx.name} ${width} ${theme} lines`);
          console.log("chrome:", JSON.stringify(chLines));
          console.log("xeet:  ", JSON.stringify(ruLines));
        }
      } else {
        // Leftmost start per line; the vertical position is pinned by the box
        // geometry and the type-scale model instead (see the measurement code).
        let max = 0;
        for (let i = 0; i < chLines.length; i++) {
          max = Math.max(max, Math.abs(chLines[i].x - ruLines[i].x));
          // A line that must not be ellipsized has one glyph run; a clamped title
          // line has two (the text and the "…"). Chrome's own count is printed
          // for context; the expectation is the fixture's, because Chrome's DOM
          // never contains the ellipsis it paints.
          const want = fx.runs?.[i];
          if (want != null && ruLines[i].runs !== want) {
            failed = true;
            parts.push(`line[${i}].runs xeet ${ruLines[i].runs} want ${want} (chrome rects ${chLines[i].runs ?? "?"})`);
          }
        }
        if (max > EPS) {
          failed = true;
          parts.push(`lines max ${round(max)}`);
          if (process.env.VERBOSE) {
            console.log(`\n${fx.name} ${width} ${theme} lines`);
            console.log("chrome:", JSON.stringify(chLines));
            console.log("xeet:  ", JSON.stringify(ruLines));
          }
        } else {
          parts.push(`lines:${chLines.length}@${round(max)}`);
        }
      }
      const dh = Math.abs(seen.attBox.h - rust.height);
      if (dh > EPS) failed = true;
      rows.push({
        fixture: fx.name,
        width,
        theme,
        height: `${round(seen.attBox.h)} / ${round(rust.height)}`,
        detail: parts.join(" "),
        verdict: failed ? "FAIL" : "ok",
      });
    }
  }
}

await browser.close();

const w = (s, n) => String(s).padEnd(n);
console.log(`\n${w("fixture", 18)}${w("w", 5)}${w("theme", 7)}${w("height chrome/xeet", 22)}${w("verdict", 8)}detail`);
let fails = 0;
for (const r of rows) {
  if (r.verdict !== "ok") fails++;
  console.log(`${w(r.fixture, 18)}${w(r.width, 5)}${w(r.theme, 7)}${w(r.height ?? "", 22)}${w(r.verdict, 8)}${r.detail ?? ""}`);
}
console.log(`\n${rows.length - fails}/${rows.length} pass`);
process.exit(fails ? 1 : 0);
