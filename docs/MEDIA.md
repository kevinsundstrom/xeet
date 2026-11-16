# Media: the pixels X would draw

A `Post` from `/api/resolve` describes its images — kind, size, alt — and leaves
the bytes out. With `media: true` the playground fills them in
(`tools/playground/lib/media.mjs`), so every column of the page draws real
pixels instead of placeholders.

```
media: [{kind: "video", width: 3840, height: 2160, duration: 86.7,
         data: "<base64 JPEG>"}]        // ← the poster frame
author: {avatar: "<base64>"}, affiliate: {badge: "<base64>"}
links: {url: {image: {width, height, data: "<base64>"}}}
quote: {…the same shapes, one level deep…}
source.media: { "<url>": {file, bytes, width, height, variant, role} }
```

`Media::data` is the **poster frame** for a video or GIF (`model::Media`'s own
words: "For video and GIF, the poster frame"). GIF payloads are `animated_gif`
with a `media_url_https` still and an mp4 in `video_info`; a video's still is
`amplify_video_thumb/…?format=jpg`, and `video_info.duration_millis` becomes the
duration badge.

## Which size

X's server render carries a `srcset` and lets the browser pick against the slot's
CSS width × the device pixel ratio:

```html
<img sizes="(max-width: 600px) calc(100vw - 80px), 600px"
     src="…/HWs1ch3WUAAyaeo?format=webp&amp;name=large"
     srcSet="…?format=webp&amp;name=small 680w,
             …?format=webp&amp;name=medium 1200w,
             …?format=webp&amp;name=large 2048w">
```

(`assets/vendor/corpus/NASA.html`, `MrBeast.html`.) The resolver does the same
arithmetic: the slot width comes from the attachment and the column
(`cards/media.rs`: one item fills the content column, a quote's slot is 80% of
it, and a multi-image post is laid out by `layout_carousel` inside the column;
`media.mjs`'s `slotWidth` derives the cell width from the item count), needed =
slot × dpr, and the smallest variant that covers it wins. So:

| cell | dpr 1 | dpr 2 | dpr 3 |
|---|---|---|---|
| 382 px phone, 1 item | small | medium | medium |
| 600 px column, 1 item | small | medium | large |
| 600 px column, 4 photos | small | small | medium |
| 382 px phone, 4 photos | small | small | small |

The iPhone Duo presets are the demanding ones: the closed 382 pose at dpr 3 and
the open pose (a 600 px column) at dpr 3 both land on a variant that is at least
as wide as the device pixels they paint, which is what keeps posters and photos
sharp there.

## Carousels: two to twenty items

More than one image is a carousel, never the old four-tile grid: one card per
image in a horizontally scrolling row, cells sized by `layout_carousel`
(`cards/media.rs`) and the overflow clipped at the slot's right edge as X's
"there is more" hint. `limits.rs` allows up to **20** carousel items
(`max_media`, sized for the 20-item carousels real payloads carry), so a
19-photo post resolves and renders like a 4-photo one, with one card per image
and the last cells cut off.

Avatars follow X's own 48 px `<img>` srcset exactly:
`_normal.jpg 1x, _x96.jpg 2x, _reasonably_small.jpg 3x`. The affiliation badge is
the payload's own `label.badge.url` (a `_bigger` 73 px square), which is what X
draws.

## Never the original

A payload's `original_info` can be 8192×5464. `orig` would break `limits.rs`
(`max_image_dimension` 8192, `max_image_pixels` 67M, `max_image_bytes` 8 MB per
image, 24 MB per request) and cost megabytes per resolve. The matched variant is
680–2048 px wide (roughly 80 kB–800 kB), which is the same image X itself paints.
If a CDN refuses a variant the payload URL is tried once, and only if it fits the
limits.

## Cache and the URL → file map

Bytes live in `assets/vendor/playground/media/` — git-ignored, one file per URL,
named by the URL's SHA-256. The directory is capped at 500 MB by default
(`XEET_MEDIA_CACHE_BYTES`) and evicts least-recently-used files first, so a long
session does not grow without bound. Nothing here is ever committed.

`source.media` maps every inlined URL to its file:

```json
"source": { "media": {
  "https://pbs.twimg.com/media/HWs1ch3WUAAyaeo?format=jpg&name=small": {
    "file": "assets/vendor/playground/media/3f2b….jpg",
    "bytes": 79696, "width": 544, "height": 680,
    "variant": "small", "role": "media:0" },
  "https://pbs.twimg.com/profile_images/…_x96.jpg": {
    "file": "…/9a01….jpg", "bytes": 5210, "width": 96, "height": 96,
    "variant": "_x96", "role": "avatar" }
} }
```

Chrome's page mode can serve those same bytes for the page's own image requests,
so a diff compares like with like. The map is populated only for URLs that were
actually inlined; `role` says which slot (`media:0`, `avatar`, `badge`,
`card`, `quoted media:0`, `quoted avatar`, …).

## Defaults

`media: true` is the default for the playground's `/api/resolve`
(`media: false`, or `?media=0`, opts out — the UI should send that while someone
is typing, since a four-photo post inlines ~3 MB). The same default applies to
the only deployed function, `api/playground-resolve.mjs`, which serves the web
demo's internal `/_playground/resolve` and `/_playground/resolve-links` routes;
the second takes its own `media` flag for the card image only. There is no
public render endpoint: `xeet` ships as `@xeet/core`, the Rust crates and
`@xeet/cli`.

## What is verified

- `node tools/playground/test/media-unit.mjs` — the variant table (including the
  Duo presets), the CDN URLs, and the avatar sizes.
- `node tools/playground/test/server-smoke.mjs` — a fixture that serves
  variant-sized images: a video poster, a quoted photo, avatars, a badge, the
  URL → file map, a render that differs from the placeholder one, native and http
  byte-identical, and LRU eviction above the cap. No network.
- Live, 2026-11-10: `x.com/NASA/status/2119833829389041896` (video poster) and
  `x.com/NBA/status/2120019063476785477` (video + quoted video) now carry poster
  bytes; `x.com/F1/status/2119898824810389849` (four photos) inlines all four at
  `small`/`medium` depending on the cell; `x.com/GIPHY/status/1957913446118285360`
  (`animated_gif`) inlines its still; `x.com/MrBeast/status/2117003477079761397`
  inlines the quoted post's two photos, its video poster and both avatars.
