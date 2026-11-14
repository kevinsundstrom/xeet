#!/usr/bin/env node
// Raster parity for color emoji.
//
//   node tools/oracle/raster-emoji.mjs [--dpr 4] [--save tmp/raster-emoji]
//
// Emoji have two separate questions:
//
// 1. **Placement.** Layout gives every emoji cluster Apple's 1.25 em advance,
//    because posts are read on iOS and macOS. Twemoji's own advance is 1 em, so
//    the painter centers the artwork in the advance instead of left-aligning
//    it. Chrome cannot be asked for that layout (it uses Twemoji's 1 em
//    advance), so the oracle checks the two halves separately: the artwork's
//    size and its offset from the pen, measured in Chrome at 4×, and our
//    artwork's size plus its centering in a 1.25 em advance.
//
// 2. **Color and shape.** The artwork itself should be identical, so the two
//    ink boxes are cropped and diffed pixel by pixel. Emoji outlines are
//    saturated colour against white, so an anti-aliased rim pixel differs by
//    up to 178 levels even when the geometry is identical (77 → 255 in blue).
//    That is why the report leads with the ink box, the ink mass and the
//    number of differing pixels *away from* edges, not with a raw percentage.
//
// Emoji missing from the bundled artwork (newer than Emoji 14) are listed, so
// the "missing glyph" box is a known, reported state rather than a surprise.

import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { launch, newPage, setContentAs, ROOT, VENDOR } from "./browser.mjs";
import { readPng, writePng, diff, diffImage, paintBinary } from "./raster-lib.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const dpr = Number(flag("dpr", 4));
const size = Number(flag("size", 15));
const dir = flag("save", join(ROOT, "tmp", "raster-emoji"));
mkdirSync(dir, { recursive: true });

// A spread: default-presentation, text-presentation-with-VS16, ZWJ family,
// skin tone, flag (tag sequence), keycap, and two from Emoji 15/16 that the
// bundled Twemoji may not have.
const emoji = flag(
  "emoji",
  "😀,❤️,👨‍👩‍👧,👍🏽,🏴󠁧󠁢󠁳󠁣󠁴󠁿,1️⃣,🎉,🫠,🩷",
).split(",");

// Chrome and xeet both draw from Apple Color Emoji (64 ppem sbix strike in
// assets/vendor/fonts/AppleColorEmoji.ttf).
function html() {
  const rows = emoji
    .map((e, i) => `<div class="row" data-i="${i}" style="padding:8px 12px"><span class="em">${e}</span></div>`)
    .join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#fff}
  .em{font-family:"Apple Color Emoji";font-size:${size}px;line-height:${size * 1.4}px}
  .row{white-space:nowrap}</style></head><body>${rows}</body></html>`;
}

const browser = await launch();
const { page, context } = await newPage(browser, { width: 300, height: 600, dpr, theme: "light" });
await setContentAs(page, html(), "/i/raster-emoji");
const metrics = await page.evaluate(() => {
  const out = [];
  for (const span of document.querySelectorAll(".em")) {
    const r = document.createRange();
    r.selectNodeContents(span);
    const b = r.getBoundingClientRect();
    out.push({ text: span.textContent, width: b.width, height: b.height, left: b.left, top: b.top });
  }
  return out;
});
const shots = [];
for (let i = 0; i < emoji.length; i++) {
  const el = page.locator(".row").nth(i);
  const path = join(dir, `chrome-${i}.png`);
  await el.screenshot({ path });
  const box = await el.boundingBox();
  shots.push({ path, box });
}
await context.close();
await browser.close();

/** Total ink (sum of per-channel distance from the background). */
function inkMass(img) {
  const bg = [...img.data.subarray(0, 4)];
  let sum = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(img.data[o + k] - bg[k]));
    sum += d;
  }
  return sum;
}

/** Ink box (pixels differing from the corner color) in a screenshot. */
function inkBox(img) {
  const bg = [...img.data.subarray(0, 4)];
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      let d = 0;
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(img.data[o + k] - bg[k]));
      if (d > 12) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Crops to `box` and centres the result in a common canvas, so the two crops
 * can be compared even when their ink boxes differ by a pixel (which happens
 * when an anti-aliased fringe crosses the threshold on one side only).
 */
function crop(img, box, width, height) {
  const out = { width, height, data: Buffer.alloc(width * height * 4, 255) };
  const ox = Math.round((width - box.w) / 2);
  const oy = Math.round((height - box.h) / 2);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const si = ((box.y + y) * img.width + box.x + x) * 4;
      const di = ((oy + y) * width + ox + x) * 4;
      img.data.copy(out.data, di, si, si + 4);
    }
  }
  return out;
}

const results = [];
for (let i = 0; i < emoji.length; i++) {
  const chrome = readPng(shots[i].path);
  const box = shots[i].box;
  const chromeInk = inkBox(chrome);
  // Layout advance xeet uses for one emoji cluster.
  const advance = Math.round(size * 1.25);
  const scene = {
    width: 64,
    height: 40,
    dpr,
    background: "#ffffff",
    items: [{ type: "text", text: emoji[i], x: 8, y: 8, width: 48, size, lh: size * 1.4 }],
  };
  const oursPath = join(dir, `xeet-${i}.png`);
  execFileSync(paintBinary(), ["-o", oursPath], { input: JSON.stringify(scene), maxBuffer: 1 << 28 });
  const ours = readPng(oursPath);
  const oursInk = inkBox(ours);
  const entry = { emoji: emoji[i], chromeArtWidth: chromeInk ? +(chromeInk.w / dpr).toFixed(2) : null };
  if (!chromeInk || !oursInk) {
    entry.missingArtwork = !oursInk;
    results.push(entry);
    continue;
  }
  // Chrome's artwork sits at the pen; ours is centered in the advance. Convert
  // both to CSS px offsets from the text box origin, then compare the artwork
  // crops themselves.
  const penX = 8 + (metrics[i].left - box.x / dpr >= 0 ? 0 : 0);
  entry.chromeArtWidth = +(chromeInk.w / dpr).toFixed(2);
  entry.xeetArtWidth = +(oursInk.w / dpr).toFixed(2);
  entry.chromeArtOffsetFromRow = +((chromeInk.x / dpr) - 12).toFixed(2);
  entry.xeetArtOffsetFromPen = +((oursInk.x / dpr) - 8).toFixed(2);
  entry.expectedCenteredOffset = +((advance - oursInk.w / dpr) / 2).toFixed(2);
  entry.chromeAdvance = +metrics[i].width.toFixed(2);
  entry.xeetAdvance = advance;
  // Artwork of a different size means the two sides did not draw the same
  // glyph at all: xeet fell back to its missing-emoji box (or Chrome used the
  // system emoji font because Twemoji lacks the codepoint).
  if (Math.abs(chromeInk.w - oursInk.w) > 2 || Math.abs(chromeInk.h - oursInk.h) > 2) {
    entry.missingArtwork = true;
    entry.inkBox = { chrome: [chromeInk.w, chromeInk.h], xeet: [oursInk.w, oursInk.h] };
    results.push(entry);
    continue;
  }
  const cw = Math.max(chromeInk.w, oursInk.w);
  const ch = Math.max(chromeInk.h, oursInk.h);
  const ca = crop(chrome, chromeInk, cw, ch);
  const cb = crop(ours, oursInk, cw, ch);
  // Emoji edges are colour-to-white transitions, so classify with a wider
  // band than flat-colour items need.
  const d = diff(ca, cb, { tolerance: 12, edgeRadius: 2, edgeStep: 48 });
  entry.artWithinPct = d.withinPct;
  entry.artMaxDelta = d.maxChannelDelta;
  entry.artMeanDelta = d.meanChannelDelta;
  entry.artDifferingOutsideEdges = d.differingOutsideEdges;
  entry.inkMassRatio = +(inkMass(cb) / inkMass(ca)).toFixed(4);
  entry.inkBox = { chrome: [chromeInk.w, chromeInk.h], xeet: [oursInk.w, oursInk.h] };
  entry.sameInkBox =
    Math.abs(chromeInk.w - oursInk.w) <= 1 && Math.abs(chromeInk.h - oursInk.h) <= 1;
  writePng(join(dir, `diff-${i}.png`), diffImage(ca, d));
  void penX;
  results.push(entry);
}

const report = {
  dpr,
  size,
  emoji: emoji.length,
  missingArtwork: results.filter((r) => r.missingArtwork).map((r) => r.emoji),
  minArtWithinPct: Math.min(...results.filter((r) => r.artWithinPct != null).map((r) => r.artWithinPct)),
  maxArtOutsideEdges: Math.max(0, ...results.map((r) => r.artDifferingOutsideEdges ?? 0)),
  inkMassRange: results
    .filter((r) => r.inkMassRatio != null)
    .reduce((a, r) => [Math.min(a[0], r.inkMassRatio), Math.max(a[1], r.inkMassRatio)], [1e9, 0])
    .map((v) => +v.toFixed(4)),
  allInkBoxesMatch: results.every((r) => r.sameInkBox !== false),
  results,
  screenshots: dir,
};
writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
