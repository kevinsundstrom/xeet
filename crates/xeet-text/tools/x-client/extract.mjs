// Pulls X's own weighted-length implementation out of a shipped chunk, verbatim.
//
// The bundle is minified, so single-letter names repeat in every module. This
// locates the module that contains `weightedLength` and picks its helpers by
// shape, asserting each one, instead of trusting a name. The only edit to the
// extracted code is replacing the imported URL extractor with a stub (the texts
// it is run on contain no URLs); everything else is byte-identical to the chunk.
import { readFileSync, writeFileSync } from "node:fs";

const CHUNK = process.argv[2] ?? new URL("../../../../assets/vendor/upstream/js/CFyVwPZu.js", import.meta.url).pathname;
const src = readFileSync(CHUNK, "utf8");

function braceBlock(from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(from, i + 1); }
  }
  throw new Error("unbalanced");
}
function findFn(from, test, what) {
  let at = from;
  for (;;) {
    at = src.indexOf("function ", at);
    if (at < 0) throw new Error("no function for " + what);
    const nameEnd = src.indexOf("(", at);
    const name = src.slice(at + 9, nameEnd);
    const open = src.indexOf("{", nameEnd);
    const body = braceBlock(open);
    if (test(body)) return { name, text: "function " + name + src.slice(nameEnd, open) + body };
    at = open;
  }
}
/** `name = /literal/flags` for the regex whose source starts with `needle`. */
function assigned(needle, pattern) {
  const m = pattern.exec(src);
  if (!m) throw new Error("no assignment for " + needle);
  const j = m.index + m[0].indexOf("/");
  let k = j + 1, inClass = false;
  while (k < src.length) {
    const c = src[k];
    if (c === "\\") { k += 2; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) break;
    k++;
  }
  const flags = (src.slice(k + 1).match(/^[a-z]*/) ?? [""])[0];
  return { name: m[1], text: src.slice(j, k + 1) + flags };
}

const anchor = src.indexOf("weightedLength");
if (anchor < 0) throw new Error("no weightedLength in chunk");
const window = Math.max(0, anchor - 2000);

const parse = findFn(window, (b) => b.includes("weightedLength") && b.includes("2300"), "parseTweet");
const emojiMap = findFn(window, (b) => b.includes(".matchAll("), "emoji entity map");
const weight = findFn(window, (b) => b.includes("charCodeAt(0)") && b.includes("weight;"), "getCharacterWeight");
const surrogate = findFn(window, (b) => b.includes("55296"), "isSurrogatePair");

const emoji = assigned("emoji", /(\w)=\/\\u\{1F3F4\}\\u\{E0067\}/);
const invalid = assigned("invalid chars", /(\w)=\/\[\\uFFFE\\uFEFF\\uFFFF\]/);
const cfg = src.match(/(\w=\d+),(\w=\d+),(\w=\[\{start:0,end:4351,weight:100\},\{start:8192,end:8205,weight:100\},\{start:8208,end:8223,weight:100\},\{start:8242,end:8247,weight:100\}\])/);
const scaleVar = cfg[1].split("=")[0], defaultVar = cfg[2].split("=")[0];

const fixedParse = parse.text.replace(/\(0,o\.t\)\(/g, "extractUrlsWithIndices(");
if (fixedParse.includes("(0,o.t)")) throw new Error("unknown url extractor reference");

const out = `// Extracted from ${CHUNK} by tools/x-client/extract.mjs. The only edit is that the
// URL extractor import became \`extractUrlsWithIndices\`, fed by \`setUrlSpans\`
// so the caller can supply the spans this crate already extracts identically.
// Everything else is verbatim: X's own parseTweet, emoji regex, weight ranges and
// invalid-character test.
let ${cfg[1]},${cfg[2]},${cfg[3]};
const ${emoji.name} = ${emoji.text};
const ${invalid.name} = ${invalid.text};
const SCALE = ${scaleVar}, DEFAULT_WEIGHT = ${defaultVar};
let __urlSpans = [];
const extractUrlsWithIndices = () =>
  __urlSpans.map(([start, end]) => ({ url: "u".repeat(end - start), indices: [start, end] }));
export const setUrlSpans = (spans) => { __urlSpans = spans; };

${fixedParse}
${emojiMap.text}
${weight.text}
${surrogate.text}

export const parseTweet = (text, max = 280) => ${parse.name}(text, max);
export const emojiSpans = (text) => [...${emojiMap.name}(text.normalize())];
export const emojiRegexSource = ${emoji.name}.source;
export { SCALE, DEFAULT_WEIGHT };
`;
if (!out.includes("weightedLength") || !out.includes("matchAll")) throw new Error("bad extraction");
const OUT = new URL("x-weighted.mjs", import.meta.url).pathname;
writeFileSync(OUT, out);
console.log("wrote", OUT, out.length, "bytes");
console.log("emoji regex:", emoji.text.slice(0, 70) + "…");
