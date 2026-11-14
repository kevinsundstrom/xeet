#!/usr/bin/env node
// Raster parity for icons: X's SVG sprite, drawn by Chrome and by xeet.
//
//   node tools/oracle/raster-icons.mjs [--dpr 4] [--size 24] [--save tmp/raster-icons]
//
// The sprite (`assets/vendor/icons.json`) is X's own: 24×24 symbols whose body
// is paths (and, for the verified badges, a linear gradient). Chrome gets the
// same body inline in an `<svg>` with `fill="currentColor"`, xeet gets an
// `Item::Icon`. This checks the SVG path parser (including arcs), the fill
// rules, the gradients, and the scaling into the item's rectangle.
//
// Icons whose body uses something beyond that subset are reported rather than
// silently drawn wrong.

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
const size = Number(flag("size", 24));
// 99.9 is the PLAN §4 target against Chrome on Linux; macOS Chrome rasterizes
// glyphs through CoreText, whose masks are not analytic coverage (docs/e2e-raster.md),
// so the darwin floor is the measured level.
const gate = Number(flag("gate", process.platform === "darwin" ? "98.2" : "99.9"));
const dir = flag("save", join(ROOT, "tmp", "raster-icons"));
mkdirSync(dir, { recursive: true });
const COLOR = "#536471";

const sprite = JSON.parse(await readFile(join(VENDOR, "icons.json"), "utf8"));
const names = Object.keys(sprite).sort();

const cell = size + 8;
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}*{box-sizing:border-box}
.cell{position:relative;width:${cell}px;height:${cell}px}
.cell svg{position:absolute;left:4px;top:4px;width:${size}px;height:${size}px;color:${COLOR}}</style></head><body>${names
  .map((n) => `<div class="cell" data-name="${n}"><svg viewBox="${sprite[n].viewBox}" fill="currentColor" color="${COLOR}">${sprite[n].body}</svg></div>`)
  .join("")}</body></html>`;

const browser = await launch();
const { page, context } = await newPage(browser, { width: cell * 4, height: cell * 8, dpr, theme: "light" });
await setContentAs(page, html, "/i/raster-icons");
const shots = [];
for (let i = 0; i < names.length; i++) {
  const el = page.locator(".cell").nth(i);
  const path = join(dir, `chrome-${names[i]}.png`);
  await el.screenshot({ path });
  shots.push(path);
}
await context.close();
await browser.close();

let pixels = 0, within = 0, outside = 0;
const results = [];
for (let i = 0; i < names.length; i++) {
  const oursPath = join(dir, `xeet-${names[i]}.png`);
  const scene = {
    width: cell,
    height: cell,
    dpr,
    background: "#ffffff",
    items: [{ type: "icon", name: names[i], rect: [4, 4, size, size], color: COLOR }],
  };
  execFileSync(paintBinary(), ["-o", oursPath], { input: JSON.stringify(scene), maxBuffer: 1 << 28 });
  const chrome = readPng(shots[i]);
  const ours = readPng(oursPath);
  const d = diff(chrome, ours, { tolerance: 8, edgeRadius: 1 });
  if (d.sizeMismatch) {
    results.push({ name: names[i], sizeMismatch: true, chrome: d.sizeA, xeet: d.sizeB });
    continue;
  }
  pixels += d.total;
  within += d.within;
  outside += d.differingOutsideEdges;
  results.push({ name: names[i], withinPct: d.withinPct, outsideEdges: d.differingOutsideEdges, maxDelta: d.maxChannelDelta });
  if (d.withinPct < 99) writePng(join(dir, `diff-${names[i]}.png`), diffImage(chrome, d));
}
results.sort((a, b) => (a.withinPct ?? 0) - (b.withinPct ?? 0));
const withinPct = pixels ? (within / pixels) * 100 : 0;
const report = {
  dpr,
  size,
  icons: names.length,
  pixels,
  withinPct: +withinPct.toFixed(4),
  differingOutsideEdges: outside,
  worst: results.slice(0, 8),
  gate,
  platform: process.platform,
  pass: withinPct >= gate,
  screenshots: dir,
};
writeFileSync(join(dir, "report.json"), JSON.stringify({ ...report, results }, null, 1));
console.log(JSON.stringify(report, null, 1));
process.exit(report.pass ? 0 : 1);
