// Derive X's text rules from captured public payloads (PLAN.md §9, §11.4).
//
//   node tools/rules/derive.mjs               # full report
//   node tools/rules/derive.mjs --json out.json
//
// Reads assets/vendor/capture/payloads.jsonl (tools/capture.mjs). Every number
// printed here is cited in SPEC.md. It computes, for each post:
//
//   - long posts: where `full_text` cuts `note_tweet` text (UTF-16 units, word
//     boundary or not, trailing ellipsis), and whether the cut lands on 280
//     weighted characters;
//   - hidden leading ranges: `display_text_range[0] > 0`, what is hidden;
//   - hidden trailing ranges: `display_text_range[1] < len`, what is hidden;
//   - which attachment the payload carries (media / card / quote / poll) and
//     whether the trailing URL hides because of it;
//   - `display_url` form: length, host, trailing ellipsis, path cut;
//   - reply and quote inventories.
//
// No network access: this is a corpus reducer.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const JSONL = join(ROOT, "assets/vendor/capture/payloads.jsonl");
if (!existsSync(JSONL)) {
  console.error(`no capture yet: ${JSONL}\nrun: node tools/capture.mjs --accounts vercel,nytimes --details 20`);
  process.exit(1);
}

const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

const cps = (s) => Array.from(s ?? "");
const lastIdx = (arr, pred) => {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
};
const records = [];
const seenIds = new Set();
for (const line of readFileSync(JSONL, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  if (!r.id || seenIds.has(r.id)) continue;
  seenIds.add(r.id);
  records.push(r);
}

// twitter-text v3 weighted length, close enough for cut-point statistics.
const URL_WEIGHT = 23;
function weightedLength(text, urls) {
  const chars = cps(text);
  let weight = 0;
  const ranges = (urls ?? [])
    .filter((u) => Array.isArray(u.indices))
    .map((u) => u.indices)
    .sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < chars.length; ) {
    const hit = ranges.find(([s, e]) => s === i);
    if (hit) {
      weight += URL_WEIGHT;
      i = hit[1];
      continue;
    }
    const c = chars[i].codePointAt(0);
    const cjk =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd);
    weight += cjk ? 2 : 1;
    i++;
  }
  return weight;
}

const stats = {
  posts: records.length,
  accounts: new Set(records.map((r) => r.handle).filter(Boolean)).size,
  longPosts: [],
  leadingHides: [],
  trailingHides: [],
  displayUrls: [],
  displayUrlRule: { checked: 0, matched: 0, mismatches: [] },
  cardUrls: { withUrlEntity: 0, matchedLastUrl: 0, matchedFirstUrl: 0, unmatched: [] },
  attachments: { none: 0, media: 0, card: 0, quote: 0, poll: 0 },
  combos: {},
  quotes: [],
  notesWithoutExpandable: 0,
};

/** Code-point index -> UTF-16 index (payload `indices` are UTF-16). */
function utf16Offsets(text) {
  const out = [0];
  let u = 0;
  for (const ch of text) {
    u += ch.length;
    out.push(u);
  }
  return out;
}

/** X's display URL: host without `www.`, no query, path cut at 15 UTF-16 units. */
function displayUrl(expanded) {
  let url;
  try {
    url = new URL(expanded);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname === "/" ? "" : url.pathname;
  const units = [...path];
  let shown = path;
  if (units.length > 15) shown = units.slice(0, 15).join("").trimEnd() + "\u2026";
  return host + shown;
}

for (const r of records) {
  const chars = cps(r.text);
  const [rangeStart, rangeEnd] = r.display_range ?? [0, chars.length];
  const noteText = r.note?.text ?? null;

  if (noteText != null) {
    const nChars = cps(noteText);
    let cut = 0;
    while (cut < chars.length && cut < nChars.length && chars[cut] === nChars[cut]) cut++;
    const nextInNote = nChars[cut] ?? "";
    const lastShown = chars[cut - 1] ?? "";
    stats.longPosts.push({
      id: r.id,
      handle: r.handle,
      separator: noteText[cut - 1] === "\u2026" || (r.text.endsWith("\u2026") ?? false) ? "ellipsis" : lastShown === " " ? "space" : "mid",
      cutCp: cut,
      fullCp: chars.length,
      noteCp: nChars.length,
      nextChar: nextInNote,
      lastChar: lastShown,
      weightedCut: weightedLength(chars.slice(0, cut).join(""), r.urls),
      fullWeighted: weightedLength(r.text, r.urls),
      isExpandable: r.note?.is_expandable ?? null,
      hiddenTail: chars.slice(rangeEnd).join(""),
      prefix: chars.slice(0, cut).join("").endsWith(noteText.slice(0, cut)),
      textTail: r.text.slice(-40),
    });
    if (r.note?.is_expandable !== true) stats.notesWithoutExpandable++;
  }

  if (rangeStart > 0) {
    stats.leadingHides.push({ id: r.id, hidden: chars.slice(0, rangeStart).join(""), reply_to: r.reply_to != null, reply_handle: r.reply_handle });
  }
  if (rangeEnd < chars.length) {
    const tail = chars.slice(rangeEnd).join("");
    const ends = utf16Offsets(r.text);
    const endU = ends[Math.min(rangeEnd, ends.length - 1)];
    const mediaAt = (r.media ?? [])
      .filter((m) => Array.isArray(m.indices))
      .find((m) => m.indices[0] >= endU - 1);
    const tailUrl = (r.urls ?? []).find((u) => u.indices && u.indices[0] >= endU - 1) ?? null;
    stats.trailingHides.push({
      id: r.id,
      tail,
      tailIsMedia: mediaAt != null,
      tailUrl: tailUrl ? { tco: tailUrl.url, expanded: tailUrl.expanded_url, display: tailUrl.display_url } : null,
      hasMedia: (r.media ?? []).length > 0,
      hasCard: r.card != null,
      cardUrl: r.card?.url ?? null,
      hasQuote: r.quote != null,
      hasPoll: r.poll != null,
      hiddenCp: chars.length - rangeEnd,
    });
  }

  const kinds = [];
  if ((r.media ?? []).length) kinds.push("media");
  if (r.card) kinds.push("card");
  if (r.quote) kinds.push("quote");
  if (r.poll) kinds.push("poll");
  if (!kinds.length) stats.attachments.none++;
  else for (const k of kinds) stats.attachments[k]++;
  const key = kinds.join("+") || "none";
  stats.combos[key] = (stats.combos[key] ?? 0) + 1;

  for (const u of r.urls ?? []) {
    const d = u.display_url;
    if (!d) continue;
    const host = d.split("/")[0];
    const cut = u.indices && /[^\x00-\x7f]/.test(r.text);
    stats.displayUrls.push({
      display: d,
      expanded: u.expanded_url,
      tco: u.url,
      len: cps(d).length,
      hasEllipsis: d.endsWith("\u2026"),
      host,
      pathLen: d.includes("/") ? cps(d.slice(d.indexOf("/"))).length : 0,
      // The corpus stores UTF-16 indices; flag texts where code points differ so
      // the index base is not confused later.
      utf16Differs: cut || undefined,
    });
    const want = displayUrl(u.expanded_url);
    if (want != null) {
      stats.displayUrlRule.checked++;
      if (want === d) stats.displayUrlRule.matched++;
      else if (stats.displayUrlRule.mismatches.length < 12) stats.displayUrlRule.mismatches.push({ display: d, want, expanded: u.expanded_url });
    }
  }
  if (r.card?.url != null && (r.urls ?? []).length) {
    const urls = (r.urls ?? []).filter((u) => u.url || u.expanded_url);
    const cardUrl = r.card.url ?? r.card.card_url ?? null;
    const matches = (u) => cardUrl != null && (u.url === cardUrl || u.expanded_url === cardUrl);
    stats.cardUrls.withUrlEntity++;
    if (urls.length && matches(urls[urls.length - 1])) stats.cardUrls.matchedLastUrl++;
    if (urls.length && matches(urls[0])) stats.cardUrls.matchedFirstUrl++;
    if (!urls.some(matches) && stats.cardUrls.unmatched.length < 8) {
      stats.cardUrls.unmatched.push({ id: r.id, cardUrl, urlCount: urls.length, urls: urls.map((u) => u.url), card_url: r.card.card_url });
    }
  }
  if (r.quote) stats.quotes.push({ id: r.id, quoteId: r.quote.id, quoteText: r.quote.text, quoteCp: cps(r.quote.text).length, media: (r.quote.media ?? []).length });
}

// ------------------------------------------------------------------ summary

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
const out = [];
const say = (...a) => {
  console.log(...a);
  out.push(a.join(" "));
};

say(`corpus: ${stats.posts} posts from ${stats.accounts} accounts`);

// Long posts
const lp = stats.longPosts;
say(`\n== long posts (note_tweet present): ${lp.length}`);
if (lp.length) {
  const cuts = {};
  const seps = {};
  for (const p of lp) {
    cuts[p.cutCp] = (cuts[p.cutCp] ?? 0) + 1;
    seps[p.separator] = (seps[p.separator] ?? 0) + 1;
  }
  say(`cut at code point (top): ${Object.entries(cuts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(" ")}`);
  say(`cut boundary: ${Object.entries(seps).map(([k, v]) => `${k}:${v}`).join(" ")}`);
  const weighted = lp.map((p) => p.fullWeighted);
  say(`full weighted range: ${Math.min(...weighted)}..${Math.max(...weighted)}; is_expandable true: ${lp.filter((p) => p.isExpandable).length}/${lp.length}`);
  say(`full_text is prefix of note text: ${lp.filter((p) => p.prefix).length}/${lp.length}`);
  const ex = lp.slice(0, 5).map((p) => `  ${p.id} @${p.handle} cut=${p.cutCp} full=${p.fullCp} note=${p.noteCp} last=${JSON.stringify(p.lastChar)} next=${JSON.stringify(p.nextChar)} tail=${JSON.stringify(p.hiddenTail)}`);
  say(ex.join("\n"));
}

// The long-post cut model, fitted exactly as `rules::long_post_cut` does it.
// The budget is UTF-16 code units: a surrogate pair counts twice (SPEC.md §5).
const CUT_LIMIT = 280;
function modelCut(note) {
  const a = [...note];
  const units = a.reduce((n, ch) => n + ch.length, 0);
  if (units <= CUT_LIMIT) return note;
  let end = 0;
  let used = 0;
  while (end < a.length && used + a[end].length <= CUT_LIMIT) {
    used += a[end].length;
    end++;
  }
  const nextSpace = a[end] === undefined || /\s/.test(a[end]);
  const lastSpace = /\s/.test(a[end - 1]);
  if (!nextSpace && !lastSpace) {
    let i = end;
    while (i > 0 && !/\s/.test(a[i - 1])) i--;
    if (i > 0) end = i;
  }
  return a.slice(0, end).join("").trimEnd();
}
let fitChecked = 0;
let fitMatched = 0;
const fitMisses = [];
for (const r of records) {
  if (!r.note?.text) continue;
  let visible = r.text;
  const m = visible.match(/ https:\/\/t\.co\/[A-Za-z0-9]+$/);
  if (m) visible = visible.slice(0, -m[0].length);
  if ([...visible].length < 200) continue;
  fitChecked++;
  if (modelCut(r.note.text) === visible) fitMatched++;
  else if (fitMisses.length < 8) {
    fitMisses.push({ id: r.id, handle: r.handle, visibleCp: [...visible].length, modelCp: [...modelCut(r.note.text)].length });
  }
}
stats.cutFit = { checked: fitChecked, matched: fitMatched, misses: fitMisses };

say(`\n== long-post cut model: ${fitMatched}/${fitChecked} exact (${pct(fitMatched, fitChecked)})`);
for (const m of fitMisses) say(`  fit miss ${m.id} @${m.handle} model=${m.modelCp} actual=${m.visibleCp}`);

say(`\n== leading hidden ranges (display_text_range[0] > 0): ${stats.leadingHides.length}`);
for (const h of stats.leadingHides.slice(0, 8)) say(`  @${h.id} hidden=${JSON.stringify(h.hidden)} reply_to=${h.reply_to} reply_handle=${h.reply_handle}`);

say(`\n== trailing hidden ranges (display_text_range[1] < len): ${stats.trailingHides.length}`);
const tails = stats.trailingHides;
say(`  media at cut: ${tails.filter((t) => t.tailIsMedia).length}, card: ${tails.filter((t) => t.hasCard).length}, quote: ${tails.filter((t) => t.hasQuote).length}, poll: ${tails.filter((t) => t.hasPoll).length}`);
if (tails.length) say(`  tail is a t.co url: ${tails.filter((t) => t.tailUrl || /https:\/\/t\.co\//.test(t.tail)).length}/${tails.length}; hidden codepoints: ${[...new Set(tails.map((t) => t.hiddenCp))].sort((a, b) => a - b).join(",")}`);
for (const t of tails.slice(0, 6)) say(`  ${t.id} tail=${JSON.stringify(t.tail)} card=${t.hasCard} media=${t.hasMedia} quote=${t.hasQuote} poll=${t.hasPoll}`);

say(`\n== attachments (a post may carry more than one)`);
say(`  ${Object.entries(stats.attachments).map(([k, v]) => `${k}:${v}`).join(" ")}`);
say(`  combos: ${Object.entries(stats.combos).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ")}`);

say(`\n== display_url: ${stats.displayUrls.length} urls`);
const dl = stats.displayUrls;
if (dl.length) {
  const max = Math.max(...dl.map((d) => d.len));
  const ell = dl.filter((d) => d.hasEllipsis);
  say(`  with ellipsis: ${ell.length}/${dl.length}; max length ${max}; lengths: ${[...new Set(dl.map((d) => d.len))].sort((a, b) => a - b).join(",")}`);
  const ellLens = {};
  for (const d of ell) ellLens[d.len] = (ellLens[d.len] ?? 0) + 1;
  say(`  ellipsis lengths: ${Object.entries(ellLens).map(([k, v]) => `${k}:${v}`).join(" ")}`);
  const r = stats.displayUrlRule;
  say(`  rule [host minus www + path/15 units + ellipsis]: ${r.matched}/${r.checked} match`);
  for (const m of r.mismatches) say(`    MISMATCH shown=${JSON.stringify(m.display)} want=${JSON.stringify(m.want)} <- ${m.expanded}`);
}

say(`\n== card -> url entity`);
say(`  posts with card.url and url entities: ${stats.cardUrls.withUrlEntity}; matches last url: ${stats.cardUrls.matchedLastUrl}; matches first url: ${stats.cardUrls.matchedFirstUrl}`);
for (const u of stats.cardUrls.unmatched) say(`  no entity match ${u.id}: card.url=${u.cardUrl} card_url=${u.card_url} urls=${JSON.stringify(u.urls)}`);

say(`\n== quotes: ${stats.quotes.length}`);
for (const q of stats.quotes.slice(0, 5)) say(`  ${q.id} quotes ${q.quoteId} textCp=${q.quoteCp} media=${q.media}`);

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify({ generatedAt: new Date().toISOString(), jsonl: JSONL.slice(ROOT.length + 1), ...stats }, null, 1)}\n`);
  say(`\nwrote ${jsonOut}`);
}
