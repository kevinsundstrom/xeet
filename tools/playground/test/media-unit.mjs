#!/usr/bin/env node
// Unit checks for the media inliner's pure parts: the variant X's client would
// pick, the URLs for those variants, and the avatar size by dpr. No network.
//
//   node tools/playground/test/media-unit.mjs
//
// The evidence for the numbers is in `tools/playground/lib/media.mjs` and
// `assets/vendor/corpus/{NASA,MrBeast}.html`'s srcsets: `name=small 680w`,
// `name=medium 1200w`, `name=large 2048w`, and the 48px avatar's
// `_normal 1x, _x96 2x, _reasonably_small 3x`.

import { avatarUrlFor, slotWidth, variantFor, variantUrl } from "../lib/media.mjs";

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- slot widths: the `sizes` attributes X's markup carries -------------------
// A 600px column's content area is 568 (16px padding each side); a 382px phone
// leaves 350.
const CONTENT_600 = 568;
const CONTENT_382 = 350;
check("slot: one item fills the column", slotWidth({ count: 1, contentWidth: CONTENT_600 }) === 568, "");
check("slot: two items split it with the 4px gap", slotWidth({ count: 2, contentWidth: CONTENT_600 }) === 282, "");
check("slot: four items are a 2×2 grid", slotWidth({ count: 4, contentWidth: CONTENT_600 }) === 282, "");
check("slot: three items keep the wide left tile", slotWidth({ count: 3, contentWidth: CONTENT_600 }) === 338.4, "");
check(
  "slot: a quote's media is narrower",
  Math.abs(slotWidth({ count: 1, contentWidth: CONTENT_600, layout: "quote" }) - 454.4) < 0.01,
  String(slotWidth({ count: 1, contentWidth: CONTENT_600, layout: "quote" })),
);

// --- variant choice: sharp at the presets the UI offers ----------------------
const cases = [
  // [count, content, dpr, expected] — the Duo's closed 382 at 3x and open 600
  // column at 3x are the demanding ones the lead called out.
  [1, CONTENT_382, 1, "small"],
  [1, CONTENT_382, 2, "medium"], // 700px needed > 680
  [1, CONTENT_382, 3, "medium"], // 1050px needed
  [1, CONTENT_600, 2, "medium"], // 1136px needed
  [1, CONTENT_600, 3, "large"], // 1704px needed
  [2, CONTENT_600, 3, "medium"], // 846px needed
  [4, CONTENT_600, 3, "medium"], // 846px needed
  [4, CONTENT_382, 3, "small"], // 519px needed
  [2, CONTENT_382, 3, "small"], // 519px needed
];
for (const [count, content, dpr, expected] of cases) {
  const got = variantFor(slotWidth({ count, contentWidth: content }), dpr);
  check(`variant: ${count} item(s) at ${content}px, dpr ${dpr} → ${expected}`, got === expected, got);
}

// --- the CDN URLs ------------------------------------------------------------
check(
  "url: a photo variant",
  variantUrl("https://pbs.twimg.com/media/HWncStCWYAEG1pS.jpg", "medium") ===
    "https://pbs.twimg.com/media/HWncStCWYAEG1pS?format=jpg&name=medium",
  variantUrl("https://pbs.twimg.com/media/HWncStCWYAEG1pS.jpg", "medium"),
);
check(
  "url: a video poster variant (amplify_video_thumb)",
  variantUrl("https://pbs.twimg.com/amplify_video_thumb/1/img/hOpkRWS4zu5Mmzkr.jpg", "large") ===
    "https://pbs.twimg.com/amplify_video_thumb/1/img/hOpkRWS4zu5Mmzkr?format=jpg&name=large",
  variantUrl("https://pbs.twimg.com/amplify_video_thumb/1/img/hOpkRWS4zu5Mmzkr.jpg", "large"),
);
check(
  "url: an existing `name` is replaced, not appended",
  variantUrl("https://pbs.twimg.com/card_img/1/x?format=jpg&name=800x419", "small") ===
    "https://pbs.twimg.com/card_img/1/x?format=jpg&name=small",
  variantUrl("https://pbs.twimg.com/card_img/1/x?format=jpg&name=800x419", "small"),
);
check("url: a non-pbs host is left alone", variantUrl("https://example.com/a.jpg", "small") === "https://example.com/a.jpg", "");

// --- avatars: X's own 48px srcset -------------------------------------------
const avatar = "https://pbs.twimg.com/profile_images/1321163587679784960/0ZxKlEKB_normal.jpg";
check("avatar: dpr 1 → _normal", avatarUrlFor(avatar, 1).endsWith("_normal.jpg"), avatarUrlFor(avatar, 1));
check("avatar: dpr 2 → _x96", avatarUrlFor(avatar, 2).endsWith("_x96.jpg"), avatarUrlFor(avatar, 2));
check("avatar: dpr 3 → _reasonably_small", avatarUrlFor(avatar, 3).endsWith("_reasonably_small.jpg"), avatarUrlFor(avatar, 3));
check("avatar: dpr 4 stays at 3x", avatarUrlFor(avatar, 4).endsWith("_reasonably_small.jpg"), avatarUrlFor(avatar, 4));
check("avatar: a URL with no suffix gets a size", avatarUrlFor("https://pbs.twimg.com/profile_images/1/x.jpg", 3).includes("128x128"), avatarUrlFor("https://pbs.twimg.com/profile_images/1/x.jpg", 3));

console.log(`\nmedia-unit: ${failures === 0 ? "ok" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
