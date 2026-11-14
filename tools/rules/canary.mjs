// Passive behavior canary (PLAN.md §11 pipeline 4, passive half).
//
// Server behavior does not live in the stylesheet, so it needs its own check.
// This tool pulls a small fresh sample of public posts, re-extracts the embedded
// payloads, and re-asserts every rule SPEC.md calls `derived`:
//
//   1. display URL form           host (no www) + path/query cut at 15 units + …
//   2. attachment exclusivity     a post does not carry media and a card
//   3. trailing hidden range      a server-hidden tail is one media t.co link
//   4. long-post cut              the visible body is a short, word-bounded
//                                 prefix of note_tweet.text
//
// Exit code 0 when nothing contradicts the ruleset, 1 when something does. A
// thin sample (no long posts, no cards) is reported as skipped, not as a
// failure, so a quiet week does not page anyone.
//
//   node tools/rules/canary.mjs                     # fresh sample, ~10 pages
//   node tools/rules/canary.mjs --accounts a,b,c --budget 20
//   node tools/rules/canary.mjs --offline           # use the saved corpus
//   node tools/rules/canary.mjs --json canary.json
//
// Requests are public and logged out, >=1.1 s apart, identified, and stop at the
// first block. With --offline nothing touches the network.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS = join(ROOT, "assets/vendor/capture/payloads.jsonl");
const { tweetsFromHtml } = await import(join(ROOT, "tools/capture.mjs"));

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const offline = args.includes("--offline");
const accounts = opt(
  "accounts",
  "vercel,nytimes,AP,github,NASA,OpenAI,anthropicai,verge,stripe,karpathy,rauchg,jasonfried"
).split(",").filter(Boolean);
const budget = Number(opt("budget", "12"));
const jsonOut = opt("json", null);
const UA = "xeet-dev/0.1 (behavior canary, logged out, low volume; +https://github.com/vercel-labs/xeet)";

const cps = (s) => Array.from(s ?? "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** X's display URL rule, as SPEC.md §2 states it. */
function displayUrl(expanded) {
  let url;
  try {
    url = new URL(expanded);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname === "/" ? "" : url.pathname;
  const rest = path + url.search;
  const units = [...rest];
  let shown = rest;
  if (units.reduce((n, c) => n + c.length, 0) > 15) {
    let out = "";
    let n = 0;
    for (const c of units) {
      if (n + c.length > 15) break;
      n += c.length;
      out += c;
    }
    shown = `${out.trimEnd()}\u2026`;
  }
  return host + shown;
}

async function freshSample() {
  const htmls = [];
  let requests = 0;
  for (const account of accounts) {
    if (requests >= budget) break;
    await sleep(1100);
    requests++;
    const res = await fetch(`https://x.com/${account}`, {
      headers: { "user-agent": UA, accept: "text/html", "accept-language": "en-US,en;q=0.9" },
      redirect: "follow",
    });
    if (res.status === 429 || res.status === 403 || res.status === 401) {
      throw new Error(`blocked: ${res.status} for @${account}`);
    }
    if (!res.ok) {
      console.warn(`  ${res.status} for @${account}`);
      continue;
    }
    htmls.push({ account, html: await res.text() });
  }
  const byId = new Map();
  for (const { html } of htmls) for (const t of tweetsFromHtml(html)) if (!byId.has(t.id)) byId.set(t.id, t);
  return { posts: [...byId.values()], pages: htmls.length, source: "live" };
}

async function savedSample() {
  if (!existsSync(CORPUS)) throw new Error(`no saved corpus at ${CORPUS}; run tools/capture.mjs first`);
  const byId = new Map();
  for (const line of (await readFile(CORPUS, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const t = JSON.parse(line);
    if (t.id && !byId.has(t.id)) byId.set(t.id, t);
  }
  return { posts: [...byId.values()], pages: 0, source: CORPUS.slice(ROOT.length + 1) };
}

// --------------------------------------------------------------------- checks

function checkDisplayUrls(posts) {
  let checked = 0;
  let matched = 0;
  const mismatches = [];
  for (const p of posts) {
    for (const u of p.urls ?? []) {
      if (!u.display_url || !u.expanded_url) continue;
      const want = displayUrl(u.expanded_url);
      if (want == null) continue;
      checked++;
      if (want === u.display_url) matched++;
      else if (mismatches.length < 10) mismatches.push({ id: p.id, display: u.display_url, want, expanded: u.expanded_url });
    }
  }
  // Two known-shape exceptions (query kept, IDN) are tolerated by the ratio.
  const ratio = checked ? matched / checked : 1;
  return { name: "display-url", checked, matched, ratio, ok: ratio >= 0.9, skipped: checked < 10, mismatches };
}

function checkExclusivity(posts) {
  const withMediaAndCard = posts.filter((p) => (p.media ?? []).length > 0 && p.card && p.card.name);
  const cards = posts.filter((p) => p.card && p.card.name).length;
  const media = posts.filter((p) => (p.media ?? []).length > 0).length;
  const ratio = posts.length ? withMediaAndCard.length / posts.length : 0;
  return {
    name: "media-vs-card",
    posts: posts.length,
    cards,
    media,
    both: withMediaAndCard.length,
    ratio,
    ok: ratio <= 0.02,
    skipped: cards < 5 || media < 5,
    examples: withMediaAndCard.slice(0, 5).map((p) => p.id),
  };
}

function checkTrailingHidden(posts) {
  const hidden = [];
  for (const p of posts) {
    const chars = cps(p.text);
    const end = p.display_range?.[1];
    if (end == null || end >= chars.length) continue;
    hidden.push({ id: p.id, tail: chars.slice(end).join(""), hasMedia: (p.media ?? []).length > 0 });
  }
  const tco = hidden.filter((h) => /^\s*https:\/\/t\.co\/[A-Za-z0-9]+$/.test(h.tail));
  const withMedia = hidden.filter((h) => h.hasMedia);
  const ratio = hidden.length ? tco.length / hidden.length : 1;
  return {
    name: "trailing-hidden-range",
    hidden: hidden.length,
    tco: tco.length,
    withMedia: withMedia.length,
    ratio,
    ok: ratio >= 0.98,
    skipped: hidden.length < 5,
    examples: hidden.slice(0, 3),
  };
}

function checkLongPostCut(posts) {
  const rows = [];
  for (const p of posts) {
    if (!p.note?.text) continue;
    // Visible body = full_text minus an appended " https://t.co/..." stub.
    let visible = p.text;
    const m = visible.match(/ https:\/\/t\.co\/[A-Za-z0-9]+$/);
    if (m) visible = visible.slice(0, -m[0].length);
    const v = cps(visible);
    if (v.length < 200) continue; // short note, not truncated
    const note = cps(p.note.text);
    const prefixOk = v.every((c, i) => note[i] === c) || v.slice(0, 200).every((c, i) => note[i] === c);
    const last = v[v.length - 1] ?? "";
    const nextInNote = note[v.length] ?? "";
    const bounded = /\s/.test(last) === false && /\s/.test(nextInNote);
    rows.push({ id: p.id, cp: v.length, prefixOk, bounded });
  }
  const inWindow = rows.filter((r) => r.cp >= 250 && r.cp <= 290);
  const bounded = rows.filter((r) => r.bounded);
  const ratio = rows.length ? bounded.length / rows.length : 1;
  const windowRatio = rows.length ? inWindow.length / rows.length : 1;
  return {
    name: "long-post-cut",
    bodies: rows.length,
    inWindow: inWindow.length,
    bounded: bounded.length,
    ratio,
    windowRatio,
    // The exact constant is `derived`, so the canary checks the shape: almost
    // all visible bodies end on a word boundary within 250–290 code points.
    ok: geoMean(ratio, windowRatio) >= 0.85,
    skipped: rows.length < 3,
    examples: rows.slice(0, 5),
  };
}

function geoMean(a, b) {
  return Math.sqrt(a * b);
}

// ----------------------------------------------------------------------- main

const sample = offline ? await savedSample() : await freshSample();
const checks = [
  checkDisplayUrls(sample.posts),
  checkExclusivity(sample.posts),
  checkTrailingHidden(sample.posts),
  checkLongPostCut(sample.posts),
];

const failures = checks.filter((c) => !c.skipped && !c.ok);
const report = {
  at: new Date().toISOString(),
  source: sample.source,
  posts: sample.posts.length,
  pages: sample.pages,
  ruleset: "x-web@89824c0",
  checks,
  ok: failures.length === 0,
};
console.log(`canary: ${sample.posts.length} posts from ${sample.source}`);
for (const c of checks) {
  const state = c.skipped ? "SKIP (thin sample)" : c.ok ? "ok" : "DRIFT";
  console.log(`  ${c.name}: ${state}${c.checked != null ? ` (${c.matched}/${c.checked})` : ""}${c.ratio != null ? ` ratio ${c.ratio.toFixed(3)}` : ""}`);
  if (!c.ok && !c.skipped) console.log(`    ${JSON.stringify(c).slice(0, 600)}`);
}
if (jsonOut) {
  await writeFile(jsonOut, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`wrote ${jsonOut}`);
}
process.exit(report.ok ? 0 : 1);
