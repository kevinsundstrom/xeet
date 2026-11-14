#!/usr/bin/env node
// Prints the laid-out geometry of one post from a captured page.
//
//   node tools/oracle/dump.mjs <captured.html> <articleIndex>
//        [--width 600] [--theme light] [--depth N] [--json out.json] [--shot out.png] [--images]
import { readFile, writeFile } from "node:fs/promises";
import { launch, newPage, setContentAs } from "./browser.mjs";
import { dumpGeometry } from "./geometry.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const [file, index = "0"] = args;
const width = Number(flag("width", 600));
const theme = flag("theme", "light");

const browser = await launch();
const { page } = await newPage(browser, {
  width, theme, dpr: Number(flag("dpr", 2)), allowImages: args.includes("--images"),
});
await setContentAs(page, await readFile(file, "utf8"), "/i/replay");
await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);

const geo = await page.evaluate(dumpGeometry, { selector: "article", index: Number(index) });
if (!geo) {
  console.error("no such article");
  process.exit(1);
}
if (flag("json")) await writeFile(flag("json"), JSON.stringify(geo, null, 1));
if (flag("shot")) {
  const el = (await page.$$("article"))[Number(index)];
  await el.screenshot({ path: flag("shot") });
}

const maxDepth = Number(flag("depth", 99));
const noise = /(hover|focus-visible|active|disabled|group-hover|aria-expanded|has-focus-visible)[:][^\s]+|transition[^\s]*|duration-\d+|outline-focus|cursor-[a-z-]+|\[&[^\s]*/g;
console.log(`article ${index}: ${geo.rect.w}x${geo.rect.h} at ${geo.rect.x},${geo.rect.y}`);
for (const b of geo.boxes) {
  if (b.depth > maxDepth) continue;
  const cls = b.cls.replace(noise, "").replace(/\s+/g, " ").trim();
  const extra = `${b.radius ? " r=" + b.radius : ""}${b.bg ? " bg=" + b.bg : ""}${b.border ? " border=" + b.border : ""}`;
  console.log(`${"  ".repeat(b.depth)}<${b.tag}> [${b.x},${b.y} ${b.w}x${b.h}]${extra} .${cls.slice(0, 150)}`);
}
console.log("--- text fragments ---");
for (const t of geo.texts.sort((a, b) => a.y - b.y || a.x - b.x)) {
  console.log(`[${t.x},${t.y} ${t.w}x${t.h}] ${t.size}px/${t.weight} ${t.color} ${JSON.stringify(t.text.slice(0, 110))}`);
}
await browser.close();
