// Builds a parity corpus: texts plus what twitter-text@3.1.0 extracts from them.
// Builds the differential corpus for `tests/parity.rs`.
//
// Needs the published twitter-text package next to it:
//   cd crates/xeet-text/tools/parity && printf '{}' > package.json && pnpm add twitter-text@3.1.0
//   node make-corpus.mjs > parity.jsonl
//   PARITY=$PWD/parity.jsonl CARGO_TARGET_DIR=target/agent-text cargo test -p xeet-text --test parity -- --nocapture
//
// The corpus is real post text from the captures, every conformance text, a
// handful of hand-written URL-grammar stress cases, and generated fuzz text.
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import twitter from "twitter-text";

const texts = new Set();
// 1. Real post texts from the captures.
const dir = new URL("../../../../assets/vendor/corpus", import.meta.url).pathname;
for (const f of readdirSync(dir).sort()) {
  if (!f.endsWith(".html")) continue;
  const html = readFileSync(`${dir}/${f}`, "utf8");
  const re = /"((?:[^"\\]|\\.)*full_text(?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const walk = (o) => {
        if (!o || typeof o !== "object") return;
        if (o.__typename === "Tweet" && o.details?.full_text != null) {
          const cps = [...o.details.full_text];
          const [a, b] = o.details.display_text_range ?? [0, cps.length];
          const shown = cps.slice(a, b).join("");
          if (shown.trim()) texts.add(shown);
        }
        for (const k in o) walk(o[k]);
      };
      walk(JSON.parse(JSON.parse(`"${m[1]}"`)));
    } catch {}
  }
}
// 2. Every conformance text.
for (const f of readdirSync(new URL("../../../../tests/conformance", import.meta.url).pathname).filter((f) => f.endsWith(".yml"))) {
  const src = readFileSync(new URL(`../../../../tests/conformance/${f}`, import.meta.url).pathname, "utf8");
  for (const m of src.matchAll(/^\s+text: "((?:[^"\\]|\\.)*)"$/gm)) {
    try { texts.add(JSON.parse(`"${m[1].replace(/\\U([0-9a-fA-F]{8})/g, "\\u$1")}"`)); } catch {}
  }
}
// 3. Hand-written stress cases for the URL grammar.
const extra = [
  "Пример https://пример.рф/путь?q=1 и http://test.example/a(b(c)d)e!",
  "intra:example.com, http://x.co/foo. (see http://en.wikipedia.org/wiki/Primer_(film))",
  "電話 03-1234-5678 と www.example.co.jp/path/ と mailto:a@b.com",
  "https://例え.テスト/パス?q=%E3%81%82#frag",
  "a.b.c.d.e.f.g.h.i https://a.b.c.d.e.f.g.h.i/x",
  "user@example.com http://user:pass@example.com:8080/p?q=2#f",
  "＃全角 ＠全角 http://全角.jp/パス",
  "https://t.co/abcdefghij?amp=1 https://t.co/abc#x https://t.co/abcdefghijklmnopqrstuvwxyz0123456789abcdefgh",
  "nested ((https://a.com/(b))c) https://a.com/((b))",
  "$AAPL $BRK.B $A_1 test$NO",
  "@a/list @b/c-d #tag #タグ #1a $x ¡hola!",
];
for (const t of extra) texts.add(t);
// 4. Fuzz.
import { fuzzTexts, coverageTexts } from "../../../../tools/oracle/samples.mjs";
for (const t of fuzzTexts(1500, 7)) texts.add(t);
for (const set of ["emoji", "bidi", "styled", "space"]) {
  for (const t of coverageTexts(set, 200, 3)) texts.add(t);
}

const out = [];
for (const t of texts) {
  const entities = twitter.extractEntitiesWithIndices(t);
  out.push({
    t,
    entities: entities.map((e) => [e.url ?? e.hashtag ?? e.screenName ?? e.cashtag ?? "", e.indices[0], e.indices[1], e.url ? "url" : e.hashtag ? "hashtag" : e.screenName ? "mention" : "cashtag"]),
    urls: twitter.extractUrlsWithIndices(t).map((u) => [u.url, u.indices[0], u.indices[1]]),
    mentions: twitter.extractMentions(t),
    hashtags: twitter.extractHashtags(t),
    cashtags: twitter.extractCashtags(t),
    weighted: twitter.parseTweet(t).weightedLength,
    valid: twitter.parseTweet(t).valid,
  });
}
writeFileSync(new URL("parity.jsonl", import.meta.url).pathname, out.map((o) => JSON.stringify(o)).join("\n") + "\n");
console.log(out.length, "texts");
