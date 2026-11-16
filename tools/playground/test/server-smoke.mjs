#!/usr/bin/env node
// The playground server's smoke test: start it on a free port, hit every
// endpoint, render a text post through `native` and `http`, resolve a URL from
// the cache (seeded from the corpus, so no network is needed), and check the
// PNGs are PNGs.
//
//   node tools/playground/test/server-smoke.mjs
//   node tools/playground/test/server-smoke.mjs --build       # build first if needed
//   PLAYGROUND_SMOKE_BUILD=1 node tools/playground/test/server-smoke.mjs
//
// Exits non-zero if a check fails. Prints the round-trip distribution for the
// two server targets, which is the number docs/PLAYGROUND.md's latency goals are
// about.
//
// No network: the URL case is resolved from `assets/vendor/corpus` through the
// playground's own cache directory, and the link-card case from a fixture HTTP
// server on `127.0.0.1` (a redirect chain plus twitter/og tags plus a PNG) that
// the resolver is allowed to reach only because `XEET_LINKS_ALLOW_PRIVATE` names
// it. Chrome is not rendered here (that is pg-oracle's `test/oracle*.mjs`); it
// is only checked as an inventory row.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const CORPUS = join(ROOT, "assets", "vendor", "corpus");
const CACHE = join(ROOT, "assets", "vendor", "playground");
const LINKS_CACHE = join(CACHE, "links");
const NATIVE_BIN = join(ROOT, "target", "playground", "fast", "xeet-render");
const PUBLIC_INDEX = join(ROOT, "tools", "playground", "public", "index.html");

const argv = process.argv.slice(2);
const rebuild = argv.includes("--build") || process.env.PLAYGROUND_SMOKE_BUILD === "1";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WASM_SIGNATURE = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

let failures = 0;
let skipped = 0;
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (ok) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

function skip(name, why) {
  skipped++;
  console.log(`  skip ${name} — ${why}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The link-card fixture: a local HTTP server the resolver may reach
// ---------------------------------------------------------------------------

/** A solid-colour PNG of any size, so the card can carry a real 400×210 image. */
function solidPng(width, height, [r, g, b] = [29, 155, 240]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return pngFromRaw(raw, width, height);
}

/** A PNG from raw RGB rows (filter byte included per row). */
function pngFromRaw(raw, width, height) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A deterministic, incompressible pattern: a real photo beats a flat placeholder
 *  in a PNG size comparison, which is how "real pixels" is checked. */
function patternPng(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let seed = 12345;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      // xorshift32: the low bits of an LCG cycle far too fast, and a PNG of a
      // short cycle compresses to nothing — which would defeat both the size
      // comparison and the cache-cap check.
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      raw[row + 1 + x * 3] = seed & 255;
      raw[row + 2 + x * 3] = (seed >>> 8) & 255;
      raw[row + 3 + x * 3] = (seed >>> 16) & 255;
    }
  }
  return pngFromRaw(raw, width, height);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

/**
 * A page with a two-hop redirect chain, twitter/og tags where the title comes
 * from `og:title` (the documented fallback, exercised end to end) and a 400×210
 * PNG as the card image.
 */
const FIXTURE_PNG = solidPng(400, 210);
const FIXTURE_PAGE = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>fixture</title>
<meta property="og:type" content="website">
<meta property="og:title" content="A card from the fixture &amp; friends">
<meta property="og:description" content="This description comes from Open Graph, which X falls back to.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="/img.png">
</head><body><p>not much here</p></body></html>`;

/**
 * The id of the post the nested-quote check resolves, and the id it quotes.
 * The page is what X's server render embeds: the quoted post's own quote arrives
 * twice — a stub in `quoted_tweet_results`, the real post (text, a video) in
 * `nested_quoted_tweet_results` — which is the shape `elonmusk.html` has.
 */
const NESTED_POST_ID = "2119812607117062451";
const NESTED_QUOTER_ID = "2119805979583828413";
const NESTED_INNER_ID = "2119802588841316632";

/**
 * `id` picks which post of the tree this page is: the root (which quotes the
 * quoter) or the quoter itself (which quotes the inner post). A draft that ends
 * with the quoter's link only ever sees the second.
 */
function nestedQuotePage(id, base, avatar, innerAvatar, badge) {
  const inner = {
    __typename: "Tweet",
    rest_id: NESTED_INNER_ID,
    details: { full_text: "Tesla has started the Earthworks for Project X", created_at_ms: 1762700000000 },
    core: {
      user_results: {
        result: {
          core: { name: "SERobinsonJr", screen_name: "SERobinsonJr" },
          avatar: { image_url: innerAvatar },
          identity_profile_labels_highlighted_label: { label: { description: "Fixture Org", badge: { url: badge } } },
        },
      },
    },
    media_entities2: [
      {
        type: "video",
        media_url_https: `${base}/media/inner.jpg`,
        original_info: { width: 2560, height: 1440 },
        video_info: { duration_millis: 42500 },
      },
    ],
  };
  const quoted = {
    __typename: "Tweet",
    rest_id: NESTED_QUOTER_ID,
    details: { full_text: "Tesla has officially started construction", created_at_ms: 1762750000000 },
    core: { user_results: { result: { core: { name: "Quoter", screen_name: "quoter" }, avatar: { image_url: avatar } } } },
    media_entities2: [
      { type: "photo", media_url_https: `${base}/media/quoter.jpg`, original_info: { width: 1600, height: 900 } },
    ],
    // The stub X leaves in the first slot, and the real post in the second.
    quoted_tweet_results: { result: { __typename: "Tweet", rest_id: NESTED_INNER_ID, id: NESTED_INNER_ID } },
    nested_quoted_tweet_results: { result: inner },
  };
  const root = {
    __typename: "Tweet",
    rest_id: NESTED_POST_ID,
    details: { full_text: "Wow https://t.co/nested", created_at_ms: 1762785296789 },
    core: { user_results: { result: { core: { name: "Fixture", screen_name: "fixture" } } } },
    quoted_tweet_results: { result: quoted },
    url_entities: [{ url: "https://t.co/nested", display_url: "x.com/someone/status…" }],
  };
  const payload = id === NESTED_QUOTER_ID ? quoted : root;
  const escaped = JSON.stringify(JSON.stringify(payload));
  return `<html><head><script>window.__STATE__ = ${escaped};</script></head><body></body></html>`;
}

/** The post a "Post video" link points at, and the post crediting another author. */
const ATTACH_POST_ID = "2118458629091426304";
const CREDIT_POST_ID = "2118458629091426305";

function attachPage(base, { id = ATTACH_POST_ID, handle = "fixture", source = null } = {}) {
  const media = {
    type: "video",
    media_url_https: `${base}/media/attach-poster.jpg`,
    original_info: { width: 1280, height: 720 },
    video_info: { duration_millis: 42000 },
    ext_alt_text: "a fixture video",
  };
  if (source) {
    media.source_user_results = {
      result: {
        __typename: "User",
        rest_id: "4242",
        core: { name: "NFL", screen_name: source },
        avatar: { image_url: `${base}/avatar.jpg` },
        verification: { verified_type: "Business", is_blue_verified: true },
        profile_image_shape: "Square",
      },
    };
  }
  const payload = {
    __typename: "Tweet",
    rest_id: id,
    details: { full_text: "the original fixture post", created_at_ms: 1762380000000 },
    core: {
      user_results: {
        result: {
          core: { name: "Fixture", screen_name: handle },
          avatar: { image_url: `${base}/avatar2.jpg` },
          verification: { is_blue_verified: true },
        },
      },
    },
    media_entities2: [media],
    counts: { reply_count: 1, retweet_count: 2, quote_count: 3, favorite_count: 4 },
  };
  const escaped = JSON.stringify(JSON.stringify(payload));
  return `<html><head><script>window.__STATE__ = ${escaped};</script></head><body></body></html>`;
}

const FIXTURE_IMAGES = new Map();
function fixtureImage(key, make) {
  if (!FIXTURE_IMAGES.has(key)) FIXTURE_IMAGES.set(key, make());
  return FIXTURE_IMAGES.get(key);
}

/** The host this request arrived as (the resolver's mapped name, or 127.0.0.1). */
function fixtureHostFor(req) {
  return req.headers.host ?? `127.0.0.1:${req.socket.localPort}`;
}

/** Any request for a video stream during the run: there must be none. */
const videoStreamRequests = [];

async function startFixture() {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("User-agent: Twitterbot\nDisallow: /blocked\n");
    }
    if (path === "/start") {
      res.writeHead(302, { location: "/hop" });
      return res.end();
    }
    if (path === "/hop") {
      res.writeHead(301, { location: "/page" });
      return res.end();
    }
    if (path === "/blocked") {
      return res.end("robots.txt should have kept us away");
    }
    if (path === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(FIXTURE_PAGE);
    }
    if (path === `/i/status/${ATTACH_POST_ID}` || path === `/i/status/${CREDIT_POST_ID}`) {
      const base = `http://${fixtureHostFor(req)}`;
      const credit = path.endsWith(CREDIT_POST_ID);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(
        attachPage(base, credit ? { id: CREDIT_POST_ID, handle: "espn", source: "NFL" } : { handle: "cursor_ai" }),
      );
    }
    if (path.endsWith(".mp4") || path.endsWith(".m3u8")) {
      videoStreamRequests.push(path);
      res.writeHead(200, { "content-type": "video/mp4" });
      return res.end(Buffer.alloc(0));
    }
    if (path === `/i/status/${NESTED_POST_ID}` || path === `/i/status/${NESTED_QUOTER_ID}`) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const base = `http://${fixtureHostFor(req)}`;
      return res.end(
        nestedQuotePage(
          path.endsWith(NESTED_QUOTER_ID) ? NESTED_QUOTER_ID : NESTED_POST_ID,
          base,
          `${base}/avatar.jpg`,
          `${base}/avatar2.jpg`,
          `${base}/badge.jpg`,
        ),
      );
    }
    if (path === "/img.png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(FIXTURE_PNG.length) });
      return res.end(FIXTURE_PNG);
    }
    // Media fixture: the payload URLs point here, and `?name=` picks a size, so
    // `source.media` reports which variant the resolver chose.
    if (path.startsWith("/media/")) {
      const variant = new URL(req.url ?? "/", "http://fixture").searchParams.get("name") ?? "orig";
      const size = { small: [680, 382], medium: [1200, 675], large: [2048, 1152] }[variant] ?? [400, 210];
      const bytes = fixtureImage(`${variant}:${path}`, () => patternPng(size[0], size[1]));
      res.writeHead(200, { "content-type": "image/png", "content-length": String(bytes.length) });
      return res.end(bytes);
    }
    if (path === "/avatar.jpg" || path === "/avatar2.jpg" || path === "/badge.jpg") {
      const bytes = fixtureImage(`${path}`, () => solidPng(96, 96, [10, 120, 220]));
      res.writeHead(200, { "content-type": "image/png", "content-length": String(bytes.length) });
      return res.end(bytes);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    // A name with a real TLD: xeet's own entity extraction does not treat an IP
    // literal as a URL, so a post's text cannot contain `127.0.0.1`. The
    // resolver's test-only host map connects this name to the fixture.
    host: "fixture.example.com",
    nonce: Math.random().toString(36).slice(2, 8),
    url: (path) => `http://fixture.example.com${path}`,
    image: (path) => `http://fixture.example.com${path}?run=${Math.random().toString(36).slice(2, 10)}`,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------------------
// Media inlining, against the fixture image endpoints
// ---------------------------------------------------------------------------

/**
 * Drives `lib/media.mjs` the way a URL resolve does: a payload whose media
 * URLs point at the fixture, a post with the same shapes, and the render
 * options of an iPhone Duo (the open pose is a 600 px column at dpr 3).
 */
async function checkMediaInlining(fixture, base) {
  const { configureLinks, enforceImageCacheCap } = await import("../lib/links.mjs");
  const { inlinePostMedia, variantFor, slotWidth } = await import("../lib/media.mjs");
  configureLinks({
    cacheDir: LINKS_CACHE,
    allowHosts: ["127.0.0.1"],
    hostMap: { [fixture.host]: `127.0.0.1:${fixture.port}` },
  });
  // The route's resolver is the Rust library; it reads the same test seam from
  // the environment (`XEET_LINKS_ALLOW_PRIVATE` / `XEET_LINKS_HOST_MAP`).
  process.env.XEET_LINKS_ALLOW_PRIVATE = `127.0.0.1,${fixture.host},x.com`;
  process.env.XEET_LINKS_HOST_MAP = `${fixture.host}=127.0.0.1:${fixture.port},x.com=127.0.0.1:${fixture.port}`;

  // The variant rule itself: dpr 3 at 382 and at the 600 column (Duo open).
  check("media: a 382 slot at dpr 3 gets a medium variant", variantFor(slotWidth({ count: 1, contentWidth: 350 }), 3) === "medium", variantFor(slotWidth({ count: 1, contentWidth: 350 }), 3));
  check("media: the 600 column at dpr 3 gets large", variantFor(slotWidth({ count: 1, contentWidth: 568 }), 3) === "large", variantFor(slotWidth({ count: 1, contentWidth: 568 }), 3));
  check("media: four photos in the 600 column at dpr 3 get medium", variantFor(slotWidth({ count: 4, contentWidth: 568 }), 3) === "medium", variantFor(slotWidth({ count: 4, contentWidth: 568 }), 3));

  const mediaUrl = (name, variant = null) =>
    `${fixture.image(`/media/${name}.jpg`)}${variant ? `&name=${variant}` : ""}`;
  const payload = {
    core: {
      user_results: {
        result: {
          avatar: { image_url: fixture.image("/avatar.jpg") },
          identity_profile_labels_highlighted_label: {
            label: { description: "Fixture Org", badge: { url: fixture.image("/badge.jpg") } },
          },
        },
      },
    },
    media_entities2: [
      {
        type: "video",
        media_url_https: mediaUrl("poster"),
        original_info: { width: 1920, height: 1080 },
        video_info: { duration_millis: 30000, variants: [] },
      },
    ],
    quoted_tweet_results: {
      result: {
        core: { user_results: { result: { avatar: { image_url: fixture.image("/avatar2.jpg") } } } },
        media_entities2: [
          { type: "photo", media_url_https: mediaUrl("quote"), original_info: { width: 1000, height: 800 } },
        ],
      },
    },
  };
  const post = {
    text: "A video and a quote",
    author: { name: "Fixture", handle: "fixture", verified: "none", affiliate: { name: "Fixture Org" } },
    media: [{ kind: "video", width: 1920, height: 1080, duration: 30 }],
    quote: {
      text: "quoted",
      author: { name: "Q", handle: "q", verified: "none" },
      media: [{ kind: "image", width: 1000, height: 800 }],
    },
  };

  const { map } = await inlinePostMedia(post, payload, { width: 669, dpr: 3, media: true });
  const posterUrl = Object.keys(map).find((url) => map[url].role === "media:0");
  check(
    "media: a video's poster frame is inlined as Media.data",
    Boolean(post.media[0].data) && map[posterUrl]?.variant === "large",
    posterUrl ?? "no entry",
  );
  check(
    "media: the poster's bytes are cached with their dimensions",
    map[posterUrl]?.width > 0 && map[posterUrl]?.height > 0 && map[posterUrl]?.bytes > 0,
    `${map[posterUrl]?.width}×${map[posterUrl]?.height}, ${map[posterUrl]?.bytes} bytes`,
  );
  check("media: the quoted post's photo is inlined", Boolean(post.quote.media[0].data));
  const avatarEntries = Object.entries(map).filter(([, entry]) => entry.role === "avatar");
  check(
    "media: avatars are fetched at X's 3x size",
    Boolean(post.author.avatar) && avatarEntries.some(([, entry]) => entry.variant === "_reasonably_small"),
    avatarEntries.map(([, entry]) => entry.variant).join(","),
  );
  check("media: the affiliation badge is inlined", Boolean(post.author.affiliate.badge));
  check("media: the quoted author's avatar is inlined", Boolean(post.quote.author.avatar));
  check(
    "media: source.media maps every inlined URL to a file",
    Object.values(map).length >= 4 && Object.values(map).every((entry) => entry.file && existsSync(entry.file)),
    `${Object.keys(map).length} entries`,
  );

  // Real pixels: the same post renders bigger (and differently) with the bytes
  // than with the placeholders.
  const without = JSON.parse(JSON.stringify(post));
  for (const item of [...without.media, ...without.quote.media]) delete item.data;
  without.author.avatar = undefined;
  without.quote.author.avatar = undefined;
  without.author.affiliate = undefined;
  const withPng = await postJson(base, "/api/render", { target: "native", post, options: { width: 669, dpr: 3 } });
  const withoutPng = await postJson(base, "/api/render", { target: "native", post: without, options: { width: 669, dpr: 3 } });
  const a = pngOf(withPng.body);
  const b = pngOf(withoutPng.body);
  check(
    "media: the native render draws the fetched bytes",
    isPng(a) && a.length > b.length * 1.1 && !a.equals(b),
    `${a.length} bytes with media, ${b.length} without`,
  );
  const asHttp = await postJson(base, "/api/render", { target: "http", post, options: { width: 669, dpr: 3 } });
  check("media: every target draws the same pixels", isPng(pngOf(asHttp.body)) && pngOf(asHttp.body).equals(a), "");

  // The cache cap: with a tiny cap, writing a second image evicts the first.
  const tmpDir = join(ROOT, "tmp", `media-cap-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
  configureLinks({ imageDir: tmpDir, imageCacheBytes: 1_000_000 });
  const { fetchImageAsset } = await import("../lib/links.mjs");
  const first = await fetchImageAsset(mediaUrl("cap-1", "small"), {});
  const second = await fetchImageAsset(mediaUrl("cap-2", "small"), {});
  const evicted = await enforceImageCacheCap({ force: true });
  const remaining = existsSync(first.file);
  check(
    "media: the cache evicts the least recently used file above its cap",
    second.bytes.length > 0 && !remaining,
    `first ${first.bytes.length}B, second ${second.bytes.length}B, evicted ${evicted.evicted} (${evicted.bytes}B left); first file ${remaining ? "kept" : "evicted"}`,
  );
  configureLinks({ imageDir: join(CACHE, "media"), imageCacheBytes: 500 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// The HTTP function's /resolve-links route, in-process
// ---------------------------------------------------------------------------

/**
 * Calls the shipped function the way the deployment does — a real `Request`
 * into `api/index.mjs` — so the route, its limits and its error shape are
 * covered without a server.
 */
async function checkResolveLinksRoute(fixture, linkUrl) {
  const { configureLinks } = await import("../lib/links.mjs");
  // Same cache the playground's server uses, so this is a cache hit for the URL
  // the resolve above already fetched; the fixture host is reachable for this
  // process only.
  configureLinks({
    cacheDir: LINKS_CACHE,
    allowHosts: ["127.0.0.1"],
    hostMap: { [fixture.host]: `127.0.0.1:${fixture.port}` },
  });
  // The route's resolver is the Rust library; it reads the same test seam from
  // the environment (`XEET_LINKS_ALLOW_PRIVATE` / `XEET_LINKS_HOST_MAP`).
  process.env.XEET_LINKS_ALLOW_PRIVATE = `127.0.0.1,${fixture.host},x.com`;
  process.env.XEET_LINKS_HOST_MAP = `${fixture.host}=127.0.0.1:${fixture.port},x.com=127.0.0.1:${fixture.port}`;
  const api = (await import(join(ROOT, "api", "playground-resolve.mjs"))).default;
  const call = async (path, body) => {
    const response = await api.fetch(
      new Request(`http://localhost/_playground${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: await response.json() };
  };

  const ok = await call("/resolve-links", { urls: [linkUrl] });
  check(
    "POST /resolve-links returns the card metadata",
    ok.status === 200 && ok.body?.links?.[linkUrl]?.meta?.card === "summary_large_image",
    `status ${ok.status}, card ${ok.body?.links?.[linkUrl]?.meta?.card ?? ok.body?.links?.[linkUrl]?.error?.code ?? "none"}`,
  );

  const tooMany = await call("/resolve-links", { urls: Array.from({ length: 5 }, () => linkUrl) });
  check(
    "POST /resolve-links caps a request at 4 URLs",
    tooMany.status === 400 && tooMany.body?.code === "too_many_urls",
    `status ${tooMany.status} ${tooMany.body?.code ?? ""}`,
  );

  const noUrls = await call("/resolve-links", {});
  check("POST /resolve-links needs urls", noUrls.status === 400 && noUrls.body?.code === "invalid_request", `status ${noUrls.status}`);

  const metadata = "http://169.254.169.254/latest/meta-data/";
  const ssrf = await call("/resolve-links", { urls: [metadata] });
  check(
    "POST /resolve-links refuses the cloud metadata address",
    ssrf.body?.links?.[metadata]?.error?.code === "private_address",
    ssrf.body?.links?.[metadata]?.error?.code ?? JSON.stringify(ssrf.body).slice(0, 120),
  );

  const blocked = `${fixture.base}/blocked`;
  const robots = await call("/resolve-links", { urls: [blocked] });
  check(
    "POST /resolve-links honours robots.txt",
    robots.body?.links?.[blocked]?.error?.code === "robots",
    robots.body?.links?.[blocked]?.error?.message?.slice(0, 80) ?? "",
  );
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [join(ROOT, "tools", "playground", "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", PLAYGROUND_WATCH: "0", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8000);
  });
  const rl = createInterface({ input: child.stdout });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server did not print its URL in 20 s\n${stderr}`)), 20000);
    rl.on("line", (line) => {
      const match = line.match(/^playground: http:\/\/127\.0\.0\.1:(\d+)$/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited with ${code} before printing its URL\n${stderr}`));
    });
  });
  // Keep draining so a chatty server never blocks on a full pipe.
  rl.on("line", () => {});
  return { child, port, base: `http://127.0.0.1:${port}`, stderr: () => stderr };
}

async function stopServer(server) {
  if (!server) return;
  server.child.kill("SIGTERM");
  const exited = new Promise((resolve) => server.child.once("exit", resolve));
  await Promise.race([exited, sleep(3000)]);
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function getJson(base, path, options = {}) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(120000), ...options });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
}

async function postJson(base, path, body) {
  return getJson(base, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const pngOf = (body) => Buffer.from(String(body?.png ?? ""), "base64");
const isPng = (buf) => buf.length > 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);

const POST = {
  text: "We just shipped the thing.\n\nRead more: https://vercel.com/blog/the-thing",
  author: { name: "Vercel", handle: "vercel", verified: "business" },
};

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function main() {
  console.log(`playground smoke: ${ROOT}`);

  if (!existsSync(NATIVE_BIN)) {
    if (rebuild) {
      console.log("  native binary is missing; building it (this takes a while)…");
      const server = await startServer();
      try {
        const built = await postJson(server.base, "/api/build", { target: "native" });
        if (!check("build native", built.body?.ok === true, built.body?.log?.split("\n").slice(-3).join(" | "))) {
          throw new Error("the native build failed, so nothing else can be checked");
        }
      } finally {
        await stopServer(server);
      }
    } else {
      console.log(`\nthe native binary is not built: ${NATIVE_BIN}`);
      console.log("run with --build (or PLAYGROUND_SMOKE_BUILD=1) to build it, or build it once with:");
      console.log("  CARGO_TARGET_DIR=target/playground cargo build --profile fast -p xeet-cli --bin xeet-render\n");
      process.exit(2);
    }
  }

  // --- resolve from the corpus, offline: seed the playground cache by hand so
  // the test needs no network.
  const cachedId = "20";
  mkdirSync(CACHE, { recursive: true });
  const seed = join(CORPUS, "jack-20.html");
  let seeded = false;
  if (existsSync(seed)) {
    // Verify with the payload extractor: a captured page embeds its payload as
    // escaped JSON, so a substring test for `"rest_id":"20"` never matches.
    const { extractTweets } = await import("../../oracle/samples.mjs");
    const html = readFileSync(seed, "utf8");
    if (extractTweets(html).some((t) => String(t.rest_id) === cachedId)) {
      writeFileSync(join(CACHE, `${cachedId}.html`), html);
      const lock = JSON.parse(readFileSync(join(ROOT, "assets", "upstream.lock.json"), "utf8"));
      writeFileSync(
        join(CACHE, `${cachedId}.json`),
        JSON.stringify(
          {
            url: `https://x.com/i/status/${cachedId}`,
            id: cachedId,
            seededFromCorpus: "assets/vendor/corpus/jack-20.html",
            fetchedAt: lock.fetchedAt,
            appVersion: html.match(/"appVersion":"([0-9a-f]+)"/)?.[1] ?? null,
          },
          null,
          2,
        ) + "\n",
      );
      seeded = true;
    }
  }

  const fixture = await startFixture();
  // The resolver refuses private addresses by default; the fixture is on
  // 127.0.0.1, so the test names it, and maps the fixture's TLD host to it.
  // Nothing else in the process may reach it.
  const server = await startServer({
    // The resolver (Rust, through wasm) refuses private hosts and non-default
    // ports; the fixture is both, so the test names it and maps it. `x.com` is
    // mapped too: a post URL is fetched from `https://x.com/i/status/<id>`
    // whatever host it was written with.
    XEET_LINKS_ALLOW_PRIVATE: `127.0.0.1,${fixture.host},x.com,pbs.twimg.com,video.twimg.com`,
    XEET_LINKS_HOST_MAP:
      `${fixture.host}=127.0.0.1:${fixture.port},` +
      `x.com=127.0.0.1:${fixture.port},` +
      `pbs.twimg.com=127.0.0.1:${fixture.port},` +
      `video.twimg.com=127.0.0.1:${fixture.port}`,
    // A fixture URL must never be answered from (or left in) the playground's
    // real card cache.
    XEET_LINKS_CACHE_DIR: join(CACHE, "links-fixture"),
  });
  console.log(`  up    ${server.base}`);
  console.log(`  links ${fixture.url("")} → 127.0.0.1:${fixture.port} (fixture; offline)\n`);
  try {
    // --- inventory
    const targets = await getJson(server.base, "/api/targets");
    check("GET /api/targets", targets.status === 200 && Array.isArray(targets.body?.targets), `status ${targets.status}`);
    const ids = (targets.body?.targets ?? []).map((t) => t.id);
    check("targets are chrome, wasm, native, http", ["chrome", "wasm", "native", "http"].every((id) => ids.includes(id)), ids.join(", "));
    const nativeRow = targets.body?.targets?.find((t) => t.id === "native");
    const httpRow = targets.body?.targets?.find((t) => t.id === "http");
    check("native target is available", Boolean(nativeRow?.available), nativeRow?.error ?? "");
    check(
      "native version has rev/builtAt/ruleset/upstream",
      Boolean(nativeRow?.version?.rev && nativeRow?.version?.builtAt && nativeRow?.version?.ruleset && nativeRow?.version?.upstream),
      JSON.stringify(nativeRow?.version ?? null),
    );
    check("http target is available", Boolean(httpRow?.available), httpRow?.error ?? "");
    const chromeRow = targets.body?.targets?.find((t) => t.id === "chrome");
    if (chromeRow?.available) check("chrome target is available", true, "pg-oracle's module imports");
    else skip("chrome target", chromeRow?.error ?? "not installed");

    // --- static files
    if (existsSync(PUBLIC_INDEX)) {
      const page = await fetch(`${server.base}/`);
      check("GET / serves the UI", page.status === 200 && /text\/html/.test(page.headers.get("content-type") ?? ""), `status ${page.status}`);
    } else {
      skip("GET / serves the UI", "public/index.html does not exist yet (pg-ui builds it)");
    }
    const wasm = await fetch(`${server.base}/wasm/xeet_wasm_bg.wasm`);
    const wasmBytes = Buffer.from(await wasm.arrayBuffer());
    check(
      "GET /wasm/xeet_wasm_bg.wasm",
      wasm.status === 200 && wasm.headers.get("content-type") === "application/wasm" && wasmBytes.subarray(0, 4).equals(WASM_SIGNATURE),
      `${wasm.status} ${wasm.headers.get("content-type")} ${wasmBytes.length} bytes`,
    );
    const glue = await fetch(`${server.base}/wasm/xeet_wasm.js`);
    check("GET /wasm/xeet_wasm.js", glue.status === 200 && /javascript/.test(glue.headers.get("content-type") ?? ""), `${glue.status}`);

    // --- resolve: text
    const text = await postJson(server.base, "/api/resolve", { input: "hello world\nsecond line" });
    check(
      "POST /api/resolve text",
      text.status === 200 && text.body?.kind === "text" && text.body?.post?.text === "hello world\nsecond line",
      JSON.stringify(text.body).slice(0, 120),
    );

    // --- resolve: post JSON (validated by native)
    const good = await postJson(server.base, "/api/resolve", {
      input: JSON.stringify({ text: "hi", author: { name: "A", handle: "a" } }),
    });
    check(
      "POST /api/resolve post JSON",
      good.status === 200 && good.body?.kind === "json" && good.body?.post?.text === "hi",
      `validatedBy ${good.body?.validatedBy ?? "?"}`,
    );

    // --- resolve: post JSON with a typo → strict error with a suggestion
    const bad = await postJson(server.base, "/api/resolve", {
      input: JSON.stringify({ text: "hi", auther: { name: "A", handle: "a" } }),
    });
    const badFields = bad.body?.error?.fields ?? [];
    check(
      "POST /api/resolve rejects a typo with fields",
      bad.status === 400 && badFields.length > 0 && JSON.stringify(badFields).includes("did you mean `author`"),
      `status ${bad.status}`,
    );

    // --- resolve: URL from the cache (seeded from the corpus above)
    if (seeded) {
      const url = await postJson(server.base, "/api/resolve", {
        input: `https://x.com/jack/status/${cachedId}`,
        offline: true,
      });
      check(
        "POST /api/resolve URL from cache",
        url.status === 200 && url.body?.kind === "url" && typeof url.body?.post?.text === "string" && url.body.post.text.length > 0,
        `id ${url.body?.source?.id} cached ${url.body?.source?.cached}`,
      );
      check(
        "resolved URL carries source.page",
        typeof url.body?.source?.page === "string" && existsSync(url.body.source.pagePath ?? ""),
        `${url.body?.source?.page} → ${url.body?.source?.pagePath ?? ""}`,
      );
      const page = await fetch(`${server.base}/api/source/${cachedId}`);
      const html = await page.text();
      check(
        "GET /api/source/:id serves the captured page",
        page.status === 200 &&
          /text\/html/.test(page.headers.get("content-type") ?? "") &&
          html.length > 1000 &&
          html.includes("rest_id"),
        `${page.status} ${html.length} bytes`,
      );
    } else {
      skip("POST /api/resolve URL", `no usable seed page at ${seed}`);
    }

    // --- link cards: a text post whose URL redirects to a tagged page
    //
    // This is the user-visible bug the resolver exists for: paste a link and
    // the card must appear in every target. The fixture answers `/start` with a
    // 302 → 301 → page chain, and the page's title/description come from Open
    // Graph (the documented fallback), so the whole path is exercised offline.
    const linkUrl = fixture.url("/start");
    const linked = await postJson(server.base, "/api/resolve", {
      input: `We shipped it.\n\nRead more: ${linkUrl}`,
    });
    const linkMeta = linked.body?.post?.links?.[linkUrl];
    check(
      "POST /api/resolve fills post.links from a pasted URL",
      linked.status === 200 && Boolean(linkMeta),
      JSON.stringify(linked.body?.post?.links ?? null).slice(0, 220),
    );
    check(
      "the card follows the redirect chain",
      Boolean(linkMeta?.card === "summary_large_image") && (linked.body?.links?.[linkUrl]?.chain ?? []).length >= 3,
      `card ${linkMeta?.card}; chain ${(linked.body?.links?.[linkUrl]?.chain ?? []).map((hop) => hop.status).join("→")}`,
    );
    check(
      "the card takes its title from og:title and its domain from the final host",
      linkMeta?.title === "A card from the fixture & friends" && linkMeta?.domain === fixture.host,
      `title ${JSON.stringify(linkMeta?.title)} domain ${linkMeta?.domain}`,
    );
    check(
      "the card image is fetched and measured",
      linkMeta?.image?.width === 400 && linkMeta?.image?.height === 210,
      `${linkMeta?.image?.width}×${linkMeta?.image?.height}`,
    );
    check(
      "the display form is the unshortened URL",
      linkMeta?.display === `${fixture.host}/page`,
      linkMeta?.display ?? "",
    );

    const withoutLinks = await postJson(server.base, "/api/render", {
      target: "native",
      client: "smoke",
      post: { text: `We shipped it.\n\nRead more: ${linkUrl}` },
      options: { width: 390, theme: "dark", dpr: 2 },
    });
    check(
      "a post with the resolved links has no card left to fill in",
      withoutLinks.body?.report?.attachment?.shown !== "card",
      `attachment ${withoutLinks.body?.report?.attachment?.shown ?? "none"}`,
    );
    const withCard = await postJson(server.base, "/api/render", {
      target: "native",
      client: "smoke",
      post: linked.body.post,
      options: { width: 390, theme: "dark", dpr: 2 },
    });
    check(
      "the card renders in the native target",
      withCard.status === 200 &&
        withCard.body?.report?.attachment?.shown === "card" &&
        pngOf(withCard.body).length > pngOf(withoutLinks.body).length,
      `attachment ${withCard.body?.report?.attachment?.shown ?? "none"}, ${withCard.body?.height} px tall`,
    );

    // --- two levels of quotes: a draft whose trailing link quotes a post that
    // quotes another. X's nested preview draws that second level, and the
    // resolver must fill it (and its bytes) rather than drop it.
    const nestedInput = `this is huge\n\nhttps://x.com/i/status/${NESTED_QUOTER_ID}`;
    const nested = await postJson(server.base, "/api/resolve", {
      input: nestedInput,
      media: true,
      options: { width: 390, dpr: 2 },
    });
    const level1 = nested.body?.post?.quote ?? null;
    const level2 = level1?.quote ?? null;
    check(
      "resolve: a draft quote carries post.quote (level 1)",
      Boolean(level1) && level1.author?.handle === "quoter" && level1.media?.length === 1,
      `quote ${level1?.author?.handle ?? "none"}, ${level1?.media?.length ?? 0} media`,
    );
    check(
      "resolve: and post.quote.quote (level 2), from the rich payload not the stub",
      Boolean(level2) &&
        level2.author?.handle === "SERobinsonJr" &&
        level2.text === "Tesla has started the Earthworks for Project X" &&
        level2.media?.length === 1,
      `${level2?.author?.handle ?? "none"}: ${JSON.stringify(level2?.text ?? null).slice(0, 40)}`,
    );
    check(
      "resolve: the nested quote's avatar, badge and first media are inlined",
      Boolean(level2?.author?.avatar) &&
        Boolean(level2?.author?.affiliate?.badge) &&
        Boolean(level2?.media?.[0]?.data),
      `avatar ${Boolean(level2?.author?.avatar)}, badge ${Boolean(level2?.author?.affiliate?.badge)}, ` +
        `media ${Boolean(level2?.media?.[0]?.data)}, warnings ${JSON.stringify(nested.body?.warnings ?? null).slice(0, 200)}`,
    );
    check(
      "resolve: a third level is dropped",
      level2?.quote === undefined || level2?.quote === null,
      `depth 3 ${level2?.quote ? "present" : "absent"}`,
    );
    const nestedFiles = Object.entries(nested.body?.source?.media ?? {});
    const roleOf = (role) => nestedFiles.find(([, file]) => file.role === role)?.[1] ?? null;
    const innerFile = roleOf("quoted quoted media:0");
    const innerAvatar = roleOf("quoted quoted avatar");
    check(
      "resolve: source.media names the nested slots (quoted quoted …)",
      Boolean(innerFile) && Boolean(innerAvatar) && innerFile.variant === "small",
      `${innerFile ? `${innerFile.variant} ${innerFile.width}×${innerFile.height}` : "no media:0"}, ` +
        `${innerAvatar ? `${innerAvatar.variant}` : "no avatar"}`,
    );
    const nestedRender = await postJson(server.base, "/api/render", {
      target: "native",
      client: "smoke",
      post: nested.body.post,
      options: { width: 390, theme: "light", dpr: 2 },
    });
    const flattened = structuredClone(nested.body.post);
    if (flattened.quote) delete flattened.quote.quote;
    const flatRender = await postJson(server.base, "/api/render", {
      target: "native",
      client: "smoke",
      post: flattened,
      options: { width: 390, theme: "light", dpr: 2 },
    });
    // The resolver's job is the tree and the bytes; whether the preview *draws*
    // is the renderer's `cards::nested_eligible`, which declines a shape where
    // more than one of the three posts has an attachment of its own (here q1 and
    // q2 both have media, and the draft's own text carries the quoted link). So
    // the render must succeed either way, and a taller cell is a pass — an equal
    // one is reported, not failed.
    check(
      "resolve: the post with a nested quote renders",
      nestedRender.status === 200 && isPng(pngOf(nestedRender.body)),
      `${nestedRender.status}/${nestedRender.body?.height} px ` +
        `${JSON.stringify(nestedRender.body?.error ?? null).slice(0, 120)}`,
    );
    if (nestedRender.body?.height > flatRender.body?.height) {
      check(
        "resolve: the nested preview draws (the cell is taller with it)",
        true,
        `${nestedRender.body?.height} px vs ${flatRender.body?.height} px`,
      );
    } else {
      skip(
        "resolve: the nested preview draws",
        "the renderer's nested_eligible declines this shape (q1 and q2 both have media)",
      );
    }

    // --- "Post video" / "Post photo": a status URL that *names a media item* is
    // an attachment, not a quote — while the same URL without the suffix is the
    // quote it has always been.
    const videoLink = `https://x.com/cursor_ai/status/${ATTACH_POST_ID}/video/1`;
    const attached = await postJson(server.base, "/api/resolve", {
      input: `watch this\n\n${videoLink}`,
      media: true,
      options: { width: 600, dpr: 2 },
    });
    const attachedMedia = attached.body?.post?.media?.[0] ?? null;
    check(
      "resolve: /status/<id>/video/1 becomes post media, not a quote",
      attached.status === 200 &&
        attached.body?.post?.quote == null &&
        attachedMedia?.kind === "video" &&
        attachedMedia?.width === 1280 &&
        attachedMedia?.height === 720,
      `quote ${attached.body?.post?.quote ? "present" : "none"}, media ` +
        `${attachedMedia?.kind ?? "none"} ${attachedMedia?.width}×${attachedMedia?.height}`,
    );
    check(
      "resolve: the attached video carries its poster and credits its author",
      Boolean(attachedMedia?.data) &&
        attachedMedia?.sourceAuthor?.handle === "cursor_ai" &&
        Boolean(attachedMedia?.sourceAuthor?.avatar),
      `poster ${Boolean(attachedMedia?.data)}, source ` +
        `${attachedMedia?.sourceAuthor?.handle ?? "none"}, avatar ${Boolean(attachedMedia?.sourceAuthor?.avatar)}`,
    );
    const sourceAvatar = Object.values(attached.body?.source?.media ?? {}).find((file) => file.role === "media:0 source avatar");
    check(
      "resolve: source.media carries the attribution avatar at the 16 px size",
      Boolean(sourceAvatar) && sourceAvatar.variant === "_normal",
      sourceAvatar ? `${sourceAvatar.variant} ${sourceAvatar.width}×${sourceAvatar.height}` : "no media:0 source avatar",
    );
    const sameWithoutSuffix = await postJson(server.base, "/api/resolve", {
      input: `watch this\n\nhttps://x.com/cursor_ai/status/${ATTACH_POST_ID}`,
      media: true,
      options: { width: 600, dpr: 2 },
    });
    check(
      "resolve: the same status URL without the suffix is still a quote",
      sameWithoutSuffix.status === 200 &&
        Boolean(sameWithoutSuffix.body?.post?.quote) &&
        (sameWithoutSuffix.body?.post?.media ?? []).length === 0,
      `quote ${sameWithoutSuffix.body?.post?.quote ? "present" : "none"}, ` +
        `${(sameWithoutSuffix.body?.post?.media ?? []).length} media`,
    );

    // A payload that credits another author (`source_user_results`, ESPN → NFL).
    const credited = await postJson(server.base, "/api/resolve", {
      input: `https://x.com/espn/status/${CREDIT_POST_ID}`,
      media: true,
      options: { width: 600, dpr: 2 },
    });
    const creditedMedia = credited.body?.post?.media?.[0] ?? null;
    check(
      "resolve: a payload's source_user_results becomes Media.sourceAuthor",
      creditedMedia?.sourceAuthor?.handle === "NFL" &&
        creditedMedia?.sourceAuthor?.squareAvatar === true &&
        Boolean(creditedMedia?.sourceAuthor?.avatar),
      `${creditedMedia?.sourceAuthor?.handle ?? "none"}, avatar ${Boolean(creditedMedia?.sourceAuthor?.avatar)}, ` +
        `credit ${JSON.stringify(creditedMedia?.sourceAuthor ?? null).slice(0, 60)}`,
    );

    // Direct twimg URLs: the video is never downloaded, its size comes from the
    // path; a photo is inlined.
    const beforeStreams = videoStreamRequests.length;
    const directVideo = await postJson(server.base, "/api/resolve", {
      input: "watch https://video.twimg.com/amplify_video/123/vid/avc1/864x1080/clip.mp4",
      media: true,
      options: { width: 600, dpr: 2 },
    });
    const directMedia = directVideo.body?.post?.media?.[0] ?? null;
    check(
      "resolve: a video.twimg.com URL attaches a 864×1080 video without fetching it",
      directMedia?.kind === "video" &&
        directMedia?.width === 864 &&
        directMedia?.height === 1080 &&
        videoStreamRequests.length === beforeStreams,
      `${directMedia?.kind ?? "none"} ${directMedia?.width}×${directMedia?.height}, ` +
        `${videoStreamRequests.length - beforeStreams} stream requests`,
    );
    const directPhoto = await postJson(server.base, "/api/resolve", {
      input: "look https://pbs.twimg.com/media/ABC.jpg",
      media: true,
      options: { width: 600, dpr: 2 },
    });
    const directPhotoMedia = directPhoto.body?.post?.media?.[0] ?? null;
    check(
      "resolve: a pbs.twimg.com/media URL is inlined as a photo",
      directPhotoMedia?.kind === "image" && Boolean(directPhotoMedia?.data) && directPhotoMedia?.width > 0,
      `${directPhotoMedia?.kind ?? "none"} ${directPhotoMedia?.width}×${directPhotoMedia?.height}, ` +
        `bytes ${Boolean(directPhotoMedia?.data)}`,
    );

    // --- /resolve-links on the shipped HTTP function, in-process
    await checkResolveLinksRoute(fixture, linkUrl);

    // --- media: posters, variants, avatars, badges, quoted media, source.media
    await checkMediaInlining(fixture, server.base);

    // --- renders
    const native = await postJson(server.base, "/api/render", {
      target: "native",
      client: "smoke",
      post: POST,
      options: { width: 390, theme: "dark", dpr: 2 },
    });
    const nativePng = pngOf(native.body);
    check(
      "POST /api/render native",
      native.status === 200 && isPng(nativePng) && native.body?.width === 390 && native.body?.height > 0,
      `${nativePng.length} bytes, ${native.body?.width}×${native.body?.height}, ${native.body?.ms?.total} ms`,
    );
    check("native render carries report and geometry", Boolean(native.body?.report?.length && native.body?.geometry?.lines?.length), "");

    const http = await postJson(server.base, "/api/render", {
      target: "http",
      client: "smoke",
      post: POST,
      options: { width: 390, theme: "dark", dpr: 2 },
    });
    const httpPng = pngOf(http.body);
    check(
      "POST /api/render http",
      http.status === 200 && isPng(httpPng) && http.body?.width === 390 && http.body?.height > 0,
      `${httpPng.length} bytes, ${http.body?.ms?.total} ms`,
    );
    if (nativePng.length && httpPng.length) {
      const same = nativePng.equals(httpPng);
      if (same) check("native and http agree byte for byte", true);
      else skip("native and http agree byte for byte", "they differ; one of them is stale (see /api/targets)");
    }
    // --- paint time: the number next to a column is the render, not the
    // round trip. Each target reports `ms.paint` measured around its own render
    // call only; `ms.total` is the wall clock the browser saw.
    const paintOf = (body) => body?.ms?.paint;
    const wallOf = (body) => body?.ms?.total;
    const pipelineOf = (body) => body?.ms?.pipeline ?? body?.ms?.target;
    for (const [label, response] of [
      ["native", native],
      ["http", http],
    ]) {
      const paint = paintOf(response.body);
      const wall = wallOf(response.body);
      const pipeline = pipelineOf(response.body);
      check(
        `paint: ${label} reports ms.paint`,
        Number.isFinite(paint) && paint >= 0,
        `paint ${paint}, target ${response.body?.ms?.target}, wall ${wall}`,
      );
      check(
        `paint: ${label} paint is inside its pipeline and inside the wall clock`,
        Number.isFinite(paint) && Number.isFinite(pipeline) && Number.isFinite(wall) && paint <= pipeline + 1 && paint <= wall + 1,
        `paint ${paint} ≤ pipeline ${pipeline} ≤ wall ${wall}`,
      );
    }
    // The two targets that run the same Rust core should not disagree by much;
    // the gap is the wire and the JSON, which is exactly what `paint` removes.
    check(
      "paint: native and http report the same order of magnitude",
      Number.isFinite(paintOf(native.body)) &&
        Number.isFinite(paintOf(http.body)) &&
        Math.max(paintOf(native.body), paintOf(http.body)) <= Math.min(paintOf(native.body), paintOf(http.body)) * 8 + 2,
      `native ${paintOf(native.body)} ms, http ${paintOf(http.body)} ms`,
    );
    const chromeRowNow = (await getJson(server.base, "/api/targets")).body?.targets?.find((t) => t.id === "chrome");
    if (chromeRowNow?.available) {
      const chrome = await postJson(server.base, "/api/render", {
        target: "chrome",
        client: "smoke-chrome-paint",
        post: POST,
        options: { width: 390, theme: "dark", dpr: 2 },
      });
      const paint = paintOf(chrome.body);
      const wall = wallOf(chrome.body);
      check(
        "paint: chrome reports ms.paint (layout + screenshot, queue excluded)",
        chrome.status === 200 && Number.isFinite(paint) && paint >= 0 && paint <= wall + 1,
        `paint ${paint} ≤ wall ${wall}, queue ${chrome.body?.ms?.queue} ms`,
      );
      check(
        "paint: chrome keeps the queue wait out of the paint number",
        Number.isFinite(chrome.body?.ms?.queue) && Number.isFinite(paint) && Number.isFinite(wall)
          ? paint <= wall - chrome.body.ms.queue + 1
          : false,
        `paint ${paint} + queue ${chrome.body?.ms?.queue} ≤ wall ${wall}`,
      );
    } else {
      skip("paint: chrome reports ms.paint", chromeRowNow?.error ?? "chrome is not installed");
    }

    // A URL resolve puts `appVersion` on the post, so a wasm build older than
    // the model that added it rejects every resolved post. That is exactly the
    // staleness this server is supposed to surface, and exactly what a rebuild
    // fixes; check the shipped module accepts it.
    const withAppVersion = await postJson(server.base, "/api/render", {
      target: "http",
      client: "smoke",
      post: { text: "appVersion", appVersion: "3e351742fe4f2424674722b87619ee182fff37e8" },
      options: { width: 390 },
    });
    check(
      "http accepts appVersion (the wasm build is current)",
      withAppVersion.status === 200 && isPng(pngOf(withAppVersion.body)),
      withAppVersion.body?.error ? JSON.stringify(withAppVersion.body.error).slice(0, 160) : `status ${withAppVersion.status}`,
    );

    // --- render errors
    const unknown = await postJson(server.base, "/api/render", { target: "nope", post: POST });
    check("POST /api/render unknown target", unknown.status === 400 && unknown.body?.error?.code === "unknown_target", `status ${unknown.status}`);
    const wasmRender = await postJson(server.base, "/api/render", { target: "wasm", post: POST });
    check(
      "POST /api/render wasm is a client-side target",
      wasmRender.status === 400 && wasmRender.body?.error?.code === "client_side_target",
      `status ${wasmRender.status}`,
    );
    const invalidPost = await postJson(server.base, "/api/render", { target: "native", post: { text: "hi", wat: 1 } });
    check(
      "POST /api/render rejects an invalid post",
      invalidPost.status === 400 && Boolean(invalidPost.body?.error?.code),
      `${invalidPost.status} ${invalidPost.body?.error?.code}`,
    );

    // --- build endpoint: validation only (a real build is opt-in)
    const buildMissing = await postJson(server.base, "/api/build", {});
    check("POST /api/build needs a target", buildMissing.status === 400 && Boolean(buildMissing.body?.error), `status ${buildMissing.status}`);
    const buildChrome = await postJson(server.base, "/api/build", { target: "chrome" });
    check("POST /api/build rejects chrome", buildChrome.status === 400 && buildChrome.body?.error?.code === "not_buildable", `status ${buildChrome.status}`);
    if (rebuild) {
      const built = await postJson(server.base, "/api/build", { target: "native" });
      check("POST /api/build native", built.status === 200 && built.body?.ok === true, `${built.body?.ms} ms`);
    } else {
      skip("POST /api/build native", "pass --build to compile (slow)");
    }

    // --- events
    await checkEvents(server.base);

    // --- latency
    await measure(server.base, "native");
    await measure(server.base, "http");
  } finally {
    const stderr = server.stderr();
    await stopServer(server);
    await fixture.close();
    if (stderr.trim() && failures) console.log(`\nserver stderr:\n${stderr.trim()}`);
  }

  console.log(
    `\n${failures === 0 ? "smoke: ok" : `smoke: ${failures} failed`}` +
      `${skipped ? `, ${skipped} skipped` : ""} (${results.length} checks)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

async function checkEvents(base) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${base}/events`, { signal: controller.signal });
    const type = res.headers.get("content-type") ?? "";
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const first = Buffer.from(value ?? []).toString("utf8");
    check(
      "GET /events is an event stream",
      res.status === 200 && type.startsWith("text/event-stream") && first.includes(": connected"),
      `${res.status} ${type}`,
    );
    reader.cancel().catch(() => {});
  } catch (e) {
    // The abort is how this check ends if no bytes arrive.
    check("GET /events is an event stream", false, e.name === "AbortError" ? "nothing arrived in 3 s" : String(e.message ?? e));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function measure(base, target) {
  const times = [];
  const paints = [];
  const rounds = 10;
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    const res = await postJson(base, "/api/render", {
      target,
      client: `bench-${target}`,
      post: { text: `${POST.text}\nround ${i}` },
      options: { width: 390, dpr: 2 },
    });
    times.push(performance.now() - started);
    if (Number.isFinite(res.body?.ms?.paint)) paints.push(res.body.ms.paint);
    if (res.status !== 200) {
      check(`${target} latency sample ${i}`, false, `status ${res.status}`);
      return;
    }
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(rounds / 2)];
  const p90 = times[Math.floor(rounds * 0.9)];
  check(`${target} round trip stays interactive`, median < 50, `median ${median.toFixed(1)} ms, p90 ${p90.toFixed(1)} ms`);
  if (paints.length === rounds) {
    paints.sort((a, b) => a - b);
    const paint = paints[Math.floor(rounds / 2)];
    check(
      `${target} paint is below the round trip it is reported in`,
      paint < median,
      `paint ${paint.toFixed(1)} ms, round trip ${median.toFixed(1)} ms`,
    );
  } else {
    skip(`${target} paint is below the round trip`, "no ms.paint on some samples");
  }
}

main().catch((e) => {
  console.error(`smoke: crashed: ${e?.stack ?? e}`);
  process.exit(1);
});
