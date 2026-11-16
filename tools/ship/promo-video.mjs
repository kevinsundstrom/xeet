#!/usr/bin/env node
// Composes the animated release video and Open Graph card from xeet's own output.
//
//   cargo build --release -p xeet-cli --bin xeet-render
//   node tools/ship/promo-video.mjs [--bin target/release/xeet-render] [--timings timings.json]
//
// Writes:
//   public/og/xeet-<sha256>.mp4     1920×1080 H.264 @30fps, og:video & X release clip
//   app/opengraph-image.png         1200×630 @2x Open Graph / X card image
//   app/_generated/og-video.js      the video's hashed URL, read by app/layout.jsx

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { cpus, homedir, loadavg } from "node:os";
import { join } from "node:path";
import { highlight } from "../../app/_lib/highlight.js";
import { HARD, ROOT, buildPost } from "./hard-posts.mjs";
import { simulate } from "./tetris.mjs";

const FPS = 30;
const W = 1920;
const H = 1080;

// --- 1. Render everything, timed --------------------------------------------

const argv = process.argv.slice(2);
const binFlag = argv.indexOf("--bin");
const BIN = binFlag >= 0 ? argv[binFlag + 1] : join(ROOT, "target", "release", "xeet-render");

const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const EXPORT = flagValue("--export-requests");
const TIMINGS_FILE = flagValue("--timings");
const PREVIEW_DIR = flagValue("--preview-dir");
const TIMINGS = TIMINGS_FILE ? JSON.parse(readFileSync(TIMINGS_FILE, "utf8")) : null;
const requestKey = (post, options) => createHash("sha256").update(JSON.stringify({ post, options })).digest("hex");
if (TIMINGS) console.log(`timings from ${TIMINGS_FILE}: ${JSON.stringify(TIMINGS.meta)}`);

let server = null;
const pending = new Map();
let nextId = 1;
function ensureServer() {
  if (server) return server;
  server = spawn(BIN, ["serve", "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
  createInterface({ input: server.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  });
  return server;
}
function call(request) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ensureServer().stdin.write(`${JSON.stringify({ id, ...request })}\n`);
  });
}
async function renderNative(post, options) {
  const reply = await call({ op: "render", post, options, geometry: false });
  if (reply.error) throw new Error(`xeet-render: ${reply.error.message}`);
  return { png: new Uint8Array(Buffer.from(reply.png, "base64")), ms: reply.ms.render };
}

const posts = HARD.map((item) => ({ item, post: buildPost(item) }));
const byId = (id) => posts.find((p) => p.item.id === id);

async function waitForQuiet(what) {
  const limit = Math.max(2, cpus().length / 2);
  const deadline = Date.now() + Number(flagValue("--wait-minutes") ?? 45) * 60_000;
  let said = 0;
  while (loadavg()[0] > limit) {
    if (Date.now() > deadline) {
      server?.stdin.end();
      throw new Error(`the machine stayed busy (load ${loadavg()[0].toFixed(1)}, limit ${limit}); not timing ${what}`);
    }
    if (Date.now() - said > 60_000) {
      console.log(`waiting to time ${what}: load average ${loadavg()[0].toFixed(1)} > ${limit}`);
      said = Date.now();
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(`timing ${what} at load ${loadavg()[0].toFixed(1)}`);
}

const CACHE = join(ROOT, "tmp", "promo-cache");
mkdirSync(CACHE, { recursive: true });
const FRESH = argv.includes("--fresh");
const binStamp = (() => {
  if (TIMINGS || EXPORT) return "";
  const st = statSync(BIN);
  return `${st.size}:${st.mtimeMs}`;
})();
const cacheKey = (post, options) =>
  createHash("sha256").update(binStamp).update(JSON.stringify({ post, options })).digest("hex");
const cached = (post, options) => {
  if (FRESH) return null;
  const file = join(CACHE, `${cacheKey(post, options)}.json`);
  try {
    const { ms, png } = JSON.parse(readFileSync(file, "utf8"));
    return { ms, png: new Uint8Array(Buffer.from(png, "base64")) };
  } catch {
    return null;
  }
};

async function timedRender(post, options) {
  if (TIMINGS) {
    const t = TIMINGS.results[requestKey(post, options)];
    if (!t) throw new Error(`${TIMINGS_FILE} has no timing for this request; re-export and re-time`);
    return { ms: t.ms, png: new Uint8Array(Buffer.from(t.png, "base64")) };
  }
  const hit = cached(post, options);
  if (hit) return hit;
  let best = Infinity;
  let png;
  for (let k = 0; k < 7; k++) {
    const r = await renderNative(post, options);
    png ??= r.png;
    best = Math.min(best, r.ms);
  }
  writeFileSync(join(CACHE, `${cacheKey(post, options)}.json`), JSON.stringify({ ms: best, png: Buffer.from(png).toString("base64") }));
  return { png, ms: best };
}
const existsCache = (post, options) => {
  try {
    statSync(join(CACHE, `${cacheKey(post, options)}.json`));
    return true;
  } catch {
    return false;
  }
};
const allCached = (requests) => TIMINGS || EXPORT || (!FRESH && requests.every(([post, options]) => existsCache(post, options)));

// Retina @2x (764×1142 px — supersampled above both the 860 px 1080p video slot
// and the 1124 px @2x Open Graph card slot, matching the @2x code examples).
const GAME = { surface: "ios-detail", width: 382, theme: "dark", dpr: 2 };
const AUTHOR = byId("rauchg-math-nested").post.author;
const game = simulate();
const gamePost = (f) => ({
  text: f.text,
  author: AUTHOR,
  createdAt: "2026-11-15T17:00:00.000Z",
  now: "2026-11-15T17:05:00.000Z",
  counts: { replies: f.placed, reposts: f.lines, likes: f.score, views: 1000 + f.tick * 137, bookmarks: 0 },
});
if (!allCached(game.frames.map((f) => [gamePost(f), GAME]))) {
  await renderNative(gamePost(game.frames[0]), GAME);
  await waitForQuiet("the game");
}

const reel = [];
if (!EXPORT) for (const f of game.frames) reel.push({ f, ...(await timedRender(gamePost(f), GAME)) });
const fastest = reel.length ? Math.min(...reel.map((r) => r.ms)) : 0;
const reelTotal = reel.reduce((sum, r) => sum + r.ms, 0);
if (!EXPORT) {
  console.log(
    `game: ${reel.length} frames in ${reelTotal.toFixed(0)} ms, fastest ${fastest.toFixed(2)} ms · ${JSON.stringify(game.stats)}`,
  );
}

const CODE = [
  {
    lang: "CLI",
    hl: "sh",
    code: `# Install the self-contained native binary
npm i -g @xeet/cli

# Resolve a live x.com URL and render to Retina PNG
xeet resolve https://x.com/jack/status/20 --media \\
  | xeet render - --width 600 --theme dark --dpr 2 -o jack.png`,
    example: "jack-20",
    options: { surface: "web-timeline", width: 600, theme: "dark", dpr: 2 },
  },
  {
    lang: "TypeScript",
    hl: "js",
    code: `import { loadXeet } from "@xeet/core/node";

const xeet = await loadXeet();
const { post } = await xeet.resolve(
  "https://x.com/NASAGoddard/status/928356699043491842",
  { media: true },
);

const { png, report } = xeet.render(post, {
  surface: "ios-timeline",
  width: 382,
  theme: "dark",
  dpr: 3,
});`,
    example: "nasa",
    options: { surface: "ios-timeline", width: 382, theme: "dark", dpr: 3 },
  },
  {
    lang: "Rust",
    hl: "rust",
    code: `use xeet_core::model::{Post, RenderOptions, Surface, Theme};

let post: Post = serde_json::from_str(&json)?;
let options = RenderOptions {
    surface: Surface::WebDetail,
    width: 390.0,
    theme: Theme::Light,
    dpr: 2.0,
    ..RenderOptions::default()
};
let (png, report) =
    xeet_core::render::render(&post, &options)?;`,
    example: "poll",
    options: { surface: "web-detail", width: 390, theme: "light", dpr: 2 },
  },
];
if (EXPORT) {
  const requests = [...game.frames.map((f) => [gamePost(f), GAME]), ...CODE.map((c) => [byId(c.example).post, c.options])];
  writeFileSync(EXPORT, requests.map(([post, options]) => JSON.stringify({ key: requestKey(post, options), post, options })).join("\n") + "\n");
  console.log(`wrote ${requests.length} render requests to ${EXPORT}`);
  process.exit(0);
}
if (!allCached(CODE.map((c) => [byId(c.example).post, c.options]))) await waitForQuiet("the code slides");
for (const c of CODE) {
  if (!TIMINGS && !existsCache(byId(c.example).post, c.options)) await renderNative(byId(c.example).post, c.options);
  Object.assign(c, await timedRender(byId(c.example).post, c.options));
}

// --- 2. Lay out & animate scenes in Chromium --------------------------------

const font = (name) =>
  `data:font/woff2;base64,${readFileSync(join(ROOT, "app/_assets/fonts", name)).toString("base64")}`;
const pngUrl = (png) => `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
const pngSize = (png) => {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
};
const fmtMs = (ms) => `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutQuart = (t) => 1 - (1 - clamp01(t)) ** 4;
const easeInOutCubic = (t) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

const TEMPLATE = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Serif; src: url(${font("GeistSerif.woff2")}); font-weight: 100 900; }
@font-face { font-family: Sans; src: url(${font("GeistSans.woff2")}); font-weight: 100 900; }
@font-face { font-family: Mono; src: url(${font("GeistMono.woff2")}); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
html, body { width: ${W}px; height: ${H}px; background: #000; color: #fff; overflow: hidden; -webkit-font-smoothing: antialiased; }
section.scene { position: absolute; inset: 0; opacity: 0; pointer-events: none; will-change: transform, opacity; }
.dim { color: rgba(255,255,255,0.56); }
.mono { font-family: Mono; letter-spacing: -0.01em; }

#intro, #outro { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
#intro h1 { font: 400 200px/1 Serif; letter-spacing: -0.02em; }
#intro p { font: 400 52px/1.3 Serif; margin-top: 28px; }
#intro .mono { font-size: 28px; margin-top: 40px; }

/* Code showcase: fixed top tab rail + top-aligned code card & rendered preview card. */
#code .tabs-rail {
  position: absolute;
  left: 136px;
  top: 162px;
  width: 936px;
  display: flex;
  gap: 48px;
  border-bottom: 1px solid rgba(255,255,255,0.14);
  font: 400 30px/1 Sans;
  letter-spacing: -0.01em;
}
#code .tabs-rail span[data-tab] {
  padding: 0 2px 18px;
  color: rgba(255,255,255,0.38);
}
#code .tab-line {
  position: absolute;
  left: 0;
  bottom: -1px;
  height: 2px;
  background: #fff;
  border-radius: 2px;
}
#code .code-box {
  position: absolute;
  left: 136px;
  top: 244px;
  width: 936px;
  border: 1px solid rgba(255,255,255,0.22);
  border-radius: 18px;
  background: rgba(255,255,255,0.04);
  overflow: hidden;
}
#code .code-layer {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  padding: 38px 44px;
  font: 400 23.5px/1.6 Mono;
  white-space: pre;
}
#code .out-stage {
  position: absolute;
  left: 1148px;
  top: 244px;
  width: 636px;
}
#code .out-layer {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
}
#code .cap {
  margin-top: 26px;
  font: 400 24px/1 Mono;
  letter-spacing: -0.01em;
}
.t-comment { color: #8b949e; font-style: italic; } .t-keyword { color: #ff7b72; } .t-string { color: #a5d6ff; }
.t-number { color: #79c0ff; } .t-fn { color: #d2a8ff; } .t-prop { color: #ffa657; } .t-type { color: #7ee787; } .t-punct { color: #c9d1d9; }

#reel .top, #reel .bottom { position: absolute; left: 120px; right: 120px; display: flex; justify-content: space-between; align-items: baseline; }
#reel .top { top: 56px; font: 400 26px/1 Mono; }
#reel .bottom { bottom: 64px; }
#reel .bottom .who { font: 400 24px/1 Mono; }
#reel .bottom .ms { font: 400 64px/1 Mono; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
#reel .frame { position: absolute; left: 0; right: 0; top: 110px; bottom: 110px; display: flex; align-items: center; justify-content: center; }
#reel .bar { position: absolute; left: 120px; width: 440px; bottom: 44px; height: 3px; background: rgba(255,255,255,0.16); border-radius: 3px; overflow: hidden; }
#reel .bar span { display: block; height: 100%; background: #fff; }

#outro .big { font: 400 150px/1 Mono; letter-spacing: -0.04em; }
#outro .line { font: 400 46px/1.3 Serif; margin-top: 34px; }
#outro .install { font: 400 30px/1 Mono; margin-top: 70px; display: flex; gap: 56px; }

#cta {
  display: flex;
  align-items: center;
  justify-content: center;
}
#cta .prompt {
  display: inline-flex;
  align-items: center;
  font: 400 76px/1 Mono;
  letter-spacing: -0.015em;
  color: #f2f2f2;
}
#cta .typed {
  white-space: pre;
}
#cta .caret {
  display: inline-block;
  width: 0.56em;
  height: 1.12em;
  margin-left: 0.14em;
  background: #ededed;
  transform: translateY(0.03em);
}
#cta .caret.off {
  opacity: 0;
}

#og { position: absolute; inset: 0; display: none; }
body[data-mode="og"] section.scene { display: none; }
body[data-mode="og"] #og { display: block; }
#og .left { position: absolute; left: 64px; top: 0; bottom: 0; width: 470px; display: flex; flex-direction: column; justify-content: center; }
#og h1 { font: 400 124px/1 Serif; letter-spacing: -0.02em; }
#og p { font: 400 33px/1.25 Serif; margin-top: 18px; }
#og .mono { font-size: 19px; margin-top: 28px; }
#og .url { font: 400 22px/1 Mono; margin-top: 42px; }
#og img { position: absolute; }
</style></head><body>
<section class="scene" id="intro">
  <h1 id="introTitle">xeet</h1>
  <p id="introSub">X posts rendered to PNG, without a browser.</p>
  <div class="mono dim" id="introMeta">Rust · WebAssembly · TypeScript · CLI</div>
</section>

<section class="scene" id="code">
  <div class="tabs-rail" id="tabsRail">
    <span data-tab="0">CLI</span>
    <span data-tab="1">TypeScript</span>
    <span data-tab="2">Rust</span>
    <div class="tab-line" id="tabLine"></div>
  </div>
  <div class="code-box" id="codeBox">
    <div class="code-layer" id="codeA"></div>
    <div class="code-layer" id="codeB"></div>
  </div>
  <div class="out-stage" id="outStage">
    <div class="out-layer" id="outA"><img id="imgA"><div class="cap dim" id="capA"></div></div>
    <div class="out-layer" id="outB"><img id="imgB"><div class="cap dim" id="capB"></div></div>
  </div>
</section>

<section class="scene" id="reel">
  <div class="top"><span class="dim">Tetris · every frame is a post</span><span id="reelCount"></span></div>
  <div class="frame"><img id="reelImg"></div>
  <div class="bottom"><span class="who dim" id="reelWho"></span><span class="ms" id="reelMs"></span></div>
  <div class="bar"><span id="reelBar"></span></div>
</section>

<section class="scene" id="outro">
  <div class="big" id="outroBig"></div>
  <div class="line dim" id="outroLine"></div>
  <div class="install" id="outroInstall"><span>npm i @xeet/core</span><span class="dim">·</span><span>npm i -g @xeet/cli</span></div>
</section>

<section class="scene" id="cta">
  <div class="prompt"><span class="typed" id="ctaText"></span><span class="caret" id="ctaCaret"></span></div>
</section>

<section id="og">
  <div class="left">
    <h1>xeet</h1>
    <p>X posts rendered to PNG, without a browser.</p>
    <div class="mono dim">Rust · WebAssembly · TypeScript · CLI</div>
    <div class="url dim">xeet-rs.vercel.app</div>
  </div>
  <div id="ogCards"></div>
</section>
</body></html>`;

const require = createRequire(join(ROOT, "tools/package.json"));
const { chromium } = require("playwright-core");
const cacheDir = join(homedir(), "Library/Caches/ms-playwright");
const shellDir = readdirSync(cacheDir).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? join(cacheDir, shellDir, "chrome-mac/headless_shell"),
});

mkdirSync(join(ROOT, "tmp"), { recursive: true });
const SCRATCH = mkdtempSync(join(ROOT, "tmp/promo-video."));
mkdirSync(join(SCRATCH, "slides"));
mkdirSync(join(SCRATCH, "frames"));

const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.setContent(TEMPLATE);
await page.evaluate(() => document.fonts.ready);

const frameStyle = (displayW, cssW) => {
  const k = displayW / cssW;
  const px = (n) => `${(n * k).toFixed(2)}px`;
  return {
    borderRadius: px(16),
    boxShadow: `0 0 0 ${px(1)} rgba(255,255,255,0.22), 0 0 0 ${px(7)} #000, 0 0 0 ${px(8)} rgba(255,255,255,0.08)`,
  };
};

const fit = (png, maxW, maxH) => {
  const { w, h } = pngSize(png);
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: Math.round(w * k), h: Math.round(h * k) };
};

// Prepare code slide metrics (exact tab underline positions & natural code-box heights).
const codeSlides = [];
for (const [idx, c] of CODE.entries()) {
  const html = highlight(c.code, c.hl);
  const size = fit(c.png, 620, 680);
  const src = pngUrl(c.png);
  const cap = `${c.options.surface} · ${c.options.width} · rendered in ${fmtMs(c.ms)}`;
  const frame = frameStyle(size.w, c.options.width);
  const metrics = await page.evaluate(
    ({ idx, html }) => {
      const codeEl = document.getElementById("codeA");
      codeEl.innerHTML = html;
      const tabEl = document.querySelector(`[data-tab="${idx}"]`);
      return {
        boxH: codeEl.scrollHeight,
        tabX: tabEl.offsetLeft,
        tabW: tabEl.offsetWidth,
      };
    },
    { idx, html },
  );
  // Keep the whole (tabs + max(codeBox, previewCard + caption)) ensemble optically
  // centered on the 1080p canvas while preserving exact top-edge alignment at y=244.
  const ensembleH = (244 - 162) + Math.max(metrics.boxH, size.h + 50);
  const centerOffsetY = Math.round((H - ensembleH) / 2 - 162);
  codeSlides.push({ ...c, html, size, src, cap, frame, ...metrics, centerOffsetY });
}

await page.evaluate(
  ({ big, line }) => {
    document.getElementById("outroBig").textContent = big;
    document.getElementById("outroLine").textContent = line;
  },
  {
    big: `${reel.length} frames in ${reelTotal >= 1000 ? `${(reelTotal / 1000).toFixed(2)} s` : fmtMs(reelTotal)}`,
    line: `Every frame a post, rendered in as little as ${fmtMs(fastest)}. Native Rust. No browser.`,
  },
);

const decodeAll = () =>
  page.evaluate(() => Promise.all([...document.querySelectorAll("img")].map((i) => (i.src ? i.decode().catch(() => {}) : null))));

let slideNo = 0;
const timeline = [];
async function shoot(frames = 1, previewName = null) {
  await decodeAll();
  const file = join(SCRATCH, "slides", `${String(slideNo++).padStart(4, "0")}.png`);
  await page.screenshot({ path: file });
  if (PREVIEW_DIR && previewName) {
    mkdirSync(PREVIEW_DIR, { recursive: true });
    writeFileSync(join(PREVIEW_DIR, previewName), readFileSync(file));
  }
  timeline.push({ file, frames: Math.max(1, Math.round(frames)) });
}

async function setIntroState({ sceneOpacity = 1, sceneScale = 1, t = 1 }) {
  await page.evaluate(
    ({ sceneOpacity, sceneScale, t }) => {
      const clamp = (v) => Math.max(0, Math.min(1, v));
      const ease = (v) => 1 - (1 - clamp(v)) ** 4;
      for (const s of document.querySelectorAll("section.scene")) {
        if (s.id !== "intro") s.style.opacity = "0";
      }
      const intro = document.getElementById("intro");
      intro.style.opacity = String(sceneOpacity);
      intro.style.transform = `scale(${sceneScale.toFixed(4)})`;

      const t1 = ease(t / 0.6);
      const t2 = ease((t - 0.16) / 0.65);
      const t3 = ease((t - 0.32) / 0.68);
      const apply = (id, p, dy) => {
        const el = document.getElementById(id);
        el.style.opacity = String(p);
        el.style.transform = `translateY(${((1 - p) * dy).toFixed(2)}px)`;
      };
      apply("introTitle", t1, 22);
      apply("introSub", t2, 18);
      apply("introMeta", t3, 14);
    },
    { sceneOpacity, sceneScale, t },
  );
}

async function mountCodeLayers(aIdx, bIdx = null) {
  const a = codeSlides[aIdx];
  const b = bIdx !== null ? codeSlides[bIdx] : null;
  await page.evaluate(
    ({ a, b }) => {
      document.getElementById("codeA").innerHTML = a.html;
      const imgA = document.getElementById("imgA");
      imgA.src = a.src;
      imgA.style.width = `${a.size.w}px`;
      imgA.style.height = `${a.size.h}px`;
      Object.assign(imgA.style, a.frame);
      document.getElementById("capA").textContent = a.cap;

      const codeB = document.getElementById("codeB");
      const outB = document.getElementById("outB");
      if (b) {
        codeB.innerHTML = b.html;
        const imgB = document.getElementById("imgB");
        imgB.src = b.src;
        imgB.style.width = `${b.size.w}px`;
        imgB.style.height = b.size.h + "px";
        Object.assign(imgB.style, b.frame);
        document.getElementById("capB").textContent = b.cap;
      } else {
        codeB.style.opacity = "0";
        outB.style.opacity = "0";
      }
    },
    { a, b },
  );
}

async function setCodeState({ fromIdx, toIdx = null, t = 0, sceneOpacity = 1, extraY = 0, sceneScale = 1, lineDraw = 1 }) {
  const a = codeSlides[fromIdx];
  const b = toIdx !== null ? codeSlides[toIdx] : a;
  const lineEase = easeInOutCubic(t);
  const contentOut = clamp01(t / 0.48);
  const contentIn = easeOutQuart((t - 0.18) / 0.82);
  const boxEase = easeInOutCubic(t);

  const tabX = lerp(a.tabX, b.tabX, lineEase);
  const tabW = lerp(a.tabW, b.tabW, lineEase) * lineDraw;
  const boxH = lerp(a.boxH, b.boxH, boxEase);
  const sceneY = lerp(a.centerOffsetY, b.centerOffsetY, boxEase) + extraY;

  await page.evaluate(
    ({ fromIdx, toIdx, t, sceneOpacity, sceneY, sceneScale, tabX, tabW, boxH, contentOut, contentIn }) => {
      const code = document.getElementById("code");
      code.style.opacity = String(sceneOpacity);
      code.style.transform = `translateY(${sceneY.toFixed(2)}px) scale(${sceneScale.toFixed(4)})`;

      const line = document.getElementById("tabLine");
      line.style.transform = `translateX(${tabX.toFixed(2)}px)`;
      line.style.width = `${Math.max(0, tabW).toFixed(2)}px`;

      for (const el of document.querySelectorAll("[data-tab]")) {
        const idx = Number(el.dataset.tab);
        let alpha = 0.38;
        if (toIdx === null || t === 0) {
          alpha = idx === fromIdx ? 1 : 0.38;
        } else if (idx === fromIdx) {
          alpha = 1 - 0.62 * t;
        } else if (idx === toIdx) {
          alpha = 0.38 + 0.62 * t;
        }
        el.style.color = `rgba(255,255,255,${alpha.toFixed(3)})`;
      }

      document.getElementById("codeBox").style.height = `${boxH.toFixed(2)}px`;

      const codeA = document.getElementById("codeA");
      const codeB = document.getElementById("codeB");
      const outA = document.getElementById("outA");
      const outB = document.getElementById("outB");

      if (toIdx === null || t === 0) {
        codeA.style.opacity = "1";
        codeA.style.transform = "translateY(0px)";
        codeB.style.opacity = "0";
        outA.style.opacity = "1";
        outA.style.transform = "translateY(0px) scale(1)";
        outB.style.opacity = "0";
      } else {
        const aAlpha = 1 - contentOut;
        codeA.style.opacity = aAlpha.toFixed(3);
        codeA.style.transform = `translateY(${(-10 * contentOut).toFixed(2)}px)`;
        outA.style.opacity = aAlpha.toFixed(3);
        outA.style.transform = `translateY(${(-12 * contentOut).toFixed(2)}px) scale(${(1 - 0.015 * contentOut).toFixed(4)})`;

        codeB.style.opacity = contentIn.toFixed(3);
        codeB.style.transform = `translateY(${(12 * (1 - contentIn)).toFixed(2)}px)`;
        outB.style.opacity = contentIn.toFixed(3);
        outB.style.transform = `translateY(${(16 * (1 - contentIn)).toFixed(2)}px) scale(${(0.985 + 0.015 * contentIn).toFixed(4)})`;
      }
    },
    { fromIdx, toIdx, t, sceneOpacity, sceneY, sceneScale, tabX, tabW, boxH, contentOut, contentIn },
  );
}

async function mountReelFrame(i, progressOverride = null) {
  const r = reel[i];
  const size = fit(r.png, 1560, 860);
  await page.evaluate(
    ({ src, w, h, who, ms, count, progress, frame }) => {
      const img = document.getElementById("reelImg");
      img.src = src;
      img.style.width = `${w}px`;
      img.style.height = `${h}px`;
      Object.assign(img.style, frame);
      document.getElementById("reelWho").textContent = who;
      document.getElementById("reelMs").textContent = ms;
      document.getElementById("reelCount").textContent = count;
      document.getElementById("reelBar").style.width = `${(progress * 100).toFixed(3)}%`;
    },
    {
      src: pngUrl(r.png),
      ...size,
      who: `@${AUTHOR.handle} · ${GAME.surface} · ${GAME.width} · ${GAME.theme}`,
      ms: fmtMs(r.ms),
      count: `frame ${String(i + 1).padStart(3, "0")} / ${reel.length}`,
      progress: progressOverride ?? (i + 1) / reel.length,
      frame: frameStyle(size.w, GAME.width),
    },
  );
}

// --- Choreographed timeline -------------------------------------------------

// 1. Intro stagger-in (0.6s = 18 frames) + hold (1.7s = 51 frames).
const INTRO_IN = 18;
for (let f = 0; f < INTRO_IN; f++) {
  await setIntroState({ sceneOpacity: 1, sceneScale: 1, t: (f + 1) / INTRO_IN });
  await shoot(1);
}
await setIntroState({ sceneOpacity: 1, sceneScale: 1, t: 1 });
await shoot(Math.round(1.7 * FPS));

// 2. Crossfade Intro → Code[0] (CLI) (0.5s = 15 frames).
await mountCodeLayers(0, null);
const INTRO_TO_CODE = 15;
for (let f = 0; f < INTRO_TO_CODE; f++) {
  const p = (f + 1) / INTRO_TO_CODE;
  const out = easeInOutCubic(p);
  const inn = easeOutQuart(Math.max(0, (p - 0.12) / 0.88));
  await setIntroState({ sceneOpacity: 1 - out, sceneScale: lerp(1, 0.968, out), t: 1 });
  await setCodeState({ fromIdx: 0, sceneOpacity: inn, extraY: lerp(22, 0, inn), lineDraw: inn });
  await shoot(1);
}
await page.evaluate(() => (document.getElementById("intro").style.opacity = "0"));

// 3. Code slides + animated tab-line / card transitions.
const TAB_TRANSITION = 16; // ~0.53s smooth slide
const CODE_HOLD = Math.round(2.7 * FPS);

for (let i = 0; i < codeSlides.length; i++) {
  await mountCodeLayers(i, null);
  await setCodeState({ fromIdx: i, sceneOpacity: 1 });
  await shoot(CODE_HOLD, `code-${codeSlides[i].lang.toLowerCase()}.png`);

  if (i + 1 < codeSlides.length) {
    await mountCodeLayers(i, i + 1);
    for (let f = 1; f < TAB_TRANSITION; f++) {
      const p = f / TAB_TRANSITION;
      await setCodeState({ fromIdx: i, toIdx: i + 1, t: p, sceneOpacity: 1 });
      const midPreview = f === Math.floor(TAB_TRANSITION / 2) ? `transition-${i}-to-${i + 1}.png` : null;
      await shoot(1, midPreview);
    }
  }
}

if (PREVIEW_DIR && argv.includes("--preview-only")) {
  await browser.close();
  server?.stdin.end();
  rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`wrote preview stills to ${PREVIEW_DIR}`);
  process.exit(0);
}

// 4. Transition Code[2] (Rust) → Tetris Reel (0.5s = 15 frames).
await mountCodeLayers(2, null);
await mountReelFrame(0, 1 / reel.length);
const CODE_TO_REEL = 15;
for (let f = 0; f < CODE_TO_REEL; f++) {
  const p = (f + 1) / CODE_TO_REEL;
  const out = easeInOutCubic(p);
  const inn = easeOutQuart(Math.max(0, (p - 0.15) / 0.85));
  await setCodeState({ fromIdx: 2, sceneOpacity: 1 - out, sceneScale: lerp(1, 0.972, out) });
  await page.evaluate(
    ({ op, y, sc }) => {
      const reelEl = document.getElementById("reel");
      reelEl.style.opacity = String(op);
      reelEl.style.transform = `translateY(${y.toFixed(2)}px) scale(${sc.toFixed(4)})`;
    },
    { op: inn, y: lerp(20, 0, inn), sc: lerp(0.985, 1, inn) },
  );
  await shoot(1);
}
await page.evaluate(() => {
  document.getElementById("code").style.opacity = "0";
  const reelEl = document.getElementById("reel");
  reelEl.style.opacity = "1";
  reelEl.style.transform = "none";
});

// 5. Tetris gameplay reel (hold opening board briefly, then 15 game fps).
for (const [i] of reel.entries()) {
  await mountReelFrame(i);
  await shoot(i === 0 ? Math.round(0.9 * FPS) : FPS / 15, i === Math.floor(reel.length * 0.55) ? "reel-mid.png" : null);
}

// 6. Transition Tetris Reel → Outro (0.5s = 15 frames) + Outro hold (2.5s).
const REEL_TO_OUTRO = 15;
for (let f = 0; f < REEL_TO_OUTRO; f++) {
  const p = (f + 1) / REEL_TO_OUTRO;
  const out = easeInOutCubic(p);
  const inn = easeOutQuart(Math.max(0, (p - 0.15) / 0.85));
  await page.evaluate(
    ({ reelOp, reelSc, outroOp, t }) => {
      const clamp = (v) => Math.max(0, Math.min(1, v));
      const ease = (v) => 1 - (1 - clamp(v)) ** 4;
      const reelEl = document.getElementById("reel");
      reelEl.style.opacity = String(reelOp);
      reelEl.style.transform = `scale(${reelSc.toFixed(4)})`;

      const outro = document.getElementById("outro");
      outro.style.opacity = String(outroOp);
      const apply = (id, delay, dy) => {
        const q = ease((t - delay) / (1 - delay));
        const el = document.getElementById(id);
        el.style.opacity = String(q);
        el.style.transform = `translateY(${((1 - q) * dy).toFixed(2)}px)`;
      };
      apply("outroBig", 0.0, 22);
      apply("outroLine", 0.16, 18);
      apply("outroInstall", 0.32, 14);
    },
    { reelOp: 1 - out, reelSc: lerp(1, 0.975, out), outroOp: inn, t: inn },
  );
  await shoot(1);
}
await page.evaluate(() => {
  document.getElementById("reel").style.opacity = "0";
  document.getElementById("outro").style.opacity = "1";
  for (const id of ["outroBig", "outroLine", "outroInstall"]) {
    const el = document.getElementById(id);
    el.style.opacity = "1";
    el.style.transform = "none";
  }
});
await shoot(Math.round(2.5 * FPS), "outro.png");

// 7. Transition Outro → Terminal CTA + block-caret typing of `xeet-rs.vercel.app`.
const CTA_URL = "xeet-rs.vercel.app";
async function setCtaState({ text = "", caretOn = true, opacity = 1 }) {
  await page.evaluate(
    ({ text, caretOn, opacity }) => {
      const cta = document.getElementById("cta");
      cta.style.opacity = String(opacity);
      document.getElementById("ctaText").textContent = text;
      document.getElementById("ctaCaret").classList.toggle("off", !caretOn);
    },
    { text, caretOn, opacity },
  );
}

const OUTRO_TO_CTA = 13;
for (let f = 0; f < OUTRO_TO_CTA; f++) {
  const p = (f + 1) / OUTRO_TO_CTA;
  const out = easeInOutCubic(p);
  const inn = easeOutQuart(Math.max(0, (p - 0.25) / 0.75));
  await page.evaluate(
    ({ op, sc }) => {
      const outro = document.getElementById("outro");
      outro.style.opacity = String(op);
      outro.style.transform = `scale(${sc.toFixed(4)})`;
    },
    { op: 1 - out, sc: lerp(1, 0.975, out) },
  );
  await setCtaState({ text: "", caretOn: true, opacity: inn });
  await shoot(1);
}
await page.evaluate(() => (document.getElementById("outro").style.opacity = "0"));

// Brief pre-type beat: solid caret → short blink → solid caret, then type.
await setCtaState({ text: "", caretOn: true, opacity: 1 });
await shoot(8);
await setCtaState({ text: "", caretOn: false, opacity: 1 });
await shoot(5);
await setCtaState({ text: "", caretOn: true, opacity: 1 });
await shoot(4);

// Natural human typing cadence (1–2 frames/char at 30fps, brief beat on `-` and `.`).
for (let i = 1; i <= CTA_URL.length; i++) {
  const slice = CTA_URL.slice(0, i);
  const ch = CTA_URL[i - 1];
  const hold = ch === "-" || ch === "." ? 3 : i % 3 === 0 ? 1 : 2;
  await setCtaState({ text: slice, caretOn: true, opacity: 1 });
  await shoot(hold, i === 11 ? "cta-mid.png" : null);
}

// Resting blink on the completed URL, ending with the block caret ON so the
// final paused frame of the video is the crisp `xeet-rs.vercel.app █` CTA.
await setCtaState({ text: CTA_URL, caretOn: true, opacity: 1 });
await shoot(16);
await setCtaState({ text: CTA_URL, caretOn: false, opacity: 1 });
await shoot(14);
await setCtaState({ text: CTA_URL, caretOn: true, opacity: 1 });
await shoot(16);
await setCtaState({ text: CTA_URL, caretOn: false, opacity: 1 });
await shoot(14);
await setCtaState({ text: CTA_URL, caretOn: true, opacity: 1 });
await shoot(22, "cta-final.png");

// --- 3. Encode --------------------------------------------------------------

let frameNo = 0;
for (const { file, frames } of timeline) {
  for (let f = 0; f < frames; f++) {
    linkSync(file, join(SCRATCH, "frames", `${String(frameNo++).padStart(5, "0")}.png`));
  }
}
const seconds = frameNo / FPS;
const tmpMp4 = join(SCRATCH, "xeet.mp4");
execFileSync(
  "ffmpeg",
  [
    "-y", "-loglevel", "error",
    "-framerate", String(FPS),
    "-i", join(SCRATCH, "frames", "%05d.png"),
    "-vf", "format=yuv420p",
    "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-threads", "4",
    "-movflags", "+faststart",
    tmpMp4,
  ],
  { stdio: "inherit" },
);
const mp4 = readFileSync(tmpMp4);
const hash = createHash("sha256").update(mp4).digest("hex").slice(0, 12);
const ogDir = join(ROOT, "public", "og");
mkdirSync(ogDir, { recursive: true });
for (const f of readdirSync(ogDir)) if (/^xeet-[0-9a-f]{12}\.mp4$/.test(f)) rmSync(join(ogDir, f));
const videoRel = `/og/xeet-${hash}.mp4`;
writeFileSync(join(ROOT, "public", videoRel), mp4);
writeFileSync(
  join(ROOT, "app", "_generated", "og-video.js"),
  `// Generated by tools/ship/promo-video.mjs.\nexport const OG_VIDEO = ${JSON.stringify({ url: videoRel, width: W, height: H, type: "video/mp4" })};\n`,
);
console.log(`video: public${videoRel} (${seconds.toFixed(1)} s, ${(mp4.length / 1e6).toFixed(2)} MB, ${timeline.length} unique frames, ${frameNo} video frames)`);

// --- 4. Open Graph image (1200×630 @2x) -------------------------------------

const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
await og.setContent(TEMPLATE);
await og.evaluate(() => document.fonts.ready);
const ogFrame = reel[Math.floor(reel.length * 0.55)];
const ogSize = pngSize(ogFrame.png);
const ogH = 630 - 2 * 34;
const ogW = Math.round((ogH * ogSize.w) / ogSize.h);
const ogCards = [{ src: pngUrl(ogFrame.png), x: 1200 - 90 - ogW, y: 34, w: ogW, frame: frameStyle(ogW, GAME.width) }];
await og.evaluate((cards) => {
  document.body.dataset.mode = "og";
  document.getElementById("ogCards").replaceChildren(
    ...cards.map((c) => {
      const img = document.createElement("img");
      img.src = c.src;
      Object.assign(img.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px` }, c.frame);
      return img;
    }),
  );
  return Promise.all([...document.querySelectorAll("#ogCards img")].map((i) => i.decode()));
}, ogCards);
const ogPath = join(ROOT, "app", "opengraph-image.png");
await og.screenshot({ path: ogPath });
writeFileSync(join(ROOT, "app", "opengraph-image.alt.txt"), "xeet: X posts rendered to PNG, without a browser");
console.log(`og image: app/opengraph-image.png (${(statSync(ogPath).size / 1e6).toFixed(2)} MB)`);

await browser.close();
server?.stdin.end();
rmSync(SCRATCH, { recursive: true, force: true });
