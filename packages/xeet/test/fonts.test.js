// Tests for the lazy-pack loader: slicing, checksums, and the request-to-pack
// decision. These use a tiny in-memory pack, so they do not need the wasm
// module or the vendored fonts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createFontPacks } from "../src/fonts.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function packOf(files) {
  const chunks = [];
  const entries = [];
  let offset = 0;
  for (const [file, text] of Object.entries(files)) {
    const bytes = Buffer.from(text);
    entries.push({ file, offset, length: bytes.length, sha256: hash(bytes) });
    chunks.push(bytes);
    offset += bytes.length;
  }
  const blob = Buffer.concat(chunks);
  return { blob, manifest: { version: 1, packs: { demo: { bytes: blob.length, sha256: hash(blob), files: entries } } } };
}

function loader(manifest, blob, { failHash = false } = {}) {
  const registered = [];
  const packs = createFontPacks({
    manifest,
    read: () => blob,
    hash: (bytes) => (failHash ? "0".repeat(64) : hash(bytes)),
    register: (file, bytes) => registered.push([file, Buffer.from(bytes).toString("utf8")]),
    missingPacks: () => JSON.stringify(["demo"]),
  });
  return { packs, registered };
}

test("registers every file with its slice of the pack", async () => {
  const { blob, manifest } = packOf({ "a.ttf": "alpha", "b.ttf": "bravo!" });
  const { packs, registered } = loader(manifest, blob);
  assert.deepEqual(await packs.ensure({ post: {} }), ["demo"]);
  assert.deepEqual(registered, [
    ["a.ttf", "alpha"],
    ["b.ttf", "bravo!"],
  ]);
  assert.deepEqual(packs.loaded(), ["demo"]);
});

test("verifies the pack SHA-256 before registering anything", async () => {
  const { blob, manifest } = packOf({ "a.ttf": "alpha" });
  const { packs, registered } = loader(manifest, blob, { failHash: true });
  await assert.rejects(() => packs.ensure({ post: {} }), /failed its SHA-256 check/);
  assert.deepEqual(registered, []);
  assert.deepEqual(packs.loaded(), []);
});

test("rejects a file range that runs past the blob", async () => {
  const { blob, manifest } = packOf({ "a.ttf": "alpha" });
  manifest.packs.demo.files[0].length = blob.length + 1;
  const { packs } = loader(manifest, blob);
  await assert.rejects(() => packs.ensure({ post: {} }), /bad entry/);
});

test("the sync loader uses the same checksum", () => {
  const { blob, manifest } = packOf({ "a.ttf": "alpha" });
  const { packs, registered } = loader(manifest, blob);
  assert.deepEqual(packs.ensureSync({ post: {} }), ["demo"]);
  assert.deepEqual(registered, [["a.ttf", "alpha"]]);
});
