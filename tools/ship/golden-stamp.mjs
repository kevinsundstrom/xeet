#!/usr/bin/env node
// Golden stamps: the mechanism behind PLAN.md §11's one principle, "expected
// results only come from the oracle".
//
// A golden (geometry, raster or text goldens under tests/golden/) is never
// accepted because xeet produced it. It is accepted because a stamped oracle
// run produced it, against a known upstream snapshot and a known Chrome. Every
// golden has a sidecar `<golden>.stamp.json`:
//
//   {
//     "golden": "text.json",
//     "sha256": "…",                      // of the golden bytes
//     "cases": 1234,
//     "generatedAt": "2026-11-09T21:00:00.000Z",
//     "oracle": {
//       "script": "tools/oracle/text-parity.mjs",
//       "harnessSha256": "…",             // tools/oracle/ + package.json + lock
//       "chrome": "157.0.8103.39",
//       "chromiumBuild": "1194",
//       "playwright": "1.56.1"
//     },
//     "upstream": { "appVersion": "89824c04…", "stylesheetSha256": "1089…" },
//     "host": "darwin-arm64"
//   }
//
// `--check` (the CI gate) fails when:
//   - a golden has no stamp;
//   - a golden's bytes no longer match its stamp (someone edited the snapshot
//     to make a test pass: exactly the decay the principle exists to prevent);
//   - the stamp names a different upstream snapshot than assets/upstream.lock.json;
//   - the oracle harness changed since the stamp was made (the comparison
//     itself moved, so the goldens have to be re-derived);
//   - the stamp's Chrome is not the pinned Chrome.
//
// `--write` is the only way to make a stamp, and it demands the oracle run's
// own log, so a stamp cannot be typed by hand from a failing test.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, arch } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLDEN_DIR = join(ROOT, "tests", "golden");
const LOCK = join(ROOT, "assets", "upstream.lock.json");
const PIN = join(ROOT, "tools", "ship", "oracle-pin.json");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * The files that actually produce a golden: the oracle script that wrote it,
 * plus every module it reaches through a relative import.
 *
 * This used to hash every script in `tools/oracle/`, which meant editing
 * `cards-parity.mjs` invalidated the text and e2e stamps even though neither
 * golden is produced by it — a stamp that covers files which cannot affect the
 * golden is noise, and noise is what makes people re-stamp without looking. The
 * closure is derived from the imports rather than from a hand-kept list, so it
 * cannot drift when an oracle grows a dependency.
 *
 * `tools/package.json` and the lock are always included: the Chrome that produces
 * every golden comes from there.
 */
export function harnessFiles(entry) {
  const files = new Set();
  const visit = (rel) => {
    if (files.has(rel)) return;
    files.add(rel);
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    const source = readFileSync(abs, "utf8");
    for (const m of source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      const next = relative(ROOT, resolve(dirname(abs), m[1]));
      // Only inside the repository: a golden cannot depend on a package's
      // internals, and those are covered by the lock anyway.
      if (!next.startsWith("..")) visit(next);
    }
  };
  if (entry) visit(entry);
  const extras = ["tools/package.json", "tools/pnpm-lock.yaml"].filter((f) => existsSync(join(ROOT, f)));
  return [...files, ...extras].sort();
}

/** The hash of `harnessFiles(entry)`'s contents: what a stamp records. */
export function harnessHashFor(entry) {
  const files = harnessFiles(entry);
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update(readFileSync(join(ROOT, rel)));
  }
  return h.digest("hex");
}

function upstream() {
  const lock = JSON.parse(readFileSync(LOCK, "utf8"));
  return { appVersion: lock.appVersion, stylesheetSha256: lock.stylesheet?.sha256 ?? null };
}

function pinned() {
  try {
    return JSON.parse(readFileSync(PIN, "utf8"));
  } catch {
    return {};
  }
}

function goldens() {
  if (!existsSync(GOLDEN_DIR)) return [];
  return readdirSync(GOLDEN_DIR)
    .filter((f) => (f.endsWith(".json") || f.endsWith(".png")) && !f.endsWith(".stamp.json"))
    .sort();
}

function stampPath(name) {
  return join(GOLDEN_DIR, `${name}.stamp.json`);
}

function check() {
  const problems = [];
  const notes = [];
  const files = goldens();
  if (files.length === 0) {
    notes.push(`no goldens in ${relative(ROOT, GOLDEN_DIR)} yet; nothing to stamp`);
  }
  const up = upstream();
  const pin = pinned();
  const seenChrome = new Set();

  for (const name of files) {
    const file = join(GOLDEN_DIR, name);
    const sidecar = stampPath(name);
    if (!existsSync(sidecar)) {
      problems.push(`${name}: no stamp. Goldens may only be produced by an oracle run: node tools/ship/golden-stamp.mjs --write --golden tests/golden/${name} --oracle-log <log>`);
      continue;
    }
    let stamp;
    try {
      stamp = JSON.parse(readFileSync(sidecar, "utf8"));
    } catch (e) {
      problems.push(`${name}: the stamp is not valid JSON: ${e.message}`);
      continue;
    }
    const actual = sha256(readFileSync(file));
    if (stamp.sha256 !== actual) {
      problems.push(
        `${name}: the golden changed after it was stamped (stamp ${stamp.sha256.slice(0, 12)}…, file ${actual.slice(0, 12)}…). A failing test is not fixed by editing the snapshot: re-run the oracle and stamp the new file.`,
      );
    }
    if (stamp.upstream?.appVersion !== up.appVersion) {
      problems.push(`${name}: stamped against upstream ${stamp.upstream?.appVersion}, but the lockfile pins ${up.appVersion}`);
    }
    if (up.stylesheetSha256 && stamp.upstream?.stylesheetSha256 !== up.stylesheetSha256) {
      problems.push(`${name}: stamped against stylesheet ${stamp.upstream?.stylesheetSha256}, but the lockfile pins ${up.stylesheetSha256}`);
    }
    if (!stamp.oracle?.script) {
      problems.push(`${name}: the stamp does not name the oracle script that produced it, so what it depends on cannot be known`);
    } else {
      const harness = harnessHashFor(stamp.oracle.script);
      if (stamp.oracle.harnessSha256 !== harness) {
        problems.push(`${name}: the oracle that produces it changed since this stamp (${stamp.oracle.harnessSha256?.slice(0, 12)}… vs ${harness.slice(0, 12)}…; ${stamp.oracle.script} and what it imports); re-run it`);
      }
    }
    if (pin.chrome && stamp.oracle?.chrome && stamp.oracle.chrome !== pin.chrome) {
      problems.push(`${name}: stamped with Chrome ${stamp.oracle.chrome}, but the pin is ${pin.chrome}`);
    }
    if (stamp.oracle?.chrome) seenChrome.add(stamp.oracle.chrome);
  }
  if (seenChrome.size > 1) {
    problems.push(`goldens were produced with more than one Chrome (${[...seenChrome].join(", ")}); re-capture the corpus in one run`);
  }

  for (const n of notes) console.log(`goldens: ${n}`);
  for (const p of problems) console.error(`goldens: FAIL: ${p}`);
  if (problems.length === 0) console.log(`goldens: ${files.length} golden(s) verified against the oracle stamp`);
  return problems.length === 0;
}

function write() {
  const name = flag("golden");
  const logPath = flag("oracle-log");
  if (!name || !logPath) {
    console.error("usage: golden-stamp.mjs --write --golden tests/golden/<file> --oracle-log <path to the oracle run's JSON>");
    return false;
  }
  const file = name.startsWith("/") ? name : join(ROOT, name);
  if (!existsSync(file)) {
    console.error(`goldens: FAIL: ${file} does not exist; the oracle has to produce it first`);
    return false;
  }
  if (!existsSync(logPath)) {
    console.error(`goldens: FAIL: ${logPath} does not exist. A stamp needs the oracle run that produced the golden, so pass the JSON summary the oracle printed (chrome version, case count).`);
    return false;
  }
  const log = JSON.parse(readFileSync(logPath, "utf8"));
  if (!log.chrome && !log.chromeVersion) {
    console.error("goldens: FAIL: the oracle log has no Chrome version; refusing to stamp an unattributed golden");
    return false;
  }
  if (statSync(file).mtimeMs + 1000 < statSync(logPath).mtimeMs - 60_000) {
    console.error("goldens: FAIL: the golden is older than the oracle log; the log does not show that this file was produced");
    return false;
  }
  const up = upstream();
  const pin = pinned();
  if (log.upstream?.appVersion && log.upstream.appVersion !== up.appVersion) {
    console.error(`goldens: FAIL: the oracle ran against upstream ${log.upstream.appVersion}, the lockfile pins ${up.appVersion}`);
    return false;
  }
  const chrome = log.chrome ?? log.chromeVersion;
  if (pin.chrome && chrome !== pin.chrome) {
    console.error(`goldens: FAIL: the oracle ran with Chrome ${chrome}, the pin is ${pin.chrome}. Bump tools/ship/oracle-pin.json only in the oracle-bump job.`);
    return false;
  }
  const bytes = readFileSync(file);
  const stamp = {
    golden: relative(GOLDEN_DIR, file),
    sha256: sha256(bytes),
    cases: log.cases ?? log.samples ?? null,
    generatedAt: new Date().toISOString(),
    oracle: {
      script: log.script ?? null,
      harnessSha256: harnessHashFor(log.script ?? null),
      chrome,
      chromiumBuild: log.chromiumBuild ?? pin.chromiumBuild ?? null,
      playwright: log.playwright ?? pin.playwright ?? null,
    },
    upstream: up,
    host: `${platform()}-${arch()}`,
  };
  const out = stampPath(relative(GOLDEN_DIR, file));
  writeFileSync(out, JSON.stringify(stamp, null, 2) + "\n");
  console.log(`goldens: stamped ${relative(ROOT, file)} (${stamp.sha256.slice(0, 12)}…)`);
  console.log(`goldens: wrote ${relative(ROOT, out)}`);
  return true;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain && args.includes("--explain")) {
  const entry = args[args.indexOf("--explain") + 1];
  for (const f of harnessFiles(entry)) console.log(`  ${f}`);
  process.exit(0);
}
if (isMain) {
  const ok = args.includes("--write") ? write() : check();
  process.exit(ok ? 0 : 1);
}
