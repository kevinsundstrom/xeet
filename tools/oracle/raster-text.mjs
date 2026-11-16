#!/usr/bin/env node
// Raster parity for text: the same block of text through Chrome and through
// xeet's painter, compared pixel by pixel.
//
//   node tools/oracle/raster-text.mjs [--width 390] [--dpr 2] [--theme light]
//        [--size body|lead] [--n 40] [--set emoji,bidi,styled] [--fuzz 20]
//        [--samples file.json] [--tolerance 8] [--save tmp/raster-text]
//        [--gate 99.9]
//
// Chrome gets X's real stylesheet and the same markup `text-parity.mjs` uses,
// at the same width, padding, theme and DPR, with hinting off and no LCD text
// (see browser.mjs). xeet gets the text through the real text engine
// (`inline::layout`) and the real painter (`paint_text`), so a difference here
// is a difference in rasterization, not in layout.
//
// The reported number is the percentage of pixels whose every channel is
// within `--tolerance` (default 8/255). Mismatches are also split into
// "on glyph edges" and "elsewhere": PLAN §4's raster gate allows a fraction of
// a percent of pixels to differ as long as they sit on edges.

import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, newPage, setContentAs, bundledFallbackCss, ROOT } from "./browser.mjs";
import { corpusTexts, coverageTexts, fuzzTexts } from "./samples.mjs";
import { readPng, writePng, diff, diffImage, runPaint } from "./raster-lib.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const width = Number(flag("width", 390));
const dpr = Number(flag("dpr", 2));
const theme = flag("theme", "light");
const variant = flag("size", "body");
const TYPE = { body: { cls: "text-body", size: 15, lh: 20 }, lead: { cls: "text-lead", size: 17, lh: 24 } }[variant];
const padding = Number(flag("padding", 16));
// `--smoothing antialiased` adds X's own `.antialiased` utility to the text
// element, which turns off CoreText font smoothing on macOS Chrome. Linux
// Chrome ignores it; there the glyph mask has no smoothing to begin with.
const smoothing = flag("smoothing", "");
const tolerance = Number(flag("tolerance", 8));
// 99.9 is the PLAN §4 target against Chrome on Linux; macOS Chrome rasterizes
// glyphs through CoreText, whose masks are not analytic coverage (docs/e2e-raster.md),
// so the darwin floor is the measured level.
const gate = Number(flag("gate", process.platform === "darwin" ? "97.9" : "99.9"));
const outDir = flag("save", "");
const seed = Number(flag("seed", 1));

let samples = [];
if (flag("samples")) samples = JSON.parse(await readFile(flag("samples"), "utf8"));
else if (!flag("set") && !flag("fuzz")) samples = await corpusTexts();
for (const set of (flag("set") ?? "").split(",").filter(Boolean)) {
  samples = samples.concat(coverageTexts(set, Number(flag("n", 40)), seed));
}
if (flag("fuzz")) samples = samples.concat(fuzzTexts(Number(flag("fuzz")), seed));
const limit = Number(flag("n", 0));
if (limit) samples = samples.slice(0, limit);
// Keep frames small: the oracle is about glyphs, not about very long posts.
samples = samples.map((s) => s.slice(0, 400)).filter((s) => s.trim().length);

// Samples with emoji are reported separately. Chrome on this machine draws
// them with Apple Color Emoji, whose artwork cannot be bundled (PLAN §14);
// xeet paints Twemoji. That difference is by design, so emoji are gated by
// `raster-emoji.mjs` (which gives Chrome the same Twemoji file) and not here.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{20E3}\u{1F1E6}-\u{1F1FF}]/u;
const hasEmoji = (s) => EMOJI.test(s);

const chromeVersion = (await readFile(join(ROOT, "node_modules", "playwright-core", "package.json"), "utf8").catch(() => "{}"));
const lock = JSON.parse(await readFile(join(ROOT, "assets", "upstream.lock.json"), "utf8"));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fallbackCss = await bundledFallbackCss();

function pageHtml(texts) {
  const frames = texts
    .map(
      (t, i) =>
        `<div class="frame" data-i="${i}" style="width:${width}px;padding:${padding}px;box-sizing:border-box"><div class="max-w-full ${TYPE.cls} xeet-fallback font-normal whitespace-pre-wrap wrap-anywhere ${smoothing === "antialiased" ? "antialiased" : ""}" dir="auto" style="color:${theme === "dark" ? "#e7e9ea" : "#0f1419"}"><span class="max-w-full text-[length:inherit] font-[weight:inherit] text-[color:inherit]">${esc(t)}</span></div></div>`,
    )
    .join("\n");
  return `<!DOCTYPE html><html lang="en" dir="ltr" data-theme="${theme}"><head><meta charset="utf-8"><link rel="stylesheet" href="${lock.stylesheet.url}"><style>${fallbackCss}
    html,body{margin:0;padding:0;background:${theme === "dark" ? "#000000" : "#ffffff"}}
    .frame{overflow:hidden}</style></head><body>${frames}</body></html>`;
}

const dir = outDir || join(ROOT, "tmp", "raster-text");
mkdirSync(dir, { recursive: true });

const browser = await launch();
const { page, context } = await newPage(browser, { width: width + 40, height: 900, dpr, theme });
await setContentAs(page, pageHtml(samples), "/i/raster-text");

// Screenshot each frame at its own size.
const frameCount = await page.evaluate(() => document.querySelectorAll(".frame").length);
const shots = [];
for (let i = 0; i < frameCount; i++) {
  const el = page.locator(".frame").nth(i);
  const path = join(dir, `chrome-${i}.png`);
  await el.screenshot({ path });
  const box = await el.boundingBox();
  shots.push({ path, height: box.height });
}
// Colors as Chrome resolved them, for the report.
const colors = await page.evaluate(() => {
  const el = document.querySelector(".frame .xeet-fallback") ?? document.querySelector(".frame");
  const cs = getComputedStyle(el);
  const body = getComputedStyle(document.body);
  return { color: cs.color, background: body.backgroundColor, font: cs.fontFamily, size: cs.fontSize, lineHeight: cs.lineHeight };
});
await context.close();
await browser.close();

let totalPixels = 0;
let withinPixels = 0;
let outsideEdges = 0;
const perSample = [];
const emojiSamples = [];
for (let i = 0; i < samples.length; i++) {
  const oursPath = join(dir, `xeet-${i}.png`);
  runPaint([
    "--width", String(width),
    "--dpr", String(dpr),
    "--size", String(TYPE.size),
    "--lh", String(TYPE.lh),
    "--padding", String(padding),
    "--theme", theme,
    "--text", samples[i],
    "-o", oursPath,
  ]);
  const chrome = readPng(shots[i].path);
  const ours = readPng(oursPath);
  const d = diff(chrome, ours, { tolerance });
  if (d.sizeMismatch) {
    perSample.push({ i, text: samples[i].slice(0, 60), sizeMismatch: true, chrome: d.sizeA, xeet: d.sizeB });
    totalPixels += chrome.width * chrome.height;
    continue;
  }
  if (!hasEmoji(samples[i])) {
    totalPixels += d.total;
    withinPixels += d.within;
    outsideEdges += d.differingOutsideEdges;
  } else {
    totalPixels += 0;
  }
  const row = {
    i,
    text: samples[i].slice(0, 60),
    withinPct: d.withinPct,
    differingOutsideEdges: d.differingOutsideEdges,
    maxChannelDelta: d.maxChannelDelta,
    histogram: d.histogram,
  };
  if (hasEmoji(samples[i])) emojiSamples.push(row);
  else perSample.push(row);
  if (outDir) writePng(join(dir, `diff-${i}.png`), diffImage(chrome, d));
}

perSample.sort((a, b) => (a.withinPct ?? 100) - (b.withinPct ?? 100));
const withinPct = totalPixels ? (withinPixels / totalPixels) * 100 : 0;
const report = {
  chrome: colors,
  width,
  dpr,
  theme,
  variant,
  smoothing: smoothing || "none",
  tolerance,
  samples: samples.length,
  pixels: totalPixels,
  withinPct: +withinPct.toFixed(4),
  differingOutsideEdges: outsideEdges,
  differingOutsideEdgesPct: totalPixels ? +((outsideEdges / totalPixels) * 100).toFixed(4) : 0,
  gate,
  pass: withinPct >= gate,
  worst: perSample.slice(0, 8),
  emojiSamples: emojiSamples.length,
  emojiWithinPct: emojiSamples.length
    ? +(emojiSamples.reduce((a, r) => a + r.withinPct, 0) / emojiSamples.length).toFixed(4)
    : null,
  screenshots: dir,
};
writeFileSync(join(dir, "report.json"), JSON.stringify({ ...report, perSample }, null, 1));
console.log(JSON.stringify(report, null, 1));
process.exit(report.pass ? 0 : 1);
