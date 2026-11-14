#!/usr/bin/env node
// Renders the site's 17 hard-tweet examples (web/js/hard.js) in BOTH light and
// dark themes (`docs/gallery/<slug>-{light,dark}.webp`) and writes
// `docs/GALLERY.md` using GitHub `<picture>` `(prefers-color-scheme: dark)`
// sources so GitHub renders dark cards in dark mode and light cards in light
// mode without overwhelming `README.md`.
//
//   node tools/ship/readme-gallery.mjs [--bin target/lead/fast/xeet]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARD } from "../../app/_lib/hard.js";
import { vercelAvatarBase64 } from "../../app/_lib/vercel-avatar.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB = join(ROOT, "app/_assets");
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

const AVATARS = {
  NASAGoddard: "avatars/NASAGoddard.jpg",
  pizzahut: "avatars/pizzahut.jpg",
  MerriamWebster: "avatars/MerriamWebster.png",
  cursor_ai: "avatars/cursor_ai.jpg",
  rauchg: "avatars/rauchg.jpg",
  mihar_22: "avatars/mihar_22.jpg",
  bscholl: "avatars/bscholl.jpg",
  kyunbit: "avatars/kyunbit.jpg",
  anabology: "avatars/anabology.jpg",
  vineettiruvadi: "avatars/vineettiruvadi.jpg",
  zackdfilms1: "avatars/zackdfilms1.jpg",
  adamfuhrer: "avatars/adamfuhrer.jpg",
  justinbieber: "avatars/justinbieber.jpg",
  ciguleva: "avatars/ciguleva.jpg",
  espn: "avatars/espn.jpg",
  NFL: "avatars/NFL.jpg",
  karpathy: "avatars/karpathy.jpg",
  mattpocockuk: "avatars/mattpocockuk.jpg",
  jack: "avatars/jack.jpg",
};

const asset = (rel) => readFileSync(join(WEB, rel.replace(/^\.\//, ""))).toString("base64");

function withAvatars(post) {
  if (!post) return post;
  const out = { ...post };
  const handle = out.author?.handle;
  if (handle && !out.author.avatar) {
    const avatar = handle === "vercel" ? vercelAvatarBase64() : AVATARS[handle] ? asset(AVATARS[handle]) : null;
    if (avatar) out.author = { ...out.author, avatar };
  }
  if (Array.isArray(out.media)) {
    out.media = out.media.map((m) => {
      const sh = m.sourceAuthor?.handle;
      if (sh && !m.sourceAuthor.avatar && AVATARS[sh]) {
        return { ...m, sourceAuthor: { ...m.sourceAuthor, avatar: asset(AVATARS[sh]) } };
      }
      return m;
    });
  }
  if (out.quote) out.quote = withAvatars(out.quote);
  return out;
}

function buildPost(item) {
  const post = withAvatars({ ...item.post, links: { ...item.post.links } });
  for (const [url, path] of Object.entries(item.assets?.cards ?? {})) {
    if (post.links[url]?.image) {
      post.links[url] = { ...post.links[url], image: { ...post.links[url].image, data: asset(path) } };
    }
  }
  if (item.assets?.media?.length && post.media?.length) {
    post.media = post.media.map((m, i) => (item.assets.media[i] ? { ...m, data: asset(item.assets.media[i]) } : m));
  }
  if (item.assets?.quoteMedia?.length && post.quote?.media?.length) {
    post.quote = {
      ...post.quote,
      media: post.quote.media.map((m, i) =>
        item.assets.quoteMedia[i] ? { ...m, data: asset(item.assets.quoteMedia[i]) } : m,
      ),
    };
  }
  if (item.assets?.affiliateBadge && post.author?.affiliate) {
    post.author = { ...post.author, affiliate: { ...post.author.affiliate, badge: asset(item.assets.affiliateBadge) } };
  }
  if (item.assets?.quoteAffiliateBadge && post.quote?.author?.affiliate) {
    post.quote = {
      ...post.quote,
      author: {
        ...post.quote.author,
        affiliate: { ...post.quote.author.affiliate, badge: asset(item.assets.quoteAffiliateBadge) },
      },
    };
  }
  return post;
}

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

Every image below is rendered directly by \`xeet\` from [\`app/_lib/hard.js\`](../app/_lib/hard.js) via [\`tools/ship/readme-gallery.mjs\`](../tools/ship/readme-gallery.mjs) in both \`light\` and \`dark\` themes — GitHub automatically shows the theme matching your appearance setting. Try or customize any post interactively at **[xeet.vercel.dev](https://xeet.vercel.dev)**.

<table>
${rows.join("\n")}
</table>
`;

writeFileSync(GALLERY_MD, galleryDoc);
rmSync(SCRATCH, { recursive: true, force: true });
console.log(`wrote docs/GALLERY.md (${HARD.length} examples, light + dark)`);
