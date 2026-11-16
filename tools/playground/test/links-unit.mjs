#!/usr/bin/env node
// Unit checks for the link resolver's pure parts: no server, no network.
//
//   node tools/playground/test/links-unit.mjs
//
// These encode the rules in `api/_lib/links.mjs` that came from X's docs and the
// corpus: the display form, the address guard, the robots matcher, card tag
// fallbacks, meta refresh and image dimensions. The offline end-to-end case (a
// fixture server, a redirect chain, a card in the render) lives in
// `server-smoke.mjs`; the live check is `docs/LINK-CARDS.md`.

import {
  cardsFromHtml,
  displayUrl,
  imageSize,
  isPrivateAddress,
  metaRefreshTarget,
  normalizeUrl,
  robotsMatcher,
} from "../lib/links.mjs";

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- display form: xeet-text's rule, from 122 corpus pairs --------------------
const displays = [
  ["https://x.com/i/broadcasts/2KoXmRNZMNJONX", "x.com/i/broadcasts/2…"],
  ["https://vercel.com/changelog/vercel-daemons-is-now-in-public-beta", "vercel.com/changelog/verc…"],
  ["https://vercel.com/for/platforms", "vercel.com/for/platforms"],
  ["https://karpathy.ai/tristan-tube/", "karpathy.ai/tristan-tube/"],
  ["http://www.example.com/a/b?c=1", "example.com/a/b?c=1"],
  ["https://hackertube.org/", "hackertube.org/"],
];
for (const [href, want] of displays) check(`display ${href}`, displayUrl(href) === want, displayUrl(href));

// --- the address guard -------------------------------------------------------
const privateOnes = [
  "127.0.0.1",
  "0.0.0.0",
  "10.1.2.3",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "100.64.0.1",
  "100.127.255.254",
  "169.254.169.254",
  "198.18.0.1",
  "192.0.2.1",
  "203.0.113.9",
  "224.0.0.1",
  "255.255.255.255",
  "::1",
  "::",
  "fd00::1",
  "fe80::1",
  "ff02::1",
  "2001:db8::1",
  "::ffff:127.0.0.1",
  "::ffff:10.0.0.1",
  "64:ff9b::a00:1",
  "2002:7f00:1::1",
];
const publicOnes = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.63.255.255", "2606:4700::1111", "::ffff:8.8.8.8"];
for (const address of privateOnes) check(`refuses ${address}`, isPrivateAddress(address) === true);
for (const address of publicOnes) check(`allows ${address}`, isPrivateAddress(address) === false);

// --- robots.txt (Google's matching rules) -----------------------------------
const robots = [
  "User-agent: Twitterbot",
  "Disallow: /private",
  "Allow: /private/ok",
  "",
  "User-agent: *",
  "Disallow: /",
].join("\n");
const allowed = robotsMatcher(robots);
check("robots: the specific group wins", allowed("/") === true && allowed("/private") === false, "");
check("robots: Allow wins a longer path", allowed("/private/ok") === true, "");
const wildcard = robotsMatcher("User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*\n");
check(
  "robots: * and $ patterns",
  wildcard("/a.pdf") === false && wildcard("/a.pdf?x=1") === true && wildcard("/tmp/x") === false && wildcard("/y") === true,
  "",
);
check("robots: no rules means allow", robotsMatcher("")("/anything") === true, "");

// --- cards: the documented fallbacks ----------------------------------------
const both = `<!doctype html><html><head>
<meta property="og:title" content="OG title">
<meta name="twitter:title" content="Twitter title">
<meta property="og:description" content="OG description">
<meta name="twitter:image" content="/img.png">
<meta name="twitter:card" content="summary_large_image">
</head></html>`;
const full = cardsFromHtml(both, "https://example.com/a/b");
check("card: twitter:title wins over og:title", full.meta.title === "Twitter title", full.meta.title);
check("card: description falls back to og:description", full.meta.description === "OG description", full.meta.description);
check("card: a relative image resolves against the final URL", full.imageUrl === "https://example.com/img.png", full.imageUrl);
check("card: the domain is the final host verbatim", full.meta.domain === "example.com", full.meta.domain);
check("card: display is the unshortened form", full.meta.display === "example.com/a/b", full.meta.display);

const ogOnly = `<meta property="og:type" content="website"><meta property="og:title" content="T"><meta property="og:description" content="D">`;
check("card: og:type+title+description and no twitter:card → summary", cardsFromHtml(ogOnly, "https://e.com/x").meta.card === "summary", "");
const ogNoType = `<meta property="og:title" content="T"><meta property="og:description" content="D">`;
check("card: without og:type the documented rule does not apply", cardsFromHtml(ogNoType, "https://e.com/x").meta.card === null, "");
const bogus = `<meta name="twitter:card" content="gallery">`;
check("card: an unknown card type is no card", cardsFromHtml(bogus, "https://e.com/x").meta.card === null, "");
const player = `<meta name="twitter:card" content="player"><meta name="twitter:image" content="https://e.com/i.png">`;
check("card: a player card without twitter:player is no card", cardsFromHtml(player, "https://e.com/x").meta.card === null, "");
const selfLink = `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="https://e.com/i.png">`;
check(
  "card: an X link never gets a card",
  cardsFromHtml(selfLink, "https://x.com/someone/status/1").meta.card === null,
  "",
);
const encoded = `<meta name="twitter:card" content="summary"><meta name="twitter:title" content="A &amp; B &quot;quoted&quot;">`;
check("card: entity-encoded title is decoded", cardsFromHtml(encoded, "https://e.com/x").meta.title === 'A & B "quoted"', "");
const long = `<meta name="twitter:card" content="summary"><meta name="twitter:title" content="${"x".repeat(90)}">`;
const longNotes = [];
const longCard = cardsFromHtml(long, "https://e.com/x", longNotes);
check("card: title is capped at X's 70 characters", longCard.meta.title.length === 70, String(longCard.meta.title.length));
check("card: the cap is reported in notes", longNotes.some((note) => note.includes("documented maximum is 70")), JSON.stringify(longNotes));
check(
  "model: image carries only width/height (the strict parser refuses extras)",
  (() => {
    const image = cardsFromHtml(both, "https://e.com/x").meta.image;
    return image && Object.keys(image).every((key) => key === "width" || key === "height");
  })(),
  "",
);

// --- meta refresh (what t.co serves a browser UA) ---------------------------
check(
  "meta refresh is followed",
  metaRefreshTarget(
    `<noscript><META http-equiv="refresh" content="0;URL=https://vercel.com/changelog/x"></noscript>`,
    "https://t.co/a",
  ) === "https://vercel.com/changelog/x",
  "",
);
check("no meta refresh → null", metaRefreshTarget("<html><head></head></html>", "https://e.com") === null, "");

// --- image dimensions --------------------------------------------------------
/** The smallest possible PNG header of a given size. */
function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
check("image: PNG dimensions", JSON.stringify(imageSize(png(1200, 630))) === '{"width":1200,"height":630}', "");
const gif = Buffer.from("GIF89a", "latin1");
const gifHeader = Buffer.concat([gif, Buffer.from([0x40, 0x01, 0x2e, 0x01])]);
check("image: GIF dimensions", JSON.stringify(imageSize(gifHeader)) === '{"width":320,"height":302}', "");
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x76, 0x03, 0xe8, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01,
  0x03, 0x11, 0x01,
]);
const jpegSize = imageSize(jpeg);
check("image: JPEG dimensions", jpegSize?.width === 1000 && jpegSize?.height === 630, JSON.stringify(jpegSize));
check("image: garbage is null", imageSize(Buffer.from("not an image at all")) === null, "");

// --- input normalization -----------------------------------------------------
check("normalize: adds https", normalizeUrl("example.com/a") === "https://example.com/a", "");
check("normalize: refuses file:", normalizeUrl("file:///etc/passwd") === null, "");
check("normalize: strips the fragment", normalizeUrl("https://e.com/a#frag") === "https://e.com/a", "");

console.log(`\nlinks-unit: ${failures === 0 ? "ok" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
