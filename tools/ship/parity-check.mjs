#!/usr/bin/env node
// Layout parity against stored goldens, with no Chrome and no network.
//
//   node tools/ship/parity-check.mjs [--golden tests/golden/text.json] [--max 20]
//
// The goldens are the ones `tools/oracle/text-parity.mjs --save` writes: Chrome's
// own line boxes for each case. This script lays out the same cases with
// `xeet debug-text` and compares line breaks, block height, and line x/width.
// It is the offline half of the text gate; the live half is the oracle run that
// produces the goldens in the first place.
//
// Line breaks are exact. Positions are compared at 1/64 px, Chrome's own layout
// unit ("every glyph run and box within 1/64 px", PLAN.md §4).
//
// Line *widths* get a wider allowance, 4/64 px, for a reason: a line's width is
// the sum of every glyph advance, and Chrome reports it through
// `getClientRects()`, which quantizes again. Two sub-1/64 errors per run add up,
// so a whole-line width that is off by 2-3/64 px is compatible with every run
// being inside 1/64. The gate still catches a real width difference (a wrong
// advance, kerning or letter-spacing shows up as whole pixels); it just does not
// fail on summation. `maxLineWidthDelta` is reported either way.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const flag = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const goldenPath = join(ROOT, flag("golden", "tests/golden/text.json"));
const maxFailures = Number(flag("max", "20"));
const TOL = 1 / 64 + 1e-6;
const WIDTH_TOL = 4 / 64 + 1e-6;
const bin = process.env.XEET_BIN ?? join(ROOT, "target", "ship-wasm", "release", "xeet");
const help = args.includes("--help");

if (help) {
  console.log("usage: parity-check.mjs [--golden tests/golden/text.json] [--max 20]  (XEET_BIN=path/to/xeet)");
  process.exit(0);
}
if (!existsSync(goldenPath)) {
  console.log(`parity: no goldens at ${goldenPath}; run the oracle first: node tools/oracle/text-parity.mjs --save ${flag("golden", "tests/golden/text.json")}`);
  process.exit(0);
}
if (!existsSync(bin)) {
  console.error(`parity: ${bin} does not exist. Build it (cargo build --release --bin xeet) or set XEET_BIN.`);
  process.exit(1);
}

const cases = JSON.parse(readFileSync(goldenPath, "utf8"));
if (!Array.isArray(cases) || cases.length === 0) {
  console.error("parity: the golden file is empty or not an array");
  process.exit(1);
}

// Group by the layout the case was captured at.
const groups = new Map();
for (const c of cases) {
  const key = `${c.width}|${c.size}|${c.lh}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(c);
}

const strip = (s) => s.replace(/ +$/, "");
let total = 0;
let lineMismatches = 0;
let heightMismatches = 0;
let geometryMismatches = 0;
let maxDx = 0;
let maxDw = 0;
const failures = [];

for (const [key, group] of groups) {
  const [width, size, lh] = key.split("|");
  const texts = group.map((c) => c.text);
  const out = JSON.parse(
    execFileSync(bin, ["debug-text", "--width", width, "--size", size, "--lh", lh], {
      input: JSON.stringify(texts),
      maxBuffer: 1 << 28,
    }).toString(),
  );
  if (out.length !== group.length) {
    failures.push({ width, reason: "the binary returned a different number of blocks", expected: group.length, got: out.length });
    continue;
  }
  for (let i = 0; i < group.length; i++) {
    total++;
    const want = group[i];
    const got = out[i];
    const wantLines = want.lines.map((l) => strip(l.text));
    const gotLines = got.lines.map((l) => strip(l.text));
    const sameLines = wantLines.length === gotLines.length && wantLines.every((t, k) => t === gotLines[k]);
    if (!sameLines) {
      lineMismatches++;
      const k = wantLines.findIndex((t, j) => t !== gotLines[j]);
      if (failures.length < maxFailures) {
        failures.push({
          width: Number(width),
          text: want.text.slice(0, 80),
          line: k,
          expected: wantLines[k],
          actual: gotLines[k],
          expectedLines: wantLines.length,
          actualLines: gotLines.length,
        });
      }
      continue;
    }
    if (Math.abs(want.height - got.height) > TOL) {
      heightMismatches++;
      if (failures.length < maxFailures) {
        failures.push({ width: Number(width), text: want.text.slice(0, 80), expectedHeight: want.height, actualHeight: got.height });
      }
    }
    for (let k = 0; k < want.lines.length; k++) {
      const dx = Math.abs(want.lines[k].x - got.lines[k].x);
      const dw = Math.abs(want.lines[k].w - got.lines[k].w);
      maxDx = Math.max(maxDx, dx);
      maxDw = Math.max(maxDw, dw);
      if (dx > TOL || dw > WIDTH_TOL) {
        geometryMismatches++;
        if (failures.length < maxFailures) {
          failures.push({
            width: Number(width),
            text: want.text.slice(0, 60),
            line: k,
            dx: +dx.toFixed(4),
            dw: +dw.toFixed(4),
            expected: { x: want.lines[k].x, w: want.lines[k].w },
            actual: { x: got.lines[k].x, w: got.lines[k].w },
          });
        }
      }
    }
  }
}

const summary = {
  golden: flag("golden", "tests/golden/text.json"),
  cases: total,
  layouts: groups.size,
  lineBreakMismatches: lineMismatches,
  heightMismatches,
  geometryMismatches,
  maxLineXDelta: +maxDx.toFixed(4),
  maxLineWidthDelta: +maxDw.toFixed(4),
  tolerance: +TOL.toFixed(6),
  widthTolerance: +WIDTH_TOL.toFixed(6),
};
for (const f of failures) console.log(JSON.stringify(f));
console.log(JSON.stringify(summary, null, 1));

// PLAN.md §4: the Layout gate is zero line-break differences and every box
// within 1/64 px. Anything less is a failure, not a warning.
if (lineMismatches || heightMismatches || geometryMismatches) {
  console.error(
    `parity: FAIL — ${lineMismatches} line-break, ${heightMismatches} height, ${geometryMismatches} geometry mismatch(es) over ${total} cases`,
  );
  process.exit(1);
}
console.log(`parity: ${total} cases identical to the stored Chrome geometry`);
