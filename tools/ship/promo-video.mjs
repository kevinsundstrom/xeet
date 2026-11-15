#!/usr/bin/env node
// Composes the release video and the Open Graph card from xeet's own output.
//
//   cargo build --release -p xeet-cli --bin xeet-render
//   node tools/ship/promo-video.mjs [--bin target/release/xeet-render]
//
// Writes:
//   public/og/xeet-<sha256>.mp4     1920×1080 H.264, the og:video and the X release clip
//   app/opengraph-image.png         1200×630 @2x Open Graph / X card image
//   app/_generated/og-video.js      the video's hashed URL, read by app/layout.jsx
//
// Every post in it is rendered here by the native release renderer, kept warm
// as `xeet-render serve --stdio`, and every "ms" on screen is that server's own
// `ms.render` for the exact PNG shown: layout, paint and PNG encoding inside
// one process, with no spawn, pipe or JSON cost. Each is the fastest of seven
// runs after a warm-up, so background load on the machine making the video
// does not leak into the numbers. Slides are laid out in
// headless Chromium and encoded with ffmpeg. The centerpiece is Tetris
// (tools/ship/tetris.mjs) played inside one mobile post: every frame of the
// game is a post, rendered and timed like everything else.
//
// Timing only starts once the machine is quiet (1-minute load average under
// half the cores); the script waits for that and refuses to publish numbers
// measured on a busy machine
// until each render is on screen for a single frame.

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

// Timing can happen elsewhere: `--export-requests FILE` writes every render
// this video needs as JSON lines and exits; tools/ship/promo-time.mjs times
// them on a quiet machine (a Vercel Sandbox); `--timings FILE` then builds the
// video from those timings and PNGs without rendering anything here.
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const EXPORT = flagValue("--export-requests");
const TIMINGS_FILE = flagValue("--timings");
const TIMINGS = TIMINGS_FILE ? JSON.parse(readFileSync(TIMINGS_FILE, "utf8")) : null;
const requestKey = (post, options) => createHash("sha256").update(JSON.stringify({ post, options })).digest("hex");
if (TIMINGS) console.log(`timings from ${TIMINGS_FILE}: ${JSON.stringify(TIMINGS.meta)}`);

// One warm native render server for the whole run, started on first use;
// requests are matched to replies by id.
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

/** Waits until the machine is quiet enough that a timing means something. */
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

// Timed renders are cached by their request and the renderer binary, so a
// layout-only change to the video does not need another quiet-machine timing
// pass. `--fresh` ignores the cache.
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
let cacheHits = 0;
const cached = (post, options) => {
  if (FRESH) return null;
  const file = join(CACHE, `${cacheKey(post, options)}.json`);
  try {
    const { ms, png } = JSON.parse(readFileSync(file, "utf8"));
    cacheHits++;
    return { ms, png: new Uint8Array(Buffer.from(png, "base64")) };
  } catch {
    return null;
  }
};

/** Fastest of seven native renders (`ms.render`), after a warm-up render. */
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
/** True when every request is already timed and cached. */
const allCached = (requests) => TIMINGS || EXPORT || (!FRESH && requests.every(([post, options]) => existsCache(post, options)));
const existsCache = (post, options) => {
  try {
    statSync(join(CACHE, `${cacheKey(post, options)}.json`));
    return true;
  } catch {
    return false;
  }
};

// The game: one post per frame, on the iOS post page at iPhone Duo width (the
// timeline would cut a 19-line post at nine). The screen is the text; the
// score is the like count, lines are reposts, pieces are replies, and views
// tick up every frame.
const GAME = { surface: "ios-detail", width: 382, theme: "dark", dpr: 3 };
const byId = (id) => posts.find((p) => p.item.id === id);
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
  await renderNative(gamePost(game.frames[0]), GAME); // warm-up: emoji bitmaps, shaping caches
  await waitForQuiet("the game");
}

const reel = [];
if (!EXPORT) for (const f of game.frames) reel.push({ f, ...(await timedRender(gamePost(f), GAME)) });
const fastest = Math.min(...reel.map((r) => r.ms));
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
    code: `npm i -g @xeet/cli

xeet resolve https://x.com/jack/status/20 --media \\
  | xeet render - --theme dark --dpr 2 -o jack.png`,
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
  if (!TIMINGS && !existsCache(byId(c.example).post, c.options)) await renderNative(byId(c.example).post, c.options); // warm-up
  Object.assign(c, await timedRender(byId(c.example).post, c.options));
}

// --- 2. Lay out slides in Chromium -------------------------------------------

const font = (name) =>
  `data:font/woff2;base64,${readFileSync(join(ROOT, "app/_assets/fonts", name)).toString("base64")}`;
const pngUrl = (png) => `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
const pngSize = (png) => {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
};
const fmtMs = (ms) => `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;

const TEMPLATE = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Serif; src: url(${font("GeistSerif.woff2")}); font-weight: 100 900; }
@font-face { font-family: Sans; src: url(${font("GeistSans.woff2")}); font-weight: 100 900; }
@font-face { font-family: Mono; src: url(${font("GeistMono.woff2")}); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
html, body { width: ${W}px; height: ${H}px; background: #000; color: #fff; overflow: hidden; -webkit-font-smoothing: antialiased; }
section { position: absolute; inset: 0; display: none; }
body[data-mode="intro"] #intro, body[data-mode="code"] #code, body[data-mode="reel"] #reel,
body[data-mode="outro"] #outro, body[data-mode="og"] #og { display: block; }
.dim { color: rgba(255,255,255,0.56); }
.mono { font-family: Mono; letter-spacing: -0.01em; }


#intro, #outro { display: none; text-align: center; }
body[data-mode="intro"] #intro, body[data-mode="outro"] #outro { display: flex; flex-direction: column; align-items: center; justify-content: center; }
#intro h1 { font: 400 200px/1 Serif; letter-spacing: -0.02em; }
#intro p { font: 400 52px/1.3 Serif; margin-top: 28px; }
#intro .mono { font-size: 28px; margin-top: 40px; }

body[data-mode="code"] #code { display: flex; align-items: center; justify-content: center; gap: 100px; }
#code .left { width: 980px; }
#code .tabs { display: flex; gap: 44px; font: 400 32px/1 Sans; }
#code .tabs span { padding-bottom: 16px; border-bottom: 2px solid transparent; color: rgba(255,255,255,0.4); }
#code .tabs span.on { color: #fff; border-bottom-color: #fff; }
#code pre { margin-top: 40px; padding: 40px 46px; border: 1px solid rgba(255,255,255,0.22);
  border-radius: 18px; background: rgba(255,255,255,0.04); font: 400 25px/1.6 Mono; white-space: pre; }
#code .out { width: 640px; display: flex; flex-direction: column; align-items: center; }
#code .cap { margin-top: 30px; font: 400 26px/1 Mono; }
.t-comment { color: #8b949e; font-style: italic; } .t-keyword { color: #ff7b72; } .t-string { color: #a5d6ff; }
.t-number { color: #79c0ff; } .t-fn { color: #d2a8ff; } .t-prop { color: #ffa657; } .t-type { color: #7ee787; } .t-punct { color: #c9d1d9; }

#reel .top, #reel .bottom { position: absolute; left: 120px; right: 120px; display: flex; justify-content: space-between; align-items: baseline; }
#reel .top { top: 56px; font: 400 26px/1 Mono; }
#reel .bottom { bottom: 64px; }
#reel .bottom .who { font: 400 24px/1 Mono; }
#reel .bottom .ms { font: 400 64px/1 Mono; letter-spacing: -0.03em; }
#reel .frame { position: absolute; left: 0; right: 0; top: 110px; bottom: 110px; display: flex; align-items: center; justify-content: center; }
#reel .bar { position: absolute; left: 120px; width: 440px; bottom: 44px; height: 3px; background: rgba(255,255,255,0.16); border-radius: 3px; overflow: hidden; }
#reel .bar span { display: block; height: 100%; background: #fff; }


#outro .big { font: 400 150px/1 Mono; letter-spacing: -0.04em; }
#outro .line { font: 400 46px/1.3 Serif; margin-top: 34px; }
#outro .install { font: 400 30px/1 Mono; margin-top: 70px; display: flex; gap: 56px; }
#outro .url { font: 400 40px/1 Serif; margin-top: 64px; }

#og .left { position: absolute; left: 64px; top: 0; bottom: 0; width: 470px; display: flex; flex-direction: column; justify-content: center; }
#og h1 { font: 400 124px/1 Serif; letter-spacing: -0.02em; }
#og p { font: 400 33px/1.25 Serif; margin-top: 18px; }
#og .mono { font-size: 19px; margin-top: 28px; }
#og .url { font: 400 22px/1 Mono; margin-top: 42px; }
#og img { position: absolute; }
</style></head><body data-mode="intro">
<section id="intro">
  <h1>xeet</h1>
  <p>X posts rendered to PNG, without a browser.</p>
  <div class="mono dim">Rust · WebAssembly · TypeScript · CLI</div>
</section>
<section id="code">
  <div class="left">
    <div class="tabs"><span data-tab="CLI">CLI</span><span data-tab="TypeScript">TypeScript</span><span data-tab="Rust">Rust</span></div>
    <pre><code id="codeBody"></code></pre>
  </div>
  <div class="out"><img id="codeImg"><div class="cap dim" id="codeCap"></div></div>
</section>
<section id="reel">
  <div class="top"><span class="dim">Tetris · every frame is a post</span><span id="reelCount"></span></div>
  <div class="frame"><img id="reelImg"></div>
  <div class="bottom"><span class="who dim" id="reelWho"></span><span class="ms" id="reelMs"></span></div>
  <div class="bar"><span id="reelBar"></span></div>
</section>
<section id="outro">
  <div class="big" id="outroBig"></div>
  <div class="line dim" id="outroLine"></div>
  <div class="install"><span>npm i @xeet/core</span><span class="dim">·</span><span>npm i -g @xeet/cli</span></div>
  <div class="url">xeet-rs.vercel.app</div>
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

// The site's frame (16 px radius, 1 px line, 7 px gap, 1 px halo), scaled by
// how many on-screen pixels each CSS pixel of the post occupies, so the ring
// hugs the post's own corners at any size.
const frameStyle = (displayW, cssW) => {
  const k = displayW / cssW;
  const px = (n) => `${(n * k).toFixed(2)}px`;
  return {
    borderRadius: px(16),
    boxShadow: `0 0 0 ${px(1)} rgba(255,255,255,0.22), 0 0 0 ${px(7)} #000, 0 0 0 ${px(8)} rgba(255,255,255,0.08)`,
  };
};

const decodeAll = () =>
  page.evaluate(() => Promise.all([...document.querySelectorAll("img")].map((i) => (i.src ? i.decode().catch(() => {}) : null))));

let slideNo = 0;
const timeline = []; // [{ file, frames }]
async function shoot(frames) {
  await decodeAll();
  const file = join(SCRATCH, "slides", `${String(slideNo++).padStart(4, "0")}.png`);
  await page.screenshot({ path: file });
  timeline.push({ file, frames: Math.max(1, Math.round(frames)) });
}

// Fit a render inside a box without upscaling past its own pixels.
const fit = (png, maxW, maxH) => {
  const { w, h } = pngSize(png);
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: Math.round(w * k), h: Math.round(h * k) };
};

// Intro.
await page.evaluate(() => (document.body.dataset.mode = "intro"));
await shoot(2.6 * FPS);

// Code: CLI, TypeScript, Rust, each beside the PNG it produces.
for (const c of CODE) {
  const size = fit(c.png, 640, 820);
  await page.evaluate(
    ({ html, lang, src, w, h, cap, frame }) => {
      document.body.dataset.mode = "code";
      document.getElementById("codeBody").innerHTML = html;
      for (const t of document.querySelectorAll("[data-tab]")) t.classList.toggle("on", t.dataset.tab === lang);
      const img = document.getElementById("codeImg");
      img.src = src;
      img.style.width = `${w}px`;
      img.style.height = `${h}px`;
      Object.assign(img.style, frame);
      document.getElementById("codeCap").textContent = cap;
    },
    {
      html: highlight(c.code, c.hl),
      lang: c.lang,
      src: pngUrl(c.png),
      ...size,
      cap: `${c.options.surface} · ${c.options.width} · rendered in ${fmtMs(c.ms)}`,
      frame: frameStyle(size.w, c.options.width),
    },
  );
  await shoot(3.6 * FPS);
}

// The game, at 15 frames a second: each frame is one post, shown for two video frames.
for (const [i, r] of reel.entries()) {
  const size = fit(r.png, 1560, 860);
  await page.evaluate(
    ({ src, w, h, who, ms, count, progress, frame }) => {
      document.body.dataset.mode = "reel";
      const img = document.getElementById("reelImg");
      img.src = src;
      img.style.width = `${w}px`;
      img.style.height = `${h}px`;
      Object.assign(img.style, frame);
      document.getElementById("reelWho").textContent = who;
      document.getElementById("reelMs").textContent = ms;
      document.getElementById("reelCount").textContent = count;
      document.getElementById("reelBar").style.width = `${progress * 100}%`;
    },
    {
      src: pngUrl(r.png),
      ...size,
      who: `@${AUTHOR.handle} · ${GAME.surface} · ${GAME.width} · ${GAME.theme}`,
      ms: fmtMs(r.ms),
      count: `frame ${String(i + 1).padStart(3, "0")} / ${reel.length}`,
      progress: (i + 1) / reel.length,
      frame: frameStyle(size.w, GAME.width),
    },
  );
  // Hold the first frame so the level reads, then play at 15 fps.
  await shoot(i === 0 ? 1.2 * FPS : FPS / 15);
}

// Outro.
await page.evaluate(
  ({ big, line }) => {
    document.body.dataset.mode = "outro";
    document.getElementById("outroBig").textContent = big;
    document.getElementById("outroLine").textContent = line;
  },
  {
    big: `${reel.length} frames in ${reelTotal >= 1000 ? `${(reelTotal / 1000).toFixed(1)} s` : fmtMs(reelTotal)}`,
    line: `Every frame a post, rendered in as little as ${fmtMs(fastest)}. Native Rust. No browser.`,
  },
);
await shoot(3.8 * FPS);

// --- 3. Encode ------------------------------------------------------------------

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
    "-vf", `fade=t=in:st=0:d=0.4,fade=t=out:st=${(seconds - 0.6).toFixed(2)}:d=0.6,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-tune", "stillimage", "-threads", "4",
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
console.log(`video: public${videoRel} (${seconds.toFixed(1)} s, ${(mp4.length / 1e6).toFixed(2)} MB, ${timeline.length} slides)`);

// --- 4. Open Graph image (1200×630 @2x) -------------------------------------

const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
await og.setContent(TEMPLATE);
await og.evaluate(() => document.fonts.ready);
// Mid-game: a stack, a line or two cleared, a piece on its way down.
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
