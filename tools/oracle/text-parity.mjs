#!/usr/bin/env node
// Differential test of the text engine against Chrome.
//
// Lays out each sample text in Chrome, inside the exact element X uses for
// post text and with X's real stylesheet and fonts, then lays out the same
// text with `xeet debug-text` and compares line by line.
//
//   node tools/oracle/text-parity.mjs [--widths 280,320,420,520] [--size body|lead]
//        [--samples file.json] [--fuzz N] [--seed S] [--verbose] [--save tests/golden/text.json]
//        [--set emoji,bidi,styled,space] [--n 200] [--no-corpus]
//        [--fallback system|bundled]
//
// --fallback bundled makes Chrome fall back to the fonts xeet embeds instead
// of this machine's system fonts, which isolates the engine's own logic
// (shaping, bidi, segmentation, breaking) from the choice of device font.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { launch, newPage, setContentAs, bundledFallbackCss, ROOT, xeetBinary } from "./browser.mjs";
import { corpusTexts, coverageTexts, fuzzTexts } from "./samples.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const widths = flag("widths", "240,280,310,350,420,520").split(",").map(Number);
const variant = flag("size", "body");
const TYPE = { body: { cls: "text-body", size: 15, lh: 20 }, lead: { cls: "text-lead", size: 17, lh: 24 } }[variant];
const verbose = args.includes("--verbose");

let samples = [];
if (flag("samples")) samples = JSON.parse(await readFile(flag("samples"), "utf8"));
else if (!args.includes("--no-corpus") && !flag("set")) samples = await corpusTexts();
const fuzzN = Number(flag("fuzz", 0));
if (fuzzN) samples = samples.concat(fuzzTexts(fuzzN, Number(flag("seed", 1))));
for (const set of (flag("set") ?? "").split(",").filter(Boolean)) {
  samples = samples.concat(coverageTexts(set, Number(flag("n", 200)), Number(flag("seed", 1))));
}
const fallback = flag("fallback", "system");
const extraCss = fallback === "bundled" ? await bundledFallbackCss() : "";

const lock = JSON.parse(await readFile(join(ROOT, "assets", "upstream.lock.json"), "utf8"));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function pageHtml(texts, width) {
  const blocks = texts
    .map(
      (t, i) =>
        `<div style="width:${width}px" class="blk" data-i="${i}"><div class="max-w-full ${TYPE.cls}${extraCss ? " xeet-fallback" : ""} font-normal text-primary whitespace-pre-wrap wrap-anywhere" dir="auto"><span class="max-w-full text-[length:inherit] font-[weight:inherit] text-[color:inherit]">${esc(t)}</span></div></div>`,
    )
    .join("\n");
  return `<!DOCTYPE html><html lang="en" dir="ltr" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="${lock.stylesheet.url}"><style>${extraCss}</style></head><body>${blocks}</body></html>`;
}

/** Runs in the page: per block, the text and box of every rendered line. */
function extractLines() {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const out = [];
  for (const blk of document.querySelectorAll(".blk")) {
    const node = blk.querySelector("span").firstChild;
    const box = blk.firstElementChild.getBoundingClientRect();
    const lines = [];
    if (node) {
      const range = document.createRange();
      let cur = null;
      for (const { segment, index } of seg.segment(node.data)) {
        if (segment === "\n") { cur = null; continue; }
        range.setStart(node, index);
        range.setEnd(node, index + segment.length);
        const rects = range.getClientRects();
        if (!rects.length) continue;
        const r = rects[0];
        // Same line if the boxes overlap vertically. Bidi reordering means a
        // line's graphemes need not advance left to right.
        if (cur && r.top < cur.bottom - 1 && r.bottom > cur.top + 1) {
          cur.text += segment; cur.left = Math.min(cur.left, r.left); cur.right = Math.max(cur.right, r.right);
          cur.top = Math.min(cur.top, r.top); cur.bottom = Math.max(cur.bottom, r.bottom);
        } else {
          cur = { text: segment, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          lines.push(cur);
        }
      }
    }
    out.push({
      height: box.height,
      lines: lines.map((l) => ({ text: l.text, x: l.left - box.left, y: l.top - box.top, w: l.right - l.left, h: l.bottom - l.top })),
    });
  }
  return out;
}

const bin = xeetBinary();
const browser = await launch();
let total = 0, lineMismatch = 0, heightMismatch = 0, maxDx = 0, maxDw = 0, linesCompared = 0;
const failures = [];
const golden = [];
for (const width of widths) {
  const { page, context } = await newPage(browser, { width: Math.max(width + 40, 400), dpr: 1 });
  await setContentAs(page, pageHtml(samples, width), "/i/text-parity");
  const chrome = await page.evaluate(extractLines);
  await context.close();
  const ours = JSON.parse(
    execFileSync(bin, ["debug-text", "--width", String(width), "--size", String(TYPE.size), "--lh", String(TYPE.lh)], {
      input: JSON.stringify(samples), maxBuffer: 1 << 28,
    }).toString(),
  );
  for (let i = 0; i < samples.length; i++) {
    total++;
    const c = chrome[i], o = ours[i];
    const cl = c.lines.map((l) => l.text.replace(/ +$/, ""));
    const ol = o.lines.map((l) => l.text.replace(/ +$/, ""));
    const same = cl.length === ol.length && cl.every((t, k) => t === ol[k]);
    if (args.includes("--save")) golden.push({ width, size: TYPE.size, lh: TYPE.lh, text: samples[i], height: c.height, lines: c.lines.map((l) => ({ text: l.text, x: +l.x.toFixed(3), w: +l.w.toFixed(3) })) });
    if (!same) {
      lineMismatch++;
      if (failures.length < 12) {
        const k = cl.findIndex((t, j) => t !== ol[j]);
        failures.push({ width, sample: i, line: k, chrome: cl[k], xeet: ol[k], chromeNext: cl[k + 1], xeetNext: ol[k + 1] });
      }
      continue;
    }
    if (Math.abs(c.height - o.height) > 0.01) {
      heightMismatch++;
      if (failures.length < 12) failures.push({ width, sample: i, heightChrome: c.height, heightXeet: o.height, text: samples[i].slice(0, 60) });
    }
    for (let k = 0; k < c.lines.length; k++) {
      linesCompared++;
      // Compare without trailing spaces: Chrome reports hanging spaces inconsistently.
      const hang = c.lines[k].text.length - cl[k].length;
      maxDx = Math.max(maxDx, Math.abs(c.lines[k].x - o.lines[k].x));
      if (!hang && o.lines[k].text.length === ol[k].length) {
        const dw = Math.abs(c.lines[k].w - o.lines[k].w);
        if (dw > maxDw) {
          maxDw = dw;
          if (verbose && dw > 0.05) console.log("width delta", dw.toFixed(3), JSON.stringify(cl[k].slice(0, 80)), c.lines[k].w, o.lines[k].w);
        }
      }
    }
  }
}
await browser.close();
if (flag("save")) await writeFile(flag("save"), JSON.stringify(golden));
console.log(JSON.stringify({
  variant, widths, samples: samples.length, layouts: total, lineBreakMismatches: lineMismatch, heightMismatches: heightMismatch,
  linesCompared, maxLineXDelta: +maxDx.toFixed(4), maxLineWidthDelta: +maxDw.toFixed(4),
}, null, 1));
for (const f of failures) console.log(JSON.stringify(f));
process.exit(lineMismatch || heightMismatch ? 1 : 0);
