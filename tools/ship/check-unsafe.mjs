#!/usr/bin/env node
// PLAN.md §13: "Our crates forbid `unsafe`." This is the check that keeps that
// sentence true.
//
//   node tools/ship/check-unsafe.mjs
//
// Rules:
//
// - `xeet-core` and `xeet-text` must carry `#![forbid(unsafe_code)]` and contain
//   no `unsafe` at all.
// - `xeet-wasm` must carry `#![deny(unsafe_code)]` and every file with `unsafe`
//   in it must also carry `#[allow(unsafe_code)]`: the attribute only makes
//   sense where wasm-bindgen's macro expansion needs it, and `deny` (not
//   `forbid`) is what makes that possible. The check prints the exact count, so
//   a new `allow` anywhere is visible in review.
// - Every other crate reports what it has; a binary wrapper with no `unsafe` is
//   fine, one with `unsafe` is a failure.
//
// A text check rather than a compiler flag because it needs no build, so it runs
// in the first CI job and cannot be skipped by someone else's compile error.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CRATES = join(ROOT, "crates");

function rustFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...rustFiles(p));
    else if (entry.name.endsWith(".rs")) out.push(p);
  }
  return out;
}

/** Lines that contain the `unsafe` keyword, not the lint name. */
function unsafeLines(source) {
  return source
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /\bunsafe\b/.test(line.replace(/unsafe_code/g, "")))
    .filter(({ line }) => !/^\s*\/\//.test(line));
}

const problems = [];
const report = [];

for (const crate of readdirSync(CRATES)) {
  const src = join(CRATES, crate, "src");
  try {
    if (!statSync(src).isDirectory()) continue;
  } catch {
    continue;
  }
  const files = rustFiles(src);
  const lib = files.find((f) => f.endsWith("lib.rs"));
  const libText = lib ? readFileSync(lib, "utf8") : "";
  const forbids = /#!\[forbid\(unsafe_code\)\]/.test(libText);
  const denies = /#!\[deny\(unsafe_code\)\]/.test(libText);

  let total = 0;
  const withUnsafe = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const hits = unsafeLines(text);
    if (hits.length === 0) continue;
    total += hits.length;
    const allows = /#\[allow\(unsafe_code\)\]/.test(text);
    withUnsafe.push({ file: relative(ROOT, file), count: hits.length, allows, first: hits[0] });
  }

  const isCore = crate === "xeet-core" || crate === "xeet-text";
  const isGlue = crate === "xeet-wasm";

  if (isCore) {
    if (!forbids) problems.push(`${crate}: lib.rs must carry #![forbid(unsafe_code)]`);
    if (total > 0) problems.push(`${crate}: contains ${total} \`unsafe\` usage(s); this crate must forbid it`);
    else report.push(`${crate}: #![forbid(unsafe_code)], 0 usage`);
  } else if (isGlue) {
    if (!denies) problems.push(`${crate}: lib.rs must carry #![deny(unsafe_code)]`);
    const allows = files.reduce((n, f) => n + (/^#\[allow\(unsafe_code\)\]/m.test(readFileSync(f, "utf8")) ? 1 : 0), 0);
    if (allows === 0) {
      problems.push(`${crate}: no scoped #[allow(unsafe_code)]: wasm-bindgen's generated shims need exactly one, on the ffi module`);
    }
    for (const w of withUnsafe) {
      if (!w.allows) problems.push(`${w.file}: has ${w.count} \`unsafe\` usage(s) without a scoped #[allow(unsafe_code)]`);
      else report.push(`${w.file}: ${w.count} \`unsafe\` behind #[allow(unsafe_code)] (first at line ${w.first.n})`);
    }
    report.push(
      `${crate}: #![deny(unsafe_code)], ${total} \`unsafe\` in source, ${allows} scoped allow(s) for the wasm-bindgen expansion`,
    );
  } else if (total > 0) {
    problems.push(`${crate}: contains ${total} \`unsafe\` usage(s) in a crate that should have none`);
  } else {
    report.push(`${crate}: no \`unsafe\``);
  }
}

for (const r of report) console.log(`unsafe: ${r}`);
for (const p of problems) console.error(`unsafe: FAIL: ${p}`);
if (problems.length) {
  console.error(`unsafe: ${problems.length} problem(s)`);
  console.error("PLAN.md §13 requires the cores to forbid unsafe; only the wasm glue may allow it, in one scoped module.");
  process.exit(1);
}
console.log("unsafe: cores forbid it, the wasm glue confines it to one module");
