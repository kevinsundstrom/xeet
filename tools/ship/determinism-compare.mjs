#!/usr/bin/env node
// Compares the determinism artifacts one job per platform uploaded (PLAN.md §11:
// "identical bytes on Linux x64, Linux arm64 and macOS").
//
//   node tools/ship/determinism-compare.mjs [dir]
//
// Each artifact is `determinism-<platform>.json` written by
// `tools/ship/determinism.mjs`: `{ machine, cases: [{ fixture, width, theme,
// dpr, sha256 }] }`. Every case must hash the same on every platform that
// produced it.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".";
const files = readdirSync(dir).filter((f) => f.startsWith("determinism-") && f.endsWith(".json"));

if (files.length === 0) {
  console.error("determinism-compare: no determinism-*.json artifacts found");
  process.exit(1);
}
if (files.length === 1) {
  console.error(`determinism-compare: only ${files[0]} — determinism across platforms needs at least two`);
  process.exit(1);
}

const seen = new Map();
let bad = 0;
let total = 0;
for (const file of files.sort()) {
  const { machine, cases } = JSON.parse(readFileSync(join(dir, file), "utf8"));
  for (const c of cases) {
    total++;
    const key = `${c.fixture}|${c.width}|${c.theme}|${c.dpr}`;
    const prev = seen.get(key);
    if (prev && prev.sha256 !== c.sha256) {
      bad++;
      console.error(`DIFF ${key}: ${prev.machine} ${prev.sha256} vs ${machine} ${c.sha256}`);
    } else if (!prev) {
      seen.set(key, { ...c, machine });
    }
  }
  console.log(`${machine}: ${cases.length} cases`);
}

if (bad) {
  console.error(`${bad} cross-platform difference(s) of ${total}`);
  process.exit(1);
}
console.log(`all ${seen.size} cases identical on ${files.length} platforms`);
