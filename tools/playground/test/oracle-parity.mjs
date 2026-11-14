#!/usr/bin/env node
// Replica parity: the playground's replica against the captured page itself.
//
//   node tools/playground/test/oracle-parity.mjs [--n 20] [--width 600] [--dpr 2]
//                                                [--json tmp/parity.json] [--keep]
//
// For each corpus post this renders it twice through the Chrome target:
//
//   page     the captured x.com page, that post's own cell, cropped and
//            measured (the stronger truth, `docs/E2E.md`'s layer 2);
//   replica  X's captured cell + attachment markup with this post's data
//            injected (`tools/playground/lib/chrome-markup.mjs`).
//
// and then compares the two: the cell's height, and every box both modes model
// (within 1/64 px), plus the body's line breaks. An equal height with equal
// boxes means the replica reproduces what the page drew, for a post whose data
// the converter (`tools/ship/corpus-post.mjs`) could recover completely.
//
// Posts the converter cannot model (a card whose metadata the capture does not
// keep) are skipped with the reason, as in `tools/ship/e2e.mjs`: comparing them
// would be scoring a comparison that was set up to fail.
//
// Exit code 1 if any compared post differs.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createChrome } from "../lib/chrome.mjs";
import { extractTweets } from "../../oracle/samples.mjs";
import { payloadToPost } from "../../ship/corpus-post.mjs";
import { ROOT, VENDOR } from "../../oracle/browser.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const N = Number(opt("n", "20"));
const WIDTH = Number(opt("width", "600"));
const DPR = Number(opt("dpr", "2"));
const SURFACE = opt("surface", null);
const ONLY = opt("files", null)?.split(",").map((s) => s.trim()).filter(Boolean);
const JSON_OUT = opt("json", null);
const KEEP = has("keep");
const TOL = 1 / 64 + 1e-9;
const CORPUS = join(VENDOR, "corpus");

const lock = JSON.parse(await readFile(join(ROOT, "assets", "upstream.lock.json"), "utf8"));
const NOW = lock.fetchedAt;
const round = (v) => (v == null ? v : Math.round(v * 64) / 64);

// ---------------------------------------------------------------- candidates

/**
 * Every corpus post the converter models completely, bucketed by the shape it
 * exercises, so the 20 are not 20 text-only posts.
 */
async function candidates() {
  const { readdir } = await import("node:fs/promises");
  const all = (await readdir(CORPUS)).filter((f) => f.endsWith(".html")).sort();
  const files = ONLY ? all.filter((f) => ONLY.includes(f)) : all;
  const buckets = new Map();
  for (const file of files) {
    const html = await readFile(join(CORPUS, file), "utf8");
    const appVersion = html.match(/"appVersion":"([0-9a-f]+)"/)?.[1] ?? null;
    let tweets = [];
    try {
      tweets = extractTweets(html);
    } catch {
      continue;
    }
    for (const tweet of tweets) {
      const { post, meta } = payloadToPost(tweet, { now: NOW, appVersion });
      if (!meta.restId) continue;
      if (!post.text && !post.media?.length && !post.quote) continue;
      if (meta.unsupported.length) continue; // the capture cannot feed the replica
      const shape = meta.hasQuote
        ? "quote"
        : meta.hasVideo
          ? "video"
          : post.media?.length
            ? `media${post.media.length}`
            : post.mediaTags?.length
              ? "tagged"
              : meta.longPost
                ? "long"
                : "text";
      const key = `${file.replace(/\.html$/, "")}-${meta.restId}`;
      if (!buckets.has(shape)) buckets.set(shape, []);
      buckets.get(shape).push({ key, file, id: String(meta.restId), post, shape, longPost: Boolean(meta.longPost) });
    }
  }
  // Round-robin across shapes: every shape with a capture gets a row before any
  // shape gets a second one.
  const order = ["text", "media1", "media2", "media3", "media4", "video", "quote", "tagged", "long"];
  const names = [...buckets.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const picked = [];
  const seen = new Set();
  for (let round_ = 0; picked.length < N; round_++) {
    let added = 0;
    for (const name of names) {
      const list = buckets.get(name);
      const item = list?.[round_];
      if (!item || seen.has(item.key)) continue;
      seen.add(item.key);
      picked.push(item);
      added++;
      if (picked.length >= N) break;
    }
    if (!added) break;
  }
  return picked;
}

// ---------------------------------------------------------------- comparison

/** Boxes a mismatch on is a failure; the rest are reported, not counted. */
const CORE = new Set(["cell", "article", "avatar", "avatarShape", "name", "handle", "text", "actionRow", "attachment", "contentColumn"]);

function compareBoxes(a, b, notes) {
  const diffs = [];
  const presence = [];
  for (const name of Object.keys(a)) {
    const left = a[name];
    const right = b[name];
    if (!left && !right) continue;
    if (!left || !right) {
      presence.push({ box: name, page: Boolean(left), replica: Boolean(right) });
      continue;
    }
    for (const key of ["x", "y", "w", "h"]) {
      const delta = right[key] - left[key];
      if (Math.abs(delta) > TOL) diffs.push({ box: name, key, page: left[key], replica: right[key], delta: round(delta) });
    }
  }
  void notes;
  return { diffs, presence };
}

function compareLines(a, b) {
  const n = Math.min(a.length, b.length);
  let first = null;
  for (let i = 0; i < n; i++) {
    if (a[i].text !== b[i].text) {
      first = { line: i, page: a[i].text, replica: b[i].text };
      break;
    }
  }
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i < n; i++) {
    maxX = Math.max(maxX, Math.abs(a[i].x - b[i].x));
    maxY = Math.max(maxY, Math.abs(a[i].y - b[i].y));
  }
  return { countPage: a.length, countReplica: b.length, first, maxX: round(maxX), maxY: round(maxY) };
}

/**
 * The `now` that makes xeet's relative label equal the one the captured page
 * printed ("3h", "Nov 8", "Jul 6, 2025"). A capture is a snapshot: its labels
 * were computed when it was fetched, so a page-mode cell and a replica built
 * from the same payload only agree if the replica is handed the same clock.
 * `tools/oracle/replica.mjs`'s round trip solves the same way.
 */
function solveNow(createdAt, label) {
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts) || !label) return null;
  const day = 86_400_000;
  let now = null;
  let match;
  if ((match = /^(\d+)s$/.exec(label))) now = ts + Number(match[1]) * 1000 + 1;
  else if ((match = /^(\d+)m$/.exec(label))) now = ts + Number(match[1]) * 60_000 + 1;
  else if ((match = /^(\d+)h$/.exec(label))) now = ts + Number(match[1]) * 3_600_000 + 1;
  else if (/^[A-Z][a-z]{2} \d/.test(label)) now = ts + (/,\s*\d{4}$/.test(label) ? 400 : 2) * day;
  return now == null ? null : new Date(now).toISOString();
}

// --------------------------------------------------------------------- main

const picked = await candidates();
if (picked.length === 0) {
  console.error("parity: no comparable corpus post found");
  process.exit(2);
}
const chrome = await createChrome();
const rows = [];
let compared = 0;
let failed = 0;

for (const item of picked) {
  const row = { ...item, post: undefined, verdict: null };
  try {
    const options = { width: WIDTH, dpr: DPR, theme: "light", surface: SURFACE ?? "web-timeline" };
    // Page mode first: it also tells us the cell width, which the replica must
    // match, whether the surface we assumed is the one the page used, and
    // whether the cell carries a context row. A context row is page state, not
    // payload state, so the harness maps it into the model exactly as
    // `tools/ship/e2e.mjs` does (`post.socialContext = "pinned"`).
    const page = await chrome.render({ post: item.post, options, mode: "page", source: { page: item.file, id: item.id } });
    row.page = { width: page.width, height: page.height, ms: page.ms, measuredId: page.measuredId };
    // Page state the payload does not carry: a context row (`docs/E2E.md`), and
    // the clock the relative label was computed with.
    let post = page.geometry.boxes.pinnedRow ? { ...item.post, socialContext: "pinned" } : item.post;
    if (page.geometry.boxes.pinnedRow) row.pinned = true;
    const label = page.geometry.texts?.timestamp ?? null;
    if (!(SURFACE ?? "web-timeline").includes("detail") && post.createdAt && label) {
      const now = solveNow(post.createdAt, label);
      if (now) post = { ...post, now };
    }
    row.stamp = label;
    row.stampReplica = null;
    const replica = await chrome.render({ post, options: { ...options, width: page.width } });
    row.replica = { width: replica.width, height: replica.height, ms: replica.ms, decisions: replica.version.decisions, ruleset: replica.version.ruleset };
    row.notes = [...page.notes, ...replica.notes];
    row.stampReplica = replica.geometry.texts?.timestamp ?? null;

    // The timestamp's *text* is content, not layout: a capture's label was
    // formatted when it was fetched, and a payload without `createdAt` cannot
    // reproduce it. When the labels differ, the box is reported and excluded.
    const stampDiff = row.stamp != null && row.stampReplica != null && row.stamp !== row.stampReplica;
    const { diffs: allDiffs, presence } = compareBoxes(page.geometry.boxes, replica.geometry.boxes);
    const diffs = stampDiff ? allDiffs.filter((d) => d.box !== "timestamp") : allDiffs;
    const lines = compareLines(page.geometry.lines, replica.geometry.lines);
    row.heightDelta = round(replica.height - page.height);
    row.boxDiffs = diffs;
    row.boxPresence = presence;
    row.lines = lines;
    const heightOk = Math.abs(row.heightDelta) <= TOL;
    const corePresence = presence.filter((p) => CORE.has(p.box));
    const contentDiff = Boolean(lines.first) || stampDiff;
    const layoutOk = heightOk && diffs.length === 0 && corePresence.length === 0 && lines.countPage === lines.countReplica;
    if (layoutOk && !contentDiff) row.verdict = "ok";
    else if (!layoutOk) row.verdict = "layout";
    else row.verdict = "content";
    compared++;
    if (row.verdict !== "ok") failed++;
  } catch (error) {
    const nested = error.code === "nested_only";
    row.verdict = nested ? "skip" : "error";
    row.error = nested ? "only appears as a quoted card on this page" : String(error.message ?? error).split("\n")[0];
    if (!nested) failed++;
  }
  rows.push(row);
  if (KEEP) {
    const dir = join(ROOT, "tmp", "parity");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${item.key}.json`), JSON.stringify(row, null, 2) + "\n");
  }
}

await chrome.close();

const w = (s, n) => String(s ?? "").padEnd(n);
console.log(`\n${w("post", 42)}${w("shape", 8)}${w("w", 5)}${w("height page/replica", 20)}${w("boxes", 7)}${w("lines", 7)}verdict`);
for (const r of rows) {
  const h = r.page && r.replica ? `${round(r.page.height)} / ${round(r.replica.height)} (Δ${r.heightDelta >= 0 ? "+" : ""}${r.heightDelta})` : "—";
  const boxes = r.boxDiffs ? `${r.boxDiffs.length}` : "—";
  const lines = r.lines ? `${r.lines.countPage}/${r.lines.countReplica}` : "—";
  console.log(`${w(r.key.replace(/\.html$/, ""), 42)}${w(r.shape, 8)}${w(r.page?.width ?? "—", 5)}${w(h, 20)}${w(boxes, 7)}${w(lines, 7)}${r.verdict}${r.error ? ` ${r.error}` : ""}`);
  for (const d of (r.boxDiffs ?? []).slice(0, 4)) console.log(`    box ${d.box}.${d.key}: page ${d.page} replica ${d.replica} (${d.delta})`);
  for (const p of (r.boxPresence ?? []).slice(0, 4)) console.log(`    box ${p.box}: only in ${p.page ? "page" : "replica"}`);
  if (r.lines?.first) console.log(`    line ${r.lines.first.line}: page ${JSON.stringify(r.lines.first.page)} replica ${JSON.stringify(r.lines.first.replica)}`);
  if (r.stamp && r.stampReplica && r.stamp !== r.stampReplica) console.log(`    label: page ${JSON.stringify(r.stamp)} replica ${JSON.stringify(r.stampReplica)}`);
  if (r.notes?.length) for (const n of r.notes.slice(0, 3)) console.log(`    note: ${n}`);
}

console.log(`\n${compared - failed}/${compared} posts agree (height and boxes within 1/64 px, same line breaks; body text differences are reported as "content")`);
if (JSON_OUT) {
  await mkdir(dirname(JSON_OUT), { recursive: true });
  await writeFile(JSON_OUT, JSON.stringify({ width: WIDTH, dpr: DPR, rows }, null, 2) + "\n");
  console.log(`wrote ${JSON_OUT}`);
}
process.exit(failed ? 1 : 0);
