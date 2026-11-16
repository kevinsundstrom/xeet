#!/usr/bin/env node
// Measures Chrome's exact rule for "does this line fit".
//
// For each probe, finds the narrowest container (on the 1/64 px LayoutUnit
// grid) at which a given prefix stays on the first line. It also records the
// width Chrome itself gives that first line at that container width, so the
// threshold can be compared with Chrome's own numbers rather than only with
// the prefix's natural (max-content) width.
//
// Probes cover breaks after a space and breaks after a hyphen, which Chrome
// turns out to treat differently.
//
//   node tools/oracle/fit-threshold.mjs [--json out.json] [--probes 60] [--seed 7]
//
// Output columns:
//   nat    max-content width of the prefix, as getBoundingClientRect reports it
//   k      narrowest container width that keeps the prefix on line one,
//          minus ceil64(nat), in 1/64 px steps
//   thrW   that narrowest container width, in px
//   lineW  width Chrome gives the prefix's text on the first line at thrW
//   paraW  width Chrome gives the same prefix when the text is not broken
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, newPage, setContentAs, ROOT } from "./browser.mjs";

const argv = process.argv.slice(2);
const flag = (name, d) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : d;
};
const NPROBES = Number(flag("probes", 60));
const JSONOUT = flag("json", null);
const SEED = Number(flag("seed", 7));

const lock = JSON.parse(await readFile(join(ROOT, "assets", "upstream.lock.json"), "utf8"));
const WORDS = ["made", "the", "with", "when", "Co-founder", "update", "new", "first", "as", "may", "ship", "team", "product", "launch", "faster", "today", "into", "write", "people", "water", "number", "AVA", "Tо", "we're", "v2.0"];
const probes = [];
let seed = SEED;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 0x100000000);
for (let i = 0; i < NPROBES; i++) {
  const n = 3 + Math.floor(rnd() * 5);
  const prefix = Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(" ");
  // kind "space": first line should end with "<prefix> ship", then a space and more text.
  // kind "hyphen": first line should end with "<prefix> open-", followed directly by "source".
  probes.push({ kind: "space", head: `${prefix} ship`, tail: " more words follow here" });
  probes.push({ kind: "hyphen", head: `${prefix} open-`, tail: "source words follow here" });
  probes.push({ kind: "slash-less", head: `${prefix} state-of-`, tail: "the-art follows" });
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const cls = "max-w-full text-body font-normal text-primary whitespace-pre-wrap wrap-anywhere";
const html = `<!DOCTYPE html><html lang="en" dir="ltr" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="${lock.stylesheet.url}"></head><body>${probes
  .map(
    (p) =>
      `<div class="probe"><div class="nat ${cls}" style="width:max-content"><span>${esc(p.head)}</span></div>` +
      `<div class="box" style="width:900px"><div class="${cls}" dir="auto"><span>${esc(p.head + p.tail)}</span></div></div>` +
      `<div class="wide" style="width:900px"><div class="${cls}" dir="auto"><span>${esc(p.head + p.tail)}</span></div></div></div>`,
  )
  .join("")}</body></html>`;

const browser = await launch();
const { page } = await newPage(browser, { width: 1000, dpr: 1 });
await setContentAs(page, html, "/i/fit-threshold");
const results = await page.evaluate((heads) => {
  const out = [];
  const range = document.createRange();
  // Width of the first client rect covering [a, b) of a text node.
  const rectW = (node, a, b) => {
    range.setStart(node, a);
    range.setEnd(node, b);
    const rs = range.getClientRects();
    return rs.length ? +(rs[0].right - rs[0].left).toFixed(6) : null;
  };
  const topOf = (node, i) => {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const rs = range.getClientRects();
    return rs.length ? rs[0].top : null;
  };
  [...document.querySelectorAll(".probe")].forEach((probe, i) => {
    const headLen = heads[i].length;
    const natural = probe.querySelector(".nat span").getBoundingClientRect().width;
    const box = probe.querySelector(".box");
    const node = box.querySelector("span").firstChild;
    const wideNode = probe.querySelector(".wide span").firstChild;
    const paraW = rectW(wideNode, 0, headLen);
    const fitsAt = (k) => {
      box.style.width = `${base + k / 64}px`;
      const t0 = topOf(node, 0);
      const t1 = topOf(node, headLen - 1);
      return t0 !== null && t1 !== null && Math.abs(t1 - t0) < 0.5;
    };
    const base = Math.ceil(natural * 64) / 64;
    // Monotone in width: binary search the smallest k that keeps the head on line one.
    let lo = -16;
    let hi = 8;
    let threshold = null;
    if (fitsAt(hi)) {
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (fitsAt(mid)) hi = mid;
        else lo = mid + 1;
      }
      threshold = lo;
    }
    let lineW = null;
    let nextLineW = null;
    if (threshold !== null) {
      box.style.width = `${base + threshold / 64}px`;
      lineW = rectW(node, 0, headLen);
      // Width of the head when the box has a little more room (same break).
      box.style.width = `${base + (threshold + 4) / 64}px`;
      const lw4 = rectW(node, 0, headLen);
      nextLineW = lw4;
    }
    out.push({ natural, base, threshold, thrW: threshold === null ? null : base + threshold / 64, lineW, lineWp4: nextLineW, paraW });
  });
  return out;
}, probes.map((p) => p.head));
await browser.close();

const rows = results.map((r, i) => ({ ...probes[i], ...r }));
if (JSONOUT) await writeFile(JSONOUT, JSON.stringify(rows, null, 1));

const tally = {};
for (const r of rows) {
  const key = `${r.kind} threshold=${r.threshold === null ? "none" : `${r.threshold}/64`}`;
  tally[key] = (tally[key] ?? 0) + 1;
}
console.log("threshold = narrowest box that keeps the head on line one, minus ceil64(natural width), in 1/64 px steps");
for (const [k, v] of Object.entries(tally).sort()) console.log(`${k}: ${v} probes`);
const fmt = (v) => (v === null ? "-" : v.toFixed(4));
console.log("\nkind     nat      thrW     lineW    lineW+4  paraW    head");
for (const r of rows.slice(0, 12)) {
  console.log(`${r.kind.padEnd(8)} ${fmt(r.natural).padStart(8)} ${fmt(r.thrW).padStart(8)} ${fmt(r.lineW).padStart(8)} ${fmt(r.lineWp4).padStart(8)} ${fmt(r.paraW).padStart(8)}  ${JSON.stringify(r.head.slice(-16))}`);
}
if (JSONOUT) console.log(`\nwrote ${JSONOUT}`);
