#!/usr/bin/env node
// Chrome replica <-> xeet layout + pixel parity gate on the 4 iconic posts:
//   - iconic-nasa-goddard.json    (928356699043491842: space field + 8 Apple emojis)
//   - iconic-mw-whataboutism.json (908706514302570497: ⚪️/🔘 radio buttons + card)
//   - iconic-mw-anyways.json      (905445022878879744: ┻┳| brick wall + •.•) / ⊂ﾉ + card)
//   - iconic-pizzahut.json        (928347864471875585: <) )╯ dancing figure + 22 🍕)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./browser.mjs";
import { createChrome } from "../playground/lib/chrome.mjs";
import { readPng, diff } from "./raster-lib.mjs";

const FIXTURES = [
  "iconic-nasa-goddard.json",
  "iconic-mw-whataboutism.json",
  "iconic-mw-anyways.json",
  "iconic-pizzahut.json",
];
const WIDTHS = [320, 390, 600];
const SURFACES = ["web-timeline", "web-detail"];
const MAX_PIXEL_DIFF = process.platform === "darwin" ? 0.03 : 0.005;

const xeetRender =
  process.env.XEET_RENDER_BIN ??
  join(ROOT, "target", "playground", "fast", "xeet-render");

const tmpDir = join(ROOT, "tmp", "iconic-parity");
mkdirSync(tmpDir, { recursive: true });
let passed = 0;
let failed = 0;
const oracle = await createChrome();

try {
  for (const file of FIXTURES) {
    const post = JSON.parse(
      readFileSync(join(ROOT, "tests", "fixtures", "posts", file), "utf8"),
    );
    for (const surface of SURFACES) {
      for (const width of WIDTHS) {
        const options = {
          surface,
          width,
          theme: "light",
          dpr: 2,
          fontScale: 1,
        };
        const chrome = await oracle.render({
          post,
          options: { ...options, smoothing: "antialiased" },
          mode: "replica",
        });
        const xeetPngBuf = execFileSync(
          xeetRender,
          [
            "render",
            "-",
            "--surface",
            surface,
            "--width",
            String(width),
            "--theme",
            "light",
            "--dpr",
            "2",
          ],
          { input: JSON.stringify(post), maxBuffer: 32 * 1024 * 1024 },
        );
        const cPath = join(tmpDir, `${file}-${surface}-${width}-chrome.png`);
        const xPath = join(tmpDir, `${file}-${surface}-${width}-xeet.png`);
        writeFileSync(
          cPath,
          Buffer.isBuffer(chrome.png) ? chrome.png : Buffer.from(chrome.png, "base64"),
        );
        writeFileSync(xPath, xeetPngBuf);
        const cImg = readPng(cPath);
        const xImg = readPng(xPath);
        const dh = Math.abs(Math.ceil(chrome.height) - Math.round(xImg.height / 2));
        const hCrop = Math.min(cImg.height, xImg.height);
        const cCrop = { width: cImg.width, height: hCrop, data: cImg.data.subarray(0, cImg.width * hCrop * 4) };
        const xCrop = { width: xImg.width, height: hCrop, data: xImg.data.subarray(0, xImg.width * hCrop * 4) };
        const d = diff(cCrop, xCrop, { tolerance: 16 });
        const pct = 1 - d.withinPct / 100;
        const ok = dh <= 1 && pct <= MAX_PIXEL_DIFF;
        if (ok) passed++;
        else failed++;
        console.log(
          `${ok ? "ok  " : "FAIL"} ${file.replace(".json", "").padEnd(24)} ${surface.padEnd(13)} w=${width}  h=${chrome.height}/${xImg.height / 2}  px=${(pct * 100).toFixed(2)}%`,
        );
      }
    }
  }
} finally {
  await oracle.close();
}

console.log(`\niconic parity: ${passed}/${passed + failed} passed (budget ${(MAX_PIXEL_DIFF * 100).toFixed(1)}%)`);
if (failed > 0) process.exit(1);
