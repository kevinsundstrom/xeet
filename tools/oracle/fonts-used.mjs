#!/usr/bin/env node
// Asks Chrome which font it actually uses for each sample, under X's real
// font stack. This is how fallback decisions are learned rather than guessed.
//
//   node tools/oracle/fonts-used.mjs "text one" "text two" ...
//   node tools/oracle/fonts-used.mjs            # built-in probe set
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, newPage, setContentAs, bundledFallbackCss, ROOT } from "./browser.mjs";

const PROBES = [
  "مرحبا بالعالم", "שלום עולם", "𝚖𝚘𝚗𝚘𝚜𝚙𝚊𝚌𝚎", "𝕏", "𝗯𝗼𝗹𝗱 𝘀𝗮𝗻𝘀", "𝘪𝘵𝘢𝘭𝘪𝘤", "𝓼𝓬𝓻𝓲𝓹𝓽", "𝐛𝐨𝐥𝐝", "𝔣𝔯𝔞𝔨𝔱𝔲𝔯",
  "ᴀʙᴄ", "ＡＢＣ", "ⓐⓑⓒ", "x²³", "Привет", "Γειά", "中文", "日本語かな", "한국어", "ไทย", "हिन्दी",
  "①②③", "▁▂▃", "░▒▓", "⠿", "ℹ", "‼", "⁉", "〰", "㊗", "∑∫√", "←→↔", "✦✧", "❯", "⚙", "⚠",
];
// --fallback bundled: put xeet's embedded fallback fonts in the stack (see browser.mjs).
const argv = process.argv.slice(2);
const bundled = argv.includes("--fallback") && argv[argv.indexOf("--fallback") + 1] === "bundled";
const texts = argv.filter((a, i) => a !== "--fallback" && argv[i - 1] !== "--fallback");
const samples = texts.length ? texts : PROBES;
const css = bundled ? await bundledFallbackCss() : "";
const lock = JSON.parse(await readFile(join(ROOT, "assets", "upstream.lock.json"), "utf8"));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const html = `<!DOCTYPE html><html lang="en" dir="ltr" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="${lock.stylesheet.url}"><style>${css}</style></head><body>${samples
  .map((s) => `<div class="text-body font-normal whitespace-pre-wrap${css ? " xeet-fallback" : ""}" dir="auto"><span class="probe">${esc(s)}</span></div>`)
  .join("")}</body></html>`;

const browser = await launch();
const { page } = await newPage(browser, { width: 600, dpr: 1 });
await setContentAs(page, html, "/i/fonts-used");
const cdp = await page.context().newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");
const widths = await page.evaluate(() => [...document.querySelectorAll(".probe")].map((e) => +e.getBoundingClientRect().width.toFixed(3)));
const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".probe" });
for (const [i, nodeId] of nodeIds.entries()) {
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  const used = fonts.map((f) => `${f.familyName || "?"}${f.isCustomFont ? " (web)" : ""} ×${f.glyphCount}`).join(", ");
  console.log(`${JSON.stringify(samples[i]).padEnd(22)} w=${String(widths[i]).padEnd(9)} ${used}`);
}
await browser.close();
