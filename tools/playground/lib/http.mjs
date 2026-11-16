// The Node WASM target (`packages/xeet/src/node.js`), called in-process by the
// local dev playground.

import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { ROOT } from "./build.mjs";

const NODE_ENTRY = join(ROOT, "packages", "xeet", "src", "node.js");

let xeetPromise = null;
let loadError = null;
let upstreamSeen = null;
let rulesetSeen = null;

export async function loadHandler() {
  if (xeetPromise) return xeetPromise;
  xeetPromise = (async () => {
    const mod = await import(pathToFileURL(NODE_ENTRY).href);
    const xeet = await mod.loadXeet();
    upstreamSeen = xeet.upstream ?? null;
    return xeet;
  })();
  try {
    return await xeetPromise;
  } catch (e) {
    loadError = e;
    xeetPromise = null;
    throw e;
  }
}

export function handlerFailure() {
  return loadError ? String(loadError.message ?? loadError) : null;
}

export async function available() {
  try {
    await loadHandler();
    return true;
  } catch {
    return false;
  }
}

export function upstream() {
  return upstreamSeen;
}

export function ruleset() {
  return rulesetSeen;
}

export async function render({ post, options }) {
  const xeet = await loadHandler();
  const t0 = performance.now();
  const out = xeet.render(post, options);
  const paintMs = Math.round((performance.now() - t0) * 10) / 10;
  if (xeet.upstream) upstreamSeen = xeet.upstream;
  if (out.report?.ruleset) rulesetSeen = out.report.ruleset;
  return {
    png: Buffer.from(out.png).toString("base64"),
    report: out.report ?? null,
    upstream: xeet.upstream ?? null,
    ruleset: out.report?.ruleset ?? null,
    paintMs,
    renderMs: paintMs,
  };
}

export async function explain({ post, options }) {
  const xeet = await loadHandler();
  return xeet.explain(post, options);
}
