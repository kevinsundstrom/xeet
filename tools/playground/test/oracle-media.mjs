#!/usr/bin/env node
// Real image bytes, in both modes.
//
//   node tools/playground/test/oracle-media.mjs
//   node tools/playground/test/oracle-media.mjs --json tmp/media.json --keep
//
// X's truth is a page full of photographs. The replica paints the post's own
// bytes; page mode answers the page's `pbs.twimg.com` requests from the
// playground's media cache. A box of the right size with a grey placeholder in
// it looks correct in a geometry table and wrong on screen, so this checks
// *pixels*: every picture the model describes has to arrive with structure in
// it — many distinct colours, real luminance spread, no flat stub — and the same
// fixture without bytes has to be flat, which is what proves the check can tell
// the two apart.
//
// The bytes are generated here (a synthetic photograph: two colour ramps plus a
// deterministic grain), so nothing binary is committed and the test needs no
// network for the replica column. Page mode's own pictures come from the
// git-ignored media cache in `assets/vendor/playground/media/`, which
// `resolve.mjs` fills; when a page has none cached, this asks the same store for
// them once (throttled, one request per asset) and says so in the notes.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

import { ROOT } from "../../oracle/browser.mjs";
import { extractTweets } from "../../oracle/samples.mjs";
import { configureLinks } from "../lib/links.mjs";
import { createChrome } from "../lib/chrome.mjs";
import { MEDIA_CACHE } from "../lib/chrome-media.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);
const JSON_OUT = opt("json", null);
const KEEP = has("keep");
const OUT_DIR = join(ROOT, "tmp", "media");

// -------------------------------------------------------------- test bytes --
// A PNG encoder, so the fixtures carry a picture nobody could mistake for the
// placeholder: `assets/` stays free of test images.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A 320×200 "photograph": two ramps at right angles plus deterministic grain. */
function photograph(seed = 1, width = 320, height = 200) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const wave = Math.sin((x / width) * Math.PI * 2 + seed) * 0.5 + Math.cos((y / height) * Math.PI * 4 + seed) * 0.5;
      raw[at++] = 90 + Math.round(60 * wave) + ((x * 7 + y * 13 + seed * 29) % 37);
      raw[at++] = 120 + Math.round(50 * (1 - wave)) + ((x * 11 + y * 5) % 41);
      raw[at++] = 140 + Math.round(40 * wave) + ((x * 3 + y * 17 + seed) % 31);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A solid sheet of one colour, for "did *this* file get served?" questions. */
function solid(red, green, blue, width = 32, height = 32) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0;
    for (let x = 0; x < width; x++) {
      raw[at++] = red;
      raw[at++] = green;
      raw[at++] = blue;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PHOTO = photograph(1).toString("base64");
const PHOTO_2 = photograph(2).toString("base64");

const author = (name, handle, extra = {}) => ({ name, handle, ...extra });
const image = (width, height, extra = {}) => ({ kind: "image", width, height, ...extra });
const at = { createdAt: "2026-11-10T17:00:00.000Z", now: "2026-11-10T18:30:00.000Z" };

/** One fixture per picture the model can carry, each with bytes and without. */
const CASES = [
  { name: "photo-1", box: "attachment", post: { ...at, text: "One photo.", author: author("Photo", "photo"), media: [image(1600, 1000, { data: PHOTO, alt: "A picture" })] } },
  { name: "photo-2", box: "attachment", post: { ...at, text: "Two photos.", author: author("Photo", "photo"), media: [image(1200, 1200, { data: PHOTO }), image(1080, 1350, { data: PHOTO_2 })] } },
  { name: "photo-4", box: "attachment", post: { ...at, text: "Four photos.", author: author("Photo", "photo"), media: [image(1920, 1080, { data: PHOTO }), image(1080, 1920, { data: PHOTO_2 }), image(1200, 1200, { data: PHOTO }), image(900, 1600, { data: PHOTO_2 })] } },
  { name: "video", box: "attachment", post: { ...at, text: "A clip.", author: author("Video", "video"), media: [{ kind: "video", width: 1280, height: 720, duration: 83, data: PHOTO }] } },
  { name: "gif", box: "attachment", post: { ...at, text: "A GIF.", author: author("Gif", "gif"), media: [{ kind: "gif", width: 640, height: 480, data: PHOTO }] } },
  { name: "quote-photo", box: "attachment", post: { ...at, text: "Look at this.", author: author("Quote", "quote"), quote: { ...at, text: "The quoted photo.", author: author("Quoted", "quoted"), media: [image(1200, 800, { data: PHOTO })] } } },
  { name: "quote-video", box: "attachment", post: { ...at, text: "The quoted clip.", author: author("Quote", "quote"), quote: { ...at, text: "A clip.", author: author("Quoted", "quoted"), media: [{ kind: "video", width: 1280, height: 720, duration: 42, data: PHOTO }] } } },
  { name: "quote-compact-1", box: "quoteCard", post: { ...at, text: "Compact quote with a photo.", author: author("Quote", "quote"), media: [image(1600, 900, { data: PHOTO })], quote: { ...at, text: "The quoted post, compact because this one has media.", author: author("Quoted", "quoted"), media: [image(1200, 800, { data: PHOTO_2 })] } } },
  { name: "avatar", box: "avatar", post: { ...at, text: "My face.", author: author("Avatar", "avatar", { avatar: PHOTO }) } },
  { name: "card-image", box: "attachment", post: { ...at, text: "A link. https://example.com/story", author: author("Links", "links"), links: { "https://example.com/story": { card: "summary_large_image", title: "A story", domain: "example.com", image: { width: 1200, height: 628, data: PHOTO } } } } },
  { name: "card-summary", box: "attachment", post: { ...at, text: "A link. https://example.com/brief", author: author("Links", "links"), links: { "https://example.com/brief": { card: "summary", title: "A brief", domain: "example.com", image: { width: 400, height: 400, data: PHOTO } } } } },
];

/** The same post with every byte removed: the stub column. */
function withoutBytes(post) {
  const clone = structuredClone(post);
  if (clone.author?.avatar) delete clone.author.avatar;
  for (const m of clone.media ?? []) delete m.data;
  for (const m of clone.quote?.media ?? []) delete m.data;
  for (const link of Object.values(clone.links ?? {})) if (link?.image) delete link.image.data;
  return clone;
}

// --------------------------------------------------------------- measuring --
const chrome = await createChrome();
let decodePage = null;

/**
 * Structure in a box of the rendered PNG.
 *
 * A photograph has many distinct colours and a wide luminance spread; the
 * placeholder is one flat `#cfd9de`, so `flat` (the share of pixels at that
 * colour) and `stdev` separate them without knowing what the picture is.
 */
async function structure(png, box, dpr, extra = {}) {
  decodePage ??= await chrome._debug.browser.newPage();
  const url = `data:image/png;base64,${png.toString("base64")}`;
  const rect = { x: box.x, y: box.y, w: box.w, h: box.h };
  return decodePage.evaluate(async ([src, r, scale, regions]) => {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = src;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    // CSS pixels -> the PNG's pixel grid.
    const px = (region) => ({
      x: Math.max(0, Math.min(img.width - 1, Math.round(region.x * scale))),
      y: Math.max(0, Math.min(img.height - 1, Math.round(region.y * scale))),
      w: Math.max(1, Math.round(region.w * scale)),
      h: Math.max(1, Math.round(region.h * scale)),
    });

    const box = px(r);
    // Sample the middle of the box: a corner may catch a radius or a badge.
    const inset = Math.min(Math.floor(box.w * 0.1), Math.floor(box.h * 0.1), 24 * scale);
    const sx = Math.min(box.x + inset, img.width - 1);
    const sy = Math.min(box.y + inset, img.height - 1);
    const sw = Math.max(1, Math.min(box.w - inset * 2, img.width - sx));
    const sh = Math.max(1, Math.min(box.h - inset * 2, img.height - sy));
    const data = ctx.getImageData(sx, sy, sw, sh).data;
    const seen = new Set();
    let sum = 0;
    let sumSq = 0;
    let flat = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const red = data[i];
      const green = data[i + 1];
      const blue = data[i + 2];
      // 4 bits a channel: distinct enough for a photograph, tolerant of AA.
      seen.add(((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4));
      const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      sum += luma;
      sumSq += luma * luma;
      // X's placeholder: #cfd9de, and the grey of an empty media box.
      if (Math.abs(red - 0xcf) < 6 && Math.abs(green - 0xd9) < 6 && Math.abs(blue - 0xde) < 6) flat++;
      count++;
    }
    const mean = sum / count;

    const measure = (region) => {
      const at = px(region);
      const w = Math.max(1, Math.min(at.w, img.width - at.x));
      const h = Math.max(1, Math.min(at.h, img.height - at.y));
      const pixels = ctx.getImageData(at.x, at.y, w, h).data;
      let dark = 0;
      let white = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const luma = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
        if (luma < 45) dark++;
        if (luma >= 235) white++;
      }
      return { dark: dark / (w * h), white: white / (w * h) };
    };
    const found = {};
    for (const [name, region] of Object.entries(regions ?? {})) found[name] = measure(region);

    return {
      distinct: seen.size,
      stdev: Math.sqrt(Math.max(0, sumSq / count - mean * mean)),
      flat: flat / count,
      mean: Math.round(mean),
      pixels: count,
      regions: found,
    };
  }, [url, rect, dpr, extra.regions ?? {}]);
}

/**
 * X's video furniture, measured: the duration badge is a near-black pill in the
 * bottom-left corner, and the play control is a white disc at the centre. The
 * synthetic photograph never reaches either extreme (its luma stays between
 * ~90 and ~200), so both are unambiguous.
 */
async function badges(png, box, dpr) {
  const out = await structure(png, box, dpr, {
    regions: {
      pill: { x: box.x + 6, y: box.y + box.h * 0.84, w: Math.min(box.w * 0.35, 150), h: Math.max(8, box.h * 0.1) },
      centre: { x: box.x + box.w / 2 - 30, y: box.y + box.h / 2 - 30, w: 60, h: 60 },
    },
  });
  return { pill: out.regions.pill.dark, centre: out.regions.centre.white };
}

/** X's placeholder box, and the empty box, both read as flat: that is the control. */
const looksReal = (px) => px.distinct >= 24 && px.stdev >= 8 && px.flat <= 0.25;

const rows = [];
let failed = 0;
const w = (value, n) => String(value ?? "").padEnd(n);

function record(row, problems) {
  row.verdict = problems.length ? "fail" : "ok";
  if (problems.length) {
    failed++;
    row.problems = problems;
  }
  rows.push(row);
}

// --------------------------------------------------- replica: the post's bytes --
for (const fixture of CASES) {
  for (const theme of ["light", "dark"]) {
    const problems = [];
    const row = { fixture: fixture.name, mode: "replica", theme, width: 390, dpr: 2 };
    try {
      const shot = await chrome.render({ post: fixture.post, options: { width: 390, dpr: 2, theme } });
      row.ms = shot.ms;
      const box = shot.geometry.boxes[fixture.box];
      if (!box) problems.push(`no ${fixture.box} box`);
      else {
        const px = await structure(shot.png, box, 2);
        row.distinct = px.distinct;
        row.stdev = Number(px.stdev.toFixed(1));
        row.flat = Number(px.flat.toFixed(2));
        if (!looksReal(px)) problems.push(`the ${fixture.box} box has no picture in it (${px.distinct} colours, stdev ${px.stdev.toFixed(1)}, ${(px.flat * 100).toFixed(0)}% placeholder grey)`);
        // X's own furniture over the poster: a dark duration pill bottom-left,
        // and — for a video, not a GIF — a white play disc in the middle.
        if (fixture.name === "video" || fixture.name === "gif") {
          const ink = await badges(shot.png, box, 2);
          row.pill = Number(ink.pill.toFixed(2));
          row.play = Number(ink.centre.toFixed(2));
          if (ink.pill < 0.12) problems.push(`no duration badge in the bottom-left corner (${(ink.pill * 100).toFixed(1)}% dark)`);
          if (fixture.name === "video" && ink.centre < 0.02) problems.push(`no play control at the centre (${(ink.centre * 100).toFixed(1)}% white)`);
          if (fixture.name === "gif" && ink.centre > 0.02) problems.push(`the GIF box has a play control (${(ink.centre * 100).toFixed(1)}% white)`);
        }
      }
      if (theme === "light" && KEEP) {
        await mkdir(OUT_DIR, { recursive: true });
        await writeFile(join(OUT_DIR, `replica-${fixture.name}.png`), shot.png);
      }
    } catch (error) {
      problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
    }
    record(row, problems);
  }
}

// The control: the same posts without bytes must read as flat. If a stub looked
// like a picture, the rows above would prove nothing.
for (const fixture of CASES) {
  const problems = [];
  const row = { fixture: `stub:${fixture.name}`, mode: "replica", theme: "light", width: 390, dpr: 2 };
  try {
    const shot = await chrome.render({ post: withoutBytes(fixture.post), options: { width: 390, dpr: 2 } });
    const box = shot.geometry.boxes[fixture.box];
    if (!box) problems.push(`no ${fixture.box} box`);
    else {
      const px = await structure(shot.png, box, 2);
      row.distinct = px.distinct;
      row.stdev = Number(px.stdev.toFixed(1));
      row.flat = Number(px.flat.toFixed(2));
      // Two boxes are not pure pictures: `avatar` without bytes is X's default
      // portrait, which has structure of its own, and `quoteCard` contains the
      // quoted post's text. For those the control is "far fewer colours than
      // with bytes" (74 -> 23, 307 -> 48 on this machine), not flatness.
      if (fixture.box === "avatar" && px.distinct > 40) problems.push(`the stub avatar has ${px.distinct} colours, which is a picture`);
      else if (fixture.box === "quoteCard" && px.distinct > 100) problems.push(`the stub quote card has ${px.distinct} colours, which is a picture`);
      else if (fixture.box !== "avatar" && fixture.box !== "quoteCard" && looksReal(px)) problems.push(`without bytes the ${fixture.box} box still looks like a picture (${px.distinct} colours)`);
    }
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  record(row, problems);
}

// ------------------------------------------------------- page mode: real bytes --
/** A cached playground page whose cell's media is on disk (or can be fetched once). */
async function pageCandidates() {
  const dir = join(ROOT, "assets", "vendor", "playground");
  const names = (await readdir(dir)).filter((f) => f.endsWith(".html"));
  const cache = existsSync(MEDIA_CACHE) ? new Set(await readdir(MEDIA_CACHE)) : new Set();
  const cached = (url) => [...cache].some((f) => f.startsWith(createHash("sha256").update(url).digest("hex")));
  const out = [];
  for (const name of names) {
    let tweets = [];
    try {
      tweets = extractTweets(await readFile(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    for (const tweet of tweets) {
      const id = tweet?.rest_id ?? tweet?.legacy?.id_str;
      const urls = (tweet?.media_entities2 ?? []).filter((m) => m?.original_info?.width).map((m) => m.media_url_https ?? null).filter(Boolean);
      if (!id || !urls.length) continue;
      out.push({ page: name, id: String(id), urls, onDisk: urls.filter(cached).length });
    }
  }
  return out.sort((a, b) => b.onDisk - a.onDisk || b.urls.length - a.urls.length);
}

const candidates = await pageCandidates();
const withMedia = candidates.find((c) => c.onDisk > 0) ?? candidates[0];
if (!withMedia) {
  record({ fixture: "page:<none>", mode: "page", verdict: "skip" }, ["no captured page in assets/vendor/playground has media"]);
} else {
  for (const width of [390, 951]) {
    const dpr = width === 951 ? 3 : 2;
    const row = { fixture: `page:${withMedia.page}`, mode: "page", theme: "light", width, dpr, id: withMedia.id };
    const problems = [];
    try {
      const cold = Date.now();
      const shot = await chrome.render({
        post: { text: "", author: author("x", "x") },
        options: { width, dpr, theme: "light" },
        mode: "page",
        source: { page: withMedia.page, id: withMedia.id },
      });
      row.ms = shot.ms;
      row.cold = Date.now() - cold;
      const box = shot.geometry.boxes.attachment;
      if (!box) problems.push("no attachment box on the page's own cell");
      else {
        const px = await structure(shot.png, box, dpr);
        row.distinct = px.distinct;
        row.stdev = Number(px.stdev.toFixed(1));
        row.flat = Number(px.flat.toFixed(2));
        if (!looksReal(px)) problems.push(`the page's photo box has no picture in it (${px.distinct} colours, stdev ${px.stdev.toFixed(1)}, ${(px.flat * 100).toFixed(0)}% placeholder grey)`);
      }
      if (KEEP) {
        await mkdir(OUT_DIR, { recursive: true });
        await writeFile(join(OUT_DIR, `page-${withMedia.page}-${width}.png`), shot.png);
      }
      const media = chrome.stats().media;
      row.media = `hits ${media.hits} fetched ${media.fetched}`;
      if (media.fetched) row.notes = [`${media.fetched} image${media.fetched === 1 ? "" : "s"} fetched from pbs.twimg.com and cached for the next render`];
      if (media.disabled) problems.push("the media store disabled fetching after repeated failures (offline?)");
    } catch (error) {
      problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
    }
    record(row, problems);
  }

  // A video post's page: X's own poster + play control + duration badge, with
  // the poster bytes served by the route. No `<video>` playback: the frame we
  // capture is the poster state, which is deterministic.
  {
    const row = { fixture: "page:video", mode: "page", theme: "light", width: 600, dpr: 2, id: "2119486448290120108" };
    const problems = [];
    try {
      const shot = await chrome.render({
        post: { text: "", author: author("x", "x") },
        options: { width: 600, dpr: 2 },
        mode: "page",
        source: { page: "github.html", id: "2119486448290120108" },
      });
      row.ms = shot.ms;
      const box = shot.geometry.boxes.attachment;
      if (!box) problems.push("no attachment box on the video post's cell");
      else {
        const px = await structure(shot.png, box, 2);
        const ink = await badges(shot.png, box, 2);
        row.distinct = px.distinct;
        row.stdev = Number(px.stdev.toFixed(1));
        row.pill = Number(ink.pill.toFixed(2));
        row.play = Number(ink.centre.toFixed(2));
        if (!looksReal(px)) problems.push(`the video box's poster has no picture in it (${px.distinct} colours, stdev ${px.stdev.toFixed(1)})`);
        // The badge is measured but not required here: this post's poster is
        // black ASCII art, so "the corner is dark" cannot tell the badge from
        // the picture. Paint and layering of the badge are the replica's job
        // (`pill`/`play` columns above, where the picture is known).
        if (ink.centre < 0.01) problems.push(`no play control (${(ink.centre * 100).toFixed(1)}% white centre)`);
        row.notes = ["the duration badge is X's own markup here; it is dark-on-dark over this poster, so only the play control is asserted"];
      }
      if (KEEP) {
        await mkdir(OUT_DIR, { recursive: true });
        await writeFile(join(OUT_DIR, "page-video.png"), shot.png);
      }
    } catch (error) {
      problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
    }
    record(row, problems);
  }

  // Warm: the same page again is a cache read, and must not re-fetch anything.
  const row = { fixture: `page:${withMedia.page}:warm`, mode: "page", theme: "light", width: 390, dpr: 2 };
  const problems = [];
  try {
    const before = chrome.stats().media.fetched;
    const shot = await chrome.render({
      post: { text: "", author: author("x", "x") },
      options: { width: 390, dpr: 2 },
      mode: "page",
      source: { page: withMedia.page, id: withMedia.id },
    });
    row.ms = shot.ms;
    const after = chrome.stats().media.fetched;
    row.media = `fetched +${after - before}`;
    if (after !== before) problems.push(`${after - before} images fetched again on a warm page`);
    const box = shot.geometry.boxes.attachment;
    if (!box) problems.push("no attachment box");
    else {
      const px = await structure(shot.png, box, 2);
      row.distinct = px.distinct;
      if (!looksReal(px)) problems.push("the warm page's photo box went flat");
    }
    if (shot.ms.total > 1500) problems.push(`warm page render took ${shot.ms.total} ms`);
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  record(row, problems);
}

// `/api/resolve`'s `source.media` is the first thing consulted: a URL the
// resolver already inlined must be served from that map, not re-read from the
// cache and certainly not fetched.
{
  const row = { fixture: "page:source.media", mode: "page", theme: "light", width: 390, dpr: 2 };
  const problems = [];
  try {
    await mkdir(OUT_DIR, { recursive: true });
    const sheet = join(OUT_DIR, "source-media-magenta.png");
    await writeFile(sheet, solid(255, 0, 255));
    const media = { [withMedia.urls[0]]: { file: sheet, bytes: 5000, width: 32, height: 32, variant: "large" } };
    // A fresh oracle: a warm page keeps the pictures it already painted, so the
    // map has to be tested on a page that has not loaded yet.
    const mapOracle = await createChrome();
    const before = mapOracle.stats().media.fetched;
    const shot = await mapOracle.render({
      post: { text: "", author: author("x", "x") },
      options: { width: 390, dpr: 2 },
      mode: "page",
      source: { page: withMedia.page, id: withMedia.id, media },
    });
    row.ms = shot.ms;
    const box = shot.geometry.boxes.attachment;
    if (!box) problems.push("no attachment box");
    else {
      // The box also carries the ALT badge and the view overlay, so the sheet of
      // colour is the majority of it, not all of it.
      const share = await decodePage.evaluate(async ([src, region]) => {
        const img = await new Promise((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = reject;
          i.src = src;
        });
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, region.y, region.w, region.h).data;
        let hit = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 2] > 200 && data[i + 1] < 80) hit++;
        return hit / (data.length / 4);
      }, [`data:image/png;base64,${shot.png.toString("base64")}`, { y: Math.round((box.y + box.h * 0.1) * 2), w: Math.round(box.w * 2), h: Math.round(box.h * 0.5 * 2) }]);
      row.notes = [`${(share * 100).toFixed(0)}% of the box is the colour of the file source.media named`];
      if (share < 0.5) problems.push(`source.media's file was not served: ${(share * 100).toFixed(0)}% of the box is its colour`);
      if (mapOracle.stats().media.fetched !== before) problems.push("a URL that source.media covers was fetched anyway");
      await mapOracle.close();
    }
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  record(row, problems);
}

// A nested quote preview's 64 px thumbnail draws the nested post's own bytes.
{
  const row = { fixture: "nested:thumb-bytes", mode: "replica", theme: "light", width: 600, dpr: 2 };
  const problems = [];
  try {
    const shot = await chrome.render({
      post: {
        text: "Outer post.",
        author: author("Outer", "outer"),
        ...at,
        quote: {
          text: "Quoted post.",
          author: author("Quoted", "quoted"),
          ...at,
          quote: { text: "Nested post with one photo.", author: author("Nested", "nested"), ...at, media: [image(1200, 800, { data: PHOTO })] },
        },
      },
      options: { width: 600, dpr: 2 },
    });
    row.ms = shot.ms;
    const box = shot.geometry.boxes.nestedThumb;
    if (!shot.geometry.boxes.nestedQuote) problems.push("no nested preview box");
    if (!box) problems.push("no nested thumbnail box");
    else {
      const px = await structure(shot.png, box, 2);
      row.distinct = px.distinct;
      row.stdev = Number(px.stdev.toFixed(1));
      row.flat = Number(px.flat.toFixed(2));
      if (Math.abs(box.w - 64) > 0.01 || Math.abs(box.h - 64) > 0.01) problems.push(`the nested thumbnail is ${box.w}x${box.h}, not 64x64`);
      if (!looksReal(px)) problems.push(`the nested thumbnail has no picture in it (${px.distinct} colours, stdev ${px.stdev.toFixed(1)})`);
    }
    if (KEEP) {
      await mkdir(OUT_DIR, { recursive: true });
      await writeFile(join(OUT_DIR, "replica-nested-thumb.png"), shot.png);
    }
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  }
  record(row, problems);
}

// The paint budget is what the playground shows, so page mode's prefetch must be
// *outside* it. An empty media cache forces the network path: the cell's pictures
// are fetched (and the page reloaded), and the response has to say so in
// `ms.fetch` while `ms.paint` stays the DOM+layout+raster of the final frame.
{
  const row = { fixture: "page:prefetch-is-not-paint", mode: "page", theme: "light", width: 600, dpr: 2 };
  const problems = [];
  let cold = null;
  try {
    const cacheDir = await mkdtemp(join(ROOT, "tmp", "media-cache-"));
    // The store reads `source.media`, its own directory *and* the shared module
    // cache (`api/_lib/links.mjs`), so a cold store means pointing that module at
    // an empty directory too — restored in `finally`.
    configureLinks({ imageDir: cacheDir });
    cold = await createChrome({ media: { cacheDir } });
    const shot = await cold.render({
      post: { text: "", author: author("x", "x") },
      options: { width: 600, dpr: 2 },
      mode: "page",
      source: { page: "NASA.html", id: "2119846862286930036" },
    });
    const ms = shot.ms;
    const fetched = cold.stats().media.fetched;
    row.ms = ms;
    row.notes = [
      `${fetched} image(s) prefetched from pbs.twimg.com into a cold cache: paint ${ms.paint} ms, fetch ${ms.fetch} ms, load ${ms.load} ms, total ${ms.total} ms`,
    ];
    row.attachment = `paint ${ms.paint} / fetch ${ms.fetch} / total ${ms.total}`;
    if (!Number.isFinite(ms.paint) || !(ms.paint > 0)) problems.push(`ms.paint is ${JSON.stringify(ms.paint)}, not a positive number`);
    if (ms.paint > ms.total + 0.05) problems.push(`ms.paint ${ms.paint} exceeds ms.total ${ms.total}`);
    if (fetched > 0) {
      // The network path ran: its time is fetch, and fetch/paint do not overlap.
      if (!(ms.fetch > 0)) problems.push(`the store fetched ${fetched} images but ms.fetch is ${ms.fetch}`);
      if (!(ms.paint < ms.total)) problems.push(`ms.paint ${ms.paint} is not below ms.total ${ms.total} although ${fetched} images were fetched`);
      if (ms.paint + ms.fetch > ms.total + 0.5) problems.push(`ms.paint + ms.fetch = ${ms.paint + ms.fetch} exceeds ms.total ${ms.total}`);
    } else {
      row.notes.push("nothing was fetched (no network, or the page's images were already in the cold store): the exclusion is untested here");
    }
    // And the pictures really are there, i.e. the fetch did its job.
    const box = shot.geometry.boxes.attachment;
    if (box) {
      const px = await structure(shot.png, box, 2);
      if (!looksReal(px)) problems.push(`the page's photo box has no picture after the prefetch (${px.distinct} colours)`);
    }
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  } finally {
    await cold?.close().catch(() => {});
    configureLinks({ imageDir: MEDIA_CACHE });
  }
  record(row, problems);
}

// A page that has nothing cached still renders: stubs, no failure. This is the
// offline path, exercised with fetching switched off.
{
  const row = { fixture: "page:cache-only", mode: "page", theme: "light", width: 390, dpr: 2 };
  const problems = [];
  const cacheOnly = await createChrome({ media: { fetchOnMiss: false } });
  try {
    const shot = await cacheOnly.render({
      post: { text: "", author: author("x", "x") },
      options: { width: 390, dpr: 2 },
      mode: "page",
      source: { page: "poll-musk.html", id: "1604617643973124097" },
    });
    row.ms = shot.ms;
    if (!(shot.height > 10)) problems.push("empty cell with a cache-only store");
  } catch (error) {
    problems.push(`threw: ${String(error.message ?? error).split("\n")[0]}`);
  } finally {
    await cacheOnly.close();
  }
  record(row, problems);
}

if (decodePage) await decodePage.close().catch(() => {});
await chrome.close();

console.log(`\n${w("fixture", 26)}${w("mode", 8)}${w("theme", 7)}${w("w", 5)}${w("dpr", 4)}${w("colours", 9)}${w("stdev", 7)}${w("flat", 6)}${w("pill", 6)}${w("play", 6)}${w("ms", 7)}verdict`);
for (const row of rows) {
  console.log(
    `${w(row.fixture, 26)}${w(row.mode, 8)}${w(row.theme, 7)}${w(row.width, 5)}${w(row.dpr, 4)}${w(row.distinct ?? "—", 9)}${w(row.stdev ?? "—", 7)}${w(row.flat ?? "—", 6)}${w(row.pill ?? "—", 6)}${w(row.play ?? "—", 6)}${w(row.ms ? row.ms.total : "—", 7)}${row.verdict}`,
  );
  for (const problem of row.problems ?? []) console.log(`    ${problem}`);
  for (const note of row.notes ?? []) console.log(`    note: ${note}`);
}
const ok = rows.length - failed;
console.log(`\n${ok}/${rows.length} rows show real pictures where the model has bytes, and flat placeholders where it does not`);
if (JSON_OUT) {
  await mkdir(dirname(JSON_OUT), { recursive: true });
  await writeFile(JSON_OUT, JSON.stringify({ rows }, null, 2) + "\n");
  console.log(`wrote ${JSON_OUT}`);
}
process.exit(failed ? 1 : 0);
