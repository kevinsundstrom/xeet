// The playground's resolver: turns a pasted x.com link (or text with links)
// into a complete post, server side.
//
// `xeet` has no public HTTP rendering API; rendering runs in the browser, in
// WebAssembly. This endpoint exists because browsers hide the `Location` of a
// manual redirect on cross-origin requests (`opaqueredirect`), so `t.co` and
// `x.com` cannot be followed from the page itself.
//
// Two things keep it cheap and hard to abuse:
//
//   - BotID. The page marks `/_playground/*` as protected (`web/app.js`), so
//     the browser attaches BotID's challenge headers; `checkBotId()` here turns
//     away anything that is not a real browser session before any work runs.
//   - Vercel Runtime Cache. A whole response is cached for 10 minutes, keyed by
//     what was asked; the resolver's own fetches (redirect chains, link cards)
//     go through the same cache for an hour. A small in-memory map in front of
//     both saves a round trip inside one warm instance.

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { domainToASCII } from "node:url";
import { getCache } from "@vercel/functions";
import { loadXeet } from "@xeet/core/node";
import { whatwgHost } from "@xeet/core/resolve";
import { checkBotId } from "botid/server";

const MAX_BODY = 256 * 1024;

let runtimePromise = null;
function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = loadXeet({ lazy: true }).then((xeet) => {
      const host = whatwgHost({
        fetch: (url, init) => fetch(mapUrl(url), init),
        lookup: async (hostName) => {
          const mapped = parseHostMap().get(hostName.toLowerCase());
          const target = mapped ? mapped.split(":")[0] : hostName;
          const ascii = domainToASCII(target) || target;
          return (await dnsLookup(ascii, { all: true, verbatim: true })).map((a) => a.address);
        },
        cacheGet: (key) => cacheGet(`xeet:host:${VERSION}:${key}`),
        cacheSet: (key, value, storedAt) => cacheSet(`xeet:host:${VERSION}:${key}`, { value, storedAt }, HOST_TTL),
      });
      return { xeet, host };
    });
  }
  return runtimePromise;
}
/** A resolved post: counts move, so ten minutes. */
const RESPONSE_TTL = 10 * 60;
/** Redirect chains and link cards change rarely. */
const HOST_TTL = 60 * 60;
/** Bump to invalidate every cached response after a resolver change. */
const VERSION = "v2";
const TAG = "xeet-resolve";

// ----------------------------------------------------------------- caching

const LOCAL = new Map();
const LOCAL_MAX = 128;

function remember(key, value) {
  if (LOCAL.has(key)) LOCAL.delete(key);
  LOCAL.set(key, value);
  if (LOCAL.size > LOCAL_MAX) LOCAL.delete(LOCAL.keys().next().value);
}

/** The Runtime Cache, or null where there is none (local runs, tests). */
function runtimeCache() {
  try {
    return getCache();
  } catch {
    return null;
  }
}

async function cacheGet(key) {
  if (LOCAL.has(key)) return LOCAL.get(key);
  try {
    const value = (await runtimeCache()?.get(key)) ?? null;
    if (value !== null) remember(key, value);
    return value;
  } catch {
    return null;
  }
}

async function cacheSet(key, value, ttl) {
  remember(key, value);
  try {
    await runtimeCache()?.set(key, value, { ttl, tags: [TAG], name: key.split(":").slice(0, 3).join(":") });
  } catch {
    // A full or unavailable cache only costs a recompute next time.
  }
}

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

// -------------------------------------------------------------- the host

// Test seams: point hostnames at a local fixture server.
function parseHostMap() {
  const map = new Map();
  for (const pair of (process.env.XEET_LINKS_HOST_MAP ?? "").split(",")) {
    const [from, to] = pair.split("=").map((s) => s?.trim());
    if (from && to) map.set(from.toLowerCase(), to);
  }
  return map;
}

function mapUrl(raw) {
  const map = parseHostMap();
  if (!map.size) return raw;
  const u = new URL(raw);
  const to = map.get(u.hostname.toLowerCase());
  if (!to) return raw;
  const [host, port] = to.split(":");
  u.protocol = "http:";
  u.hostname = host;
  u.port = port ?? "";
  return u.toString();
}

function allowHosts() {
  const raw = process.env.XEET_LINKS_ALLOW_PRIVATE ?? "";
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

// ------------------------------------------------------------- responses

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

/**
 * BotID's verdict for this request: "human", "bot", "verified-bot", "bypassed"
 * (a deployment-protection bypass token, or a firewall bypass rule) or
 * "development" (not running on Vercel, where BotID always answers human).
 */
async function botVerdict(request) {
  // `checkBotId` decides it is in development from NODE_ENV; say it from where
  // the code actually runs instead, so a production deployment is never lax.
  const isDevelopment = process.env.VERCEL !== "1";
  try {
    const verdict = await checkBotId({
      developmentOptions: { isDevelopment },
      advancedOptions: { headers: Object.fromEntries(request.headers) },
    });
    if (isDevelopment) return "development";
    if (verdict.bypassed) return "bypassed";
    if (verdict.isVerifiedBot) return "verified-bot";
    return verdict.isBot ? "bot" : "human";
  } catch (error) {
    // Fail closed: an unverifiable request is not served. The playground's
    // built-in examples need no network, so the page still works.
    console.error("botid check failed:", error?.message ?? error);
    return "bot";
  }
}

/** Per-request timings, sent back as `Server-Timing` so slowness is visible. */
class Timings {
  constructor() {
    this.start = performance.now();
    this.marks = [];
  }
  async time(name, promise) {
    const t = performance.now();
    try {
      return await promise;
    } finally {
      this.marks.push(`${name};dur=${(performance.now() - t).toFixed(1)}`);
    }
  }
  header() {
    return [...this.marks, `total;dur=${(performance.now() - this.start).toFixed(1)}`].join(", ");
  }
}

/**
 * Serves `key` from the cache, or computes it, caches a success and returns it.
 * The lookup starts at once, in parallel with BotID; `allowed` gates the answer.
 */
async function cached(key, compute, allowed, t) {
  const lookup = t.time("cache", cacheGet(key));
  const verdict = await allowed;
  if (verdict.denied) return verdict.denied;
  const hit = await lookup;
  if (hit) return json(hit, 200, { "x-xeet-cache": "hit" });
  const { body, status = 200 } = await compute();
  if (status === 200) cacheSet(key, body, RESPONSE_TTL); // not awaited: the answer does not wait for the write
  return json(body, status, { "x-xeet-cache": "miss" });
}

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return json({ code: "method_not_allowed", message: "POST only" }, 405);
    }
    const t = new Timings();
    let verdict = "unknown";
    const allowed = t.time("botid", botVerdict(request)).then((v) => {
      verdict = v;
      const denied = v === "bot" || v === "verified-bot"
        ? json({ code: "forbidden", message: "automated requests are not allowed" }, 403)
        : null;
      return { denied };
    });
    const response = await handle(request, allowed, t);
    response.headers.set("x-xeet-botid", verdict);
    response.headers.set("server-timing", t.header());
    return response;
  },
};

async function handle(request, allowed, t) {
  {
    const text = await request.text();
    if (text.length > MAX_BODY) {
      return json({ code: "request_too_large", message: "request too large" }, 413);
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ code: "invalid_json", message: "invalid JSON" }, 400);
    }

    const url = new URL(request.url);
    const media = body?.media !== false;

    if (url.pathname.endsWith("/resolve-links")) {
      if (!Array.isArray(body?.urls)) {
        return json({ code: "invalid_request", message: "urls array is required" }, 400);
      }
      if (body.urls.length > 4) {
        return json({ code: "too_many_urls", message: "at most 4 URLs per request" }, 400);
      }
      const urls = body.urls.map(String);
      return cached(`xeet:links:${VERSION}:${digest({ urls, media })}`, async () => {
        const { xeet, host } = await t.time("load", getRuntime());
        const allow = allowHosts();
        const entries = await t.time("links", Promise.all(
          urls.map(async (u) => {
            try {
              return await xeet.resolveLinks(u, { media, ...(allow ? { allowHosts: allow } : {}) }, host);
            } catch (e) {
              return { error: { code: e.code ?? "resolve_failed", message: e.message } };
            }
          }),
        ));
        const links = Object.fromEntries(urls.map((u, i) => [u, entries[i]]));
        return { body: { links } };
      }, allowed, t);
    }

    const input = typeof body?.input === "string" ? body.input : "";
    if (!input.trim()) {
      return json({ code: "invalid_request", message: "input is required" }, 400);
    }
    const width = Number(body?.width) || 390;
    const dpr = Number(body?.dpr) || 2;
    return cached(`xeet:resolve:${VERSION}:${digest({ input, media, width, dpr })}`, async () => {
      try {
        const { xeet, host } = await t.time("load", getRuntime());
        const started = performance.now();
        const resolved = await t.time("resolve", xeet.resolve(input, { media, width, dpr }, host));
        // Keep all 20 carousel items (including narrow-strip panoramas like
        // @ciguleva where 16+ slides are visible at 600 px), dropping trailing
        // base64 bytes only if the combined media payload would approach
        // Vercel's 4.5 MB function response limit.
        if (Array.isArray(resolved.post?.media) && resolved.post.media.length > 4) {
          let budget = 3_200_000;
          resolved.post.media = resolved.post.media.map((m) => {
            const len = typeof m?.data === "string" ? m.data.length : 0;
            if (!len) return m;
            if (len <= budget) {
              budget -= len;
              return m;
            }
            budget = 0;
            return { ...m, data: undefined };
          });
        }
        const kind = resolved.source?.id ? "url" : /^\s*[{[]/.test(input) ? "json" : "text";
        return {
          body: {
            kind,
            post: resolved.post,
            links: resolved.links ?? {},
            warnings: resolved.warnings ?? [],
            ms: Math.round((performance.now() - started) * 10) / 10,
          },
        };
      } catch (e) {
        return {
          status: e.status ?? 502,
          body: { code: e.code ?? "resolve_failed", message: e.message ?? "resolve failed" },
        };
      }
    }, allowed, t);
  }
}
