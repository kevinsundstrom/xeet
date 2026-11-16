// Tests for the Node package. Run with `pnpm --dir packages/xeet test`, or
// `node --test packages/xeet/test/` from the repo root.
//
// The package needs the WebAssembly module; build it first:
//
//   node tools/ship/build-wasm.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadXeet, loadXeetSync, DEFAULT_WASM_PATH } from "../src/node.js";
import { XeetError } from "../src/abi.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixtures = join(ROOT, "tests", "fixtures", "posts");
const readFixture = (name) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

const haveWasm = existsSync(DEFAULT_WASM_PATH);
const skip = haveWasm ? false : "the wasm module is not built: run `node tools/ship/build-wasm.mjs`";
if (!haveWasm && process.env.XEET_REQUIRE_WASM === "1") {
  throw new Error(`xeet: ${DEFAULT_WASM_PATH} is missing and XEET_REQUIRE_WASM=1`);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("explain returns a report with a size and a ruleset", { skip }, async () => {
  const xeet = await loadXeet();
  const report = xeet.explain(readFixture("text-simple.json"), { width: 390, theme: "dark", dpr: 3 });
  assert.equal(report.size.width, 390);
  assert.ok(report.size.height > 0);
  assert.match(report.ruleset, /^x-web@/);
  assert.equal(report.length.limit, 280);
});

test("render returns a PNG and the same report", { skip }, async () => {
  const xeet = await loadXeet();
  const { png, report } = xeet.render(readFixture("text-simple.json"), { width: 390, dpr: 3 });
  assert.ok(png.length > 100);
  assert.deepEqual(Buffer.from(png.subarray(0, 8)), PNG_MAGIC);
  assert.ok(report.size.height > 0);
  // The PNG's own header agrees with the report: DPR was applied. (`png` is a
  // Uint8Array, which is the portable type; Node callers can wrap it in a
  // Buffer when they need one.)
  const width = Buffer.from(png).readUInt32BE(16);
  assert.equal(width, Math.ceil(report.size.width * 3));
});

test("the same input gives the same bytes", { skip }, async () => {
  const xeet = await loadXeet();
  const post = readFixture("text-simple.json");
  const a = xeet.renderPng(post, { width: 390, theme: "dark", dpr: 2 });
  const b = xeet.renderPng(post, { width: 390, theme: "dark", dpr: 2 });
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
});

test("sheet renders a labeled grid", { skip }, async () => {
  const xeet = await loadXeet();
  const png = xeet.sheet({ post: readFixture("text-simple.json"), widths: [320, 390], themes: ["light", "dark"], dpr: 1 });
  assert.deepEqual(Buffer.from(png.subarray(0, 8)), PNG_MAGIC);
  assert.ok(Buffer.from(png).readUInt32BE(16) > 390, "the sheet is wider than one cell");
});

test("invalid input throws a XeetError with fields, not a trap", { skip }, async () => {
  const xeet = await loadXeet();
  const post = { text: "x", media: Array.from({ length: 21 }, () => ({ width: 10, height: 10 })) };
  assert.throws(() => xeet.explain(post), (e) => {
    assert.ok(e instanceof XeetError);
    assert.equal(e.code, "invalid_post");
    assert.equal(e.status, 400);
    assert.ok(e.fields.some((f) => f.path.startsWith("post.media")));
    return true;
  });
  assert.throws(() => xeet.explain({ text: 42 }), (e) => e.code === "invalid_json");
});

test("a mistyped field is refused, with the field it meant", { skip }, async () => {
  const xeet = await loadXeet();
  // `created_at` instead of `createdAt` used to render "now" silently. Unknown
  // fields are errors now, everywhere in the model, and the message suggests
  // the camelCase spelling.
  for (const [post, expected] of [
    [{ text: "hi", auther: { name: "x" } }, "author"],
    [{ text: "hi", created_at: "2026-01-01T00:00:00Z" }, "createdAt"],
    [{ text: "hi", author: { square_avatar: true } }, "squareAvatar"],
    [{ text: "hi", counts: { replyCount: 1 } }, "replies"],
    [{ text: "hi", media_tags: ["a"] }, "mediaTags"],
  ]) {
    assert.throws(
      () => xeet.explain(post),
      (e) => {
        assert.ok(e instanceof XeetError);
        assert.equal(e.code, "invalid_json");
        assert.match(e.message, new RegExp(expected));
        return true;
      },
      JSON.stringify(post),
    );
  }
  // A field with no camelCase sibling still gets the accepted list.
  assert.throws(
    () => xeet.explain({ text: "hi", media: [{ width: 1, height: 1, alt_text: "x" }] }),
    (e) => /media\[0\]\.alt_text/.test(e.message) && /alt/.test(e.message),
  );
  // And the schema's own spellings still work.
  assert.ok(xeet.explain({ text: "hi", createdAt: "2026-01-01T00:00:00Z" }).size.height > 0);
});

test("the module needs no imports and reports its upstream version", { skip }, async () => {
  const xeet = await loadXeetSync();
  assert.match(xeet.upstream, /^[0-9a-f]{8,}$/);
});

test("hasShowMore detects long timeline posts and expanded renders them whole", { skip }, async () => {
  const xeet = await loadXeet();
  const short = readFixture("text-simple.json");
  assert.equal(xeet.hasShowMore(short, { surface: "web-timeline", width: 390 }), false);

  const long = {
    text: `${"Weekend hack: building a fast browserless renderer. ".repeat(12)}\n\nFinal paragraph after the cut.`,
    author: { name: "Andrej Karpathy", handle: "karpathy", verified: "blue" },
  };
  assert.equal(xeet.hasShowMore(long, { surface: "web-timeline", width: 390 }), true);
  assert.equal(xeet.hasShowMore(long, { surface: "web-detail", width: 390 }), false);

  const collapsed = xeet.explain(long, { surface: "web-timeline", width: 390 });
  const expanded = xeet.explain(long, { surface: "web-timeline", width: 390, expanded: true });
  assert.equal(collapsed.text.hasShowMore, true);
  assert.equal(expanded.text.hasShowMore, false);
  assert.equal(expanded.text.showMore, null);
  assert.ok(expanded.size.height > collapsed.size.height);
  assert.ok(expanded.text.visible.endsWith("Final paragraph after the cut."));

  // Native iOS surfaces: a <=280-char post that wraps past 9 rows clamps on
  // ios-timeline (with inline "... Show more") while web-timeline leaves it whole.
  const tallShort = {
    text: `Sometimes the line between smashing success and abject failure is paper thin.\n\nStartups only die for one reason: the founder gave up. You can always chew more glass. Once, I thought I might have to buy Boom out of bankruptcy.\n\nChoose worthy missions. So you never give up.`,
    author: { name: "Blake Scholl", handle: "bscholl", verified: "blue" },
    quote: { text: "Thanks for being vulnerable.", author: { name: "Angik Sarkar", handle: "kyunbit", verified: "blue" } },
  };
  assert.equal(xeet.hasShowMore(tallShort, { surface: "web-timeline", width: 382 }), false);
  assert.equal(xeet.hasShowMore(tallShort, { surface: "ios-timeline", width: 382 }), true);
  assert.equal(xeet.hasShowMore(tallShort, { surface: "ios-detail", width: 382 }), false);
  const iosExpanded = xeet.explain(tallShort, { surface: "ios-timeline", width: 382, dpr: 3, expanded: true });
  assert.equal(iosExpanded.text.hasShowMore, false);
  assert.ok(iosExpanded.text.visible.endsWith("So you never give up."));
});

test("lazy font packs produce byte-identical output to eager loading", { skip }, async () => {
  const post = {
    author: { name: "Rauch", handle: "rauchg" },
    text: "ship it 🚀🎉 日本語 ┻┳ 𝗯𝗼𝗹𝗱 ❤️",
  };
  const options = { width: 390, theme: "dark", dpr: 2 };
  // A separate process: `loadXeet()` in this one has already registered every
  // pack, so a lazy load here would be a no-op.
  const script = `
    import { loadXeet } from "./packages/xeet/src/node.js";
    const post = ${JSON.stringify(post)};
    const options = ${JSON.stringify(options)};
    const xeet = await loadXeet({ lazy: true });
    const packs = xeet.packsFor({ post });
    const loadedBefore = xeet.loadedPacks();
    await xeet.ensureFonts({ post });
    const png = Buffer.from(xeet.renderPng(post, options)).toString("base64");
    process.stdout.write(JSON.stringify({ packs, loadedBefore, loadedAfter: xeet.loadedPacks(), png }));
  `;
  const run = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  assert.deepEqual(run.loadedBefore, []);
  for (const pack of ["emoji", "cjk", "math"]) assert.ok(run.packs.includes(pack), pack);
  for (const pack of run.packs) assert.ok(run.loadedAfter.includes(pack), pack);

  const eager = Buffer.from((await loadXeet()).renderPng(post, options));
  assert.ok(eager.equals(Buffer.from(run.png, "base64")), "lazy and eager PNGs differ");
});
