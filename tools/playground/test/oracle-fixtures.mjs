#!/usr/bin/env node
// Every shape the playground can be handed, in both themes, at every width.
//
//   node tools/playground/test/oracle-fixtures.mjs [--json tmp/fixtures.json] [--keep]
//
// For each fixture × theme × width this renders through the Chrome target and
// asserts the frame contract rather than a picture:
//
//   * it renders (no thrown error, no empty attachment, no lost body);
//   * the PNG is exactly `cellWidth × height` at the requested dpr;
//   * the cell is `min(width, 600)` wide — the column xeet draws;
//   * the padding is X's 16/12 (the cell, not the article, is the frame);
//   * the body's line boxes are inside the text box;
//   * something was painted (a blank cell means the injection missed).
//
// Fixtures that need a captured page (a card whose metadata the corpus keeps)
// also run in page mode, which is the same question asked of the real site.
//
// Exit code 1 on any failure.
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createChrome, MAX_CELL_WIDTH } from "../lib/chrome.mjs";
import { ROOT } from "../../oracle/browser.mjs";
import { extractTweets } from "../../oracle/samples.mjs";
import { payloadToPost } from "../../ship/corpus-post.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);
const JSON_OUT = opt("json", null);
const KEEP = has("keep");
const WIDTHS = (opt("widths", "320,382,390,600")).split(",").map(Number);
/** The iPhone Duo: 382 closed, 669 open, 951 landscape — all at dpr 3. */
const DUO_WIDTHS = (opt("duo", "382,669,951")).split(",").map(Number);
const THEMES = opt("themes", "light,dark").split(",");
const DPR = Number(opt("dpr", "2"));
const lock = JSON.parse(await readFile(join(ROOT, "assets", "upstream.lock.json"), "utf8"));

const author = (name, handle, extra = {}) => ({ name, handle, ...extra });
const image = (width, height, extra = {}) => ({ kind: "image", width, height, ...extra });
/** A link whose metadata would draw a card (a URL with no card renders none). */
const hasCard = (post) => Object.values(post.links ?? {}).some((link) => link?.card);

/** The fixtures: one per component the model can express. */
export const FIXTURES = [
  { name: "text-only", post: { text: "We just shipped the thing.\n\nIt is faster than the thing before it.", author: author("Vercel", "vercel", { verified: "blue" }), createdAt: "2026-11-09T18:00:00.000Z", now: "2026-11-09T20:57:17.555Z", counts: { replies: 12, reposts: 340, likes: 5432, views: 133337, bookmarks: 4 } } },
  { name: "text-entities", post: { text: "Hi @vercel and @nextjs — https://vercel.com/blog/a-very-long-title-here is live #shipping #webdev $TSLA", author: author("Rauch", "rauchg"), createdAt: "2026-11-08T10:00:00.000Z", now: "2026-11-09T20:57:17.555Z", links: { "https://vercel.com/blog/a-very-long-title-here": { display: "vercel.com/blog/a-very-lo…" } } } },
  { name: "text-unicode", post: { text: "Family: 👨‍👩‍👧‍👦 flag: 🇫🇷 skin: 👍🏽 keycap: 1️⃣ rtl: مرحبا بالعالم · 日本語 · “quotes” — dashes…", author: author("Unicode", "unicode") } },
  { name: "text-empty", post: { text: "", author: author("Quiet", "quiet") } },
  { name: "no-counts", post: { text: "A fresh post with no numbers yet.", author: author("New", "new") } },
  { name: "pinned", post: { text: "The pinned one.", author: author("Acme", "acme", { verified: "business" }), socialContext: "pinned", createdAt: "2026-11-01T12:00:00.000Z", now: "2026-11-09T20:57:17.555Z" } },
  { name: "affiliate", post: { text: "Shipped with our friends.", author: author("Acme", "acme", { verified: "blue", affiliate: { name: "Square" } }) } },
  { name: "long-post", post: { text: `${"Long post body that keeps going and going. ".repeat(9)}tail`, author: author("Long", "long") } },
  { name: "media-1", post: { text: "One photo.", author: author("Photo", "photo"), media: [image(1600, 900, { alt: "A landscape" })] } },
  { name: "media-1-portrait", post: { text: "One tall photo, which the 510 px cap shortens.", author: author("Photo", "photo"), media: [image(1080, 1350)] } },
  { name: "media-2", post: { text: "Two photos.", author: author("Photo", "photo"), media: [image(1200, 1200), image(1080, 1350)] } },
  { name: "media-3", post: { text: "Three photos.", author: author("Photo", "photo"), media: [image(1200, 800), image(800, 1200), image(1000, 1000)] } },
  { name: "media-4", post: { text: "Four photos.", author: author("Photo", "photo"), media: [image(1920, 1080), image(1080, 1920), image(1200, 1200), image(900, 1600)] } },
  { name: "media-tags", post: { text: "Tagged accounts under the photo.", author: author("NASA", "NASA"), media: [image(1920, 1080)], mediaTags: ["Learn With NASA", "NASA Administrator Jared Isaacman"] } },
  { name: "media-tags-many", post: { text: "Seven tags.", author: author("NASA", "NASA"), media: [image(1920, 1080)], mediaTags: ["CAPEWEEK", "b", "c", "d", "e", "f", "g"] } },
  { name: "video", post: { text: "A clip.", author: author("Video", "video"), media: [{ kind: "video", width: 1280, height: 720, duration: 34 }] } },
  { name: "video-portrait", post: { text: "A vertical clip.", author: author("Video", "video"), media: [{ kind: "video", width: 720, height: 1280, duration: 12 }] } },
  { name: "gif", post: { text: "A GIF.", author: author("Gif", "gif"), media: [{ kind: "gif", width: 640, height: 480 }] } },
  {
    name: "card-large",
    post: {
      text: "A link card. https://example.com/story",
      author: author("Links", "links"),
      links: { "https://example.com/story": { card: "summary_large_image", title: "A headline long enough to be cut somewhere", domain: "example.com", image: { width: 1200, height: 628 } } },
    },
  },
  {
    name: "card-summary",
    post: {
      text: "A small card. https://example.com/a",
      author: author("Links", "links"),
      links: { "https://example.com/a": { card: "summary", title: "A title that wraps onto a second line in the small card", domain: "example.com" } },
    },
  },
  {
    name: "quote",
    post: {
      text: "Worth reading.",
      author: author("Quoter", "quoter"),
      quote: { text: "The quoted post's own body, short.", author: author("Quoted", "quoted", { verified: "blue" }), createdAt: "2026-11-05T09:00:00.000Z", now: "2026-11-09T20:57:17.555Z" },
    },
  },
  {
    name: "quote-media",
    post: {
      text: "Quoting with a photo.",
      author: author("Quoter", "quoter"),
      quote: { text: "Look at this.", author: author("Quoted", "quoted"), media: [image(1200, 900)], createdAt: "2026-11-05T09:00:00.000Z", now: "2026-11-09T20:57:17.555Z" },
    },
  },
  {
    name: "media-quote",
    post: {
      text: "My photo and someone else's.",
      author: author("Quoter", "quoter"),
      media: [image(1200, 1200)],
      quote: { text: "And this is the quoted one.", author: author("Quoted", "quoted"), media: [{ kind: "video", width: 1280, height: 720, duration: 11 }], createdAt: "2026-11-05T09:00:00.000Z", now: "2026-11-09T20:57:17.555Z" },
    },
  },
  {
    name: "quote-reply",
    post: {
      text: "A quoted reply.",
      author: author("Quoter", "quoter"),
      quote: { text: "Replying to someone here.", author: author("Quoted", "quoted"), replyToHandle: "someone", createdAt: "2026-11-05T09:00:00.000Z", now: "2026-11-09T20:57:17.555Z" },
    },
  },
  { name: "poll-2", post: { text: "Vote below.", author: author("Poll", "poll"), poll: { choices: ["Yes", "No"], votes: [10059, 7443] } } },
  { name: "poll-3-open", post: { text: "Three choices, still open.", author: author("Poll", "poll"), poll: { choices: ["Alpha", "Beta", "Gamma"], votes: [10, 20, 30], secondsLeft: 7200 } } },
  { name: "reply-mentions", post: { text: "@someone @else this is the reply body", author: author("Replier", "replier"), replyTo: "1", replyToHandle: "someone" } },
];

/** Fixtures whose attachment the replica can only draw approximately. */
const APPROXIMATE = new Set(["card-summary", "gif"]);

const chrome = await createChrome();
const rows = [];
let failed = 0;

function ink(png) {
  // A cheap "was anything painted" test: the PNG is compressed, so instead of
  // decoding it, ask Chrome for the text and attachment boxes (below) and use
  // the file size as a proxy for "not a flat rectangle".
  return png.length;
}

for (const fixture of FIXTURES) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      const problems = [];
      const row = { fixture: fixture.name, theme, width, dpr: DPR };
      try {
        const shot = await chrome.render({ post: fixture.post, options: { width, theme, dpr: DPR } });
        const cellWidth = Math.min(width, MAX_CELL_WIDTH);
        row.ms = shot.ms;
        row.width = shot.width;
        row.height = shot.height;
        row.decisions = shot.version.decisions;
        row.notes = shot.notes;
        if (Math.abs(shot.width - cellWidth) > 1 / 64) problems.push(`cell width ${shot.width} != ${cellWidth}`);
        if (Math.abs(shot.height - Math.round(shot.height * 64) / 64) > 1e-9) problems.push(`height not on the 1/64 grid (${shot.height})`);
        const pad = shot.frame.padding;
        if (Math.abs(pad.left - 16) > 0.01 || Math.abs(pad.right - 16) > 0.01) problems.push(`horizontal padding ${pad.left}/${pad.right} != 16`);
        if (Math.abs(pad.top - 12) > 0.01 || Math.abs(pad.bottom - 12) > 0.01) problems.push(`vertical padding ${pad.top}/${pad.bottom} != 12`);
        if (!(shot.height > 0)) problems.push("empty cell");
        if (ink(shot.png) < 1000) problems.push(`png is ${shot.png.length} bytes (blank?)`);
        const geom = shot.geometry;
        if (!geom.boxes.text && fixture.post.text) problems.push("body text box missing");
        const text = geom.boxes.text;
        if (text && geom.lines.length) {
          for (const line of geom.lines) {
            if (line.y < text.y - 0.5 || line.y + line.h > text.y + text.h + 0.5) problems.push("a body line is outside the text box");
            if (line.x < text.x - 0.5) problems.push("a body line starts left of the text box");
          }
        }
        if (fixture.post.text && !geom.lines.length) problems.push("body produced no line boxes");
        if (fixture.post.media?.length || fixture.post.poll || fixture.post.quote || hasCard(fixture.post)) {
          if (!geom.boxes.attachment) problems.push("attachment slot missing");
        }
        row.attachment = geom.boxes.attachment ? `${geom.boxes.attachment.w}x${geom.boxes.attachment.h}` : null;
        if (KEEP) {
          const dir = join(ROOT, "tmp", "fixtures");
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, `${fixture.name}-${theme}-${width}.png`), shot.png);
        }
      } catch (error) {
        problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
      }
      row.verdict = problems.length ? "fail" : APPROXIMATE.has(fixture.name) ? "ok*" : "ok";
      if (problems.length) failed++;
      if (problems.length) row.problems = problems;
      rows.push(row);
    }
  }
}

// Page mode has to work at the same widths and in both themes, on the real
// captures: the playground pastes an x.com URL and expects the same frame.
const PAGE_CASES = [
  { name: "jack-20", id: "20", file: "jack-20.html" },
  { name: "NASA", id: "2119846862286930036", file: "NASA.html" },
  { name: "poll-musk", id: "1604617643973124097", file: "poll-musk.html" },
];
for (const page of PAGE_CASES) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      const problems = [];
      const row = { fixture: `page:${page.file}`, theme, width, dpr: DPR, pageMode: true };
      try {
        const shot = await chrome.render({ post: { text: "", author: author("x", "x") }, options: { width, theme, dpr: DPR, surface: "web-timeline" }, mode: "page", source: { page: page.file, id: page.id } });
        row.width = shot.width;
        row.height = shot.height;
        if (Math.abs(shot.width - Math.min(width, MAX_CELL_WIDTH)) > 1 / 64) problems.push(`cell width ${shot.width} != ${Math.min(width, MAX_CELL_WIDTH)}`);
        if (!(shot.height > 10)) problems.push("empty cell");
        if (ink(shot.png) < 1000) problems.push("blank png");
        if (shot.measuredId && String(shot.measuredId) !== String(page.id)) problems.push(`paired with ${shot.measuredId}`);
      } catch (error) {
        problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
      }
      row.verdict = problems.length ? "fail" : "ok";
      if (problems.length) failed++;
      if (problems.length) row.problems = problems;
      rows.push(row);
    }
  }
}

// dpr affects only the pixel grid, but the frame it reports must follow it.
for (const dpr of [1, 3]) {
  const problems = [];
  const row = { fixture: "dpr", theme: "light", width: 390, dpr };
  try {
    const shot = await chrome.render({ post: FIXTURES[0].post, options: { width: 390, theme: "light", dpr } });
    row.width = shot.width;
    row.height = shot.height;
    if (shot.dpr !== dpr) problems.push(`dpr ${shot.dpr} != ${dpr}`);
    // The PNG's own IHDR says whether the pixels follow the ratio.
    const w = shot.png.readUInt32BE(16);
    const h = shot.png.readUInt32BE(20);
    if (Math.abs(w - Math.round(shot.width * dpr)) > 1) problems.push(`png width ${w} != ${Math.round(shot.width * dpr)}`);
    if (Math.abs(h - Math.round(shot.height * dpr)) > 1) problems.push(`png height ${h} != ${Math.round(shot.height * dpr)}`);
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  row.verdict = problems.length ? "fail" : "ok";
  if (problems.length) failed++;
  if (problems.length) row.problems = problems;
  rows.push(row);
}

// ---------------------------------------------------------------------------
// The three defects the pixels caught, and nothing but pixels can
//
// Geometry could not see any of them: a gradient-only badge and a scalloped one
// have the same box, an invented avatar stub and X's default image have the same
// box, and font smoothing changes ink, never metrics. They are checked here by
// decoding the rendered PNG and reading the box the geometry reported.
// ---------------------------------------------------------------------------

/** A scratch page in the oracle's own browser, for decoding PNGs on a canvas. */
let decodePage = null;
async function pixels(png, box, dpr) {
  decodePage ??= await chrome._debug.browser.newPage();
  const src = `data:image/png;base64,${png.toString("base64")}`;
  const rect = {
    x: Math.round(box.x * dpr),
    y: Math.round(box.y * dpr),
    w: Math.max(1, Math.round(box.w * dpr)),
    h: Math.max(1, Math.round(box.h * dpr)),
  };
  return decodePage.evaluate(async ([url, r]) => {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(r.x, r.y, r.w, r.h).data;
    let painted = 0;
    let maxSpread = 0;
    let inkSum = 0;
    let magenta = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [red, green, blue] = [data[i], data[i + 1], data[i + 2]];
      const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
      if (spread > maxSpread) maxSpread = spread;
      // The injected test bytes are solid magenta: nothing X draws is.
      if (red > 150 && blue > 150 && green < 100) magenta++;
      // On a white page anything below 235 is ink.
      if (red < 235 || green < 235 || blue < 235) {
        painted++;
        inkSum += 765 - (red + green + blue);
      }
    }
    const total = r.w * r.h;
    return { painted: painted / total, ink: inkSum / total, maxSpread, magenta: magenta / total, w: img.width, h: img.height };
  }, [src, rect]);
}

const audit = [];

// 1. The verified badge. X's gold badge is a scalloped shape whose two fills are
//    gradients defined *inside* the sprite symbol; if the sprite's `<defs>` are
//    not in the document, only the solid inner check paints — 0.04 of the box
//    instead of 0.40, which is exactly the "thin gold tick" a user saw.
for (const verified of ["business", "blue", "government"]) {
  const post = {
    text: "A badge.",
    author: { name: "Acme", handle: "acme", verified },
    createdAt: "2026-11-09T18:00:00.000Z",
    now: "2026-11-09T20:57:17.555Z",
  };
  const row = { fixture: `badge:${verified}`, theme: "light", width: 390, dpr: 2 };
  const problems = [];
  try {
    const shot = await chrome.render({ post, options: { width: 390, dpr: 2 } });
    row.width = shot.width;
    row.height = shot.height;
    const badge = shot.geometry.boxes.badge;
    if (!badge) problems.push("no badge box");
    else {
      const px = await pixels(shot.png, badge, 2);
      row.attachment = `ink ${px.painted.toFixed(2)}`;
      // A scalloped badge fills ~0.40 of its box; the gradient-less one 0.04.
      if (px.painted < 0.2) problems.push(`badge ink ${px.painted.toFixed(3)} of its box (a thin tick, not the badge)`);
    }
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  row.verdict = problems.length ? "fail" : "ok";
  if (problems.length) failed++;
  if (problems.length) row.problems = problems;
  rows.push(row);
  audit.push(row);
}
{
  // No badge at all: the wrapper is dropped, not left empty.
  const row = { fixture: "badge:none", theme: "light", width: 390, dpr: 2 };
  const problems = [];
  try {
    const shot = await chrome.render({ post: { text: "No badge.", author: { name: "Acme", handle: "acme" } }, options: { width: 390, dpr: 2 } });
    row.width = shot.width;
    row.height = shot.height;
    if (shot.geometry.boxes.badge) problems.push("an unverified author still has a badge box");
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  row.verdict = problems.length ? "fail" : "ok";
  if (problems.length) failed++;
  if (problems.length) row.problems = problems;
  rows.push(row);
  audit.push(row);
}

// 2. Avatars: X's own default profile image when the post carries no bytes (a
//    grey silhouette on a grey field — the old invented stub was a saturated
//    green square), and the *model's* `squareAvatar`, never the badge's kind.
{
  const cases = [
    // `rounded-full` is 9999px in X's stylesheet; a square avatar is 10%.
    { name: "avatar:default-round", author: { name: "Acme", handle: "acme", verified: "business" }, radius: "9999px" },
    { name: "avatar:square", author: { name: "Acme", handle: "acme", verified: "business", squareAvatar: true }, radius: "10%" },
    { name: "avatar:round-plain", author: { name: "Acme", handle: "acme" }, radius: "9999px" },
  ];
  for (const c of cases) {
    const row = { fixture: c.name, theme: "light", width: 390, dpr: 2 };
    const problems = [];
    try {
      const shot = await chrome.render({ post: { text: "An avatar.", author: c.author }, options: { width: 390, dpr: 2 } });
      row.width = shot.width;
      row.height = shot.height;
      const shape = shot.geometry.boxes.avatarShape;
      const avatar = shot.geometry.boxes.avatar;
      row.attachment = `radius ${shape?.radius ?? "—"}`;
      if (!shape) problems.push("no avatar shape box");
      else if (shape.radius !== c.radius) problems.push(`avatar radius ${shape.radius} != ${c.radius}`);
      if (!avatar) problems.push("no avatar box");
      else {
        const px = await pixels(shot.png, avatar, 2);
        if (px.painted < 0.5) problems.push(`avatar is ${(px.painted * 100).toFixed(0)}% painted (no picture)`);
        // X's default artwork is grey; a saturated field means an invented stub.
        if (px.maxSpread > 60) problems.push(`avatar is saturated (channel spread ${px.maxSpread}): not X's default image`);
      }
    } catch (error) {
      problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
    }
    row.verdict = problems.length ? "fail" : "ok";
    if (problems.length) failed++;
    if (problems.length) row.problems = problems;
    rows.push(row);
    audit.push(row);
  }
}

// A quoted post's avatar takes the same path (default image, model shape).
{
  const row = { fixture: "avatar:quote-default", theme: "light", width: 390, dpr: 2 };
  const problems = [];
  try {
    const shot = await chrome.render({
      post: {
        text: "Quoting someone with no picture.",
        author: { name: "Quoter", handle: "quoter", verified: "blue" },
        quote: { text: "Quoted body.", author: { name: "Quoted", handle: "quoted" }, createdAt: "2026-11-05T09:00:00.000Z", now: "2026-11-09T20:57:17.555Z" },
      },
      options: { width: 390, dpr: 2 },
    });
    row.width = shot.width;
    row.height = shot.height;
    const shape = shot.geometry.boxes.quoteAvatar;
    if (!shape) problems.push("no quoted avatar box");
    else {
      row.attachment = `${shape.w}x${shape.h}`;
      const px = await pixels(shot.png, shape, 2);
      if (px.painted < 0.5) problems.push(`quoted avatar is ${(px.painted * 100).toFixed(0)}% painted (no picture)`);
      if (px.maxSpread > 60) problems.push(`quoted avatar is saturated (channel spread ${px.maxSpread})`);
    }
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  row.verdict = problems.length ? "fail" : "ok";
  if (problems.length) failed++;
  if (problems.length) row.problems = problems;
  rows.push(row);
  audit.push(row);
}

// 3. Smoothing. `antialiased` (the default) is the platform-neutral reference the
//    gates use; `platform` is what this machine's Chrome draws on x.com, where
//    CoreText dilates glyphs (docs/e2e-raster.md §1: 1.13x ink). Same metrics
//    either way — only the ink changes.
{
  const post = FIXTURES[0].post;
  const row = { fixture: "smoothing", theme: "light", width: 390, dpr: 2 };
  const problems = [];
  try {
    const aa = await chrome.render({ post, options: { width: 390, dpr: 2 } });
    const platform = await chrome.render({ post, options: { width: 390, dpr: 2, smoothing: "platform" } });
    row.width = aa.width;
    row.height = aa.height;
    const text = aa.geometry.boxes.text;
    if (aa.version.smoothing !== "antialiased") problems.push(`default smoothing is ${aa.version.smoothing}`);
    if (platform.version.smoothing !== "platform") problems.push(`platform smoothing reported as ${platform.version.smoothing}`);
    if (aa.png.equals(platform.png)) problems.push("the two settings produced identical pixels: the style never reached the page");
    if (Math.abs(aa.height - platform.height) > 1 / 64) problems.push(`heights differ (${aa.height} vs ${platform.height}); smoothing must not change metrics`);
    const inkAa = await pixels(aa.png, text, 2);
    const inkPf = await pixels(platform.png, text, 2);
    row.attachment = `ink aa ${inkAa.ink.toFixed(1)} / platform ${inkPf.ink.toFixed(1)}`;
    if (process.platform === "darwin" && !(inkPf.ink > inkAa.ink * 1.03)) {
      problems.push(`platform smoothing is not heavier than antialiased (${inkPf.ink.toFixed(1)} vs ${inkAa.ink.toFixed(1)}): CoreText dilation missing`);
    }
    // Back to the default: the page must return to the same pixels it had.
    const back = await chrome.render({ post, options: { width: 390, dpr: 2 } });
    if (!back.png.equals(aa.png)) problems.push("returning to antialiased did not restore the first render's pixels");
    if (back.version.smoothing !== "antialiased") problems.push(`after the toggle, smoothing is ${back.version.smoothing}`);
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  row.verdict = problems.length ? "fail" : "ok";
  if (problems.length) failed++;
  if (problems.length) row.problems = problems;
  rows.push(row);
  audit.push(row);
}

// 4. The badge, replica against the real page: `IGN.html`'s cell is a
//    business-verified account, so the same gold badge is drawn on both sides.
{
  const html = await readFile(join(ROOT, "assets", "vendor", "corpus", "IGN.html"), "utf8");
  const tweet = extractTweets(html).find((t) => t.rest_id === "2119835412403474942");
  const { post, meta } = payloadToPost(tweet, { now: lock.fetchedAt, appVersion: html.match(/"appVersion":"([0-9a-f]+)"/)?.[1] });
  const row = { fixture: "badge:page-vs-replica", theme: "light", width: 600, dpr: 2 };
  const problems = [];
  try {
    const pageShot = await chrome.render({ post, options: { width: 600, dpr: 2 }, mode: "page", source: { page: "IGN.html", id: String(meta.restId) } });
    const replica = await chrome.render({
      post: pageShot.geometry.boxes.pinnedRow ? { ...post, socialContext: "pinned" } : post,
      options: { width: pageShot.width, dpr: 2 },
    });
    row.width = pageShot.width;
    row.height = pageShot.height;
    const a = pageShot.geometry.boxes.badge;
    const b = replica.geometry.boxes.badge;
    if (!a || !b) problems.push(`badge box missing (page ${Boolean(a)}, replica ${Boolean(b)})`);
    else {
      const pa = await pixels(pageShot.png, a, 2);
      const pb = await pixels(replica.png, b, 2);
      row.attachment = `page ${pa.painted.toFixed(2)} / replica ${pb.painted.toFixed(2)}`;
      if (pa.painted < 0.2) problems.push(`the captured page's badge only paints ${pa.painted.toFixed(3)} of its box`);
      if (Math.abs(pa.painted - pb.painted) > 0.1) problems.push(`badge ink page ${pa.painted.toFixed(3)} vs replica ${pb.painted.toFixed(3)}`);
    }
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  row.verdict = problems.length ? "fail" : "ok";
  if (problems.length) failed++;
  if (problems.length) row.problems = problems;
  rows.push(row);
  audit.push(row);
}
// 5. The clock. The replica must format `post.createdAt`/`post.now` exactly as
//    xeet's `frame::time::label` does, and must never read a clock of its own:
//    the detail surface used to print "5:04 PM · Nov 10, 2026" for a post with
//    no `createdAt`, where xeet says "Now".
{
  const base = { text: "A post.", author: { name: "Clock", handle: "clock" } };
  const cases = [
    { name: "stamp:detail", surface: "web-detail", post: { ...base, createdAt: "2026-11-10T17:04:00.000Z", now: "2026-11-10T18:00:00.000Z" }, expect: "5:04 PM · Nov 10, 2026" },
    // The offset the ISO string carries is the display zone: 17:04-05:00 is
    // 5:04 PM, not 10:04 PM.
    { name: "stamp:detail-offset", surface: "web-detail", post: { ...base, createdAt: "2026-11-10T17:04:00.000-05:00", now: "2026-11-10T23:00:00.000Z" }, expect: "5:04 PM · Nov 10, 2026" },
    { name: "stamp:detail-no-created", surface: "web-detail", post: base, expect: "Now" },
    { name: "stamp:detail-garbage", surface: "web-detail", post: { ...base, createdAt: "yesterday" }, expect: "Now" },
    { name: "stamp:hours", post: { ...base, createdAt: "2026-11-10T15:00:00.000Z", now: "2026-11-10T18:00:00.000Z" }, expect: "3h" },
    { name: "stamp:minutes", post: { ...base, createdAt: "2026-11-10T17:58:00.000Z", now: "2026-11-10T18:00:00.000Z" }, expect: "2m" },
    { name: "stamp:seconds", post: { ...base, createdAt: "2026-11-10T17:59:15.000Z", now: "2026-11-10T18:00:00.000Z" }, expect: "45s" },
    { name: "stamp:same-year", post: { ...base, createdAt: "2026-11-08T12:00:00.000Z", now: "2026-11-10T18:00:00.000Z" }, expect: "Nov 8" },
    { name: "stamp:last-year", post: { ...base, createdAt: "2025-11-09T12:00:00.000Z", now: "2026-11-10T18:00:00.000Z" }, expect: "Nov 9, 2025" },
    // The date is the post's own day *in its own offset*: 23:30-05:00 is Nov 8.
    { name: "stamp:offset-date", post: { ...base, createdAt: "2026-11-08T23:30:00.000-05:00", now: "2026-11-10T18:00:00.000Z" }, expect: "Nov 8" },
    { name: "stamp:no-now", post: { ...base, createdAt: "2026-11-08T12:00:00.000Z" }, expect: "Now" },
    { name: "stamp:no-created", post: base, expect: "Now" },
    { name: "stamp:future", post: { ...base, createdAt: "2026-11-10T19:00:00.000Z", now: "2026-11-10T18:00:00.000Z" }, expect: "Now" },
    // The quoted post's label: its own `createdAt`, the **post's** `now`. A
    // resolver sends `now` once, on the outer post, and a quoted post carries
    // only `createdAt` — so these cases deliberately leave `quote.now` out.
    // (The earlier case supplied `quote.now`, which is exactly why it kept
    // passing while every real quote printed "Now".)
    {
      name: "stamp:quote",
      post: {
        ...base,
        createdAt: "2026-11-10T17:00:00.000Z",
        now: "2026-11-10T18:00:00.000Z",
        quote: { text: "Quoted.", author: { name: "Quoted", handle: "quoted" }, createdAt: "2026-11-05T09:00:00.000Z" },
      },
      expect: "1h",
      quoteExpect: "Nov 5",
    },
    // Three ISO strings for the same quoted post: the day is the quoted post's
    // own, in the offset its string carries. `02:12Z` and `11:12+09:00` are the
    // same instant, so they must print the same date.
    {
      name: "stamp:quote-utc",
      post: { ...base, createdAt: "2026-11-10T18:12:00.000Z", now: "2026-11-10T18:12:00.000Z", quote: { text: "Quoted.", author: { name: "Quoted", handle: "quoted" }, createdAt: "2026-11-05T02:12:00Z" } },
      expect: "Now",
      quoteExpect: "Nov 5",
    },
    {
      name: "stamp:quote-pacific",
      post: { ...base, createdAt: "2026-11-10T18:12:00.000Z", now: "2026-11-10T18:12:00.000Z", quote: { text: "Quoted.", author: { name: "Quoted", handle: "quoted" }, createdAt: "2026-11-04T18:12:00-08:00" } },
      expect: "Now",
      quoteExpect: "Nov 4",
    },
    {
      name: "stamp:quote-tokyo",
      post: { ...base, createdAt: "2026-11-10T18:12:00.000Z", now: "2026-11-10T18:12:00.000Z", quote: { text: "Quoted.", author: { name: "Quoted", handle: "quoted" }, createdAt: "2026-11-05T11:12:00+09:00" } },
      expect: "Now",
      quoteExpect: "Nov 5",
    },
    {
      name: "stamp:quote-relative",
      post: { ...base, createdAt: "2026-11-10T18:12:00.000Z", now: "2026-11-10T18:12:00.000Z", quote: { text: "Quoted.", author: { name: "Quoted", handle: "quoted" }, createdAt: "2026-11-10T15:12:00Z" } },
      expect: "Now",
      quoteExpect: "3h",
    },
  ];
  for (const c of cases) {
    const row = { fixture: c.name, theme: "light", width: 390, dpr: 2 };
    const problems = [];
    try {
      const shot = await chrome.render({ post: c.post, options: { width: 390, dpr: 2, surface: c.surface ?? "web-timeline" } });
      row.width = shot.width;
      row.height = shot.height;
      const stamp = shot.geometry.texts?.timestamp ?? null;
      if (stamp !== c.expect) problems.push(`timestamp ${JSON.stringify(stamp)} != ${JSON.stringify(c.expect)}`);
      // A quoted post's label comes from the quoted post's own strings.
      const quoteStamp = shot.geometry.texts?.quoteTimestamp ?? null;
      if (c.quoteExpect && quoteStamp !== c.quoteExpect) problems.push(`quoted timestamp ${JSON.stringify(quoteStamp)} != ${JSON.stringify(c.quoteExpect)}`);
      row.attachment = c.quoteExpect ? `${stamp} / ${quoteStamp}` : stamp;
    } catch (error) {
      problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
    }
    row.verdict = problems.length ? "fail" : "ok";
    if (problems.length) failed++;
    if (problems.length) row.problems = problems;
    rows.push(row);
    audit.push(row);
  }
}

// 6b. The quoted post's clock reaches the pixels. The bug this pins: the replica
//     formatted the quote with `quote.now`, which a resolver never sends, so
//     every quote printed "Now" and three different `createdAt` values produced
//     byte-identical PNGs. Labels are checked above; here the *pixels* are: the
//     two strings that land on different days must not render the same image,
//     and the two that are the same instant must.
{
  const now = "2026-11-10T18:12:00Z";
  const withQuote = (createdAt) => ({
    text: "Look at this.",
    author: author("Quote", "quote"),
    createdAt: now,
    now,
    quote: { text: "Quoted.", author: author("Quoted", "quoted"), createdAt },
  });
  const cases = [
    ["utc", "2026-11-05T02:12:00Z", "Nov 5"],
    ["pacific", "2026-11-04T18:12:00-08:00", "Nov 4"],
    ["tokyo", "2026-11-05T11:12:00+09:00", "Nov 5"],
    ["relative", "2026-11-10T15:12:00Z", "3h"],
  ];
  const row = { fixture: "quote:stamp-pixels", theme: "light", width: 390, dpr: 2 };
  const problems = [];
  try {
    const shots = {};
    for (const [name, createdAt, want] of cases) {
      const shot = await chrome.render({ post: withQuote(createdAt), options: { width: 390, dpr: 2 } });
      shots[name] = shot;
      const label = shot.geometry.texts?.quoteTimestamp ?? null;
      if (label !== want) problems.push(`${name}: quoted timestamp ${JSON.stringify(label)} != ${JSON.stringify(want)}`);
      if (shot.geometry.texts?.timestamp !== "Now") problems.push(`${name}: the cell's own timestamp changed (${JSON.stringify(shot.geometry.texts?.timestamp)})`);
    }
    // Different days, different pixels; the same instant, the same pixels.
    const differs = (a, b, why) => {
      if (shots[a].png.equals(shots[b].png)) problems.push(`${a} and ${b} render byte-identical PNGs (${why})`);
    };
    differs("utc", "pacific", "Nov 5 vs Nov 4");
    differs("pacific", "relative", "Nov 4 vs 3h");
    differs("utc", "relative", "Nov 5 vs 3h");
    if (!shots.utc.png.equals(shots.tokyo.png)) problems.push("02:12Z and 11:12+09:00 are the same instant but rendered differently");
    row.width = shots.utc.width;
    row.height = shots.utc.height;
    row.attachment = cases.map(([name]) => `${name} ${shots[name].geometry.texts?.quoteTimestamp}`).join(" / ");
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  row.verdict = problems.length ? "fail" : "ok";
  if (problems.length) failed++;
  if (problems.length) row.problems = problems;
  rows.push(row);
  audit.push(row);
}

// The detail timestamp against the real page: `jack-20`'s post 20 is
// `8:50 PM · Mar 21, 2006` in the capture, and the payload's `created_at_ms`
// is the only input the replica gets.
{
  const html = await readFile(join(ROOT, "assets", "vendor", "corpus", "jack-20.html"), "utf8");
  const tweet = extractTweets(html).find((t) => t.rest_id === "20");
  const { post, meta } = payloadToPost(tweet, { now: lock.fetchedAt, appVersion: html.match(/"appVersion":"([0-9a-f]+)"/)?.[1] });
  const row = { fixture: "stamp:page-vs-replica", theme: "light", width: 600, dpr: 2 };
  const problems = [];
  try {
    const pageShot = await chrome.render({ post, options: { width: 600, dpr: 2, surface: "web-detail" }, mode: "page", source: { page: "jack-20.html", id: String(meta.restId) } });
    const replica = await chrome.render({ post, options: { width: pageShot.width, dpr: 2, surface: "web-detail" } });
    row.width = pageShot.width;
    row.height = pageShot.height;
    const a = pageShot.geometry.texts?.timestamp ?? null;
    const b = replica.geometry.texts?.timestamp ?? null;
    row.attachment = `${a} / ${b}`;
    if (a !== b) problems.push(`detail timestamp page ${JSON.stringify(a)} vs replica ${JSON.stringify(b)}`);
    if (Math.abs(replica.height - pageShot.height) > 1 / 64) problems.push(`height ${pageShot.height} vs ${replica.height}`);
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  row.verdict = problems.length ? "fail" : "ok";
  if (problems.length) failed++;
  if (problems.length) row.problems = problems;
  rows.push(row);
  audit.push(row);
}

// 6. The link resolver's image bytes are drawn, not stubbed. A 1x1 magenta PNG
//    stretched over each box: nothing X draws is magenta, so a pixel that is
//    magenta came from the post.
{
  const MAGENTA =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAD0lEQVR4AQEEAPv/AP8A/wAAAAE6EuYAAAAAAElFTkSuQmCC";
  const cases = [
    { name: "bytes:media", post: { text: "Bytes.", author: author("B", "b"), media: [{ kind: "image", width: 1200, height: 800, data: MAGENTA }] }, box: "attachment" },
    {
      name: "bytes:card",
      post: { text: "Bytes. https://example.com/x", author: author("B", "b"), links: { "https://example.com/x": { card: "summary_large_image", title: "T", domain: "example.com", image: { width: 1200, height: 628, data: MAGENTA } } } },
      box: "attachment",
      // The image is the top of the card; the title bar and `From …` are below.
      sample: (box) => ({ x: box.x + 4, y: box.y + 4, w: Math.max(1, box.w - 8), h: Math.max(1, box.h * 0.5) }),
    },
    {
      name: "bytes:card-summary",
      post: { text: "Bytes. https://example.com/y", author: author("B", "b"), links: { "https://example.com/y": { card: "summary", title: "T", domain: "example.com", image: { width: 400, height: 400, data: MAGENTA } } } },
      box: "attachment",
      // The 90 px thumbnail at the start of the card.
      sample: (box) => ({ x: box.x + 2, y: box.y + 2, w: 86, h: Math.min(86, Math.max(1, box.h - 4)) }),
    },
    { name: "bytes:avatar", post: { text: "Bytes.", author: author("B", "b", { avatar: MAGENTA }) }, box: "avatar" },
  ];
  for (const c of cases) {
    const row = { fixture: c.name, theme: "light", width: 390, dpr: 2 };
    const problems = [];
    try {
      const shot = await chrome.render({ post: c.post, options: { width: 390, dpr: 2 } });
      row.width = shot.width;
      row.height = shot.height;
      const box = shot.geometry.boxes[c.box];
      if (!box) problems.push(`no ${c.box} box`);
      else {
        const px = await pixels(shot.png, c.sample ? c.sample(box) : box, 2);
        row.attachment = `magenta ${px.magenta.toFixed(2)}`;
        if (px.magenta < 0.5) problems.push(`${c.box} is only ${(px.magenta * 100).toFixed(0)}% magenta: the bytes were not drawn`);
      }
    } catch (error) {
      problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
    }
    row.verdict = problems.length ? "fail" : "ok";
    if (problems.length) failed++;
    if (problems.length) row.problems = problems;
    rows.push(row);
    audit.push(row);
  }
  // The same card without bytes keeps the labelled stub: the check above can
  // tell the two apart.
  const row = { fixture: "bytes:none", theme: "light", width: 390, dpr: 2 };
  const problems = [];
  try {
    const shot = await chrome.render({
      post: { text: "No bytes. https://example.com/z", author: author("B", "b"), links: { "https://example.com/z": { card: "summary_large_image", title: "T", domain: "example.com", image: { width: 1200, height: 628 } } } },
      options: { width: 390, dpr: 2 },
    });
    row.width = shot.width;
    row.height = shot.height;
    const box = shot.geometry.boxes.attachment;
    const px = box ? await pixels(shot.png, { x: box.x + 4, y: box.y + 4, w: Math.max(1, box.w - 8), h: Math.max(1, box.h * 0.5) }, 2) : null;
    row.attachment = px ? `magenta ${px.magenta.toFixed(2)}` : "—";
    if (!box) problems.push("no attachment box");
    else if (px.magenta > 0.05) problems.push("the stub card is magenta, which it must not be");
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  row.verdict = problems.length ? "fail" : "ok";
  if (problems.length) failed++;
  if (problems.length) row.problems = problems;
  rows.push(row);
  audit.push(row);
}

// 6. The quoted post's visible text, against the capture's own markup.
//
//    `x.com/NBA/status/2120019063476785477` quotes a post whose payload ends with
//    its own media `t.co` (`…clipboard 🤣📋 https://t.co/1FQn6XU9rz`), and the
//    converter keeps it when the payload's `display_text_range` does not come
//    through — which is what `/api/resolve` hands the playground. X's captured
//    card shows `…clipboard 🤣📋`: the URL is hidden with the space before it and
//    there is no ellipsis. The replica drew the `t.co` link (and, before the
//    hidden range was honoured, a stray space and an ellipsis). This compares the
//    replica's quote body to the capture's text, character for character.
{
  const html = await readFile(join(ROOT, "assets", "vendor", "corpus", "NBA.html"), "utf8");
  const tweet = extractTweets(html).find((t) => t.rest_id === "2120019063476785477");
  const { post } = payloadToPost(tweet, { now: lock.fetchedAt, appVersion: html.match(/"appVersion":"([0-9a-f]+)"/)?.[1] });
  // The resolved shape: the payload's own `full_text`, `t.co` and all.
  const quotedPayload = tweet?.quoted_tweet_results?.result;
  const rawQuotedText = quotedPayload?.details?.full_text ?? quotedPayload?.legacy?.full_text ?? null;
  const row = { fixture: "quote:visible-text", theme: "light", width: 382, dpr: 2 };
  const problems = [];
  try {
    if (!post.quote) problems.push("the corpus post has no quoted post");
    if (rawQuotedText) post.quote.text = rawQuotedText;
    // The row only proves anything if the input really ends with the media URL:
    // that is the text the rules have to hide.
    if (!/https:\/\/t\.co\/\S+$/.test(rawQuotedText ?? "")) problems.push(`the quoted payload does not end with a t.co (${JSON.stringify(rawQuotedText)})`);
    const expected = await decodePage.evaluate((source) => {
      const doc = new DOMParser().parseFromString(source, "text/html");
      // The post appears twice on the captured page (the stream repeats a part),
      // so every copy has to agree.
      const bodies = [...doc.querySelectorAll("div.line-clamp-5")]
        .map((d) => d.textContent)
        .filter((text) => text.startsWith("Jimmy Butler III is wearing"));
      if (!bodies.length) return "(no quoted body in the capture)";
      return bodies.every((text) => text === bodies[0]) ? bodies[0] : `the capture's copies disagree: ${JSON.stringify(bodies)}`;
    }, html);
    row.expected = expected;
    const shot = await chrome.render({ post, options: { width: 382, dpr: 2 } });
    row.ms = shot.ms;
    row.width = shot.width;
    row.height = shot.height;
    const replicaPage = chrome._debug.browser.contexts()[0].pages().find((p) => p.url().includes("playground-replica"));
    const actual = await replicaPage.evaluate(() => {
      const cell = document.getElementById("xeet-holder");
      const bodies = [...cell.querySelectorAll("div")].filter((d) => String(d.className).includes("line-clamp-5"));
      return bodies.length ? bodies[bodies.length - 1].textContent : "(no quote body)";
    });
    row.actual = actual;
    row.attachment = actual === expected ? "same text" : "differs";
    if (actual !== expected) problems.push(`the replica's quote body is ${JSON.stringify(actual)} and the capture's is ${JSON.stringify(expected)}`);
    if (/t\.co\//.test(actual)) problems.push("the quote body still prints the media t.co");
    if (/…$/.test(actual) || /\s{2,}$/.test(actual)) problems.push("the quote body ends with an ellipsis or trailing space");
    if (/(\u{1F923}).(\u{1F4CB})/u.test(actual.replace(/\n/g, ""))) problems.push("the two emoji are not adjacent");
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  row.verdict = problems.length ? "fail" : "ok";
  if (problems.length) failed++;
  if (problems.length) row.problems = problems;
  rows.push(row);
  audit.push(row);
}

// 7. The nested quote preview (`post.quote.quote`). X draws one block inside the
//    quote card, gated by `H(outer, quoted, nested)` in
//    `nested-quote-preview-SIs_tkfq`: no reply, no self-quote, no card in the
//    nested post, and at most *one* of the three levels rendering media of its
//    own. These rows pin both halves — the block when X would draw it, and
//    nothing at all when it would not (the corpus captures that carry a nested
//    payload all fail the gate, which is why they show no preview).
{
  const now = "2026-11-10T18:00:00.000Z";
  // A 1x1 magenta PNG: the nested thumbnail's pixels must come from the model.
  const PHOTO_BYTES = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAD0lEQVR4AQEEAPv/AP8A/wAAAAE6EuYAAAAAAElFTkSuQmCC";
  const quoted = (extra = {}) => ({ text: "The quoted post.", author: { name: "Quoted", handle: "quoted" }, createdAt: "2026-11-09T12:00:00.000Z", ...extra });
  const nested = (extra = {}) => ({
    text: "The nested post, which X clamps to two lines when it is long enough to wrap past the second line.",
    author: { name: "Nested", handle: "nested", verified: "blue" },
    createdAt: "2026-11-09T09:00:00.000Z",
    ...extra,
  });
  const outer = (extra = {}) => ({ text: "Look at this.", author: { name: "Outer", handle: "outer" }, createdAt: now, now, ...extra });
  const cases = [
    // No media in the quoted level: the preview is the article's second child,
    // so X's `p-3 [:first-child+&]:pt-0` resolves to 0 px of top padding.
    { name: "nested:text", post: outer({ quote: quoted({ quote: nested() }) }), expectPreview: true, expectThumb: false, expectText: 2, padTop: 0 },
    { name: "nested:photo", post: outer({ quote: quoted({ quote: nested({ media: [image(1200, 800, { data: PHOTO_BYTES })] }) }) }), expectPreview: true, expectThumb: true, expectText: 2, padTop: 0 },
    { name: "nested:three", post: outer({ quote: quoted({ quote: nested({ media: [image(1200, 800), image(800, 800), image(800, 800)] }) }) }), expectPreview: true, expectThumb: true, expectText: 2, padTop: 0, dom: "+2" },
    { name: "nested:video", post: outer({ quote: quoted({ quote: nested({ media: [{ kind: "video", width: 1280, height: 720, duration: 42 }] }) }) }), expectPreview: true, expectThumb: true, expectText: 2, padTop: 0, dom: 'data-icon="icon-player-play"' },
    // The quoted level has the media (so the card is the compact form with a
    // thumbnail) and the nested level has none: one media level, eligible.
    // The quoted level has media, so the wrapper is the article's *third* child
    // and keeps the full 12 px of `p-3` between that media and the preview.
    { name: "nested:q1-photo-q2-text", post: outer({ quote: quoted({ media: [image(1200, 800)], quote: nested() }) }), expectPreview: true, expectThumb: false, expectText: 2, padTop: 12 },
    // The gate: quoted *and* nested render media.
    { name: "nested:ineligible-media", post: outer({ quote: quoted({ media: [image(1200, 800)], quote: nested({ media: [{ kind: "video", width: 1280, height: 720 }] }) }) }), expectPreview: false },
    // The gate: a self-quote (the outer post quotes its own author).
    { name: "nested:ineligible-self", post: outer({ quote: quoted({ author: { name: "Outer", handle: "outer" }, quote: nested() }) }), expectPreview: false },
    // The gate: a reply never carries one.
    { name: "nested:ineligible-reply", post: outer({ replyTo: "2120015019408752696", quote: quoted({ quote: nested() }) }), expectPreview: false },
    // The gate: a card in the nested post.
    {
      name: "nested:ineligible-card",
      post: outer({ quote: quoted({ quote: nested({ text: "A link. https://example.com/x", links: { "https://example.com/x": { card: "summary_large_image", title: "T" } } }) }) }),
      expectPreview: false,
    },
  ];
  const replicaPage = () => chrome._debug.browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("playground-replica"));
  for (const c of cases) {
    const row = { fixture: c.name, theme: "light", width: 600, dpr: 2 };
    const problems = [];
    try {
      const shot = await chrome.render({ post: c.post, options: { width: 600, dpr: 2 } });
      row.width = shot.width;
      row.height = shot.height;
      const preview = shot.geometry.boxes.nestedQuote;
      const thumb = shot.geometry.boxes.nestedThumb;
      const text = shot.geometry.boxes.nestedText;
      const stamp = shot.geometry.boxes.nestedStamp;
      if (c.expectPreview && !preview) problems.push("no nested preview box");
      if (!c.expectPreview && preview) problems.push(`the gate is closed but a nested preview was drawn (${JSON.stringify(preview)})`);
      if (c.expectPreview) {
        if (!thumb && c.expectThumb) problems.push("no nested thumbnail box");
        if (thumb && !c.expectThumb) problems.push("a nested thumbnail was drawn where the nested post has no media");
        if (thumb && (Math.abs(thumb.w - 64) > 0.01 || Math.abs(thumb.h - 64) > 0.01)) problems.push(`the nested thumbnail is ${thumb.w}x${thumb.h}, not 64x64`);
        if (!text) problems.push("no nested text box");
        else if (text.h > 2 * 16 + 0.5) problems.push(`the nested text is ${text.h} px tall: more than the two lines X clamps to`);
        if (!stamp) problems.push("no nested timestamp box");
        // X's header row is `text-body` (15/20): the timestamp's line box is 20 px.
        else if (stamp.h < 19.5) problems.push(`the nested header's line box is ${stamp.h} px, not the 20 px of text-body`);
        // And the wrapper's top padding is X's `[:first-child+&]:pt-0` resolved.
        {
          const wrapper = await replicaPage().evaluate(() => {
            const wrap = document.querySelector("[data-xeet-nested]")?.parentElement;
            if (!wrap) return null;
            const cs = getComputedStyle(wrap);
            return { paddingTop: cs.paddingTop, paddingLeft: cs.paddingLeft, paddingBottom: cs.paddingBottom };
          });
          row.padTop = wrapper ? `${wrapper.paddingTop}/${wrapper.paddingLeft}` : null;
          if (!wrapper) problems.push("the nested preview has no p-3 wrapper");
          else {
            if (c.padTop != null && wrapper.paddingTop !== `${c.padTop}px`) problems.push(`the preview wrapper's top padding is ${wrapper.paddingTop}, not ${c.padTop}px`);
            if (wrapper.paddingLeft !== "12px" || wrapper.paddingBottom !== "12px") problems.push(`the preview wrapper's side padding is ${wrapper.paddingLeft}/${wrapper.paddingBottom}, not 12px`);
          }
        }
        if (preview && shot.geometry.boxes.quoteCard) {
          const card = shot.geometry.boxes.quoteCard;
          if (preview.y < card.y - 0.5 || preview.y + preview.h > card.y + card.h + 0.5) problems.push("the nested preview is not inside the quote card");
        }
        if (c.dom) {
          const html = await replicaPage().evaluate(() => document.getElementById("xeet-holder").innerHTML);
          if (!html.includes(c.dom)) problems.push(`the replica's markup does not contain ${c.dom}`);
        }
      }
      row.attachment = preview ? `${Math.round(preview.w)}x${Math.round(preview.h)}${thumb ? " +thumb" : ""}` : "—";
    } catch (error) {
      problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
    }
    row.verdict = problems.length ? "fail" : "ok";
    if (problems.length) failed++;
    if (problems.length) row.problems = problems;
    rows.push(row);
    audit.push(row);
  }

  // The captured page that *has* a nested payload (`elonmusk` quoting
  // SawyerMerritt, who is quoting a video): X's own HTML shows no preview, so
  // the replica must not draw one either, and the cell must match the page.
  {
    const html = await readFile(join(ROOT, "assets", "vendor", "corpus", "elonmusk.html"), "utf8");
    const tweet = extractTweets(html).find((t) => t.rest_id === "2119812607117062451");
    const { post } = payloadToPost(tweet, { now: lock.fetchedAt, appVersion: html.match(/"appVersion":"([0-9a-f]+)"/)?.[1] });
    const nestedPayload = tweet?.quoted_tweet_results?.result?.nested_quoted_tweet_results?.result;
    const row = { fixture: "nested:page-vs-replica", theme: "light", width: 600, dpr: 2 };
    const problems = [];
    try {
      if (!nestedPayload) problems.push("the corpus post has no nested payload to attach");
      else post.quote.quote = payloadToPost(nestedPayload, { now: lock.fetchedAt }).post;
      const pageShot = await chrome.render({ post, options: { width: 600, dpr: 2 }, mode: "page", source: { page: "elonmusk.html", id: "2119812607117062451" } });
      const replica = await chrome.render({ post, options: { width: pageShot.width, dpr: 2 } });
      row.width = pageShot.width;
      row.height = pageShot.height;
      const pagePreview = pageShot.geometry.boxes.nestedQuote;
      const replicaPreview = replica.geometry.boxes.nestedQuote;
      row.attachment = `page ${pagePreview ? "preview" : "none"} / replica ${replicaPreview ? "preview" : "none"}`;
      if (pagePreview) problems.push("the captured page drew a nested preview, which the harness does not model");
      if (replicaPreview) problems.push(`the replica drew a nested preview where X's capture has none (${JSON.stringify(replicaPreview)})`);
      if (Math.abs(pageShot.height - replica.height) > 1 / 64) problems.push(`heights differ: page ${pageShot.height} vs replica ${replica.height}`);
    } catch (error) {
      problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
    }
    row.verdict = problems.length ? "fail" : "ok";
    if (problems.length) failed++;
    if (problems.length) row.problems = problems;
    rows.push(row);
    audit.push(row);
  }
}

// 8. Media embedded from another account: "Post video" / "Post photo".
//    `media[].sourceAuthor` is X's `source_user_results`; the credit rides inside
//    the duration pill of a video and in the bottom-left pill of a photo, and X
//    draws nothing when the source is the post's own author.
{
  const espn = { name: "ESPN", handle: "espn", verified: "business", squareAvatar: true };
  const nfl = { name: "NFL", handle: "NFL", verified: "business", squareAvatar: true };
  const base = { text: "Look at this.", author: espn };
  const cases = [
    { name: "video:source-author", post: { ...base, media: [{ kind: "video", width: 1920, height: 1080, duration: 24, sourceAuthor: nfl }] }, expect: true, video: true },
    // The same author is not an attribution (`@ESPN` embedding `@ESPN`'s clip).
    { name: "video:same-author-suppressed", post: { ...base, media: [{ kind: "video", width: 1920, height: 1080, duration: 24, sourceAuthor: { ...nfl, name: "ESPN", handle: "ESPN" } }] }, expect: false },
    { name: "photo:source-author", post: { ...base, media: [{ kind: "image", width: 1200, height: 800, alt: "A photo", sourceAuthor: nfl }] }, expect: true, video: false },
  ];
  const replicaPage = () => chrome._debug.browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("playground-replica"));
  for (const c of cases) {
    const row = { fixture: c.name, theme: "light", width: 600, dpr: 2 };
    const problems = [];
    try {
      const shot = await chrome.render({ post: c.post, options: { width: 600, dpr: 2 } });
      row.width = shot.width;
      row.height = shot.height;
      const box = shot.geometry.boxes.mediaSource;
      row.attachment = box ? `${Math.round(box.w)}x${Math.round(box.h)}` : "—";
      if (c.expect && !box) problems.push("no media source attribution box");
      if (!c.expect && box) problems.push(`an attribution was drawn (${JSON.stringify(box)}) although the source is the post's own author`);
      if (box) {
        // One line: 20 px inside the video's `h-5` pill, 24 px for the photo's
        // `py-1` pill (`text-subtext2` 16 + 8).
        const maxHeight = c.video ? 20.5 : 24.5;
        if (box.h > maxHeight) problems.push(`the attribution is ${box.h} px tall, not the one line X draws (<= ${maxHeight})`);
        if (!c.video) {
          const inner = await replicaPage().evaluate(() => {
            const mark = document.querySelector("[data-xeet-media-source]");
            const avatar = mark?.querySelector(".x-avatar");
            const r = avatar?.getBoundingClientRect();
            return { avatar: r ? [r.width, r.height] : null, pill: mark?.className ?? null, text: mark?.textContent?.trim() ?? null, inWrapper: Boolean(mark?.closest(".pointer-events-none.absolute.z-20")) };
          });
          if (!inner.avatar || Math.abs(inner.avatar[0] - 13) > 0.01) problems.push(`the credit's avatar is ${JSON.stringify(inner.avatar)}, not 13x13`);
          if (!String(inner.pill).includes("bg-black/70")) problems.push(`the photo credit's pill is ${JSON.stringify(inner.pill)}, not X's bg-black/70 pill`);
          if (!inner.inWrapper) problems.push("the photo credit is not in X's bottom-left `pointer-events-none absolute z-20 flex bottom-3 start-3` wrapper");
          if (inner.text !== "NFL") problems.push(`the photo credit says ${JSON.stringify(inner.text)}, not NFL`);
        } else {
          const inner = await replicaPage().evaluate(() => {
            const mark = document.querySelector("[data-xeet-media-source]");
            const avatar = mark?.querySelector(".x-avatar");
            const r = avatar?.getBoundingClientRect();
            const pill = mark?.parentElement;
            return { avatar: r ? [r.width, r.height] : null, inPill: Boolean(pill && String(pill.className).includes("inline-flex h-5")), text: mark?.textContent?.trim() ?? null };
          });
          if (!inner.inPill) problems.push("the video credit is not inside the duration pill");
          if (!inner.avatar || Math.abs(inner.avatar[0] - 13) > 0.01) problems.push(`the credit's avatar is ${JSON.stringify(inner.avatar)}, not 13x13`);
          if (inner.text !== "NFL") problems.push(`the video credit says ${JSON.stringify(inner.text)}, not NFL`);
        }
      }
    } catch (error) {
      problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
    }
    row.verdict = problems.length ? "fail" : "ok";
    if (problems.length) failed++;
    if (problems.length) row.problems = problems;
    rows.push(row);
    audit.push(row);
  }

  // X's own capture of the same thing: `ESPN.html` post `2120005259485425936`
  // embeds `@NFL`'s clip, and the pill in the capture carries the credit.
  {
    const html = await readFile(join(ROOT, "assets", "vendor", "corpus", "ESPN.html"), "utf8");
    const tweet = extractTweets(html).find((t) => t.rest_id === "2120005259485425936");
    const { post } = payloadToPost(tweet, { now: lock.fetchedAt, appVersion: html.match(/"appVersion":"([0-9a-f]+)"/)?.[1] });
    const row = { fixture: "media-source:page-vs-replica", theme: "light", width: 600, dpr: 2 };
    const problems = [];
    try {
      const pageShot = await chrome.render({ post, options: { width: 600, dpr: 2 }, mode: "page", source: { page: "ESPN.html", id: "2120005259485425936" } });
      const replica = await chrome.render({ post, options: { width: pageShot.width, dpr: 2 } });
      row.width = pageShot.width;
      row.height = pageShot.height;
      const a = pageShot.geometry.boxes.mediaSource;
      const b = replica.geometry.boxes.mediaSource;
      row.attachment = a && b ? `page ${Math.round(a.w)}x${Math.round(a.h)} / replica ${Math.round(b.w)}x${Math.round(b.h)}` : "—";
      if (!a) problems.push("the captured page's pill carries no credit box");
      if (!b) problems.push("the replica draws no credit box");
      if (a && b) {
        for (const key of ["x", "y", "w", "h"]) {
          if (Math.abs(a[key] - b[key]) > 1 / 64) problems.push(`the credit's ${key} is ${b[key]} in the replica and ${a[key]} in the capture`);
        }
      }
      if (Math.abs(pageShot.height - replica.height) > 1 / 64) problems.push(`heights differ: page ${pageShot.height} vs replica ${replica.height}`);
      const pages = chrome._debug.browser.contexts().flatMap((c) => c.pages());
      const pageText = await pages.find((p) => p.url().includes("playground-page/ESPN.html")).evaluate(() => document.querySelector("[data-xeet-cell] span.inline-flex.align-middle.ms-2")?.textContent?.trim() ?? null);
      const replicaText = await pages.find((p) => p.url().includes("playground-replica")).evaluate(() => document.querySelector("[data-xeet-media-source]")?.textContent?.trim() ?? null);
      if (pageText !== "NFL") problems.push(`the capture credits ${JSON.stringify(pageText)}, not NFL`);
      if (replicaText !== pageText) problems.push(`the replica credits ${JSON.stringify(replicaText)} where the capture says ${JSON.stringify(pageText)}`);
    } catch (error) {
      problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
    }
    row.verdict = problems.length ? "fail" : "ok";
    if (problems.length) failed++;
    if (problems.length) row.problems = problems;
    rows.push(row);
    audit.push(row);
  }
}

// ------------------------------------------------------------------- the Duo --
// A phone at dpr 3 asks a different question than a desktop window: the column
// is `min(viewport, 600)` (so 382 is narrower and 669/951 are wider than the
// cell), the pixel grid is 3×, and every media query in X's stylesheet that
// matters (512, 768, 1024) falls on the other side. Both modes have to hold.
const DUO_FIXTURES = ["text-only", "media-1", "media-4", "card-large", "poll", "quote-full"];
for (const name of DUO_FIXTURES) {
  const fixture = FIXTURES.find((f) => f.name === name);
  if (!fixture) continue;
  for (const width of DUO_WIDTHS) {
    const problems = [];
    const row = { fixture: `duo:${name}`, theme: "light", width, dpr: 3 };
    try {
      const shot = await chrome.render({ post: fixture.post, options: { width, theme: "light", dpr: 3 } });
      row.ms = shot.ms;
      row.width = shot.width;
      row.height = shot.height;
      const cellWidth = Math.min(width, MAX_CELL_WIDTH);
      if (Math.abs(shot.width - cellWidth) > 1 / 64) problems.push(`cell width ${shot.width} != ${cellWidth}`);
      if (shot.dpr !== 3) problems.push(`dpr ${shot.dpr} != 3`);
      if (!(shot.height > 10)) problems.push("empty cell");
      if (ink(shot.png) < 1000) problems.push(`png is ${shot.png.length} bytes (blank?)`);
    } catch (error) {
      problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
    }
    row.verdict = problems.length ? "fail" : "ok";
    if (problems.length) failed++;
    if (problems.length) row.problems = problems;
    rows.push(row);
  }
}
for (const width of DUO_WIDTHS) {
  const page = PAGE_CASES[0];
  const problems = [];
  const row = { fixture: `duo:page:${page.file}`, theme: "light", width, dpr: 3, pageMode: true };
  try {
    const shot = await chrome.render({ post: { text: "", author: author("x", "x") }, options: { width, theme: "light", dpr: 3 }, mode: "page", source: { page: page.file, id: page.id } });
    row.ms = shot.ms;
    row.width = shot.width;
    row.height = shot.height;
    if (Math.abs(shot.width - Math.min(width, MAX_CELL_WIDTH)) > 1 / 64) problems.push(`cell width ${shot.width} != ${Math.min(width, MAX_CELL_WIDTH)}`);
    if (shot.dpr !== 3) problems.push(`dpr ${shot.dpr} != 3`);
    if (ink(shot.png) < 1000) problems.push(`png is ${shot.png.length} bytes (blank?)`);
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  row.verdict = problems.length ? "fail" : "ok";
  if (problems.length) failed++;
  if (problems.length) row.problems = problems;
  rows.push(row);
}

if (decodePage) await decodePage.close().catch(() => {});

await chrome.close();

const w = (s, n) => String(s ?? "").padEnd(n);
console.log(`\n${w("fixture", 18)}${w("theme", 7)}${w("w", 5)}${w("dpr", 4)}${w("cell", 10)}${w("attachment", 14)}${w("ms", 8)}verdict`);
for (const r of rows) {
  const cell = r.width == null ? "—" : `${r.width}x${r.height}`;
  console.log(`${w(r.fixture, 18)}${w(r.theme, 7)}${w(r.width == null ? "—" : String(r.width), 5)}${w(r.dpr, 4)}${w(cell, 10)}${w(r.attachment ?? "—", 14)}${w(r.ms ? r.ms.total : "—", 8)}${r.verdict}`);
  for (const p of r.problems ?? []) console.log(`    ${p}`);
  for (const n of (r.notes ?? []).slice(0, 2)) console.log(`    note: ${n}`);
}
const ok = rows.length - failed;
console.log(`\n${ok}/${rows.length} renders satisfy the frame contract${APPROXIMATE.size ? ` (* ${[...APPROXIMATE].join(", ")}: shape approximated, see notes)` : ""}`);
if (JSON_OUT) {
  await mkdir(dirname(JSON_OUT), { recursive: true });
  await writeFile(JSON_OUT, JSON.stringify({ rows }, null, 2) + "\n");
  console.log(`wrote ${JSON_OUT}`);
}
process.exit(failed ? 1 : 0);
