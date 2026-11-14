#!/usr/bin/env node
// Raster parity for shapes: rounded rectangles, squircles, inside strokes and
// clips, plus a fit of the squircle exponent against Chrome's own curve.
//
//   node tools/oracle/raster-shapes.mjs [--dpr 2] [--fit] [--save tmp/raster-shapes]
//
// Each case is described once and rendered twice: as CSS in Chrome (the same
// geometry, with `border-radius`, `corner-shape`, `box-shadow: inset` and
// `overflow: hidden`) and through `paint_fixture` for xeet. The diff is the
// same one raster-text.mjs uses.
//
// `--fit` renders a large superellipse in Chrome, extracts its boundary, and
// reports which exponent matches best — the evidence behind
// `paint::shapes::SUPER_K`.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { launch, newPage, setContentAs, ROOT } from "./browser.mjs";
import { readPng, writePng, diff, diffImage, paintBinary } from "./raster-lib.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const dpr = Number(flag("dpr", 2));
const gate = Number(flag("gate", 99.9));
const dir = flag("save", join(ROOT, "tmp", "raster-shapes"));
mkdirSync(dir, { recursive: true });

/** One case: an element box, its CSS, and the matching display-list items. */
function cases() {
  const out = [];
  const W = 220, H = 80;
  // `position:absolute` so the case's left/top/width/height apply.
  const add = (name, css, items, bg = "#ffffff") => out.push({ name, html: `<div style="position:absolute;${css}"></div>`, items, bg, width: W, height: H });
  add(
    "rect",
    `left:10px;top:10px;width:200px;height:60px;background:#1d9bf0`,
    [{ type: "fill", rect: [10, 10, 200, 60], color: "#1d9bf0" }],
  );
  add(
    "radius-8",
    `left:10px;top:10px;width:200px;height:60px;background:#1d9bf0;border-radius:8px`,
    [{ type: "fill", rect: [10, 10, 200, 60], radii: 8, color: "#1d9bf0" }],
  );
  add(
    "radius-16",
    `left:10px;top:10px;width:200px;height:60px;background:#1d9bf0;border-radius:16px`,
    [{ type: "fill", rect: [10, 10, 200, 60], radii: 16, color: "#1d9bf0" }],
  );
  add(
    "radius-mixed",
    `left:10px;top:10px;width:200px;height:60px;background:#1d9bf0;border-radius:4px 20px 40px 12px`,
    [{ type: "fill", rect: [10, 10, 200, 60], radii: [4, 20, 40, 12], color: "#1d9bf0" }],
  );
  add(
    "radius-clamped",
    `left:10px;top:10px;width:200px;height:60px;background:#1d9bf0;border-radius:80px`,
    [{ type: "fill", rect: [10, 10, 200, 60], radii: 80, color: "#1d9bf0" }],
  );
  add(
    "squircle-16",
    `left:10px;top:10px;width:200px;height:60px;background:#1d9bf0;border-radius:16px;corner-shape:squircle`,
    [{ type: "fill", rect: [10, 10, 200, 60], radii: 16, corner: "squircle", color: "#1d9bf0" }],
  );
  add(
    "squircle-29",
    `left:10px;top:10px;width:200px;height:60px;background:#1d9bf0;border-radius:29px;corner-shape:squircle`,
    [{ type: "fill", rect: [10, 10, 200, 60], radii: 29, corner: "squircle", color: "#1d9bf0" }],
  );
  add(
    "stroke-1",
    `left:10px;top:10px;width:200px;height:60px;background:#ffffff;border:1px solid #0f1419;border-radius:12px`,
    [
      { type: "fill", rect: [10, 10, 200, 60], radii: 12, color: "#ffffff" },
      { type: "stroke", rect: [10, 10, 200, 60], radii: 12, color: "#0f1419", width: 1 },
    ],
  );
  // X's hairline over media: a 1px inset shadow at 40% black, not a border.
  add(
    "shadow-inset-1",
    `left:10px;top:10px;width:200px;height:60px;background:#ffffff;box-shadow:inset 0 0 0 1px #00000066;border-radius:12px`,
    [
      { type: "fill", rect: [10, 10, 200, 60], radii: 12, color: "#ffffff" },
      { type: "stroke", rect: [10, 10, 200, 60], radii: 12, color: "#00000066", width: 1 },
    ],
  );
  add(
    "stroke-squircle",
    `left:10px;top:10px;width:200px;height:60px;background:#ffffff;border:1px solid #0f1419;border-radius:20px;corner-shape:squircle`,
    [
      { type: "fill", rect: [10, 10, 200, 60], radii: 20, corner: "squircle", color: "#ffffff" },
      { type: "stroke", rect: [10, 10, 200, 60], radii: 20, corner: "squircle", color: "#0f1419", width: 1 },
    ],
  );
  add(
    "clip-rounded",
    `left:10px;top:10px;width:200px;height:60px;border-radius:16px;overflow:hidden;background:#536471`,
    [
      { type: "pushclip", rect: [10, 10, 200, 60], radii: 16 },
      { type: "fill", rect: [0, 0, 220, 80], color: "#536471" },
      { type: "popclip" },
    ],
  );
  // A clipped child over a background: the container's own rounded box plus a
  // square that must be cut by `overflow: hidden`.
  out.push({
    name: "clip-mid-stack",
    html: `<div style="position:absolute;left:10px;top:10px;width:200px;height:60px;border-radius:16px;overflow:hidden;background:#1d9bf0"><div style="position:absolute;left:0;top:0;width:100px;height:60px;background:#0088cc"></div></div>`,
    items: [
      { type: "fill", rect: [10, 10, 200, 60], radii: 16, color: "#1d9bf0" },
      { type: "pushclip", rect: [10, 10, 200, 60], radii: 16 },
      { type: "fill", rect: [10, 10, 100, 60], color: "#0088cc" },
      { type: "popclip" },
    ],
    bg: "#ffffff",
    width: W,
    height: H,
  });
  return out;
}

const list = cases();
function pageHtml() {
  const els = list
    .map((c, i) => `<div class="case" data-i="${i}" style="position:relative;width:${c.width}px;height:${c.height}px;background:${c.bg}">${c.html}</div>`)
    .join("\n");
  // `box-sizing: border-box` everywhere, as X's stylesheet does (Tailwind's
  // preflight), so a 1px border does not grow the box.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff;-webkit-font-smoothing:antialiased}*{box-sizing:border-box}</style></head><body>${els}</body></html>`;
}

const browser = await launch();
const { page, context } = await newPage(browser, { width: 260, height: 400, dpr, theme: "light" });
await setContentAs(page, pageHtml(), "/i/raster-shapes");
// Does this Chrome know corner-shape at all?
const supports = await page.evaluate(() => CSS.supports("corner-shape", "squircle"));
const shots = [];
for (let i = 0; i < list.length; i++) {
  const el = page.locator(".case").nth(i);
  const path = join(dir, `chrome-${list[i].name}.png`);
  await el.screenshot({ path });
  const box = await el.boundingBox();
  shots.push({ path, height: box.height });
}
await context.close();

// Squircle fit: a big superellipse, boundary compared against candidate exponents.
let fit = null;
if (args.includes("--fit")) {
  const { page: p2, context: c2 } = await newPage(browser, { width: 400, height: 400, dpr: 1 });
  await setContentAs(
    p2,
    `<!DOCTYPE html><html><head><style>html,body{margin:0;background:#fff}div{position:fixed;left:20px;top:20px;width:200px;height:200px;background:#000;border-radius:100px;corner-shape:squircle}</style></head><body><div></div></body></html>`,
    "/i/raster-squircle",
  );
  const path = join(dir, "squircle-fit.png");
  await p2.screenshot({ path });
  await c2.close();
  const img = readPng(path);
  // The top-left corner of the box starts at (20, 20) with radius 100: read
  // the boundary x for a few y, then find the exponent that matches.
  const cover = (x, y) => 1 - img.data[(y * img.width + x) * 4] / 255;
  const boundary = [];
  for (let y = 20; y <= 120; y += 4) {
    let x = -1;
    for (let xx = 20; xx < 140; xx++) {
      if (cover(xx, y) > 0.5) {
        x = xx;
        break;
      }
    }
    if (x >= 0) boundary.push({ y: y - 20, x: x - 20 });
  }
  // Superellipse in corner-local coordinates: u = r - x, v = r - y,
  // (u/r)^k + (v/r)^k = 1.
  const r = 100;
  fit = [];
  for (const k of [2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 8]) {
    let err = 0;
    for (const b of boundary) {
      const v = b.y;
      const u = r * Math.pow(Math.max(0, 1 - Math.pow(Math.min(v / r, 1), k)), 1 / k);
      err += Math.abs(u - (r - b.x));
    }
    fit.push({ k, meanError: +(err / boundary.length).toFixed(3) });
  }
  fit.sort((a, b) => a.meanError - b.meanError);
  writeFileSync(join(dir, "squircle-fit.json"), JSON.stringify({ boundary, fit }, null, 1));
}
await browser.close();

let pixels = 0, within = 0, outside = 0;
const results = [];
for (let i = 0; i < list.length; i++) {
  const oursPath = join(dir, `xeet-${list[i].name}.png`);
  const scene = { width: list[i].width, height: list[i].height, dpr, background: list[i].bg, items: list[i].items };
  execFileSync(paintBinary(), ["-o", oursPath], { input: JSON.stringify(scene), maxBuffer: 1 << 28 });
  const chrome = readPng(shots[i].path);
  const ours = readPng(oursPath);
  const d = diff(chrome, ours, { tolerance: 8 });
  if (d.sizeMismatch) {
    results.push({ name: list[i].name, sizeMismatch: true, chrome: d.sizeA, xeet: d.sizeB });
    continue;
  }
  pixels += d.total;
  within += d.within;
  outside += d.differingOutsideEdges;
  results.push({ name: list[i].name, withinPct: d.withinPct, outsideEdges: d.differingOutsideEdges, maxDelta: d.maxChannelDelta });
  writePng(join(dir, `diff-${list[i].name}.png`), diffImage(chrome, d));
}
const withinPct = pixels ? (within / pixels) * 100 : 0;
const report = {
  dpr,
  chromeSupportsCornerShape: supports,
  cases: results,
  pixels,
  withinPct: +withinPct.toFixed(4),
  differingOutsideEdges: outside,
  squircleFit: fit,
  gate,
  platform: process.platform,
  pass: withinPct >= gate,
  screenshots: dir,
};
writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
process.exit(withinPct >= gate ? 0 : 1);
