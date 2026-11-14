#!/usr/bin/env node
// Restores the vendored X assets in CI from a private, content-addressed store.
//
//   XEET_VENDOR_URL=https://<host>/<prefix> XEET_VENDOR_TOKEN=... node tools/ship/fetch-vendor.mjs
//
// The assets (Chirp, fallback fonts, the icon sprite, captured pages) are X's
// property and are never committed (INTERFACES.md house rules). CI therefore
// has two inputs:
//
//   - `assets/upstream.lock.json`, committed: URLs and SHA-256 of every file.
//   - the store, private: the bytes, laid out exactly like `assets/vendor/`.
//
// The store's index is `index.json`:
//
//   { "appVersion": "89824c04…",
//     "files": [ { "path": "fonts/manifest.json", "sha256": "…", "bytes": 1234 }, … ] }
//
// Every file is checked against its own index entry and, where the lockfile
// names the same file, against the lockfile too. A store that disagrees with
// the lock is a hard failure: that mismatch is how a bad snapshot would enter
// a build.
//
// With no XEET_VENDOR_URL (a developer machine, or a fork's CI) this exits 0
// and says what is missing; the Rust build then fails with the actionable
// message from crates/xeet-core/build.rs.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VENDOR = join(ROOT, "assets", "vendor");
const LOCK = join(ROOT, "assets", "upstream.lock.json");

const base = process.env.XEET_VENDOR_URL?.replace(/\/+$/, "");
const token = process.env.XEET_VENDOR_TOKEN;

if (!base) {
  console.log("vendor: XEET_VENDOR_URL is not set; skipping the restore.");
  console.log("vendor: the build needs assets/vendor/ (run `node tools/sync-upstream.mjs` locally).");
  process.exit(0);
}

async function get(path) {
  const url = `${base}/${path}`;
  const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

const lock = JSON.parse(await readFile(LOCK, "utf8"));
const lockHashes = new Map();
// Collect every file the lockfile pins, keyed by its path under assets/vendor/.
for (const f of lock.fonts ?? []) lockHashes.set(`fonts/${f.file}`, f.sha256);
for (const f of lock.icons ?? []) lockHashes.set(f.path ?? f.file, f.sha256);
for (const f of lock.vendor ?? []) lockHashes.set(f.path, f.sha256);

let index;
try {
  index = JSON.parse((await get("index.json")).toString());
} catch (e) {
  console.error(`vendor: could not read the store index: ${e.message}`);
  process.exit(1);
}

if (index.appVersion && lock.appVersion && index.appVersion !== lock.appVersion) {
  console.error(
    `vendor: the store holds upstream ${index.appVersion}, the lockfile pins ${lock.appVersion}.\n` +
      `        Either update the lockfile and the store together, or restore the pinned snapshot.`,
  );
  process.exit(1);
}

const files = index.files ?? [];
if (files.length === 0) {
  console.error("vendor: the store index lists no files");
  process.exit(1);
}

let restored = 0;
let bytes = 0;
for (const entry of files) {
  const rel = normalize(entry.path).replace(/^(\.\.(\/|\\|$))+/, "");
  if (rel.startsWith("..") || rel.includes("..")) {
    console.error(`vendor: refusing a path that escapes the vendor directory: ${entry.path}`);
    process.exit(1);
  }
  const data = await get(rel);
  const sha = createHash("sha256").update(data).digest("hex");
  if (entry.sha256 && sha !== entry.sha256) {
    console.error(`vendor: ${rel} does not match the store index (${sha.slice(0, 12)}… vs ${entry.sha256.slice(0, 12)}…)`);
    process.exit(1);
  }
  const pinned = lockHashes.get(rel);
  if (pinned && pinned !== sha) {
    console.error(`vendor: ${rel} does not match assets/upstream.lock.json (${sha.slice(0, 12)}… vs ${pinned.slice(0, 12)}…)`);
    process.exit(1);
  }
  const dest = join(VENDOR, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, data);
  restored++;
  bytes += data.length;
}

console.log(`vendor: restored ${restored} file(s), ${(bytes / 1e6).toFixed(1)} MB, upstream ${index.appVersion ?? "unknown"}`);
if (!existsSync(join(VENDOR, "fonts/manifest.json"))) {
  console.error("vendor: fonts/manifest.json is missing from the restored set; the build will fail");
  process.exit(1);
}
