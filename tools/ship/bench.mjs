#!/usr/bin/env node
// Benchmarks, against the budgets in PLAN.md §12.
//
//   node tools/ship/bench.mjs                 # measure and check
//   node tools/ship/bench.mjs --save-baseline # also record this run
//   node tools/ship/bench.mjs --max-regression 1.3
//   node tools/ship/bench.mjs --skip-cold-start
//
// Two halves: the Rust example measures the in-process rows; this script
// measures what an example cannot (the cold start of the real binary and the
// size of the stripped binary), then compares everything with
// `bench-budgets.json`.
//
// The budgets are absolute; the baseline is relative. An absolute budget
// catches "we got slower than the product allows", the baseline catches "we
// got 40% slower on this machine" even when the machine is fast enough to hide
// it. The baseline is machine-tagged: a baseline recorded on a different host
// or CPU count is compared but not enforced.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUDGETS = JSON.parse(readFileSync(join(ROOT, "bench-budgets.json"), "utf8"));
const BASELINE_PATH = join(ROOT, "bench-baseline.json");
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? join(ROOT, "target", "ship-bench");

const args = process.argv.slice(2);
const flag = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] ?? true : d;
};
const maxRegression = Number(flag("max-regression", 1.25));
const saveBaseline = args.includes("--save-baseline");

const machine = {
  os: platform(),
  arch: arch(),
  cpus: cpus().length,
  // Deliberately coarse: the point is "same kind of machine", not a benchmark
  // identity. CI sets XEET_BENCH_MACHINE to the runner label.
  label: process.env.XEET_BENCH_MACHINE ?? `${platform()}-${arch()}-${cpus().length}cpu`,
};

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

const failures = [];
const warnings = [];
const results = { rows: {}, cold_start_us: null, binary_bytes: null };

// --- The in-process rows -----------------------------------------------------
console.log("bench: building the example (release)…");
// Measure the layout that ships: the core binary plus lazy packs, not a local
// build that embeds all 41 MB of fonts.
const buildEnv = {
  ...process.env,
  CARGO_TARGET_DIR: TARGET_DIR,
  XEET_FONT_PACKS: process.env.XEET_FONT_PACKS ?? "core",
};
run("cargo", ["build", "--release", "--example", "ship_bench", "--target-dir", TARGET_DIR], {
  stdio: ["ignore", "ignore", "inherit"],
  env: buildEnv,
});
const out = run(join(TARGET_DIR, "release", "examples", "ship_bench"), [], { stdio: ["ignore", "pipe", "inherit"] });
const json = out.slice(out.indexOf("{"));
const measured = JSON.parse(json);
results.rows = measured.rows;

// --- Binary size ------------------------------------------------------------
console.log("bench: building the CLI (release) for size and cold start…");
run("cargo", ["build", "--release", "--bin", "xeet-render", "--target-dir", TARGET_DIR], {
  stdio: ["ignore", "ignore", "inherit"],
  env: buildEnv,
});
const binary = join(TARGET_DIR, "release", "xeet-render");
results.binary_bytes = statSync(binary).size;
if (results.binary_bytes > BUDGETS.binary_bytes.max) {
  failures.push(`binary_bytes: ${fmtBytes(results.binary_bytes)} > ${fmtBytes(BUDGETS.binary_bytes.max)}`);
} else if (results.binary_bytes > BUDGETS.binary_bytes.max * 0.9) {
  warnings.push(`binary_bytes is at ${(results.binary_bytes / BUDGETS.binary_bytes.max * 100).toFixed(0)}% of the budget`);
}

// --- Cold start -------------------------------------------------------------
if (!flag("skip-cold-start", false)) {
  const fixture = join(ROOT, "tests", "fixtures", "posts", "text-simple.json");
  const devnull = platform() === "win32" ? "NUL" : "/dev/null";
  const samples = [];
  for (let i = 0; i < 15; i++) {
    const t = process.hrtime.bigint();
    const r = spawnSync(binary, ["render", fixture, "--width", "390", "--dpr", "1", "-o", devnull], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "pipe"],
    });
    samples.push(Number(process.hrtime.bigint() - t) / 1000);
    if (r.status !== 0) {
      failures.push(`cold start: the binary exited ${r.status}: ${String(r.stderr).slice(0, 400)}`);
      break;
    }
  }
  samples.sort((a, b) => a - b);
  results.cold_start_us = samples[Math.floor(samples.length / 2)] ?? null;
}

// --- Compare ----------------------------------------------------------------
for (const [name, row] of Object.entries(results.rows)) {
  const budget = BUDGETS.rows[name];
  if (!budget) {
    warnings.push(`${name}: no budget recorded in bench-budgets.json`);
    continue;
  }
  if (row.p50_us > budget.p50_us) {
    failures.push(`${name}: p50 ${row.p50_us.toFixed(0)} µs > budget ${budget.p50_us} µs (${budget.what})`);
  } else if (row.p50_us > budget.p50_us * 0.8) {
    warnings.push(`${name}: p50 ${row.p50_us.toFixed(0)} µs is ${(row.p50_us / budget.p50_us * 100).toFixed(0)}% of its budget`);
  }
}
if (results.cold_start_us != null && results.cold_start_us > BUDGETS.cold_start_us.p50_us) {
  failures.push(`cold_start: ${(results.cold_start_us / 1000).toFixed(2)} ms > budget ${BUDGETS.cold_start_us.p50_us / 1000} ms`);
}

// Relative check, against the recorded baseline when it is comparable.
let baseline = null;
if (existsSync(BASELINE_PATH)) baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const comparable = baseline && baseline.machine?.label === machine.label;
if (baseline && !comparable) {
  warnings.push(`baseline was recorded on ${baseline.machine?.label}; relative regression is not enforced`);
}

function relative(now, then, what) {
  if (!comparable || typeof then !== "number" || typeof now !== "number" || then <= 0) return;
  const ratio = now / then;
  if (ratio > maxRegression) failures.push(`${what}: ${ratio.toFixed(2)}× the baseline (${then.toFixed(0)} → ${now.toFixed(0)})`);
  else if (ratio > 1.15) warnings.push(`${what}: ${ratio.toFixed(2)}× the baseline`);
}
for (const [name, row] of Object.entries(results.rows)) {
  relative(row.p50_us, baseline?.rows?.[name]?.p50_us, name);
}
relative(results.cold_start_us, baseline?.cold_start_us, "cold_start");
relative(results.binary_bytes, baseline?.binary_bytes, "binary_bytes");

// --- Report -----------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log("");
console.log(`${pad("row", 24)}${pad("p50", 12)}${pad("p90", 12)}${pad("budget", 12)}status`);
for (const [name, row] of Object.entries(results.rows)) {
  const budget = BUDGETS.rows[name]?.p50_us;
  const ok = budget == null || row.p50_us <= budget;
  console.log(
    `${pad(name, 24)}${pad(`${row.p50_us.toFixed(0)} µs`, 12)}${pad(`${row.p90_us.toFixed(0)} µs`, 12)}${pad(budget != null ? `${budget} µs` : "—", 12)}${ok ? "ok" : "OVER"}`,
  );
}
if (results.cold_start_us != null) {
  console.log(`${pad("cold_start (spawn)", 24)}${pad(`${(results.cold_start_us / 1000).toFixed(2)} ms`, 12)}${pad("", 12)}${pad(`${BUDGETS.cold_start_us.p50_us / 1000} ms`, 12)}${results.cold_start_us <= BUDGETS.cold_start_us.p50_us ? "ok" : "OVER"}`);
}
console.log(`${pad("binary size", 24)}${pad(fmtBytes(results.binary_bytes), 12)}${pad("", 12)}${pad(fmtBytes(BUDGETS.binary_bytes.max), 12)}${results.binary_bytes <= BUDGETS.binary_bytes.max ? "ok" : "OVER"}`);
console.log("");

for (const w of warnings) console.log(`bench: warning: ${w}`);
for (const f of failures) console.error(`bench: FAIL: ${f}`);

if (saveBaseline && failures.length === 0) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify({ recordedAt: new Date().toISOString(), machine, rows: results.rows, cold_start_us: results.cold_start_us, binary_bytes: results.binary_bytes }, null, 2) + "\n",
  );
  console.log(`bench: baseline written to ${BASELINE_PATH}`);
}

if (failures.length) {
  console.error(`bench: ${failures.length} budget violation(s)`);
  process.exit(1);
}
console.log("bench: all budgets met");

function fmtBytes(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(0)} kB`;
}
