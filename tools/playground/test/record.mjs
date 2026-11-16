#!/usr/bin/env node
// Records the real responses the resolver needs, once, into a git-ignored
// directory.
//
//   node tools/playground/test/record.mjs [--force] [input…]
//
// The parity test (`resolve-parity.mjs`) replays these so it can compare the
// Rust resolver with the JS one, byte for byte, on the pages the playground was
// verified against — without touching the network in a test run.
//
// Recordings live in `assets/vendor/playground/recordings/` (inside the
// git-ignored `assets/vendor/`), one file per URL, named by the URL's SHA-256:
//
//   { url, status, headers: {name: value}, body: base64, truncated, fetchedAt }
//
// Only documents and images are recorded — no cookies, no credentials, nothing a
// private session could leak — and the same 1 request/second/host politeness the
// crawler uses applies while recording.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PLAYGROUND_CACHE, ROOT } from "../lib/build.mjs";

export const RECORDINGS = join(PLAYGROUND_CACHE, "recordings");

/** The inputs the playground was verified against (docs/MEDIA.md, docs/LINK-CARDS.md). */
export const INPUTS = [
  // A t.co link and the page it redirects to, with its card image.
  "https://t.co/jO01BMGwXr",
  "https://vercel.com/changelog/vercel-daemons-is-now-in-public-beta",
  // Posts: a video, a video plus a quoted video, four photos, a GIF, a quote.
  "https://x.com/NASA/status/2119833829389041896",
  "https://x.com/NBA/status/2120019063476785477",
  "https://x.com/F1/status/2119898824810389849",
  "https://x.com/GIPHY/status/1957913446118285360",
  "https://x.com/MrBeast/status/2117003477079761397",
  // A long post that quotes another (the quote rule's reference case).
  "https://x.com/rauchg/status/2120188488628977819",
  "https://x.com/rauchg/status/2118152230260092940",
  // A bit.ly chain that lands on an article with a card.
  "https://t.co/4esrsTjXt7",
];

const SHA = (text) => createHash("sha256").update(text).digest("hex");
const UA = "Twitterbot/1.0";
const PAGE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lastHit = new Map();

/** 1 request/second/host, the crawler's own politeness. */
async function politeHost(host) {
  const now = Date.now();
  const previous = lastHit.get(host) ?? 0;
  const wait = previous + 1100 - now;
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

/**
 * Live fetch with the given user agent, manual redirects, a byte cap.
 *
 * `impl` is the *real* fetch: the replay host replaces `globalThis.fetch`, so a
 * recording run must not call it again (that is an infinite recursion, and it
 * looks exactly like a hang).
 */
export async function liveFetch(
  url,
  { userAgent = UA, maxBytes = 3 * 1024 * 1024, impl = globalThis.fetch, follow = false } = {},
) {
  const parsed = new URL(url);
  await politeHost(parsed.host);
  const response = await impl(url, {
    headers: {
      "user-agent": userAgent,
      accept: "text/html,application/xhtml+xml,image/*,*/*;q=0.1",
      "accept-language": "en-US,en;q=0.9",
      connection: "close",
    },
    redirect: follow ? "follow" : "manual",
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const headers = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return {
    status: response.status,
    headers,
    body: buffer.subarray(0, maxBytes),
    truncated: buffer.length > maxBytes,
  };
}

/** The recording for a URL, if there is one. */
export function readRecording(url) {
  try {
    const entry = JSON.parse(readFileSync(join(RECORDINGS, `${SHA(url)}.json`), "utf8"));
    return {
      status: entry.status,
      headers: entry.headers,
      body: Buffer.from(entry.body, "base64"),
      truncated: Boolean(entry.truncated),
    };
  } catch {
    return null;
  }
}

/** Writes a recording (overwrites unless `force` is false and one exists). */
export function writeRecording(url, response, { force = false } = {}) {
  const path = join(RECORDINGS, `${SHA(url)}.json`);
  if (!force && existsSync(path)) return path;
  mkdirSync(RECORDINGS, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      url,
      status: response.status,
      headers: response.headers,
      body: Buffer.from(response.body).toString("base64"),
      truncated: Boolean(response.truncated),
      fetchedAt: new Date().toISOString(),
    }),
  );
  return path;
}

/** Every URL a recording run asked for (so the test can fail on a missing one). */
export const requested = new Set();

/**
 * A `globalThis.fetch` replacement that serves recordings, fetching (and
 * recording) only on a miss. Both resolvers go through this in the parity run.
 */
export function replayFetch({ record = false, force = false, onMiss = "fail", impl = globalThis.fetch } = {}) {
  /**
   * The replay is a fetch, so it behaves like one: `redirect: "manual"` hands
   * back the 3xx (the library follows it itself, and needs to see the hop),
   * anything else follows the chain through the recordings, like a browser.
   */
  async function recordedFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input.url;
    requested.add(url);
    const headers = init.headers ?? {};
    const userAgent = headers["user-agent"] ?? headers["User-Agent"] ?? UA;
    const follow = (init.redirect ?? "follow") !== "manual";
    const recorded = readRecording(url);
    if (recorded) {
      if (follow && recorded.status >= 300 && recorded.status < 400 && recorded.headers.location) {
        return recordedFetch(new URL(recorded.headers.location, url).href, init);
      }
      const response = new Response(recorded.body, {
        status: recorded.status,
        headers: recorded.headers,
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    if (!record) {
      if (onMiss === "fail") throw new Error(`no recording for ${url}`);
      return new Response("", { status: 404 });
    }
    // A recording run follows like the caller would: the library asks for manual
    // redirects and gets them (and each hop is recorded), a browser-style fetch
    // gets the final page.
    const live = await liveFetch(url, {
      userAgent: url.startsWith("https://x.com") ? PAGE_UA : userAgent,
      impl,
      follow: (init.redirect ?? "follow") !== "manual",
    });
    writeRecording(url, live, { force });
    if (follow && live.status >= 300 && live.status < 400 && live.headers.location) {
      return recordedFetch(new URL(live.headers.location, url).href, init);
    }
    return new Response(live.body, { status: live.status, headers: live.headers });
  };
  return recordedFetch;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const inputs = args.filter((arg) => !arg.startsWith("--"));
  const list = inputs.length ? inputs : INPUTS;
  // The library's Node host is what records: it resolves the input the same way
  // the playground will, and its fetches are what land in the directory.
  const { resolveWithLibrary } = await import("../lib/resolve-lib.mjs");
  const realFetch = globalThis.fetch;
  globalThis.fetch = replayFetch({ record: true, force, impl: realFetch });
  let recorded = 0;
  try {
    for (const input of list) {
      try {
        const body = await resolveWithLibrary(input, { media: true, width: 390, dpr: 2 });
        const media = Object.keys(body.source?.media ?? {}).length;
        console.log(
          `ok   ${input.slice(0, 70)} → ${body.post.media.length} media, ${media} files, ` +
            `${Object.keys(body.post.links ?? {}).length} links${body.post.quote ? ", quote" : ""}`,
        );
        recorded += 1;
      } catch (error) {
        console.log(`FAIL ${input.slice(0, 70)}: ${error.message}`);
      }
    }
    // The JS resolver's own round: it asks for its own image variants (a
    // different `name=`, its avatar size), and the parity test replays whatever
    // each one asked for. Already-recorded URLs are served from disk.
    process.env.XEET_RESOLVE = "js";
    const { configureLinks } = await import("../lib/links.mjs");
    configureLinks({
      cacheDir: join(RECORDINGS, "..", "links-record"),
      imageDir: join(RECORDINGS, "..", "media-record"),
      allowHosts: ["x.com", "pbs.twimg.com", "t.co"],
    });
    const { resolveInput } = await import("../lib/resolve.mjs");
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const wasm = require(join(ROOT, "packages", "xeet", "wasm", "xeet_wasm.js"));
    const explain = async (post, options) => {
      const frame = Buffer.from(wasm.call(0, JSON.stringify({ op: "explain", post, options: options ?? {} })));
      return JSON.parse(frame.subarray(13, 13 + frame.readUInt32LE(1)).toString("utf8"));
    };
    for (const input of list) {
      // A page cached by the other implementation would be replayed instead of
      // fetched; these ids must start empty.
      for (const id of input.match(/status\/(\d+)/g)?.map((hit) => hit.split("/")[1]) ?? []) {
        try {
          unlinkSync(join(PLAYGROUND_CACHE, `${id}.html`));
          unlinkSync(join(PLAYGROUND_CACHE, `${id}.json`));
        } catch {}
      }
      try {
        await resolveInput(input, { media: true, links: true, explain, validate: explain, options: { width: 390, dpr: 2 } });
        console.log(`ok   js ${input.slice(0, 66)}`);
      } catch (error) {
        console.log(`FAIL js ${input.slice(0, 66)}: ${error.message}`);
      }
    }
  } finally {
    delete process.env.XEET_RESOLVE;
    globalThis.fetch = realFetch;
  }
  console.log(`recordings: ${recorded}/${list.length} inputs, ${requested.size} URLs, in ${RECORDINGS}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
