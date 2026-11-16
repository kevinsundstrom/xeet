// Filling a post's image slots with X's own bytes.
//
// `/api/resolve` returns a `Post` whose media, avatar, affiliation badge, card
// image and quoted post are *descriptions* — sizes and kinds, no pixels. This
// module fetches the pixels X's client would fetch, at the size its `<img>` /
// `<video poster>` would use, and inlines them as base64 (the model's
// `Media::data`, `Author::avatar`, `Affiliate::badge`, `ImageMeta::data`).
//
// ## Which variant (the evidence)
//
// X's server render carries a `srcset` per image, and the browser resolves it
// against the slot's CSS width × the device pixel ratio:
//
//   <img sizes="(max-width: 600px) calc(100vw - 80px), 600px"
//        src="…/HWs1ch3WUAAyaeo?format=webp&name=large"
//        srcSet="…?format=webp&name=small 680w,
//                …?format=webp&name=medium 1200w,
//                …?format=webp&name=large 2048w">
//
// (captured in `assets/vendor/corpus/NASA.html`, `MrBeast.html`.) So the
// variants are `small` 680, `medium` 1200, `large` 2048 device pixels wide;
// pick the smallest that covers `slot × dpr`. A four-photo cell's `sizes` is
// `50vw` at ≤600px viewport / `300px` above, which is what the slot table below
// reproduces. Video posters are the same CDN with a different path
// (`amplify_video_thumb/…/img/…?format=webp&name=medium` in `NASA.html`).
//
// Avatars are chosen by dpr exactly as X's own 48px `<img>` srcset does:
// `_normal.jpg 1x, _x96.jpg 2x, _reasonably_small.jpg 3x`. The affiliation
// badge is the URL the payload carries (`label.badge.url`, a `_bigger` 73px
// image), which is what X draws.
//
// ## Why not the original
//
// A payload's `original_info` can be 8192×5464 (NASA post above). `orig` would
// blow `limits.rs` (`max_image_dimension` 8192, `max_image_pixels` 67M,
// `max_image_bytes` 8 MB) and cost megabytes per resolve. The variant that
// matches the cell is 680–2048 px wide, i.e. 100–800 kB, and is the same image
// X itself paints. Only if a variant is missing do we fall back to the payload
// URL itself, and then only if it fits the limits.
//
// ## Cache
//
// Bytes are cached by `api/_lib/links.mjs` (`fetchImageAsset`) in the shared,
// git-ignored `assets/vendor/playground/media/` directory, with LRU eviction
// under `XEET_MEDIA_CACHE_BYTES` (500 MB by default). The resolve response
// carries the URL → file map (`source.media`) so the oracle's page mode can
// serve Chrome the same bytes for the page's own image requests.

import { fetchImageAsset } from "./links.mjs";

/** limits.rs: `max_image_bytes`, `max_image_bytes_total`. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES_TOTAL = 24 * 1024 * 1024;

/**
 * The `srcset` widths X publishes for post media (device px). The variant is the
 * smallest one that covers the rendered slot at the requested dpr.
 */
const VARIANTS = [
  { name: "small", width: 680 },
  { name: "medium", width: 1200 },
  { name: "large", width: 2048 },
];

/** The avatar files X picks by dpr for its 48px avatar (`_normal 1x, _x96 2x, _reasonably_small 3x`). */
const AVATAR_VARIANTS = ["_normal", "_x96", "_reasonably_small"];

/** The frame draws avatars at 40 CSS px (`ImageRef::Avatar`). */
const AVATAR_CSS = 40;

/**
 * The rendered slot width of a media cell, in CSS pixels.
 *
 * Reproduces the `sizes` attributes in the captured markup for the layouts that
 * matter: one item fills the cell's content column, two and four share it in a
 * grid with the 4px gap (`cards/media.rs GAP`), three is the wide-left layout
 * where the left tile is the largest, and a quote's media sits in the quote card
 * (≈80% of the content column).
 */
export function slotWidth({ count, contentWidth, layout = "grid" }) {
  if (layout === "quote") return contentWidth * 0.8;
  if (count <= 1) return contentWidth;
  if (count === 3) return (contentWidth - 4) * 0.6;
  return (contentWidth - 4) / 2;
}

/** The variant name for a slot at a dpr. */
export function variantFor(slotCss, dpr) {
  const needed = slotCss * dpr;
  for (const variant of VARIANTS) if (needed <= variant.width) return variant.name;
  return VARIANTS[VARIANTS.length - 1].name;
}

/** `…/media/ID.jpg` + "small" → `…/media/ID?format=jpg&name=small`. */
export function variantUrl(base, variant) {
  if (!base) return null;
  let url;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  // An amplify/thumb path ends in `.jpg` but is not an extension the CDN uses
  // for resizing; the query is how X asks for a size, on every pbs path.
  if (/^pbs\.twimg\.com$/.test(url.hostname)) {
    url.pathname = url.pathname.replace(/\.(jpg|jpeg|png|webp)$/i, "");
    url.searchParams.set("format", "jpg");
    url.searchParams.set("name", variant);
    return url.href;
  }
  return base;
}

/** The avatar URL for a dpr, from `…/profile_images/<id>/<hash>_normal.jpg`. */
export function avatarUrlFor(base, dpr) {
  if (!base) return null;
  const variant = AVATAR_VARIANTS[Math.min(AVATAR_VARIANTS.length - 1, Math.max(0, Math.round(dpr) - 1))];
  // X's profile-image names carry a size suffix; swap it (a dpr whose suffix is
  // already the right one keeps the URL byte-identical).
  const known = /_(normal|bigger|mini|x96|reasonably_small|200x200|400x400)\.(png|jpe?g|webp)$/i;
  if (known.test(base)) return base.replace(known, `${variant}.$2`);
  // A profile image with no size suffix: ask the CDN for one.
  try {
    const url = new URL(base);
    if (url.hostname !== "pbs.twimg.com") return base;
    url.searchParams.set("name", variant === "_reasonably_small" ? "128x128" : variant === "_x96" ? "96x96" : "48x48");
    return url.href;
  } catch {
    return base;
  }
}

/** The payload's media entries, in `post.media` order (see `payloadToPost`). */
export function payloadMedia(tweet) {
  return (tweet?.media_entities2 ?? []).filter((m) => m?.original_info?.width && m?.original_info?.height);
}

/** The payload's affiliation badge URL, when the author has one. */
export function badgeUrl(tweet) {
  return tweet?.core?.user_results?.result?.identity_profile_labels_highlighted_label?.label?.badge?.url ?? null;
}

/** The payload's avatar URL, when there is one. */
export function payloadAvatar(tweet) {
  return tweet?.core?.user_results?.result?.avatar?.image_url ?? null;
}

/** The payload's quoted tweet, when there is one. */
export function quotedTweet(tweet) {
  return tweet?.quoted_tweet_results?.result ?? tweet?.nested_quoted_tweet_results?.result ?? null;
}

/**
 * Fills every image slot of `post` (and its quote) with X's bytes.
 *
 * @param {object} post                     the converted post, mutated in place
 * @param {object} tweet                    the payload it came from
 * @param {{width?: number, dpr?: number, signal?: AbortSignal,
 *   warnings?: string[], media?: boolean}} options
 *   `width`/`dpr` are the render options, so the variant matches the cell;
 *   `media: false` still fetches (dimensions are needed) but does not inline.
 * @returns {Promise<{map: object, stats: object}>} `map` is `source.media`:
 *   `{url: {file, bytes, width, height, variant}}` for every inlined URL.
 */
export async function inlinePostMedia(post, tweet, options = {}) {
  const { width = 600, dpr = 2, signal, media = true } = options;
  if (!media) return { map: {}, stats: { fetched: 0, cached: 0, failed: 0, skipped: 0, bytes: 0, inlined: 0 } };
  const warnings = options.warnings ?? [];
  const stats = { fetched: 0, cached: 0, failed: 0, skipped: 0, bytes: 0, inlined: 0 };
  const map = {};
  let budget = MAX_IMAGE_BYTES_TOTAL;

  const take = async (url, { variant = null, role, what }) => {
    if (!url) return null;
    try {
      const asset = await fetchImageAsset(url, { signal });
      if (asset.bytes.length > MAX_IMAGE_BYTES || asset.bytes.length > budget) {
        stats.skipped++;
        warnings.push(`${what} is ${asset.bytes.length} bytes; the render limits cap images at ${MAX_IMAGE_BYTES}`);
        return null;
      }
      budget -= asset.bytes.length;
      stats.bytes += asset.bytes.length;
      if (asset.cached) stats.cached++;
      else stats.fetched++;
      if (asset.file) {
        map[url] = {
          file: asset.file,
          bytes: asset.bytes.length,
          width: asset.width,
          height: asset.height,
          variant,
          role,
        };
      }
      return asset;
    } catch (error) {
      stats.failed++;
      warnings.push(`could not load ${what}: ${error.message}`);
      return null;
    }
  };

  const contentWidth = Math.min(Math.max(width, 100), 600) - 32;
  const cellDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 2;

  const fill = async (target, payload, { layout, rolePrefix }) => {
    if (!target || !payload) return;
    const entries = payloadMedia(payload);
    const count = target.media?.length ?? 0;
    for (let i = 0; i < count; i++) {
      const item = target.media[i];
      const entry = entries[i];
      const base = entry?.media_url_https ?? null;
      if (!base) {
        stats.skipped++;
        continue;
      }
      const slot = slotWidth({ count, contentWidth, layout });
      const variant = variantFor(slot, cellDpr);
      const url = variantUrl(base, variant);
      const role = `${rolePrefix}media:${i}`;
      const what = `${role} (${item.kind}, ${item.width}×${item.height})`;
      let asset = await take(url, { variant, role, what });
      // A CDN that refuses the resize (some legacy paths) still answers the
      // payload URL; use it when it fits the limits.
      if (!asset && url !== base) {
        asset = await take(base, { variant: "original", role, what: `${what} at its original size` });
      }
      if (!asset) {
        warnings.push(`${what}: no bytes, the renderer draws its placeholder`);
        continue;
      }
      // Video and GIF payloads carry their poster frame in `data`.
      item.data = asset.bytes.toString("base64");
      stats.inlined++;
    }

    // The avatar, at the size X's own srcset picks for this dpr.
    const avatarBase = payloadAvatar(payload);
    if (avatarBase) {
      const avatarDpr = Math.min(3, Math.max(1, Math.round(cellDpr)));
      const url = avatarUrlFor(avatarBase, avatarDpr);
      const asset = await take(url, { variant: AVATAR_VARIANTS[avatarDpr - 1], role: `${rolePrefix}avatar`, what: `${rolePrefix}the avatar` });
      if (asset && target.author) target.author = { ...target.author, avatar: asset.bytes.toString("base64") };
      stats.inlined++;
    }

    // The affiliation badge (the payload's own URL: a `_bigger` 73px square).
    const badgeBase = badgeUrl(payload);
    if (badgeBase && target.author?.affiliate) {
      const asset = await take(badgeBase, { variant: "bigger", role: `${rolePrefix}badge`, what: `${rolePrefix}the affiliation badge` });
      if (asset) target.author = { ...target.author, affiliate: { ...target.author.affiliate, badge: asset.bytes.toString("base64") } };
    }
  };

  await fill(post, tweet, { layout: "grid", rolePrefix: "" });
  const quoted = quotedTweet(tweet);
  if (quoted && post.quote) await fill(post.quote, quoted, { layout: "quote", rolePrefix: "quoted " });

  return { map, stats };
}
