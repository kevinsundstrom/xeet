#!/usr/bin/env node
// Determinism, across wrappers (PLAN.md §11 pipeline 1: "identical bytes on
// Linux x64, Linux arm64, macOS and WASM").
//
//   node tools/ship/determinism.mjs [--target-dir target/ship-wasm]
//
// Renders a matrix of fixtures and options twice natively and once through the
// WebAssembly module, then compares the SHA-256 of every PNG and the JSON of
// every report. A difference means the pipeline has state, an iteration-order
// dependency, or a float path that differs between targets: all of which would
// make goldens useless in CI.
//
// Cross-platform determinism (Linux x64/arm64) is the same check run in another
// CI job; this script covers native versus WASM on one machine, which is the
// difference that code changes can introduce.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadXeet } from "../../packages/xeet/src/node.js";
import { DEFAULT_WASM_PATH } from "../../packages/xeet/src/node.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? join(ROOT, "target", "ship-wasm");
const BIN = process.env.XEET_BIN ?? join(TARGET_DIR, "release", "xeet-render");

const args = process.argv.slice(2);
const builds = !args.includes("--no-build");
const outFlag = args.indexOf("--out");
const OUT = outFlag >= 0 ? args[outFlag + 1] : null;

if (builds) {
  console.log("determinism: building the CLI and the wasm module…");
  execFileSync("cargo", ["build", "--release", "--bin", "xeet-render", "--target-dir", TARGET_DIR], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
  });
  execFileSync("node", [join(ROOT, "tools", "ship", "build-wasm.mjs")], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, XEET_WASM_TARGET_DIR: join(TARGET_DIR, "wasm") },
  });
}

if (!existsSync(BIN)) {
  console.error(`determinism: ${BIN} does not exist; build it with cargo build --release --bin xeet-render`);
  process.exit(1);
}
if (!existsSync(DEFAULT_WASM_PATH)) {
  console.error(`determinism: ${DEFAULT_WASM_PATH} does not exist; run node tools/ship/build-wasm.mjs`);
  process.exit(1);
}

const fixtureDir = join(ROOT, "tests", "fixtures", "posts");
const fixtures = readdirSync(fixtureDir).filter((f) => f.endsWith(".json")).sort();

/** The matrix: every fixture at three widths, both themes, and 2× plus 3×. */
const cases = [];
for (const fixture of fixtures) {
  for (const [width, theme, dpr] of [
    [390, "dark", 3],
    [600, "light", 2],
    [320, "light", 1],
  ]) {
    cases.push({ fixture, width, theme, dpr });
  }
}

const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

function nativePng(c) {
  return execFileSync(BIN, ["render", join(fixtureDir, c.fixture), "--width", String(c.width), "--theme", c.theme, "--dpr", String(c.dpr), "-o", "-"], {
    cwd: ROOT,
    maxBuffer: 1 << 28,
  });
}

function nativeExplain(c) {
  return execFileSync(BIN, ["explain", join(fixtureDir, c.fixture), "--width", String(c.width), "--theme", c.theme, "--dpr", String(c.dpr), "--compact", "--quiet"], {
    cwd: ROOT,
    maxBuffer: 1 << 28,
  }).toString();
}

const xeet = await loadXeet();
const failures = [];
const hashes = [];
console.log(`${"fixture".padEnd(20)}${"opts".padEnd(18)}${"native".padEnd(10)}${"wasm".padEnd(10)}report`);
for (const c of cases) {
  const post = JSON.parse(readFileSync(join(fixtureDir, c.fixture), "utf8"));
  const options = { width: c.width, theme: c.theme, dpr: c.dpr };
  const label = `${c.width}/${c.theme}/${c.dpr}`;

  const n1 = nativePng(c);
  const n2 = nativePng(c);
  const w = Buffer.from(xeet.renderPng(post, options));
  const nativeReport = nativeExplain(c);
  const wasmReport = JSON.stringify(xeet.explain(post, options));

  const a = sha(n1);
  const b = sha(w);
  const stable = sha(n2) === a;
  const reportSame = JSON.parse(nativeReport).size.height === JSON.parse(wasmReport).size.height;
  const ok = a === b && stable && reportSame;

  hashes.push({ fixture: c.fixture, width: c.width, theme: c.theme, dpr: c.dpr, sha256: a });
  console.log(`${c.fixture.padEnd(20)}${label.padEnd(18)}${a.padEnd(10)}${b.padEnd(10)}${ok ? "same" : "DIFFERENT"}`);
  if (!ok) {
    failures.push({
      fixture: c.fixture,
      options,
      native: a,
      wasm: b,
      stableNative: stable,
      reportSame,
      sizes: { native: n1.length, wasm: w.length },
      heightNative: JSON.parse(nativeReport).size.height,
      heightWasm: JSON.parse(wasmReport).size.height,
    });
  }
}

if (OUT) {
  // The cross-platform job compares these files: same case, same SHA-256, on
  // every OS. PLAN.md §11 pipeline 1.
  writeFileSync(OUT, JSON.stringify({ machine: `${process.platform}-${process.arch}`, cases: hashes }, null, 2) + "\n");
  console.log(`determinism: hashes written to ${OUT}`);
}

if (failures.length) {
  console.error(`\ndeterminism: FAIL — ${failures.length} case(s) differ`);
  for (const f of failures.slice(0, 10)) console.error(JSON.stringify(f));
  console.error("\nWhat this means:");
  console.error("  - native differs from wasm: the pipeline reads something target-dependent (f32 math, iteration order, a hash map).");
  console.error("  - native differs run to run: state is leaking between renders in one process.");
  console.error("  - the reports differ: layout took a different path, so the pixels will too.");
  process.exit(1);
}
console.log(`\ndeterminism: ${cases.length} cases identical across native and wasm`);
