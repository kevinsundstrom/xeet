// Builds, artifacts, and what "stale" means for each target.
//
// Every target is one artifact on disk plus a meta file that says which
// revision built it. The playground owns two build commands:
//
//   native   CARGO_TARGET_DIR=target/playground cargo build --profile fast \
//              -p xeet-cli --bin xeet-render
//   wasm/http  node tools/ship/build-wasm.mjs        (both wasm-bindgen flavours)
//
// `wasm` and `http` are the same build (the browser glue and the Node glue come
// out of one `wasm-bindgen` run), so they share one job; whichever target asked
// gets its own meta file.
//
// ## Staleness
//
// A target is stale when its artifact is missing or older than the newest
// source that goes into it: everything under `crates/`, the workspace manifests,
// the pinned upstream snapshot, and the two vendored inputs that change what the
// renderer draws (the font manifest and X's design tokens/rules). The scan is a
// walk of a few hundred files cached for a second, because `/api/targets` is
// polled by a UI that must stay responsive while someone types.
//
// The git revision is compared too: the artifact's meta records the rev it was
// built from, and a checkout that moves makes an unchanged artifact stale even
// when mtime granularity says nothing happened.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The playground's own CARGO_TARGET_DIR (never target/{fast,release,debug}). */
export const TARGET_DIR = join(ROOT, "target", "playground");
export const META_DIR = join(TARGET_DIR, "meta");
export const NATIVE_PROFILE = "fast";
export const NATIVE_BIN = join(TARGET_DIR, NATIVE_PROFILE, "xeet-render");
export const NATIVE_SIDECAR = `${NATIVE_BIN}.meta.json`;
export const NODE_WASM_DIR = join(ROOT, "packages", "xeet", "wasm");
export const WEB_WASM_DIR = join(NODE_WASM_DIR, "web");
export const NODE_WASM = join(NODE_WASM_DIR, "xeet_wasm_bg.wasm");
export const NODE_GLUE = join(NODE_WASM_DIR, "xeet_wasm.js");
export const WEB_WASM = join(WEB_WASM_DIR, "xeet_wasm_bg.wasm");
export const WEB_GLUE = join(WEB_WASM_DIR, "xeet_wasm.js");
export const UPSTREAM_LOCK = join(ROOT, "assets", "upstream.lock.json");
export const PLAYGROUND_CACHE = join(ROOT, "assets", "vendor", "playground");

/** Build targets, as `POST /api/build` names them. */
export const BUILDABLE = ["native", "http", "wasm"];

const META_FILE = {
  native: join(META_DIR, "native.json"),
  http: join(META_DIR, "http.json"),
  wasm: join(META_DIR, "wasm.json"),
  chrome: join(META_DIR, "chrome.json"),
};

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

let gitCache = null;

/** The checkout's revision, dirty flag and subject, cached for two seconds. */
export function gitInfo() {
  // Discovery is the expensive part (`git status` on a big tree with untracked
  // build output), and a version badge does not need sub-second freshness; a
  // render that pays 80 ms for it once a second would jitter the keystroke.
  // The tree watcher and every build invalidate this, so a real change shows up
  // immediately; the timeout only covers edits outside `crates/` and `assets/`.
  if (gitCache && Date.now() - gitCache.at < 15000) return gitCache.value;
  const run = (args) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let value;
  try {
    value = {
      rev: run(["rev-parse", "--short", "HEAD"]),
      dirty: run(["status", "--porcelain"]).length > 0,
      subject: run(["log", "-1", "--pretty=%s"]),
    };
  } catch {
    value = { rev: "unknown", dirty: false, subject: "" };
  }
  gitCache = { at: Date.now(), value };
  return value;
}

/** Drops the git cache so the next read reflects a commit made just now. */
export function invalidateGit() {
  gitCache = null;
}

/** The upstream snapshot every target follows, from `assets/upstream.lock.json`. */
export function upstream() {
  try {
    const lock = JSON.parse(readFileSyncCached(UPSTREAM_LOCK));
    return { appVersion: lock.appVersion ?? null, fetchedAt: lock.fetchedAt ?? null };
  } catch {
    return { appVersion: null, fetchedAt: null };
  }
}

/**
 * The ruleset id the renderers carry: `x-web@<first 8 of app version>`, exactly
 * as `xeet_core::render::ruleset_id` formats it. Read from the rules file the
 * crates embed, so a UI badge agrees with a report without a render.
 */
export function rulesetId() {
  try {
    const rules = JSON.parse(readFileSyncCached(join(ROOT, "crates", "xeet-core", "rules", "x-web.json")));
    return `${rules.id}@${String(rules.appVersion ?? "").slice(0, 8)}`;
  } catch {
    return null;
  }
}

function readFileSyncCached(path) {
  // This runs on every /api/targets; a one-second memo keeps three small reads
  // off the hot path.
  const now = Date.now();
  readFileSyncCached.cache ??= new Map();
  const hit = readFileSyncCached.cache.get(path);
  if (hit && now - hit.at < 1000) return hit.text;
  const text = readFileSync(path, "utf8");
  readFileSyncCached.cache.set(path, { at: now, text });
  return text;
}

// ---------------------------------------------------------------------------
// The source scan
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "target", ".git", "tmp", "dist", ".DS_Store"]);

/** Files outside `crates/` that still change the artifacts. */
const EXTRA_SOURCES = [
  "Cargo.toml",
  "Cargo.lock",
  "assets/upstream.lock.json",
  "assets/rules.lock.json",
  // What the renderer draws with: the font set and X's own tokens/rules.
  "assets/vendor/fonts/manifest.json",
  "assets/vendor/tokens.json",
  "assets/vendor/icons.json",
];

let scanCache = null;

/**
 * The newest mtime among the sources, in milliseconds, with the file that has
 * it. Cached for a second: a typing UI asks for targets far more often than the
 * tree changes.
 */
export function sourceSnapshot() {
  if (scanCache && Date.now() - scanCache.at < 1000) return scanCache.value;
  let newest = 0;
  let newestPath = null;
  const bump = (path) => {
    try {
      const mtime = statSync(path).mtimeMs;
      if (mtime > newest) {
        newest = mtime;
        newestPath = relative(ROOT, path);
      }
    } catch {}
  };
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) bump(path);
    }
  };
  walk(join(ROOT, "crates"));
  for (const rel of EXTRA_SOURCES) bump(join(ROOT, rel));
  const value = { newest, newestPath, at: Date.now() };
  scanCache = { at: Date.now(), value };
  return value;
}

/** Forgets the cached scan, so the next read sees an edit made just now. */
export function invalidateSources() {
  scanCache = null;
}

/** mtime of a file in milliseconds, or null. */
export function artifactMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export async function readMeta(target) {
  const path = META_FILE[target];
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeMeta(target, value) {
  await mkdir(META_DIR, { recursive: true });
  await writeFile(META_FILE[target], JSON.stringify(value, null, 2) + "\n");
}

/** The version object on the wire: rev, dirty, builtAt, ruleset, upstream. */
export function versionOf({ meta, artifact, ruleset, appVersion, fetchedAt } = {}) {
  const git = gitInfo();
  const lock = upstream();
  return {
    rev: meta?.rev ?? git.rev,
    dirty: meta?.dirty ?? git.dirty,
    builtAt: meta?.builtAt ?? (artifact ? mtimeIso(artifact) : null),
    ruleset: ruleset ?? rulesetId(),
    upstream: appVersion ?? meta?.upstream ?? lock.appVersion,
    upstreamFetchedAt: fetchedAt ?? lock.fetchedAt,
  };
}

/**
 * The same object for the per-render path, from the artifact's meta alone.
 *
 * `git` costs 35–280 ms on this repository (a big worktree with ignored build
 * output), and a render response must not pay that once a cache expires. The
 * contract asks for "the git revision and dirty flag it was **built from**",
 * which is exactly what the meta records; git is consulted only for an artifact
 * that has no meta at all (built outside the playground), and that read is
 * cached.
 */
export function versionFromMeta({ meta, artifact, ruleset, appVersion, fetchedAt } = {}) {
  const lock = upstream();
  const git = meta?.rev == null ? gitInfo() : null;
  return {
    rev: meta?.rev ?? git?.rev ?? null,
    dirty: meta?.dirty ?? git?.dirty ?? null,
    builtAt: meta?.builtAt ?? (artifact ? mtimeIso(artifact) : null),
    ruleset: ruleset ?? meta?.ruleset ?? rulesetId(),
    upstream: appVersion ?? meta?.upstream ?? lock.appVersion,
    upstreamFetchedAt: fetchedAt ?? lock.fetchedAt,
  };
}

function mtimeIso(path) {
  const ms = artifactMtime(path);
  return ms == null ? null : new Date(ms).toISOString();
}

/**
 * Stale: the artifact is missing, older than the newest source, or built from
 * another revision. `artifacts` may hold several files (the wasm build writes
 * two flavours, and the Node one needs its glue).
 */
export function staleness(artifacts = [], meta = null) {
  const files = artifacts.filter(Boolean);
  if (files.length === 0) return { stale: true, why: "not built" };
  const newest = Math.max(...files.map((f) => artifactMtime(f) ?? 0));
  if (newest === 0) return { stale: true, why: "not built" };
  const sources = sourceSnapshot();
  if (sources.newest > newest) {
    return { stale: true, why: `source newer: ${sources.newestPath}` };
  }
  const git = gitInfo();
  if (meta?.rev && meta.rev !== git.rev) {
    return { stale: true, why: `built from ${meta.rev}, HEAD is ${git.rev}` };
  }
  return { stale: false, why: null };
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** @type {Map<string, Promise<any>>} */
const building = new Map();
let wasmJob = null;

export function isBuilding(target) {
  if (target === "wasm" || target === "http") return Boolean(wasmJob) || building.has(target);
  return building.has(target);
}

/** Tail of a build log, which is what a human needs from a failure. */
function tail(text, lines = 120) {
  return text.trim().split("\n").slice(-lines).join("\n");
}

function runProcess(command, args, env = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    let log = "";
    const take = (chunk) => {
      log += chunk.toString();
      // A pathological build should not grow without bound; the tail is what
      // anyone reads.
      if (log.length > 200_000) log = log.slice(-100_000);
    };
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) =>
      resolve({ ok: false, code: null, ms: Date.now() - started, log: `${log}\ncould not start ${command}: ${e.message}` }),
    );
    child.on("close", (code) => resolve({ ok: code === 0, code, ms: Date.now() - started, log }));
  });
}

/**
 * Builds one target. Concurrent calls for the same target share one job (the
 * contract is "one build at a time per target"; sharing is the honest version of
 * that, since a second cargo with the same target dir would only block on the
 * lock). `wasm` and `http` share the wasm-bindgen run.
 *
 * Resolves to `{ ok, ms, log, already, artifact }`. Never throws for a failed
 * build: a compiler error is a result the UI shows.
 */
export async function build(target) {
  if (!BUILDABLE.includes(target)) {
    throw new Error(`unknown build target \`${target}\`; expected ${BUILDABLE.join(", ")}`);
  }
  if (building.has(target)) {
    const result = await building.get(target);
    return { ...result, already: true };
  }

  const job = (async () => {
    if (target === "native") return buildNative();
    return buildWasm(target);
  })()
    .catch((e) => ({ ok: false, ms: 0, log: `build crashed: ${e?.stack ?? e}`, artifact: null }))
    .finally(() => {
      building.delete(target);
      invalidateSources();
      invalidateGit();
    });
  building.set(target, job);
  return job;
}

async function buildNative() {
  const args = ["build", "--profile", NATIVE_PROFILE, "-p", "xeet-cli", "--bin", "xeet-render"];
  const result = await runProcess("cargo", args, { CARGO_TARGET_DIR: TARGET_DIR });
  const meta = {
    target: "native",
    artifact: relative(ROOT, NATIVE_BIN),
    command: `CARGO_TARGET_DIR=${relative(ROOT, TARGET_DIR)} cargo ${args.join(" ")}`,
    builtAt: new Date().toISOString(),
    ms: result.ms,
    ...stamp(),
  };
  if (result.ok && existsSync(NATIVE_BIN)) {
    await writeMeta("native", meta);
    // The binary also wants to say which revision it is (`xeet-render serve
    // --stdio`'s `info`), and it cannot know; a sidecar next to it can.
    await writeFile(NATIVE_SIDECAR, JSON.stringify({ rev: meta.rev, dirty: meta.dirty, builtAt: meta.builtAt }, null, 2) + "\n");
  }
  return { ok: result.ok, ms: result.ms, log: tail(result.log), artifact: NATIVE_BIN, meta: result.ok ? meta : null };
}

async function buildWasm(target) {
  // One wasm-bindgen run produces both flavours, so `wasm` and `http` share it.
  wasmJob ??= runProcess("node", [join(ROOT, "tools", "ship", "build-wasm.mjs")], {
    XEET_WASM_TARGET_DIR: join(TARGET_DIR, "ship-wasm"),
  }).finally(() => {
    wasmJob = null;
  });
  const result = await wasmJob;
  // Both artefacts come out of that one run, so both meta files are rewritten:
  // whichever target asked, the other one's artefact is fresh too, and a meta
  // that disagrees with its artefact would make a version badge lie.
  const written = {};
  if (result.ok) {
    for (const id of ["wasm", "http"]) {
      const built = id === "wasm" ? WEB_WASM : NODE_WASM;
      if (!existsSync(built)) continue;
      const meta = {
        target: id,
        artifact: relative(ROOT, built),
        command: "node tools/ship/build-wasm.mjs",
        builtAt: new Date().toISOString(),
        requestedBy: target,
        ms: result.ms,
        ...stamp(),
      };
      await writeMeta(id, meta);
      written[id] = meta;
    }
  }
  const artifact = target === "wasm" ? WEB_WASM : NODE_WASM;
  return { ok: result.ok, ms: result.ms, log: tail(result.log), artifact, meta: written[target] ?? null };
}

function stamp() {
  const git = gitInfo();
  const lock = upstream();
  return {
    rev: git.rev,
    dirty: git.dirty,
    subject: git.subject,
    ruleset: rulesetId(),
    upstream: lock.appVersion,
    // The newest source at build time: useful when a rebuild seems to have
    // changed nothing.
    sourcesAt: new Date(sourceSnapshot().newest).toISOString(),
  };
}

/** Whether a build target's artifact is present at all. */
export function artifactExists(path) {
  return existsSync(path);
}
