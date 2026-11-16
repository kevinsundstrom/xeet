// Runs X's own extracted counter over a corpus of texts and writes the answers.
//
//   node crates/xeet-text/tools/x-client/expected.mjs texts.jsonl expected.jsonl
import { readFileSync, writeFileSync } from "node:fs";
import { parseTweet, setUrlSpans } from "./x-weighted.mjs";

const [, , input, output] = process.argv;
const out = [];
for (const line of readFileSync(input, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const { t, urls } = JSON.parse(line);
  setUrlSpans(urls);
  const r = parseTweet(t);
  out.push(JSON.stringify({ t, weighted: r.weightedLength, valid: r.valid }));
}
writeFileSync(output, out.join("\n") + "\n");
console.log(out.length, "texts ->", output);
