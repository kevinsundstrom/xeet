#!/usr/bin/env node
// Publishes a snapshot of `assets/vendor/` to the private content-addressed
// store, for the sync pipeline (PLAN.md §11 pipeline 3, step 1).
//
//   XEET_VENDOR_PUT_URL=https://<host>/<prefix> XEET_VENDOR_PUT_TOKEN=... \
//     node tools/ship/publish-vendor.mjs
//
// The store is described in docs/CI.md. This script writes `<path>` for every
// file under assets/vendor/ and then `index.json`, which `fetch-vendor.mjs`
// reads. Uploads are write-only and only run in the sync workflow, never on a
// pull request, so a fork cannot poison the snapshot.
//
// No resources are created by this repository: the bucket exists already (or
// does not) and the credentials are a secret. Without them the script exits
// with an explanation rather than doing anything surprising.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VENDOR = join(ROOT, "assets", "vendor");
const LOCK = join(ROOT, "assets", "upstream.lock.json");

const base = process.env.XEET_VENDOR_PUT_URL?.replace(/\/+$/, "");
const token = process.env.XEET_VENDOR_PUT_TOKEN;

if (!base || !token) {
  console.error("vendor: XEET_VENDOR_PUT_URL / XEET_VENDOR_PUT_TOKEN are not set.");
  console.error("vendor: see docs/CI.md for the store layout and the two tokens (read for CI, write for sync).");
  process.exit(2);
}

async function list(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await list(p)));
    else out.push(p);
  }
  return out;
}

async function put(path, body, type = "application/octet-stream") {
  const url = `${base}/${path}`;
  const res = await fetch(url, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": type }, body });
  if (!res.ok) throw new Error(`PUT ${url} → ${res.status} ${res.statusText}`);
}

const lock = JSON.parse(await readFile(LOCK, "utf8"));
const files = [];
for (const file of (await list(VENDOR)).sort()) {
  const rel = relative(VENDOR, file).replaceAll("\\", "/");
  const data = await readFile(file);
  const sha256 = createHash("sha256").update(data).digest("hex");
  // The lockfile is the authority: publishing a file the lock disagrees with
  // would let a bad snapshot into every later build.
  const pinned = (lock.fonts ?? []).find((f) => `fonts/${f.file}` === rel)?.sha256 ?? (lock.vendor ?? []).find((f) => f.path === rel)?.sha256;
  if (pinned && pinned !== sha256) {
    console.error(`vendor: ${rel} does not match the lockfile (${sha256.slice(0, 12)}… vs ${pinned.slice(0, 12)}…); refusing to publish`);
    process.exit(1);
  }
  await put(rel, data);
  files.push({ path: rel, sha256, bytes: (await stat(file)).size });
}

const index = { appVersion: lock.appVersion, fetchedAt: lock.fetchedAt ?? null, files };
await put("index.json", JSON.stringify(index, null, 2), "application/json");
console.log(`vendor: published ${files.length} file(s) for upstream ${lock.appVersion}`);
