#!/usr/bin/env node
// Raster parity for images: decode → `object-fit: cover` → draw.
//
//   node tools/oracle/raster-images.mjs [--dpr 2] [--save tmp/raster-images]
//
// Chrome gets an `<img>` with the same box, radii and `object-position`;
// xeet gets an `Item::Image` whose bytes come from the same file. The test
// image is generated here so the run is self-contained: flat blocks, a
// gradient and a fine checkerboard, which is what shows up the difference
// between a good downscale and a naive one.
//
// The comparison is only about pixels: the geometry (crop, scale, radius) is
// the same on both sides to within a device pixel.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { launch, newPage, setContentAs, ROOT } from "./browser.mjs";
import { readPng, writePng, encodePng, diff, diffImage, paintBinary } from "./raster-lib.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const dpr = Number(flag("dpr", 2));
const gate = Number(flag("gate", 95));
const dir = flag("save", join(ROOT, "tmp", "raster-images"));
mkdirSync(dir, { recursive: true });

// ---------------------------------------------------------- test image
function testImage(w, h) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r, g, b;
      const blockX = Math.floor(x / (w / 4)), blockY = Math.floor(y / (h / 3));
      if (blockY === 0) {
        // Flat quadrant colours.
        const ramp = Math.floor((blockX / 3) * 255);
        r = ramp;
        g = 200 - ramp / 2;
        b = 90 + blockX * 40;
      } else if (blockY === 1) {
        // Vertical gradient with a fine checker (aliasing bait).
        const fine = ((x >> 0) + y) % 2 === 0;
        r = Math.round((y / h) * 255);
        g = fine ? 30 : 220;
        b = fine ? 220 : 30;
      } else {
        // Smooth diagonal gradient.
        const t = (x / w + y / h) / 2;
        r = Math.round(t * 255);
        g = Math.round((1 - t) * 200);
        b = Math.round(127 + 100 * Math.sin(t * Math.PI * 2));
      }
      data[o] = r & 0xff;
      data[o + 1] = g & 0xff;
      data[o + 2] = b & 0xff;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const src = testImage(240, 160);
const srcPath = join(dir, "source.png");
writePng(srcPath, src);

// ---------------------------------------------------------------- cases
const cases = [];
const add = (name, box, focus, radius) => cases.push({ name, box, focus, radius });
add("cover-square-120", [120, 120], [0.5, 0.5], 0); // crop left/right
add("cover-tall-80x140", [80, 140], [0.5, 0.5], 0); // crop sides heavily
add("cover-wide-220x60", [220, 60], [0.5, 0.5], 0); // crop top/bottom
add("cover-focus-left", [120, 120], [0, 0.5], 0); // object-position: 0% 50%
add("cover-focus-bottom", [220, 60], [0.5, 1], 0);
add("downscale-2x", [120, 80], [0.5, 0.5], 0); // exactly half
add("downscale-4x", [60, 40], [0.5, 0.5], 0); // exactly quarter
add("downscale-0.75x", [60, 60], [0.5, 0.5], 0); // non-power-of-two device ratio
add("upscale-1.5x", [360, 240], [0.5, 0.5], 0);
add("rounded-cover", [120, 120], [0.5, 0.5], 12);

const PAD = 8;
const pageHtml = () => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}*{box-sizing:border-box}
.case{position:relative}
img{position:absolute;left:${PAD}px;top:${PAD}px;display:block}
</style></head><body>${cases
  .map(
    (c, i) =>
      `<div class="case" data-i="${i}" style="width:${c.box[0] + PAD * 2}px;height:${c.box[1] + PAD * 2}px"><img src="/test.png" style="width:${c.box[0]}px;height:${c.box[1]}px;object-fit:cover;object-position:${c.focus[0] * 100}% ${c.focus[1] * 100}%${c.radius ? `;border-radius:${c.radius}px` : ""}"></div>`,
  )
  .join("")}</body></html>`;

const browser = await launch();
const { page, context } = await newPage(browser, { width: 500, height: 700, dpr, theme: "light", allowImages: true, images: { "https://x.com/test.png": { type: "image/png", body: Buffer.from(encodePng(src)) } } });
await setContentAs(page, pageHtml(), "/i/raster-images");
const shots = [];
for (let i = 0; i < cases.length; i++) {
  const el = page.locator(".case").nth(i);
  const path = join(dir, `chrome-${cases[i].name}.png`);
  await el.screenshot({ path });
  shots.push(path);
}
await context.close();
await browser.close();

let pixels = 0, within = 0, outside = 0;
const results = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const oursPath = join(dir, `xeet-${c.name}.png`);
  const scene = {
    width: c.box[0] + PAD * 2,
    height: c.box[1] + PAD * 2,
    dpr,
    background: "#ffffff",
    items: [
      {
        type: "image",
        rect: [PAD, PAD, c.box[0], c.box[1]],
        radii: c.radius,
        image: "media:0",
        path: srcPath,
        focus: c.focus,
      },
    ],
  };
  execFileSync(paintBinary(), ["-o", oursPath], { input: JSON.stringify(scene), maxBuffer: 1 << 28 });
  const chrome = readPng(shots[i]);
  const ours = readPng(oursPath);
  const d = diff(chrome, ours, { tolerance: 8, edgeRadius: 1 });
  if (d.sizeMismatch) {
    results.push({ name: c.name, sizeMismatch: true, chrome: d.sizeA, xeet: d.sizeB });
    continue;
  }
  pixels += d.total;
  within += d.within;
  outside += d.differingOutsideEdges;
  results.push({ name: c.name, withinPct: d.withinPct, outsideEdges: d.differingOutsideEdges, maxDelta: d.maxChannelDelta, meanDelta: d.meanChannelDelta });
  writePng(join(dir, `diff-${c.name}.png`), diffImage(chrome, d));
}
const withinPct = pixels ? (within / pixels) * 100 : 0;
const report = { dpr, cases: results, pixels, withinPct: +withinPct.toFixed(4), differingOutsideEdges: outside, gate, platform: process.platform, pass: withinPct >= gate, screenshots: dir };
writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
process.exit(withinPct >= gate ? 0 : 1);
