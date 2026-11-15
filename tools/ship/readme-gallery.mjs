#!/usr/bin/env node
// Renders the site's 17 hard-tweet examples (app/_lib/hard.js) in BOTH light and
// dark themes (`docs/gallery/<slug>-{light,dark}.webp`) and writes
// `docs/GALLERY.md` using GitHub `<picture>` `(prefers-color-scheme: dark)`
// sources so GitHub renders dark cards in dark mode and light cards in light
// mode without overwhelming `README.md`.
//
//   node tools/ship/readme-gallery.mjs [--bin target/lead/fast/xeet]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HARD, ROOT, buildPost } from "./hard-posts.mjs";

const OUT = join(ROOT, "docs/gallery");
const GALLERY_MD = join(ROOT, "docs/GALLERY.md");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const defaultBin = existsSync(join(ROOT, "target/release/xeet"))
  ? join(ROOT, "target/release/xeet")
  : join(ROOT, "target/lead/fast/xeet");
const BIN = flag("--bin", defaultBin);

mkdirSync(join(ROOT, "tmp"), { recursive: true });
const SCRATCH = mkdtempSync(join(ROOT, "tmp/readme-gallery."));
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) {
  if (f.endsWith(".webp")) rmSync(join(OUT, f));
}

function renderPair(post, slug, surface, width) {
  for (const theme of ["light", "dark"]) {
    const png = join(SCRATCH, `${slug}-${theme}.png`);
    const out = join(OUT, `${slug}-${theme}.webp`);
    execFileSync(
      BIN,
      ["render", "-", "--surface", surface, "--width", String(width), "--theme", theme, "--dpr", "2", "-o", png],
      { input: JSON.stringify(post), stdio: ["pipe", "inherit", "inherit"] },
    );
    execFileSync("cwebp", ["-quiet", "-q", "88", "-m", "6", "-sharp_yuv", png, "-o", out], { stdio: "inherit" });
  }
  console.log(`docs/gallery/${slug}-{light,dark}.webp`.padEnd(46), `${surface} @ ${width}`);
}

const pictureTag = (relDir, slug, alt, widthAttr = "") =>
  `<picture>` +
  `<source media="(prefers-color-scheme: dark)" srcset="${relDir}/${slug}-dark.webp">` +
  `<source media="(prefers-color-scheme: light)" srcset="${relDir}/${slug}-light.webp">` +
  `<img src="${relDir}/${slug}-light.webp" alt="${alt.replace(/"/g, "&quot;")}"${widthAttr ? ` width="${widthAttr}"` : ""}>` +
  `</picture>`;

const rows = [];
const regular = [];
for (const item of HARD) {
  const post = buildPost(item);
  if (item.id.startsWith("duo-")) {
    renderPair(post, `${item.id}-web`, "web-timeline", 600);
    renderPair(post, `${item.id}-ios`, "ios-timeline", 382);
    rows.push(
      `<tr>\n<td width="50%" valign="top">\n${pictureTag("gallery", `${item.id}-web`, `${item.title} (web-timeline)`)}\n<br><b>${item.title} — Web (<code>web-timeline · 600</code>).</b> ${item.why}\n</td>\n` +
        `<td width="50%" valign="top">\n${pictureTag("gallery", `${item.id}-ios`, `${item.title} (ios-timeline)`, 382)}\n<br><b>iOS (<code>ios-timeline · 382</code>).</b> <a href="${item.url}">Source post</a>\n</td>\n</tr>`,
    );
  } else {
    renderPair(post, item.id, "web-timeline", 600);
    regular.push(item);
  }
}

for (let i = 0; i < regular.length; i += 2) {
  const left = regular[i];
  const right = regular[i + 1];
  const cell = (it) =>
    it
      ? `<td width="50%" valign="top">\n${pictureTag("gallery", it.id, it.title)}\n<br><b>${it.title}.</b> ${it.why} <a href="${it.url}">Source</a>\n</td>`
      : `<td width="50%" valign="top"></td>`;
  rows.push(`<tr>\n${cell(left)}\n${cell(right)}\n</tr>`);
}

const galleryDoc = `# Visual Gallery

Every image below is rendered directly by \`xeet\` from [\`app/_lib/hard.js\`](../app/_lib/hard.js) via [\`tools/ship/readme-gallery.mjs\`](../tools/ship/readme-gallery.mjs) in both \`light\` and \`dark\` themes — GitHub automatically shows the theme matching your appearance setting. Try or customize any post interactively at **[xeet-rs.vercel.app](https://xeet-rs.vercel.app)**.

<table>
${rows.join("\n")}
</table>
`;

writeFileSync(GALLERY_MD, galleryDoc);
rmSync(SCRATCH, { recursive: true, force: true });
console.log(`wrote docs/GALLERY.md (${HARD.length} examples, light + dark)`);
