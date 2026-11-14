#!/usr/bin/env node
// Replays a captured x.com page in Chrome exactly as the server rendered it
// (X's scripts are blocked) and reports the element chain and computed styles
// around the first post. Used to build and to re-validate the replica template.
//
//   node tools/oracle/replay.mjs assets/vendor/corpus/stripe.html [width] [theme]
import { readFile } from "node:fs/promises";
import { launch, newPage, setContentAs } from "./browser.mjs";

const [file, width = "600", theme = "light"] = process.argv.slice(2);
const html = await readFile(file, "utf8");
const browser = await launch();
const { page } = await newPage(browser, { width: Number(width), theme, dpr: 2 });
await setContentAs(page, html, "/i/replay");
const out = await page.evaluate((theme) => {
  document.documentElement.dataset.theme = theme;
  const art = document.querySelector("article");
  const chain = [];
  for (let el = art; el; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    chain.unshift({
      tag: el.tagName.toLowerCase(),
      cls: el.className?.toString?.() ?? "",
      attrs: [...el.attributes].filter((a) => !["class", "id", "style"].includes(a.name) && !a.name.startsWith("aria")).map((a) => `${a.name}=${a.value.slice(0, 40)}`).join(" "),
      rect: [r.x, r.y, r.width, r.height].map((v) => +v.toFixed(2)),
      font: `${cs.fontFamily.slice(0, 40)} ${cs.fontSize}/${cs.lineHeight} ${cs.fontWeight}`,
      color: cs.color, bg: cs.backgroundColor, smoothing: cs.webkitFontSmoothing,
    });
  }
  return { chain, articles: document.querySelectorAll("article").length, hidden: !!art?.closest("[hidden]") };
}, theme);
for (const [i, c] of out.chain.entries()) {
  console.log(`${"  ".repeat(Math.min(i, 12))}<${c.tag} class="${c.cls.slice(0, 200)}" ${c.attrs}> rect=${c.rect} font=${c.font} color=${c.color} bg=${c.bg} smoothing=${c.smoothing}`);
}
console.log(JSON.stringify({ articles: out.articles, hidden: out.hidden }));
await browser.close();
