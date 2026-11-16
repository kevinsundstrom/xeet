#!/usr/bin/env node
// Compares the natural (single-line) width of short texts in Chrome and xeet.
// Line-break mismatches almost always start as a width mismatch of one
// token; this finds which.
//
//   node tools/oracle/widths.mjs [--fallback bundled] "text" ...
//   node tools/oracle/widths.mjs --set emoji|styled|space|bidi   # tokens of a coverage set
//   node tools/oracle/widths.mjs --all                           # print matches too
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, newPage, setContentAs, bundledFallbackCss, ROOT, xeetBinary } from "./browser.mjs";
import { coverageTokens } from "./samples.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const valued = new Set(["--fallback", "--set", "--size", "--lh", "--json", "--parity"]);
let texts = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
if (flag("set")) texts = texts.concat(coverageTokens(flag("set")));
// --json file.json: an array of strings.
if (flag("json")) texts = texts.concat(JSON.parse(await readFile(flag("json"), "utf8")));
// --parity out.txt: the first mismatching line of each failure printed by text-parity.mjs, both versions.
if (flag("parity")) {
  for (const l of (await readFile(flag("parity"), "utf8")).split("\n")) {
    if (!l.startsWith('{"width"')) continue;
    const f = JSON.parse(l);
    for (const t of [f.chrome, f.xeet]) if (t) texts.push(t.replace(/[ \t]+$/, ""));
  }
}
const size = Number(flag("size", 15)), lh = Number(flag("lh", 20));
const css = flag("fallback", "bundled") === "bundled" ? await bundledFallbackCss() : "";
const lock = JSON.parse(await readFile(join(ROOT, "assets", "upstream.lock.json"), "utf8"));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const html = `<!DOCTYPE html><html lang="en" dir="ltr" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="${lock.stylesheet.url}"><style>${css}</style></head><body>${texts
  .map((t) => `<div style="width:4000px"><div class="${css ? "xeet-fallback " : ""}font-normal whitespace-pre-wrap" style="font-size:${size}px;line-height:${lh}px" dir="auto"><span class="w">${esc(t)}</span></div></div>`)
  .join("")}</body></html>`;

const browser = await launch();
const { page } = await newPage(browser, { width: 1000, dpr: 1 });
await setContentAs(page, html, "/i/widths");
const chrome = await page.evaluate(() => [...document.querySelectorAll(".w")].map((e) => e.getBoundingClientRect().width));
await browser.close();
const ours = JSON.parse(
  execFileSync(xeetBinary(), ["debug-text", "--width", "4000", "--size", String(size), "--lh", String(lh)], { input: JSON.stringify(texts) }).toString(),
);
let bad = 0;
for (let i = 0; i < texts.length; i++) {
  // Right-to-left text is right-aligned, so measure from the leftmost edge.
  const o = ours[i].lines.reduce((m, l) => Math.max(m, l.x + l.w), 0) - Math.min(...ours[i].lines.map((l) => l.x));
  const d = o - chrome[i];
  if (Math.abs(d) > 0.02) bad++;
  if (Math.abs(d) > 0.02 || args.includes("--all")) {
    const cps = [...texts[i]].map((c) => c.codePointAt(0).toString(16).toUpperCase()).join(" ");
    console.log(`${d >= 0 ? "+" : ""}${d.toFixed(3).padStart(8)}  chrome=${chrome[i].toFixed(3).padStart(8)}  ${JSON.stringify(texts[i])}  [${cps.slice(0, 60)}]`);
  }
}
console.log(`${bad} of ${texts.length} differ by more than 0.02 px`);
