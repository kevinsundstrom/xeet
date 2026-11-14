#!/usr/bin/env node
// Runs every raster oracle in series and prints one summary.
//
//   node tools/oracle/raster-all.mjs [--dpr 2] [--smoke]
//
// Each oracle compares xeet's painter against Chrome for one class of item:
//
//   raster-text     glyph rasterization (line breaks come from the text engine)
//   raster-shapes   rounded rects, squircles, borders, clips
//   raster-icons    X's SVG sprite
//   raster-emoji    color emoji placement, artwork and palette
//   raster-images   decode, cover-crop and scale
//
// On Linux CI this is the raster gate. On macOS, Chrome draws text through
// CoreText, which dilates glyphs unless the page sets
// `-webkit-font-smoothing: antialiased`; the text oracle always sets it, and
// `--smoothing none` measures the dilation for the record.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const dpr = flag("dpr", "2");
const smoke = args.includes("--smoke");

// Gates. PLAN §4 sets the raster gate against Chrome on Linux at 2× with
// hinting off: 99.9% of pixels within a small tolerance. macOS Chrome draws
// text through CoreText, whose glyphs are slightly heavier and differently
// anti-aliased, so on macOS the floor is lower and the Linux numbers are the
// ones that count; the oracles print the measured value either way.
const onLinux = process.platform === "linux";
const gate = (linuxGate, macGate) => String(process.env.XEET_RASTER_GATE ? Number(process.env.XEET_RASTER_GATE) : onLinux ? linuxGate : macGate);
const runs = [
  ["raster-text.mjs", ["--dpr", dpr, "--fuzz", smoke ? "6" : "30", "--n", smoke ? "6" : "30", "--smoothing", "antialiased", "--gate", gate(99.9, 97.5)]],
  ["raster-shapes.mjs", ["--dpr", dpr, "--gate", gate(99.9, 99.5)]],
  ["raster-icons.mjs", ["--dpr", "4", "--gate", gate(99.9, 99.0)]],
  ["raster-emoji.mjs", ["--dpr", "4"]],
  ["raster-images.mjs", ["--dpr", dpr, "--gate", gate(95, 93.5)]],
];

function run(script, scriptArgs) {
  return new Promise((resolve) => {
    // Let each oracle resolve its own binary: the text one needs paint_text,
    // the geometry ones paint_fixture.
    const env = { ...process.env };
    delete env.XEET_PAINT;
    const child = spawn(process.execPath, [join(here, script), ...scriptArgs], { stdio: ["ignore", "pipe", "inherit"], env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => {
      let report = null;
      try {
        report = JSON.parse(out);
      } catch {
        // keep the raw output for the summary
      }
      resolve({ script, code, report, raw: out.slice(-400) });
    });
  });
}

const results = [];
for (const [script, scriptArgs] of runs) {
  process.stderr.write(`> ${script}\n`);
  results.push(await run(script, scriptArgs));
}

const summary = results.map((r) => ({
  oracle: r.script,
  exit: r.code,
  withinPct: r.report?.withinPct ?? null,
  outsideEdges: r.report?.differingOutsideEdges ?? r.report?.differingOutsideEdgesPct ?? null,
  extra: r.report?.emojiWithinPct != null ? { emojiWithinPct: r.report.emojiWithinPct } : undefined,
}));
console.log(JSON.stringify({ dpr, platform: process.platform, linuxGates: onLinux, summary }, null, 1));
process.exit(summary.every((s) => s.exit === 0) ? 0 : 1);
