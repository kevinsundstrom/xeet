#!/usr/bin/env node
// Times render requests with the native renderer, for promo-video.mjs.
//
//   node tools/ship/promo-time.mjs --bin target/release/xeet-render \
//     --requests requests.jsonl --out timings.json
//
// Meant to run somewhere quiet (a Vercel Sandbox): each request is one JSON
// line `{ key, post, options }`; the output maps every key to the fastest of
// seven `ms.render` readings from a warm `xeet-render serve --stdio` and the
// PNG it produced. Node built-ins only, so it runs on a bare image.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, arch } from "node:os";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0 || !argv[i + 1]) throw new Error(`missing ${name}`);
  return argv[i + 1];
};
const BIN = flag("--bin");
const REQUESTS = flag("--requests");
const OUT = flag("--out");
const RUNS = 7;

const requests = readFileSync(REQUESTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const server = spawn(BIN, ["serve", "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;
createInterface({ input: server.stdout, crlfDelay: Infinity }).on("line", (line) => {
  const reply = JSON.parse(line);
  pending.get(reply.id)?.(reply);
  pending.delete(reply.id);
});
const render = (post, options) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (reply) => (reply.error ? reject(new Error(reply.error.message)) : resolve(reply)));
    server.stdin.write(`${JSON.stringify({ id, op: "render", post, options, geometry: false })}\n`);
  });

const loadBefore = loadavg()[0];
// Warm-up: every distinct option set once, twice over, so shaping caches and
// emoji bitmaps are in place before anything is timed.
const seen = new Set();
for (const r of requests) {
  const k = JSON.stringify(r.options);
  if (seen.has(k)) continue;
  seen.add(k);
  await render(r.post, r.options);
  await render(r.post, r.options);
}

const results = {};
const started = Date.now();
for (const [i, r] of requests.entries()) {
  let best = Infinity;
  let png = null;
  for (let k = 0; k < RUNS; k++) {
    const reply = await render(r.post, r.options);
    best = Math.min(best, reply.ms.render);
    png ??= reply.png;
  }
  results[r.key] = { ms: best, png };
  if ((i + 1) % 50 === 0) console.log(`timed ${i + 1} / ${requests.length}`);
}
server.stdin.end();

const meta = {
  platform: `${platform()} ${arch()}`,
  cpu: cpus()[0]?.model,
  cores: cpus().length,
  loadBefore,
  loadAfter: loadavg()[0],
  runs: RUNS,
  seconds: (Date.now() - started) / 1000,
};
writeFileSync(OUT, JSON.stringify({ meta, results }));
console.log(`timed ${requests.length} requests in ${meta.seconds.toFixed(1)} s on ${meta.cpu} (${meta.cores} cores, load ${loadBefore.toFixed(2)} → ${meta.loadAfter.toFixed(2)})`);
