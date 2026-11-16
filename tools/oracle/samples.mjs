// Sample texts for differential testing: real post text from the captured
// corpus, plus generated text that stresses line breaking.
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VENDOR } from "./browser.mjs";

/** Pulls every embedded post payload out of a captured page. */
export function extractTweets(html) {
  const tweets = new Map();
  const re = /"((?:[^"\\]|\\.)*full_text(?:[^"\\]|\\.)*)"/g;
  let m;
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (o.__typename === "Tweet" && o.details?.full_text != null && o.rest_id) tweets.set(o.rest_id, o);
    for (const k in o) walk(o[k]);
  };
  while ((m = re.exec(html))) {
    try {
      walk(JSON.parse(JSON.parse(`"${m[1]}"`)));
    } catch {
      // Not a payload string.
    }
  }
  return [...tweets.values()];
}

export async function corpusTweets() {
  const dir = join(VENDOR, "corpus");
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of (await readdir(dir)).sort()) {
    if (f.endsWith(".html")) out.push(...extractTweets(await readFile(join(dir, f), "utf8")));
  }
  return out;
}

/** Display text of every captured post, plus the full text of long posts. */
export async function corpusTexts() {
  const texts = new Set();
  for (const t of await corpusTweets()) {
    const cps = [...t.details.full_text];
    const [a, b] = t.details.display_text_range ?? [0, cps.length];
    const shown = cps.slice(a, b).join("").replace(/https:\/\/t\.co\/\w+/g, "example.com/a-link…");
    if (shown.trim()) texts.add(shown);
    const note = t.note_tweet?.note_tweet_results?.result?.text;
    if (note) texts.add(note.replace(/https:\/\/t\.co\/\w+/g, "example.com/a-link…"));
  }
  return [...texts];
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

const WORDS = `the of and to in is you that it he was for on are as with his they I at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part ship launch today new update build faster team product AI agents open-source release v2.0 API docs — it's we're don't can't (beta) "quoted" 100% $5,000 #hashtag @mention co-founder state-of-the-art e.g. i.e. U.S. 3.14 24/7 A/B end-to-end https://example.com/a/long/path?query=1&x=2 name@example.com C++ node.js Next.js 10x 1,000,000 wait... really?! yes/no [link] {json} <tag> a_b snake_case camelCase kebab-case`.split(/\s+/);
const EMOJI = ["🚀", "✨", "🔥", "👀", "🎉", "❤️", "👍🏽", "🇺🇸", "👨‍👩‍👧", "⬇️", "✅", "💡", "📈", "🙏🏻"];
const PUNCT = [".", ",", "!", "?", ":", ";", " —", " –", "…", ")", "”"];

// Coverage sets beyond Latin. Each stresses one part of the engine, mixed with
// ordinary words so lines actually wrap.
const EMOJI_SEQ = [
  "🚀", "❤️", "❤", "☺️", "☺", "✌🏿", "👍🏽", "🙏🏻", "🇺🇸", "🇯🇵", "🇪🇺", "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "👨‍👩‍👧‍👦", "👩🏽‍💻", "🧑🏻‍🤝‍🧑🏿",
  "🏳️‍🌈", "🏳️‍⚧️", "❤️‍🔥", "🐦‍⬛", "🙂‍↕️", "🐦‍🔥", "🫨", "🪿", "1️⃣", "#️⃣", "*️⃣", "©️", "®️", "™️", "↩️", "▶️",
  "⬆️", "✔️", "☑️", "⚠️", "⚡", "⭐", "🔟", "🆕", "🆗", "👁️‍🗨️", "🧔‍♂️", "🤷‍♀️", "🏃🏾‍♂️‍➡️", "😮‍💨", "🫶🏼",
];
const ARABIC = ["مرحبا", "بالعالم", "شكرا", "جزيلا", "الذكاء", "الاصطناعي", "إطلاق", "منتج", "جديد", "اليوم", "فريق", "التطوير", "لا", "الله", "محمد", "٢٠٢٦", "١٠٠٪", "؟", "،"];
const HEBREW = ["שלום", "עולם", "תודה", "רבה", "השקה", "מוצר", "חדש", "היום", "צוות", "פיתוח"];
const LATIN_MIX = ["the", "new", "API", "launch", "v2.0", "Next.js", "@vercel", "#AI", "2026", "100%", "(beta)", "https://example.com/ar", "is", "live"];
const STYLE_BASES = [0x1d400, 0x1d434, 0x1d468, 0x1d5d4, 0x1d608, 0x1d63c, 0x1d4d0, 0x1d56c, 0x1d670, 0x1d538, 0x1d504];
const STYLE_HOLES = new Map([[0x1d455, 0x210e], [0x1d53a, 0x2102], [0x1d53f, 0x210d], [0x1d545, 0x2115], [0x1d547, 0x2119], [0x1d548, 0x211a], [0x1d549, 0x211d], [0x1d551, 0x2124], [0x1d506, 0x212d], [0x1d50b, 0x210c], [0x1d50c, 0x2111], [0x1d515, 0x211c], [0x1d51d, 0x2128]]);
// U+3000 is left out: its advance comes from the device's CJK font
// (PingFang is 1.02 em), which xeet does not bundle. It still hangs.
const SPACES = [" ", "  ", "   ", "\t", " \t ", "\u00a0", "\u00a0\u00a0", "\u200b", "\u2009", "\u202f", "\u2002", "\u2003", "\u200a", "\u2060"];

/** The distinct building blocks of a coverage set, for width checks. */
export function coverageTokens(set) {
  const words = ["launch", "the", "Hello", "AVATAR", "write"];
  if (set === "emoji") return [...EMOJI_SEQ, ...EMOJI];
  if (set === "bidi") return [...ARABIC, ...HEBREW, ARABIC.slice(0, 4).join(" "), HEBREW.slice(0, 4).join(" "), `${ARABIC[0]} API ${ARABIC[1]}`, `the ${HEBREW[0]} 2026 ${HEBREW[1]} launch`];
  if (set === "styled") return [...STYLE_BASES.flatMap((b) => words.map((w) => styleWord(w, b))), "𝕏", "ᴀʙᴄᴅ", "ⓐⓑⓒ", "x²³", "①②③", "→", "✦", "❯", "∑", "½"];
  if (set === "space") return SPACES.map((s) => `a${s}b`).concat(SPACES.map((s) => `${s}x`), ["a\tb", "ab\tc", "abcdefgh\tc", "\t\tx"]);
  throw new Error(`unknown coverage set ${set}`);
}

/** "bold" -> 𝐛𝐨𝐥𝐝 in one of the Mathematical Alphanumeric styles. */
function styleWord(word, base) {
  return [...word].map((c) => {
    const k = c.charCodeAt(0);
    let cp = null;
    if (k >= 65 && k <= 90) cp = base + (k - 65);
    else if (k >= 97 && k <= 122) cp = base + 26 + (k - 97);
    if (cp == null) return c;
    return String.fromCodePoint(STYLE_HOLES.get(cp) ?? cp);
  }).join("");
}

/**
 * Generated texts for one coverage set: "emoji", "bidi", "styled" or "space".
 * Deterministic for a seed.
 */
export function coverageTexts(set, n, seed = 1) {
  const r = rng(seed * 7919 + set.length);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const plain = () => pick(WORDS);
  const out = [];
  for (let i = 0; i < n; i++) {
    const parts = [];
    const len = 4 + Math.floor(r() * 40);
    // Bidi texts pick a dominant script, so both paragraph directions occur.
    const rtlFirst = r() < 0.5;
    const rtlWords = r() < 0.5 ? ARABIC : HEBREW;
    for (let w = 0; w < len; w++) {
      let word;
      const roll = r();
      if (set === "emoji") {
        word = roll < 0.35 ? pick(EMOJI_SEQ) : roll < 0.45 ? pick(EMOJI_SEQ) + pick(EMOJI_SEQ) : plain();
        if (r() < 0.1) word += pick(PUNCT);
      } else if (set === "bidi") {
        const rtl = (w === 0 && rtlFirst) || (w > 0 && roll < (rtlFirst ? 0.75 : 0.3));
        word = rtl ? pick(rtlWords) : roll < 0.9 ? pick(LATIN_MIX) : plain();
        if (r() < 0.06) word = `(${word})`;
        if (r() < 0.04) word += pick(EMOJI);
      } else if (set === "styled") {
        word = roll < 0.6 ? styleWord(plain(), pick(STYLE_BASES)) : plain();
        if (r() < 0.05) word = "𝕏";
        // Fullwidth forms ("ＡＢＣ") are left out: they are CJK and come from the
        // device's CJK font (PingFang, Noto Sans CJK), which xeet does not bundle.
        if (r() < 0.04) word = pick(["ᴀʙᴄᴅ", "ⓐⓑⓒ", "x²³", "①②③", "→", "✦", "❯", "∑", "½"]);
      } else if (set === "space") {
        word = plain();
        if (roll < 0.04) word = "x".repeat(10 + Math.floor(r() * 60));
      } else throw new Error(`unknown coverage set ${set}`);
      parts.push(word);
      const sep = r();
      if (set === "space") parts.push(sep < 0.05 ? "\n" : sep < 0.08 ? " \n " : sep < 0.5 ? pick(SPACES) : " ");
      else parts.push(sep < 0.04 ? "\n" : " ");
    }
    let text = parts.join("");
    if (set === "space") {
      // Leading and trailing whitespace is preserved by pre-wrap; keep some.
      if (r() < 0.3) text = pick(SPACES) + text;
      if (r() < 0.3) text = text.trimEnd() + pick(SPACES);
      else text = text.trimEnd();
    } else text = text.trim();
    out.push(text);
  }
  return out;
}

/** Generates `n` pseudo-random post-like texts. Deterministic for a seed. */
export function fuzzTexts(n, seed = 1) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const out = [];
  for (let i = 0; i < n; i++) {
    const parts = [];
    const len = 3 + Math.floor(r() * 45);
    for (let w = 0; w < len; w++) {
      let word = pick(WORDS);
      const roll = r();
      if (roll < 0.04) word = word.toUpperCase();
      else if (roll < 0.08) word = word[0].toUpperCase() + word.slice(1);
      else if (roll < 0.1) word = pick(EMOJI);
      else if (roll < 0.115) word = "x".repeat(8 + Math.floor(r() * 70)); // unbreakable token
      else if (roll < 0.13) word = String(Math.floor(r() * 1e6));
      if (r() < 0.12) word += pick(PUNCT);
      parts.push(word);
      const sep = r();
      parts.push(sep < 0.05 ? "\n\n" : sep < 0.09 ? "\n" : sep < 0.11 ? "  " : " ");
    }
    out.push(parts.join("").trim());
  }
  return out;
}
