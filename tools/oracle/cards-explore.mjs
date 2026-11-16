// Exploration: render a captured x.com page in Chrome at a given width, then
// dump the geometry of the attachment region of one post. Development only.
//
//   node tools/oracle/cards-explore.mjs assets/vendor/corpus/github.html 0 390
//
// Prints, for every element in the attachment subtree: tag, class list, the
// border box in page coordinates, the computed styles that matter, and the
// text if any. Set XEET_SHOT=<dir> to write a screenshot.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, newPage, setContentAs, ROOT } from "./browser.mjs";

const [file, indexArg, widthArg] = process.argv.slice(2);
const index = Number(indexArg ?? 0);
const width = Number(widthArg ?? 390);
const theme = process.env.THEME ?? "light";

const browser = await launch();
const { page } = await newPage(browser, { width, height: 1400, dpr: 1, theme });

const html = await readFile(join(ROOT, file), "utf8");
await setContentAs(page, html, "/i/cards-explore");

const out = await page.evaluate((idx) => {
  const arts = [...document.querySelectorAll("article")];
  const visible = (el) => {
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.display === "none" || s.visibility === "hidden") return false;
    }
    return el.getBoundingClientRect().width > 0;
  };
  const art = idx < 0 ? arts.find(visible) : arts[idx];
  if (!art) return { error: `no article ${idx}`, count: arts.length };
  // The attachment region is the first descendant that only holds attachments.
  const att = art.querySelector(":scope .empty\\:hidden") ?? art;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(3), y: +r.y.toFixed(3), w: +r.width.toFixed(3), h: +r.height.toFixed(3) };
  };
  const cs = (el, props) => {
    const s = getComputedStyle(el);
    const o = {};
    for (const p of props) o[p] = s.getPropertyValue(p);
    return o;
  };
  const rows = [];
  const walk = (el, depth) => {
    if (depth > 14) return;
    const st = cs(el, [
      "aspect-ratio",
      "border-radius",
      "corner-shape",
      "border-top-width",
      "border-top-color",
      "background-color",
      "object-fit",
      "font-size",
      "line-height",
      "font-weight",
      "color",
      "padding",
      "gap",
    ]);
    const r = el.getBoundingClientRect();
    rows.push({
      depth,
      tag: el.tagName.toLowerCase(),
      cls: (el.getAttribute("class") ?? "").slice(0, 160),
      src: (el.getAttribute("src") ?? "").slice(0, 60),
      box: box(el),
      st,
      text: el.children.length === 0 ? (el.textContent ?? "").trim().slice(0, 80) : "",
    });
    for (const c of el.children) walk(c, depth + 1);
  };
  walk(att, 0);
  // The post column that holds the text, so we know the slot width.
  const col = art.querySelector(":scope > div > div:nth-child(2)");
  return { colBox: col ? box(col) : null, artBox: box(art), rows };
}, index);

const pad = (s, n) => String(s).padEnd(n);
console.log("article box", JSON.stringify(out.artBox), "column", JSON.stringify(out.colBox));
for (const r of out.rows ?? []) {
  const st = r.st;
  const bits = [];
  if (st["aspect-ratio"] !== "auto") bits.push(`ar=${st["aspect-ratio"]}`);
  if (st["border-radius"] !== "0px") bits.push(`r=${st["border-radius"]}`);
  if (st["corner-shape"] && st["corner-shape"] !== "round") bits.push(`cs=${st["corner-shape"]}`);
  if (st["border-top-width"] !== "0px") bits.push(`bd=${st["border-top-width"]} ${st["border-top-color"]}`);
  bits.push(`bg=${st["background-color"]}`);
  if (st["font-size"] !== "16px" || st["line-height"] !== "normal") bits.push(`f=${st["font-size"]}/${st["line-height"]}w${st["font-weight"]}`);
  if (st["padding"] !== "0px") bits.push(`p=${st["padding"]}`);
  if (st["gap"] && st["gap"] !== "normal") bits.push(`gap=${st["gap"]}`);
  if (st["object-fit"] !== "fill") bits.push(`of=${st["object-fit"]}`);
  console.log(
    `${"  ".repeat(r.depth)}${pad(r.tag, 7)} ${pad(JSON.stringify(r.box).replace(/"/g, ""), 44)} ${bits.join(" ")} ${r.text ? "· " + r.text : ""} :: ${r.cls}`,
  );
  if (out.error) console.log(out.error);
}

if (process.env.XEET_SHOT) {
  const el = await page.evaluateHandle((idx) => document.querySelectorAll("article")[idx], index);
  const handle = el.asElement();
  if (handle) await handle.screenshot({ path: join(process.env.XEET_SHOT, `art${index}-${width}.png`) });
}
await browser.close();
