#!/usr/bin/env node
// Classifies the posts in the e2e harness's `raster` bucket (docs/E2E.md).
//
//   node tools/oracle/raster-e2e.mjs --take            # re-screenshot each raster post with antialiasing forced
//   node tools/oracle/raster-e2e.mjs                   # table: harness ratio, antialiased ratio, best shift, slack
//   node tools/oracle/raster-e2e.mjs --json rep.json --dir tmp/e2e --aa tmp/e2e-aa
//
// For every post the harness put in `raster`, this re-runs the harness's own
// comparison (same crop, same masks, ship_pixel_diff) under three conditions:
//
//   delivered      what e2e scores, tolerance 2
//   antialiased    Chrome re-screenshotted with `-webkit-font-smoothing:
//                  antialiased` forced, which removes macOS CoreText dilation,
//                  at tolerance 8 (the tolerance the raster-*.mjs oracles use)
//   slack          the same, but a pixel also counts as matching when a
//                  neighbour within 1 px matches, which absorbs sub-pixel text
//                  placement
//
// The report names the cause per post: dilation, placement, a blank/offset
// Chrome capture, or unexplained. See docs/e2e-raster.md.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, newPage, setContentAs, ROOT, VENDOR } from "./browser.mjs";
import { readPng, decodePng } from "./raster-lib.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);
const REPORT = flag("json", join(ROOT, "tmp", "e2e", "report.json"));
const WORK = flag("dir", join(ROOT, "tmp", "e2e"));
const AA = flag("aa", join(ROOT, "tmp", "e2e-aa"));
const DIFF = process.env.XEET_DIFF_BIN ?? join(process.env.CARGO_TARGET_DIR ?? join(ROOT, "target", "release"), "release", "examples", "ship_pixel_diff");
const DPR = Number(flag("dpr", 2));
const THRESHOLD = Number(flag("max-diff", 0.06));
const TOL_DELIVERED = Number(flag("tolerance", 2));
const TOL_AA = Number(flag("tolerance-aa", 8));

if (!existsSync(REPORT)) {
  console.error(`no harness report at ${REPORT}\n  run: node tools/ship/e2e.mjs --keep --json ${REPORT}`);
  process.exit(2);
}
const report = JSON.parse(readFileSync(REPORT, "utf8"));
const rows = report.results.filter((r) => (r.verdict ?? "").startsWith("raster"));
if (!rows.length) {
  console.log("the report has no raster-bucket posts");
  process.exit(0);
}

// ------------------------------------------------------------------ capture
if (has("take")) {
  mkdirSync(AA, { recursive: true });
  const browser = await launch();
  const byFile = new Map();
  for (const r of rows) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  for (const [file, list] of byFile) {
    const html = readFileSync(join(VENDOR, "corpus", file), "utf8");
    const { page, context } = await newPage(browser, { width: 800, height: 900, dpr: DPR, theme: "light" });
    await setContentAs(page, html, `/i/aa/${file.replace(/\.html$/, "")}`);
    // X's server render hides the timeline until its client reveals it, and the
    // harness aborts every script: reveal the ancestors by hand, as e2e.mjs does.
    await page.evaluate(() => {
      for (const article of document.querySelectorAll("article")) {
        let el = article;
        while (el && el !== document.body) {
          if (getComputedStyle(el).display === "none") el.style.setProperty("display", "block", "important");
          el = el.parentElement;
        }
      }
      void document.body.offsetHeight;
    });
    await page.addStyleTag({ content: "*{-webkit-font-smoothing:antialiased!important}" });
    await page.evaluate(() => void document.body.offsetHeight);
    for (const r of list) {
      const tag = `${file.replace(/\.html$/, "")}-${r.id}`;
      try {
        await page.locator(`article:has(a[href*="/status/${r.id}"])`).first().screenshot({ path: join(AA, `${tag}.png`), animations: "disabled" });
      } catch (e) {
        console.log(`  capture failed for ${tag}: ${String(e).slice(0, 80)}`);
      }
    }
    await context.close();
  }
  await browser.close();
  console.log(`wrote ${AA}/*.png`);
}

// ------------------------------------------------------------------ compare
const pngSize = (p) => {
  const h = readFileSync(p).subarray(0, 24);
  return { w: h.readUInt32BE(16), h: h.readUInt32BE(20) };
};

/** Runs ship_pixel_diff, returning its ratio (and 1 on error). */
function diff(actual, expect, maskPath, crop, tolerance) {
  try {
    return JSON.parse(
      execFileSync(DIFF, ["--actual", actual, "--expect", expect, "--mask", maskPath, "--dpr", String(DPR), "--tolerance", String(tolerance), "--max-diff", String(THRESHOLD), "--crop-actual", crop], { encoding: "utf8" }),
    ).ratio;
  } catch (e) {
    const s = (e.stdout || "").toString().trim();
    return s.startsWith("{") ? JSON.parse(s).ratio : 1;
  }
}

/** Bitmap of the masked device pixels, W×H. */
function maskMap(masks, W, H) {
  const masked = new Uint8Array(W * H);
  for (const r of masks) {
    const x0 = Math.max(0, Math.floor(r.x * DPR));
    const y0 = Math.max(0, Math.floor(r.y * DPR));
    const x1 = Math.min(W, Math.ceil((r.x + r.w) * DPR));
    const y1 = Math.min(H, Math.ceil((r.y + r.h) * DPR));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) masked[y * W + x] = 1;
  }
  return masked;
}

/** Ratio with a 1 px slack: a pixel matches if any neighbour does. */
function diffSlack(actual, expect, masks, crop, tolerance) {
  const chrome = readPng(expect);
  const ours = readPng(actual);
  const [x, y, w, h] = crop.split(",").map(Number);
  const W = Math.min(Math.round(w * DPR), chrome.width);
  const H = Math.min(Math.round(h * DPR), chrome.height);
  const masked = maskMap(masks, W, H);
  const ox = Math.round(x * DPR);
  const oy = Math.round(y * DPR);
  const close = (a, b) => {
    for (let k = 0; k < 4; k++) if (Math.abs(chrome.data[a + k] - ours.data[b + k]) > tolerance) return false;
    return true;
  };
  let counted = 0;
  let differing = 0;
  for (let yy = 0; yy < H; yy++) {
    for (let xx = 0; xx < W; xx++) {
      if (masked[yy * W + xx]) continue;
      counted++;
      const a = (yy * chrome.width + xx) * 4;
      let ok = false;
      for (let dy = -1; dy <= 1 && !ok; dy++) {
        for (let dx = -1; dx <= 1 && !ok; dx++) {
          const nx = xx + ox + dx;
          const ny = yy + oy + dy;
          if (nx < 0 || ny < 0 || nx >= ours.width || ny >= ours.height) continue;
          if (close(a, (ny * ours.width + nx) * 4)) ok = true;
        }
      }
      if (!ok) differing++;
    }
  }
  return counted ? differing / counted : 1;
}

const out = [];
for (const row of rows) {
  const tag = `${row.file.replace(/\.html$/, "")}-${row.id}`;
  const dir = join(WORK, tag);
  const oursPath = join(dir, "ours.png");
  const delivered = join(dir, "chrome.png");
  if (!existsSync(oursPath) || !existsSync(delivered)) continue;
  const aaPath = join(AA, `${tag}.png`);
  const geo = JSON.parse(readFileSync(join(dir, "geometry.json"), "utf8"));
  const masks = JSON.parse(readFileSync(join(dir, "masks.json"), "utf8")).rects;
  const padTop = Math.min(
    ...geo.items.filter((i) => i.kind !== "pop-clip").map((i) => (i.rect ? i.rect.y : Infinity)).filter(Number.isFinite),
    Infinity,
  );
  const shot = pngSize(delivered);
  const crop = `${16},${Number.isFinite(padTop) ? padTop : 0},${shot.w / DPR},${shot.h / DPR}`;
  const masksPath = join(dir, "masks.json");
  // Ink inside the compared (unmasked) region only: placeholders are masked, so
  // a grey placeholder block must not make a blank Chrome capture look full.
  const unmaskedInk = (p) => {
    const img = readPng(p);
    const W = Math.min(Math.round(Number(crop.split(",")[2]) * DPR), img.width);
    const H = Math.min(Math.round(Number(crop.split(",")[3]) * DPR), img.height);
    const masked = maskMap(masks, W, H);
    let ink = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (masked[y * W + x]) continue;
        const o = (y * img.width + x) * 4;
        ink += 255 - Math.min(img.data[o], img.data[o + 1], img.data[o + 2]);
      }
    }
    return ink;
  };
  const shot2 = pngSize(delivered);
  const sameBox = (p2) => {
    const a = pngSize(p2);
    return a.w === shot2.w && a.h === shot2.h;
  };
  const oursInk = unmaskedInk(oursPath);
  const deliveredOk = existsSync(delivered) && unmaskedInk(delivered) > 0.5 * oursInk;
  const aaOk = existsSync(aaPath) && sameBox(aaPath) && unmaskedInk(aaPath) > 0.5 * oursInk;
  out.push({
    tag,
    harness: row.pixels?.ratio ?? null,
    delivered: deliveredOk ? diff(oursPath, delivered, masksPath, crop, TOL_DELIVERED) : null,
    antialiased: aaOk ? diff(oursPath, aaPath, masksPath, crop, TOL_AA) : null,
    slack: aaOk ? diffSlack(oursPath, aaPath, masks, crop, TOL_AA) : null,
  });
}

const pct = (v) => (v == null ? "—" : `${(v * 100).toFixed(1).padStart(5)}%`);
const under = (v) => v != null && v <= THRESHOLD;
let pass = 0;
for (const r of out.sort((a, b) => (b.harness ?? 0) - (a.harness ?? 0))) {
  const verdict = r.delivered == null ? "chrome capture blank/useless"
    : r.slack != null && under(r.slack) ? "dilation + placement"
    : r.antialiased != null && under(r.antialiased) ? "dilation"
    : r.antialiased == null ? "antialiased capture blank/useless"
    : "**unexplained**";
  if (under(r.slack)) pass++;
  console.log(`${r.tag.padEnd(38)} e2e ${pct(r.harness)}  delivered±${TOL_DELIVERED} ${pct(r.delivered)}  antialiased±${TOL_AA} ${pct(r.antialiased)}  slack1 ${pct(r.slack)}  ${verdict}`);
}
console.log(`\n${out.length} posts; ${pass} under the ${THRESHOLD * 100}% budget with dilation removed, tolerance ${TOL_AA} and a 1 px slack.`);
