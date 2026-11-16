// Capture public X posts, payload included, for rule derivation (PLAN.md §9).
//
// Logged out, public pages only, one request every >=1.1 s, identified UA, and
// it stops on the first block. Pages land in assets/vendor/capture/ (git-ignored)
// as raw HTML plus a normalized `payloads.jsonl`, which is what the rule
// derivations in tools/rules/ read.
//
//   node tools/capture.mjs --accounts vercel,nytimes --budget 20
//   node tools/capture.mjs --details 40     # also fetch post pages for ids that
//                                           # need richer evidence
//
// The page embeds the API payload as JSON strings inside the HTML. Two shapes
// are in the wild:
//   - compact profile/timeline shape: `{rest_id, details:{full_text,...}}`
//   - post-page shape: `{rest_id, legacy:{full_text,...}}` and wrappers such as
//     `{id, rest_id, result:{__typename:"Tweet", ...}}`
// Both are walked generically; anything with full text is normalized.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets/vendor/capture");
const JSONL = join(OUT, "payloads.jsonl");
const STATE = join(OUT, "capture-state.json");

const UA = "xeet-dev/0.1 (public post sampling, logged out, low volume; +https://github.com/rauchg/xeet)";
const DELAY_MS = 1100;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

// A spread of public accounts: brands, news, long-post people, media-heavy,
// polls and replies. The goal is coverage of payload shapes, not a census.
const DEFAULT_ACCOUNTS = [
  // brands / product
  "vercel", "stripe", "github", "Google", "XDevelopers", "figma", "notionhq", "cloudflare",
  "linear", "supabase", "raycastapp", "anthropicai", "OpenAI", "huggingface",
  // news
  "nytimes", "washingtonpost", "BBCWorld", "Reuters", "verge", "TechCrunch", "arstechnica",
  "AP", "guardian", "cnnbrk",
  // people who post long threads / links
  "paulg", "sama", "naval", "karpathy", "simonw", "rauchg", "dhh", "jasonfried",
  "tobi", "elonmusk", "jack", "biz", "marcbenioff", "satyanadella",
  // media, sports, entertainment
  "NASA", "MrBeast", "NatGeo", "NBA", "F1", "netflix", "disney", "espn",
];

const ACCOUNTS = opt("accounts", DEFAULT_ACCOUNTS.join(",")).split(",").filter(Boolean);
const EXTRA_PATHS = opt("paths", "with_replies").split(",").filter(Boolean);
const BUDGET = Number(opt("budget", "400"));
const DETAILS = Number(opt("details", "0"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

let requests = 0;
async function get(url, what) {
  if (requests >= BUDGET) throw new Error("budget exhausted");
  await sleep(DELAY_MS);
  requests++;
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  if (res.status === 429 || res.status === 403 || res.status === 401) {
    throw new Error(`blocked: ${res.status} ${res.statusText} for ${url}`);
  }
  if (!res.ok) {
    console.warn(`  ${res.status} ${what ?? url}`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------- extraction

/** Every JSON string literal in the page that could hold a payload. */
function payloadStrings(html) {
  const out = [];
  // Payload strings are escaped JSON inside a JSON string in the HTML. A lazy
  // match over the escaped quote pairs is enough; parse failures are ignored.
  const re = /"((?:[^"\\]|\\.)*full_text(?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const inner = JSON.parse(`"${m[1]}"`);
      out.push(JSON.parse(inner));
    } catch {
      // Not a payload, or truncated at a page boundary.
    }
  }
  return out;
}

const handle = (user) => user?.core?.screen_name ?? user?.legacy?.screen_name ?? user?.screen_name ?? null;
const name = (user) => user?.core?.name ?? user?.legacy?.name ?? user?.name ?? null;
const verified = (user) => user?.verification?.verified_type ?? user?.legacy?.verified_type ?? (user?.verification?.is_blue_verified || user?.legacy?.verified ? "Blue" : "None");

function mediaOf(t) {
  const list = t.media_entities2 ?? t.legacy?.extended_entities?.media ?? t.legacy?.entities?.media ?? [];
  return list.map((m) => ({
    type: m.type,
    width: m.original_info?.width ?? m.sizes?.large?.w ?? null,
    height: m.original_info?.height ?? m.sizes?.large?.h ?? null,
    duration_ms: m.video_info?.duration_millis ?? null,
    indices: m.indices ?? null,
    expanded_url: m.expanded_url ?? null,
  }));
}

function urlsOf(t) {
  const list = t.url_entities ?? t.details?.url_entities ?? t.legacy?.entities?.urls ?? t.entity_set?.urls ?? [];
  return list.map((u) => ({
    url: u.url,
    expanded_url: u.expanded_url,
    display_url: u.display_url,
    indices: u.indices,
  }));
}

function noteOf(t) {
  const n = t.note_tweet ?? t.details?.note_tweet;
  const r = n?.note_tweet_results?.result;
  if (!r) return null;
  return {
    is_expandable: n.is_expandable ?? null,
    text: r.text ?? null,
    urls: (r.entity_set?.urls ?? []).map((u) => ({ url: u.url, expanded_url: u.expanded_url, display_url: u.display_url, indices: u.indices })),
  };
}

/** A card is `card.rest_id + card.legacy.binding_values`, or a URI. */
function cardOf(t) {
  const c = t.card ?? t.details?.card ?? null;
  if (!c) return t.card_uri ? { card_uri: t.card_uri } : null;
  const bv = c.legacy?.binding_values ?? [];
  const str = (key) => bv.find((b) => b.key === key)?.value?.string_value ?? null;
  return {
    rest_id: c.rest_id ?? null,
    name: c.legacy?.name ?? c.name ?? null,
    url: c.legacy?.url ?? null,
    card_uri: c.legacy?.card_uri ?? t.card_uri ?? null,
    card_url: str("card_url"),
    vanity_url: str("vanity_url"),
    domain: str("domain"),
    title: str("title"),
    description: str("description"),
  };
}

function quoteOf(t) {
  const q = t.quoted_status_result?.result ?? t.quoted_status_result ?? t.quoted_tweet ?? null;
  if (!q) return null;
  const d = q.details ?? q.legacy;
  if (!d?.full_text) return { id: q.rest_id ?? null };
  return {
    id: q.rest_id ?? null,
    author: handle(q.core?.user_results?.result) ?? handle(q.user?.legacy) ?? null,
    text: d.full_text,
    display_range: d.display_text_range ?? null,
    media: mediaOf(q),
  };
}

function pollOf(t) {
  const p = t.poll ?? t.legacy?.poll ?? t.details?.poll ?? null;
  if (!p) return null;
  return {
    choices: (p.choices ?? []).map((c) => ({ label: c.str ?? c.label ?? null, count: c.count ?? null })),
    end_datetime: p.end_datetime ?? null,
  };
}

const info = (t) => {
  const user = t.core?.user_results?.result ?? t.user?.legacy ?? t.user ?? null;
  const d = t.details ?? t.legacy ?? {};
  return {
    id: t.rest_id ?? t.id_str ?? t.id ?? null,
    handle: handle(user),
    name: name(user),
    verified: verified(user),
    created_at_ms: t.details?.created_at_ms ?? (t.legacy?.created_at ? Date.parse(t.legacy.created_at) : null),
    text: d.full_text ?? null,
    display_range: d.display_text_range ?? null,
    reply_to: t.legacy?.in_reply_to_status_id_str ?? d.in_reply_to_status_id_str ?? null,
    reply_handle: d.in_reply_to_screen_name ?? t.legacy?.in_reply_to_screen_name ?? null,
    lang: t.legacy?.lang ?? d.lang ?? null,
    urls: urlsOf(t),
    mentions: (d.mention_entities ?? t.legacy?.entities?.user_mentions ?? []).map((u) => ({ handle: u.screen_name ?? u.screenName ?? null, indices: u.indices ?? null })),
    hashtags: (d.hashtag_entities ?? t.legacy?.entities?.hashtags ?? []).map((h) => ({ tag: h.text ?? null, indices: h.indices ?? null })),
    cashtags: (d.cashtag_entities ?? t.legacy?.entities?.symbols ?? []).map((s) => ({ tag: s.text ?? null, indices: s.indices ?? null })),
    media: mediaOf(t),
    note: noteOf(t),
    card: cardOf(t),
    quote: quoteOf(t),
    poll: pollOf(t),
  };
};

export function tweetsFromHtml(html) {
  const found = new Map();
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (o.rest_id != null) {
      const d = o.details ?? o.legacy;
      if (d?.full_text != null && info(o).id) {
        const rec = info(o);
        // Prefer the copy that carries cards/quotes/notes (post pages carry more).
        const score = (r) => (r.note ? 1 : 0) + (r.card ? 2 : 0) + (r.quote ? 2 : 0) + (r.poll ? 2 : 0);
        const prev = found.get(rec.id);
        if (!prev || score(rec) > score(prev)) found.set(rec.id, rec);
      }
    }
    for (const k in o) walk(o[k]);
  };
  for (const p of payloadStrings(html)) walk(p);
  return [...found.values()];
}

// ---------------------------------------------------------------------- main

async function main() {
  await mkdir(OUT, { recursive: true });
  const state = existsSync(STATE)
    ? JSON.parse(await readFile(STATE, "utf8"))
    : { captured: {}, seenIds: [] };

  // Re-extract every saved page after changing the normalizer: no network.
  if (args.includes("--reprocess")) {
    const { readdir } = await import("node:fs/promises");
    const all = [];
    const ids = new Set();
    for (const file of (await readdir(OUT)).sort()) {
      if (!file.endsWith(".html")) continue;
      const tweets = tweetsFromHtml(await readFile(join(OUT, file), "utf8"));
      for (const t of tweets) {
        if (!t.id || ids.has(t.id)) continue;
        ids.add(t.id);
        all.push({ ...t, source: file, capturedAt: new Date().toISOString(), upstream: state.appVersion ?? null });
      }
    }
    await writeFile(JSONL, all.map((l) => JSON.stringify(l)).join("\n") + "\n");
    console.log(`reprocessed ${all.length} unique posts from saved pages -> ${JSONL.slice(ROOT.length + 1)}`);
    return;
  }

  const seen = new Set(state.seenIds);
  const lines = [];
  let posts = 0;
  let pages = 0;

  // Flush after every page: a throttled crawl can take minutes and must
  // survive an interruption without losing the pages already paid for.
  const capture = async (url, file, tweets) => {
    await writeFile(join(OUT, file), htmlOfLast);
    pages++;
    const fresh = [];
    for (const t of tweets) {
      if (!t.id) continue;
      const rec = { ...t, source: file, capturedAt: new Date().toISOString(), upstream: state.appVersion ?? null };
      fresh.push(rec);
      lines.push(rec);
      seen.add(t.id);
      posts++;
    }
    if (fresh.length) await writeFile(JSONL, fresh.map((l) => JSON.stringify(l)).join("\n") + "\n", { flag: "a" });
    state.captured[url] = { file, at: new Date().toISOString(), posts: tweets.length };
    state.seenIds = [...seen];
    await writeFile(STATE, JSON.stringify(state, null, 1));
  };

  let htmlOfLast = "";
  const wanted = [];
  for (const account of ACCOUNTS) {
    for (const path of ["", ...EXTRA_PATHS]) {
      const url = `https://x.com/${account}${path ? `/${path}` : ""}`;
      if (state.captured[url] && !args.includes("--recapture")) continue;
      if (requests >= BUDGET) break;
      try {
        const buf = await get(url, `@${account}${path ? "/" + path : ""}`);
        if (!buf) continue;
        htmlOfLast = buf.toString("utf8");
        const tweets = tweetsFromHtml(htmlOfLast);
        await capture(url, `${account}${path ? "-" + path : ""}.html`, tweets);
        console.log(`@${account}${path ? "/" + path : ""}: ${tweets.length} posts (${requests} req, ${posts} total)`);
        if (DETAILS) {
          for (const t of tweets) {
            const rich = t.note || t.card || t.quote || t.poll || t.reply_to;
            if (rich && !seen.has(t.id)) wanted.push(t);
          }
        }
      } catch (err) {
        console.error(`stopping: ${err.message}`);
        state.stoppedAt = new Date().toISOString();
        state.stoppedReason = err.message;
        await writeFile(JSONL, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""), { flag: "a" });
        state.seenIds = [...seen];
        await writeFile(STATE, JSON.stringify(state, null, 1));
        console.error(`wrote ${posts} posts before stopping`);
        return;
      }
    }
  }

  // Post pages for ids that carry server-side state we want to see in full.
  let detailed = 0;
  for (const t of wanted) {
    if (detailed >= DETAILS || requests >= BUDGET) break;
    const url = `https://x.com/${t.handle ?? "i"}/status/${t.id}`;
    if (state.captured[url]) continue;
    try {
      const buf = await get(url, `post ${t.id}`);
      if (!buf) continue;
      htmlOfLast = buf.toString("utf8");
      const tweets = tweetsFromHtml(htmlOfLast);
      await capture(url, `post-${t.id}.html`, tweets);
      detailed++;
    } catch (err) {
      console.error(`stopping detail crawl: ${err.message}`);
      break;
    }
  }

  if (lines.length) await writeFile(JSONL, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { flag: "a" });
  state.seenIds = [...seen];
  await writeFile(STATE, JSON.stringify(state, null, 1));
  console.log(`\n${posts} posts from ${pages} pages, ${requests} requests -> ${JSONL.slice(ROOT.length + 1)}`);
}

// Only crawl when run directly; importing this file must not touch the network.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
