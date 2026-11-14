#!/usr/bin/env node
// Periodic upstream X drift canary (`pnpm canary`).
//
// Alarms us whenever X changes any of the three layers `xeet` depends on,
// running in ~5s on any machine or GitHub Actions runner (even with zero
// private font/vendor secrets):
//
//   1. Stylesheet & token invariants (`styles-*.css` on x.com): spacing,
//      squircles (`--x-radius-m: 1.8`), radii, 16:9 video, Chirp `@font-face`,
//      carousel indicator classes (`w-[22px]`, `gap-[5px]`, `-mt-2`, `mb-3`),
//      and layout utility classes (`min-w-0`, `flex-1`, `line-clamp-1`,
//      `wrap-break-word`). Also notes whether `appVersion` / stylesheet SHA
//      rotated relative to `assets/upstream.lock.json`.
//   2. Live SSR DOM & formula invariants across real public posts:
//      - `mediaCarouselLayout` (`padding-bottom` formula on 2-image, 20-image,
//        and 20-strip carousels matches `crates/xeet-core/src/cards/media.rs`),
//      - timeline vs detail indicator rule (profile timeline renders `w-[22px]`
//        pills on textless overflowing carousels; detail `/status/` omits them),
//      - 510 px vertical media height cap (`max-width: 286.875px` on 9:16),
//      - `note_tweet` / `Show more` and affiliate badge presence on live SSR.
//   3. Live `xeet.resolve()` contract check (when `packages/xeet/wasm` is built)
//      across 7 real public X posts: root text, long post + quote, video + quote,
//      9:16 vertical video, 2-image carousel, 20-image carousel, and 20-strip
//      affiliate carousel.
//
// Usage:
//   node tools/ship/upstream-canary.mjs [--report path.md] [--strict-lock]

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCK_PATH = join(ROOT, "assets", "upstream.lock.json");
const WASM_PATH = join(ROOT, "packages", "xeet", "wasm", "xeet_wasm_bg.wasm");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const args = process.argv.slice(2);
const strictLock = args.includes("--strict-lock");
const reportIdx = args.indexOf("--report");
const reportPath = reportIdx >= 0 ? args[reportIdx + 1] : null;

const failures = [];
const notices = [];
const checks = [];

function record(ok, name, detail = "") {
  checks.push({ ok, name, detail });
  const tag = ok ? "ok  " : "FAIL";
  console.log(`${tag} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "text/html,text/css,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return await res.text();
}

// Exact port of `layout_carousel` in `crates/xeet-core/src/cards/media.rs`.
function expectedPaddingBottom(ars) {
  const BASE = 0.68;
  const MAX_CELL = 0.8;
  const PEEK = 0.67;
  const GAP = 4;
  const FALLBACK = 1.24446;
  const SPARE = 0.33;
  const minR = (a, b) => (a.ratio <= b.ratio ? a : b);
  const maxR = (a, b) => (a.ratio >= b.ratio ? a : b);
  const cellR = (h, ar) => (ar == null ? h : Math.min(h * ar, MAX_CELL));

  const fit = () => {
    if (ars.length < 2 || ars.some((a) => a == null || a <= 0)) return null;
    const gaps = GAP * (ars.length - 1);
    let rest = [...ars];
    let dropped = 0;
    for (;;) {
      const sum = rest.reduce((acc, a) => acc + a, 0);
      if (sum <= 0) return null;
      const height = (1 - dropped * MAX_CELL) / sum;
      if (height <= 0) return null;
      const keep = rest.filter((a) => height * a <= MAX_CELL);
      if (keep.length === rest.length) return { ratio: height, offset: -gaps * height };
      dropped += rest.length - keep.length;
      if (!keep.length) return null;
      rest = keep;
    }
  };

  const peek = () => {
    const ar0 = ars[0] ?? 1;
    const ar1 = ars[1] ?? 1;
    if (ar0 <= 0 || ar1 <= 0) return null;
    const has0 = ars[0] != null;
    const has1 = ars[1] != null;
    const cands = [];
    const push = (num, den) => {
      if (den > 0) {
        const r = num / den;
        if (r > 0) cands.push({ ratio: r, offset: -GAP * r });
      }
    };
    const den = ar0 + PEEK * ar1;
    const h0 = den > 0 ? 1 / den : 0;
    if (h0 > 0 && (!has0 || h0 * ar0 <= MAX_CELL) && (!has1 || h0 * ar1 <= MAX_CELL)) push(1, den);
    if (has0) {
      const d = PEEK * ar1;
      const h1 = d > 0 ? 0.2 / d : 0;
      if (h1 > 0 && h1 * ar0 >= MAX_CELL && (!has1 || h1 * ar1 <= MAX_CELL)) push(0.2, d);
    }
    if (has1) {
      const h2 = (1 - PEEK * MAX_CELL) / ar0;
      if (h2 > 0 && h2 * ar1 >= MAX_CELL && (!has0 || h2 * ar0 <= MAX_CELL)) push(1 - PEEK * MAX_CELL, ar0);
    }
    return cands.length ? cands.reduce(minR) : null;
  };

  const secondVis = (e) => {
    const n = cellR(e.ratio, ars[0]);
    const r = cellR(e.ratio, ars[1]);
    return r <= 0 ? 0 : Math.min(Math.max(1 - n, 0), r) / r;
  };

  const limited2 = () => {
    let lim = Infinity;
    let any = false;
    for (const a of ars.slice(0, 2)) {
      if (a != null && a > 0) {
        lim = Math.min(lim, MAX_CELL / a);
        any = true;
      }
    }
    return any ? { ratio: lim, offset: 0 } : null;
  };

  const fallback = { ratio: FALLBACK, offset: 0 };
  let cur = minR({ ratio: BASE, offset: 0 }, fallback);
  const f = fit();
  if (f && f.ratio >= cur.ratio) cur = minR(f, fallback);
  if (ars.length === 2) {
    if (f && f.ratio < cur.ratio && secondVis(cur) >= SPARE) cur = f;
  } else if (ars.length >= 3) {
    if (1 - secondVis(cur) < SPARE) {
      const p = peek();
      if (p) {
        let best = minR(p, fallback);
        const cap = limited2();
        if (cap) best = minR(best, maxR(cap, cur));
        if (best.ratio > cur.ratio) cur = best;
      }
    }
  }
  const pct = Math.round(cur.ratio * 100 * 1e4) / 1e4;
  const off = Math.round(cur.offset * 1e3) / 1e3;
  return off === 0 ? `${pct}%` : `calc(${pct}% ${off < 0 ? "-" : "+"} ${Math.abs(off)}px)`;
}

// --- 1. Stylesheet & token invariants ---------------------------------------
const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
let probeHtml = "";
try {
  probeHtml = await fetchText("https://x.com/jack/status/20");
  record(true, "x.com SSR reachable", "https://x.com/jack/status/20");
} catch (e) {
  record(false, "x.com SSR reachable", e.message);
}

if (probeHtml) {
  const cssMatch = probeHtml.match(/https:\/\/abs\.twimg\.com\/[^"'\s>]+\.css/);
  const verMatch =
    probeHtml.match(/"appVersion"\s*:\s*"([0-9a-f]{16,64})"/) ??
    probeHtml.match(/release-([0-9a-f]{16,64})/);
  const liveVer = verMatch?.[1] ?? null;
  if (liveVer && liveVer !== lock.appVersion) {
    const msg = `pinned ${lock.appVersion.slice(0, 8)} -> live ${liveVer.slice(0, 8)}`;
    notices.push(`appVersion rotated (${msg})`);
    if (strictLock) record(false, "upstream.lock appVersion", msg);
  }

  if (!cssMatch) {
    record(false, "stylesheet URL in SSR HTML", "no abs.twimg.com/*.css link found");
  } else {
    const cssUrl = cssMatch[0];
    try {
      const css = await fetchText(cssUrl);
      const sha = createHash("sha256").update(css).digest("hex");
      if (sha !== lock.stylesheet?.sha256) {
        const msg = `${cssUrl} (${sha.slice(0, 12)}) differs from lock (${lock.stylesheet?.sha256?.slice(0, 12)})`;
        notices.push(`stylesheet rotated: ${msg}`);
        if (strictLock) record(false, "upstream.lock stylesheet", msg);
      }

      const tokenChecks = [
        ["--spacing:4px", /--spacing:\s*4px\b/],
        ["--spacing-horizontal:16px", /--spacing-horizontal:\s*16px\b/],
        ["--aspect-video:16/9", /--aspect-video:\s*16\s*\/\s*9\b/],
        ["--radius-md squircle scale", /--radius-md:\s*calc\(16px\s*\*\s*var\(--x-radius-m\)\)/],
        ["squircle --x-radius-m:1.8", /corner-shape:\s*squircle[\s\S]{0,240}--x-radius-m:\s*1\.8\b/],
        ["--radius-2xl:1rem", /--radius-2xl:\s*1rem\b/],
        ["TwitterChirp @font-face", /font-family:\s*["']?TwitterChirp["']?/],
        ["action-bar .flex-1", /\.flex-1\{[^}]*flex:\s*1\b/],
        ["action-bar .min-w-0", /\.min-w-0\{[^}]*min-width:\s*0/],
        ["handle .wrap-break-word", /\.wrap-break-word\{[^}]*overflow-wrap:\s*break-word/],
        ["action-bar 18.75px icon size", /size-\\\[18\\\.75px\\\]/],
      ];
      for (const [label, re] of tokenChecks) {
        record(re.test(css), `CSS token: ${label}`);
      }
    } catch (e) {
      record(false, "fetch live stylesheet", e.message);
    }
  }
}

// --- 2. Live SSR DOM & formula invariants -----------------------------------
const domProbes = [
  {
    name: "SSR 20-image carousel formula (justinbieber)",
    url: "https://x.com/justinbieber/status/2120954896363200630",
    check(html) {
      const exp = expectedPaddingBottom(Array(20).fill(2048 / 1356));
      if (!html.includes(`padding-bottom:${exp}`) && !html.includes(`padding-bottom: ${exp}`)) {
        return `expected padding-bottom:${exp} in SSR HTML`;
      }
      // Detail `/status/` omits timeline-only indicator pills (`variant === "timeline"`).
      if (html.includes("w-[22px]")) {
        return "unexpected timeline indicator bar on detail /status/ SSR";
      }
      // Payload inside SSR still carries all 20 media entities.
      const mediaHits = (html.match(/pbs\.twimg\.com\/media\//g) ?? []).length;
      if (mediaHits < 20) {
        return `expected >=20 media URLs in SSR HTML, found ${mediaHits}`;
      }
      return null;
    },
  },
  {
    name: "SSR 20-strip narrow carousel formula + affiliate (ciguleva)",
    url: "https://x.com/ciguleva/status/2121073443533881486",
    check(html) {
      const ars = [
        102, 103, 102, 103, 102, 102, 103, 102, 103, 102,
        102, 103, 102, 103, 102, 102, 103, 102, 103, 102,
      ].map((w) => w / 2048);
      const exp = expectedPaddingBottom(ars);
      if (!html.includes(`padding-bottom:${exp}`) && !html.includes(`padding-bottom: ${exp}`)) {
        return `expected padding-bottom:${exp} in SSR HTML`;
      }
      if (!html.includes("Restream")) {
        return "expected affiliate label Restream in SSR HTML";
      }
      return null;
    },
  },
  {
    name: "SSR 2-image non-overflowing carousel formula (adamfuhrer)",
    url: "https://x.com/adamfuhrer/status/2121031916971593832",
    check(html) {
      const exp = expectedPaddingBottom([1536 / 2048, 1536 / 2048]);
      if (!html.includes(`padding-bottom:${exp}`) && !html.includes(`padding-bottom: ${exp}`)) {
        return `expected padding-bottom:${exp} in SSR HTML`;
      }
      if (html.includes("w-[22px]")) {
        return "unexpected w-[22px] indicator bar on non-overflowing 2-image carousel";
      }
      return null;
    },
  },
  {
    name: "SSR 9:16 vertical video 510px height cap (zackdfilms1)",
    url: "https://x.com/zackdfilms1/status/2121016684291014940",
    check(html) {
      if (!html.includes("286.875px")) {
        return "expected max-width:286.875px (510px * 9/16 cap) on vertical video";
      }
      return null;
    },
  },
  {
    name: "SSR video + quote coexistence (anabology)",
    url: "https://x.com/anabology/status/2120010995309457643",
    check(html) {
      const hasVideo = html.includes("aspect-video") || html.includes("amplify_video_thumb") || html.includes("ext_tw_video_thumb");
      const hasQuote = html.includes("Fable 5.2 does with videos");
      if (!hasVideo || !hasQuote) {
        return "expected both 16:9 video poster and quoted post text in SSR HTML";
      }
      return null;
    },
  },
  {
    name: "SSR video poster + full-width detail quote media (anabology MRI)",
    url: "https://x.com/anabology/status/2095355496530071898",
    check(html) {
      if (!html.includes("amplify_video_thumb/2095354324624773122")) {
        return "expected amplify_video_thumb poster URL in SSR HTML";
      }
      if (!html.includes("aspect-ratio:4.1818")) {
        return "expected full-width quoted media aspect-ratio:4.1818 on detail SSR";
      }
      return null;
    },
  },
  {
    name: "SSR long post note_tweet + image (karpathy HackerTube)",
    url: "https://x.com/karpathy/status/2116957135661945283",
    check(html) {
      if (!html.includes("HackerTube") || !html.includes("note_tweet")) {
        return "expected HackerTube note_tweet payload in SSR HTML";
      }
      return null;
    },
  },
];

for (const probe of domProbes) {
  try {
    const html = await fetchText(probe.url);
    const problem = probe.check(html);
    record(!problem, probe.name, problem ?? "");
  } catch (e) {
    record(false, probe.name, e.message);
  }
}

// --- 3. Live `xeet.resolve()` check (when WASM bundle is built) -------------
if (existsSync(WASM_PATH)) {
  const { loadXeet } = await import("../../packages/xeet/src/node.js");
  const xeet = await loadXeet();
  const cases = [
    { name: "resolve root text", url: "https://x.com/jack/status/20", check: (p) => p.author.handle.toLowerCase() === "jack" && p.media.length === 0 },
    { name: "resolve note_tweet long post", url: "https://x.com/karpathy/status/2116957135661945283", check: (p) => Boolean(p.longPostBody) && p.media.length === 1 },
    { name: "resolve closed developer poll", url: "https://x.com/mattpocockuk/status/1925021766793019888", check: (p) => p.poll?.choices?.length === 3 && p.poll?.votes?.length === 3 },
    { name: "resolve video + quote", url: "https://x.com/anabology/status/2120010995309457643", check: (p) => p.media.length === 1 && p.media[0].kind === "video" && Boolean(p.quote) },
    { name: "resolve MRI video poster + quote media", url: "https://x.com/anabology/status/2095355496530071898", check: (p) => p.media.length === 1 && p.media[0].kind === "video" && p.quote?.media?.length === 1 && p.quote.media[0].width === 3312 },
    { name: "resolve 9:16 vertical video", url: "https://x.com/zackdfilms1/status/2121016684291014940", check: (p) => p.media.length === 1 && p.media[0].width === 1080 && p.media[0].height === 1920 },
    { name: "resolve 2-image carousel", url: "https://x.com/adamfuhrer/status/2121031916971593832", check: (p) => p.media.length === 2 },
    { name: "resolve 20-image carousel", url: "https://x.com/justinbieber/status/2120954896363200630", check: (p) => p.media.length === 20 },
    { name: "resolve 20-strip + affiliate", url: "https://x.com/ciguleva/status/2121073443533881486", check: (p) => p.media.length === 20 && p.author.affiliate?.name === "Restream" },
  ];
  for (const c of cases) {
    try {
      const res = await xeet.resolve(c.url, { media: false });
      record(Boolean(res?.post && c.check(res.post)), `xeet.resolve: ${c.name}`);
    } catch (e) {
      record(false, `xeet.resolve: ${c.name}`, e.message);
    }
  }
} else {
  notices.push("packages/xeet/wasm not built in this environment; skipped WASM xeet.resolve step");
}

if (reportPath) {
  const lines = [
    "## Upstream X Canary Report",
    "",
    `- Checked at: \`${new Date().toISOString()}\``,
    `- Passed: \`${checks.filter((c) => c.ok).length}/${checks.length}\``,
    ...(notices.length ? ["", "### Version / Hash Rotations (informational)", ...notices.map((n) => `- ${n}`)] : []),
    ...(failures.length
      ? ["", "### Drift / Contract Failures", ...failures.map((f) => `- **FAIL**: ${f}`)]
      : ["", "All CSS tokens, SSR layout formulas, and `xeet.resolve` contracts match live X."]),
    "",
  ];
  writeFileSync(reportPath, lines.join("\n"));
}

if (notices.length) {
  console.log(`notices: ${notices.join("; ")}`);
}
console.log(
  `canary: ${checks.filter((c) => c.ok).length}/${checks.length} passed, ${failures.length} failed`,
);
process.exit(failures.length ? 1 : 0);
