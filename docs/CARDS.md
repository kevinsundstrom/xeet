# The attachment slot: what X renders, and how xeet reproduces it

Evidence for `crates/xeet-core/src/cards/`. Everything here was measured against
X's own server-rendered markup and stylesheet in a headless Chrome, never
against xeet's output. App version `89824c04`, stylesheet
`styles-CaGKZNWE.css` (`assets/upstream.lock.json`).

The gate is `tools/oracle/cards-parity.mjs`: it renders the real post markup at
320/390/600 px in both themes, measures every painted box (backgrounds,
borders — including X's `::after` hairlines — images, icons and text lines) and
compares the list with `cards::layout`'s display items. Boxes must agree within
1/64 px, radii within 1/64 px, `corner-shape` and colors exactly — except an
`<img>`'s own rect, which is compared at 1/16 px: Chrome lays an image element
out from its intrinsic ratio too once the bytes decode, which lands 2–4/64 px
wider than the container's aspect box and depends on a decode race (see §8). Twenty-four
fixtures × three widths × two themes = **144 runs, all passing** (§8).

```
CARGO_TARGET_DIR=target/agent-cards cargo build --profile fast -p xeet-core --example cards_dump
cd tools && node oracle/cards-parity.mjs                      # all fixtures, 6 runs each
cd tools && VERBOSE=1 node oracle/cards-parity.mjs video      # box dumps on mismatch
```

## 1. Corner radius: `--x-radius-m` is 1.8, not 1

```css
:root { --x-radius-m: 1 }
@supports (corner-shape:squircle) {
  :is(.rounded-xs,.rounded-sm,.rounded,.rounded-md,.rounded-lg,.rounded-xl) {
    --x-radius-m: 1.8; corner-shape: squircle
  }
}
```

Chrome, Safari and Firefox all support `corner-shape`, so every preview gets
the squircle branch:

| class | radius | shape | used by |
|---|---|---|---|
| `rounded-xs` | 7.2 px | squircle | card title pill |
| `rounded-sm` | 14.4 px | squircle | carousel cells, duration badge |
| `rounded-md` | 28.8 px | squircle | media boxes, link cards, thumbnails |
| `rounded-2xl` | 16 px | plain round | the quoted-post frame |
| `rounded-full` | 9999 px (clamped) | plain round | ALT pill, play button, poll pills |

`rounded-2xl` is **not** in the `@supports` list, so it is neither scaled nor
squared — a trap if you apply `--x-radius-m` globally.

## 2. Media: two to twenty images is a carousel, not a grid

Every multi-image post in the corpus (2, 3 and 4 images) is a horizontally
scrolling carousel with one card per image, and nothing about the layout is
special-cased at four: `limits.rs` allows up to 20 carousel items, and a 19-image
post lays out and clips the same way. The layout numbers are computed in
the client bundle too — `mediaCarouselLayout` in `DIdg36-I.js` — and
`cards::media::layout_carousel` is a port of it, including its corner cases.

The computation produces a height ratio (the carousel's height as a fraction of
the slot width) plus a per-cell aspect ratio. X writes the height as
`padding-bottom: calc(68.4346% - 2.737px)`; `TC()` in the bundle formats it,
and it is the same skip that `MediaLayout::height` returns in pixels.

Constants: `BASE = 0.68`, `MAX = 0.8` (widest a cell may be relative to its own
height), `PEEK = 0.67`, gap `4 px`, fallback `1.24446`; the compact variant used
inside quotes uses `BASE × 0.85` and a `0.66` fallback.

| capture | images | item ar | X's `padding-bottom` | xeet |
|---|---|---|---|---|
| `github.html` art0 | 2 | 0.8, 0.8 | `calc(62.5% - 2.5px)` | same |
| `text-firefox.html` art2 | 2 | 2/3, 2/3 | `calc(75% - 3px)` | same |
| `NASA.html` art0 | 4 | 1.5 ×4 | `68%` | same |
| `F1.html` art1 | 4 | 0.8 ×4 | `calc(74.8503% - 2.994px)` | same |
| `MrBeast.html` art3 | 3 | 0.875 ×3 | `calc(68.4346% - 2.737px)` | same |
| `text-WHO.html` art0 | 4 | 0.82533 ×4 | `calc(72.5528% - 2.902px)` | same |
| `text-levelsio.html` art3 (quote) | 2 | 0.70588 ×2 | `66%` | same |

Two details that decide the last 1/64 px:

* **fi64 throughout.** X emits the cell aspect ratio as a 16-digit CSS number
  (`aspect-ratio:1.1764705882352942` = `0.8/0.68`). Computing it in `f32` moves
  the second cell of a four-image carousel by 1/64 px per cell.
* **LayoutUnit truncates.** Blink's `LayoutUnit(float)` is
  `int(value * 64)`, i.e. a floor for positive lengths. Chrome's cell height for
  a `68%` padding at slot 310 is `210.796875`, not `210.8`
  (`cards::snap`).

Cell geometry: cells start at the slot's left edge with a 4 px gap, each cell
carries a 1 px `border-normal` hairline (a real border, not `::after`) and its
image fills the cell's *content* box. Cells that do not fit are clipped by the
slot — in the live site the scroll container bleeds to the viewport edges
(`--media-overhang-*`), which a preview does not model.

## 3. Single media: the item's own ratio, capped at 510 px of height

A single photo or video is `<div class="…rounded-md" style="aspect-ratio:R">`
with `<img class="w-full">`, where `R` is the item's own aspect ratio (verified
against nine captures: 1.0012, 1.2221, 1.3352, 1.3740, 1.4837, 1.9108, 1.9749,
2.0, 2.3681 all equal the intrinsic ratio — there is no clamp on landscape
media). Tall media is capped through `max-width`, not `max-height`:

```js
// DiQRCAq6.js, the photo path: maxHeight 510
aspectRatio: w/h,  maxWidth: ar < 1 ? 510 * ar : undefined
```

Which is why a 9:16 video is `aspect-ratio:0.5625;max-width:286.875px` in the
markup. In a timeline cell the box is left-aligned; only a quoted post's media
wrapper has `mx-auto`, so only there is it centered.

Overlays: ALT pill (`h-6`, `px-3`, `bg-black-40`, subtext1, 24 px from the
cell's content edge), duration pill (`h-5`, `px-2`, `bg-black-80`, subtext2
medium, digits tabular because the player container carries `tabular-nums`), and
a centered 48 px `bg-black-40` play circle with a 24 px triangle.

The duration text is X's own formatter, not a hand-rolled clock: the badge
formats `duration - currentTime` with the i18n module
`unit-duration-to-video-timestamp-FqoFhlvP` (`BEV1NdT5.js`), which **truncates**
to whole seconds, prints hours only once they are non-zero, and pads every part
to two digits — `86.708 s` is `01:26`, `3600 s` is `01:00:00`, and the zero
state (also: no duration in the payload) is `00:00`, which is what every
captured timeline cell shows before the player has metadata. `NBA.html`'s quoted
video (`duration_millis: 11679`) is the non-zero proof: the server rendered
`00:11`. Table and citations: SPEC.md §9 "Media duration".
A GIF shows the same poster without the play circle and the label `GIF` (no
capture yet; that label is the replica's reading, not X's code). A source
attribution, when there is one, goes inside the same pill — `BNn3ozGQ.js` picks
the photo badge only for `type === "photo"`, so a GIF takes the video form.

### The media's source attribution ("Post video" / "Post photo")

A post can embed media from *another* post; X then labels it with that account.
`ESPN.html` (`2120005259485425936`) is the capture: `@espn` posts `@NFL`'s video
(`x.com/NFL/status/2120004918610366839/video/1`), and the duration pill reads
`00:00  [NFL-avatar] NFL ✓` in the gold check.

**When.** `media.source_author` present, with a name or a handle to show, and
**not the post's own author** — `BNn3ozGQ.js` (`video_attribution_label` /
`photo_attribution_label`) builds the label from
`media.source_user_results.result.user`'s `screen_name` and renders its fallback
(the whole badge, absent) when it cannot. The comparison is
case-insensitive on the handle with any `@` stripped; an empty source name falls
back to `@handle`. `Source::of` in `media.rs` does this once, in `items_of`, so
the suppression happens before an item exists — unit tests cover the own-author
case (including `ESPN`, ` @espn `), an empty source, the handle fallback, and the
same rule through `items_of`.

**Video (and GIF): inside the duration pill**, whose markup is copied verbatim
from the capture:

```html
<div class="inline-flex h-5 items-center gap-1 rounded-sm px-2 font-medium
            [&_svg]:size-[1em] bg-black-80 text-on-color text-subtext2 min-w-0 shrink">
  <span aria-hidden="true">00:00</span>
  <span class="inline-flex min-w-0 items-center gap-1 align-middle ms-2">…</span>
</div>
```

The pill's own `gap-1` (4) plus the attribution's `ms-2` (8) is the **12 px**
between the clock and the mini avatar; then 13 px avatar (`x-avatar
rounded-[10%]` — 1.3 px — for a business account, `rounded-full` — 6.5 — for a
circle), 4 px, the name in `text-subtext2` 13/16 weight **400** white
(`line-clamp-1 break-all`), and — when verified — 4 px and a 13 px
(`size-[1em]`) `icon-verified-*-color`. All of it is `items-center` in the 20 px
pill, so both 13 px boxes sit at `y + 3.5`.

Two flex facts decide the pill's width. The row is `absolute start-3 bottom-3`
with no width, so it is shrink-to-fit against the media box minus its own start
inset: **the pill may reach `rect.w - 12`**. And the pill is `shrink`/`min-w-0`
with the name as the only thing that can give: when the name overflows, the pill
keeps the *whole available width* (`rect.w - 12`), not the width of the clipped
text — `video-attributed-long` measures 228 / 298 / 508 px at the three widths,
exactly the maxima, and only matches if the name clamps at Chrome's own point.

Text advances are snapped up to 1/64 before they become a box (Chrome sizes each
run in layout units): `00:24` at 13/500 sums to 35.958 and Chrome's box is
35.9688, `NFL` at 13/400 sums to 23.335 and Chrome's is 23.34375. Without the
snap the pill was 0.02 px narrow — 1.25/64, enough to fail the gate.

**Photo: its own badge** (`BNn3ozGQ.js`, component `ie`):

```html
<span class="text-subtext2 inline-flex max-w-full min-w-0 items-center
             rounded-[6px] bg-black/70 py-1 ps-1 pe-2">…same contents…</span>
```

`py-1` (4) around the 16 px line makes it **24 px** tall with a 6 px round
corner; 4 px left, the same 13 px avatar, 4 px, the name, and 8 px right. It
sits in the photo's own `absolute inset-s-3 bottom-3 … items-center gap-1
max-w-[calc(100%-24px)]` row, i.e. 12 px from the bottom-start corner, **4 px to
the right of the ALT badge** when there is one (the X Polygon capture shows that
row), and it tops out at `rect.w - 12`. That photo placement is code-derived: no
captured photo carries a visible badge (the only `size-[13px]` in the corpus is
the ESPN video pill and a hover-only control bar), so `photo-attributed` renders
`ie`'s classes inside Polygon's photo row and compares Chrome's layout of them.

Both forms use `ImageRef::MediaSourceAvatar(i)`; inside a quote `as_quoted`
wraps it to `Quote(MediaSourceAvatar(i))` like any other quoted image.

Fixtures: `video-attributed` (ESPN's pill, verbatim: business source, square
avatar, gold check), `video-attributed-long` (an unverified source whose name
cannot fit at any width — the clamp), `photo-attributed` (a circle avatar with a
blue check, after an ALT badge).

## 4. Link cards

`summary_large_image` is a 1.91 image with the title in a `bg-black/75` pill
12 px above the bottom edge, and a `From example.com` line 4 px underneath.
`summary` is a square thumbnail (`w-[90px]`, `sm:w-[130px]`) beside a text
column: domain, title, description. The 1 px card border sits **outside** the
image, so the card's height is `(w - 2) / 1.91 + 2`; every inner box is inset by
that border. X's `sm:` breakpoint is **512 px** (`@media (width>=512px)`), not
Tailwind's 640, so a 600 px preview already gets the desktop thumbnail and the
description line.

Card titles are `line-clamp-1` + `text-ellipsis` with no `wrap-anywhere`, so
they break at word boundaries: the pill's width is the single-line preferred
width capped at the available space, and the ellipsis lands where Chrome puts it
(`Wrap::Normal`).

The pill itself is `inline-flex h-5 max-w-full rounded-xs bg-black/75 px-2`
inside `absolute inset-s-3 inset-e-3 bottom-3`, so its width is the title's
advance **plus 16 px**, capped at the card's content width minus 24 px. The
title inside it is a `line-clamp-1` box whose width is that inner width — and
that is one rounding step *below* the LayoutUnit sum the text engine compares a
line against, so a title that just fits (i.e. almost every short title) came back
as a two-line block clamped to one line and painted `The thing,…` inside a pill
Chrome fills completely. `pill_of` gives the fit budget 1/64 px of slack (the
text still ends exactly at its advance); the pill's own width is unchanged. A
title capped by the card keeps a zero-slack budget, so its ellipsis is where
Chrome's is.

Two gate fixtures cover both sides of that: `card-large-fit` ("The thing,
shipped": pill = advance + 16, and the line must be a single glyph run) and
`card-large-long` (a title longer than the card at 320/390/600: pill = the full
inset box, and the line must be the text run plus the `…` run). The gate compares
**glyph runs per line** for a fixture that asks for it (`runs: [...]`), because
Chrome paints `text-overflow` ellipses without a DOM node: geometry alone cannot
tell a full title from a clipped one.

## 5. Quoted posts

The frame is `rounded-2xl` + a 1 px border, and inside it X puts two siblings —
not one padded box:

```html
<div class="border-normal overflow-hidden rounded-2xl border [--media-overhang-*:0px]">
  <article>
    <div class="flex flex-col gap-1 p-3">   <!-- avatar 24, name, handle, ·, time, text -->
    <div class="mx-auto relative overflow-hidden" style="aspect-ratio:…"> <!-- media -->
  </article>
</div>
```

So the text is inset 12 px and the media is flush with the frame's sides. A
quote's *carousel* is wrapped in `mx-3 mb-3` instead: inset 12 px each side with
12 px below. The header's `·` comes from `.x-middot-group >
:not(:first-child)::before` (4 px, "·", 4 px). The body is clamped to five lines
(`rules::decide_quote`), and the timestamp is `frame::time::label(created_at,
now, false)` — the same path the post's own timestamp takes, fed the *quote's*
`createdAt` and its `now` (falling back to the outer post's).

Going through that path is what gets the **day** right: X prints the reader's
local date, and the timestamp string carries the reader's offset, so
`2026-11-05T02:12:00Z`, `2026-11-04T18:12:00-08:00` and
`2026-11-05T11:12:00+09:00` are one instant that prints `Nov 5`, `Nov 4` and
`Nov 5`. Parsing to UTC first — what `cards::time` used to do — collapsed the
offset and printed the wrong day for a quote made late in the evening west of
UTC (and disagreed with `frame::time` on the post right above it).

### Two forms, and the quoting post decides

X draws a quote one of two ways, and which one does **not** depend on the
quoted post's media aspect (quotes with a portrait video and quotes with a
portrait photo both appear in the full-width form). It depends on the *quoting*
post: when that post has media of its own, the quote is compact.

| | full width | compact |
|---|---|---|
| when | the post has nothing but a quote | the post has media, and also quotes |
| avatar | `size-6` (24 px) | `size-4` (16 px, row = one 20 px line) |
| quoted media | below the text, `mx-auto`, flush with the frame's sides | `w-24 aspect-square` (96 px) thumbnail **beside** the text, `gap-2` |
| thumb frame | `rounded-2xl` on the frame only | `rounded-md` + 1 px `border-normal` ring |
| duration | the 20 px overlay pill at 12 px inset, `tabular-nums` (`00:11`) | the same pill at 4 px inset, `text-subtext3` (11/12), proportional figures |

```html
<!-- compact: the row that replaces "text, then media" -->
<div class="flex min-w-0 items-start gap-2">
  <div class="w-24 shrink-0 relative overflow-hidden aspect-square
              after:… after:border after:border-normal rounded-md">
    <div class="relative overflow-hidden h-full w-full object-cover" style="aspect-ratio:0.8">
      <img class="h-full w-full object-cover" src="…amplify_video_thumb…">
      <div class="absolute inset-s-1 bottom-1">
        <div class="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-2
                    text-subtext3 font-medium bg-black-80 text-on-color">00:11</div>
      </div>
    </div>
  </div>
  <div class="flex min-w-0 flex-1 flex-col gap-1"><!-- the clamped text --></div>
</div>
```

All 30 quotes with media in the corpus were tabulated: the three compact ones
are the three that sit under a post with media (`NBA.html`), the other 27 are
full width. The compact thumb crops the poster to a square (`object-cover`).

### The header row, and the middot group

The name yields width before anything else: X's row is `flex min-w-0
items-center gap-1` with a `shrink-0` name group and a `shrink-0` timestamp, so
the name box is `row width - (check + gap) - (affiliate + gap) - (· group) -
stamp`, each text box rounded up to the next 1/64 before adding (that is what
makes the clamp land on 109.3906 rather than 109.4219 at a 320 px viewport). A
clamped name keeps its *box* width, not the width of the words that fit.

The separator between `@handle` and the timestamp is the whole `.x-middot-group
> :not(:first-child)::before` block — `4px + "·" + 4px` — so the timestamp starts
`handle end + 8px + the dot's advance` and nothing else. The capture settles it:
at a 310 px slot the NBA quote's header puts the name at `33`, the handle at
`88.3125` (43.9063 wide), the `·` ink at `136.2188` and the timestamp at
`144.2813`. An extra `gap-1` before the dot (what the code had) put ours at
`148.28` — the visibly wide `@NBA · 15h` from the playground. The dot's advance
is rounded *up* to 1/64 for the next box, because Chrome adds the
`padding-inline` in LayoutUnits (`4.0625` there, `4.05` in hand).
`quote::header_spacing` pins those four run positions.

### A quoted post that is itself a reply

`text-karpathy.html` `5909609487872075` quotes a reply, and X prints the row
between the quote's header and its text:

```html
<div class="max-w-full text-body font-normal text-secondary">Replying to
  <a class="… text-body text-brand" href="/celestepoasts"><span class="… ss01">@celestepoasts</span></a>
</div>
```

One 20 px line, `gap-1` (4 px) above and below, the mention in `text-brand`.
The handle is not the status id in `model::Post::reply_to`: a payload carries it
in `reply_to_user_results.result.core.screen_name`, which is
`model::Post::reply_to_handle`.

### Media and a quote at once

A post with media *and* a quote shows both, in a `flex flex-col gap-3` slot:
media, 12 px, quote. `rules::decide` reports the media attachment, so
`cards::layout` lays out the quote as well (`NBA.html`, 20 of the 30 quotes);
before that the quote was dropped and the post measured 158 px short.

### The nested quote preview (`post.quote.quote`)

A quote of a quote ends with q2 in a compact card of its own. X's markup is the
i18n module `nested-quote-preview-SIs_tkfq` (component `ve`, eligibility `H`) in
`assets/vendor/upstream/js/dfWSwB9n.js`; the quote card that hosts it is
`GH6kckO8.js`'s `Rt`, which passes it to the quoted-tweet frame as `children`,
and `DtaLJItK.js`'s quote card puts those children in

```html
<div class="p-3 [:first-child+&]:pt-0"> …preview… </div>
```

**Placement.** That wrapper is a sibling *after* the quote's own media, so its
`head` padding is 12 px on the sides and the bottom, and at the top **only when
the quote also has an attachment**: `[:first-child+&]:pt-0` drops the top
padding only when the preview is the `<article>`'s *second* child (media makes it
the third), which is why the text-only previews sit 12 px closer to the quoted
text than the media ones. Getting this wrong is a flat 12 px on the quote height.

Inside, `ve` draws a hover box whose `-mx-1.5 -my-1 px-1.5 py-1` cancel out in
layout, then `flex` of:

| box | classes | geometry |
|---|---|---|
| bar | `bg-tertiary w-[3px] shrink-0 rounded-full` | 3 px wide, full row height, `bg-tertiary` = `--x-neutral-050` / `--x-neutral-900` |
| column | `flex min-w-0 flex-1 flex-col gap-2 py-1 ps-3` | `pt/pb` 4, `padding-inline-start` 12, `gap` 8 |
| header | `flex min-w-0 items-center gap-1` | `size-4` avatar (16) + the quote header's own middot group at `text-body` (one 20 px line) |
| body | `text-subtext1 … line-clamp-2` | 14/16, two lines, `render-entity-as-text` — **entities stay `primary`**, not brand blue |
| thumb | `size-16 shrink-0 overflow-hidden rounded-sm border` | 64 × 64 with the 1 px border *inside* it (the `<img>` is 62 × 62), `bg-secondary`, `border-normal` |
| `+N` | `absolute inset-0 bg-black/40` + white bold `text-subtext1` | more than one media in q2 → `+{n-1}` over the 62 px content box |
| play | `size-6 rounded-full bg-black/60` + `size-3.5` icon | a **video**, centred in the content box; a GIF gets no overlay |
| text column | `min-w-0 flex-1`, parent `items-center` | beside the thumb, vertically centred when the text is shorter than 64 px |

Heights, which the gate confirms to 1/64 at all three widths: text-only
`4 + 20 + 8 + 32 + 4 = 68`, with media `4 + 20 + 8 + 64 + 4 = 100`, plus the
wrapper's 12 px bottom (and its 12 px top only when an attachment precedes it).

**Eligibility** is `rules::decide_nested_quote` (X's `H`): the outer post is not
a reply, `outer`/`q1`/`q2` have three distinct authors (case-insensitive on the
handle, since the model has no user ids), q2 is a plain post (no card, no poll),
and **at most one** of the three has media, a card or a poll. The function also
returns q2's body decisions with `clamp: 2` and
`NestedQuotePreview { plain_entities: true, media_thumb: !q2.media.is_empty() }`.
`cards/quote.rs` draws nothing when it returns `None`; a unit test proves the
suppression from the display list (self-quote at either hop, two attachments, a
carded q2, a reply). Not modelled, because `Post` has no such field: promoted
posts, the conversation-position test, sensitive media and birdwatch notes.

**Image refs go two deep.** The preview's thumbnail is
`ImageRef::Quote(Box::new(ImageRef::Quote(Box::new(ImageRef::Media(0)))))` and
its avatar (through `header`'s depth argument) `Quote(Quote(Avatar))` — the
painter needs both hops to know whose bytes to load, and the gate asserts the
hop count against where Chrome paints each `<img>`
(`quote-nested-photo`: `image[2].ref quote:media:0 has 1 quote hop(s), the box is
at depth 2 (nested preview)` when the second hop is removed).

Five fixtures cover it, all synthetic because **no post in the corpus quotes a
quote**: `quote-nested-text` (clamped two-line body with an entity),
`quote-nested-photo` (64 px thumb, text centred), `quote-nested-multi` (`+2`),
`quote-nested-video` (play circle), and `quote-nested-q1-media` (the quote has the
only attachment, so the preview keeps `p-3`'s 12 px top padding after the photo).

## 6. Polls

Verified against a real poll post: `assets/vendor/corpus/poll-musk.html`
(@elonmusk, "Should I step down as head of Twitter?", two choices, closed,
17,502,391 votes). Poll markup is **not** in any profile or list page captured
logged out — ten profile pages (~100 posts) contain no poll at all — but a post
*detail* page renders the poll fully, both in the markup and in the SSR payload.
That is the capture the gate uses; `poll-2` passes at 320/390/600 in both
themes. It was taken logged out with

```
curl -sS --compressed -A 'xeet-dev/0.1 (public post sampling, logged out, low volume)' \
  https://x.com/elonmusk/status/1604617643973124097 > assets/vendor/corpus/poll-musk.html
```

```html
<div class="-m-1 overflow-hidden"><div class="p-1">          <!-- cancels out -->
  <div class="flex flex-col gap-3">                          <!-- 12 px to the footer -->
    <div class="flex flex-col gap-2" role="list">            <!-- 8 px between pills -->
      <div role="listitem">
        <div class="text-body relative grid rounded-full min-h-9"
             style="--poll-choice-share:0.5749525307713672">
          <span class="absolute inset-0 rounded-full border border-normal"></span>
          <span class="absolute inset-y-0 start-0 rounded-full w-[calc(var(--poll-choice-share)*100%)]
                       bg-brand-wash"></span>               <!-- the leader's bar -->
          <span class="relative grid items-center px-4 py-2
                       grid-cols-[0fr_fit-content(calc(100%-5rem))_0rem_1fr]">
            <span>Yes</span>                                <!-- col 2 (a ::before takes col 1) -->
            <span><svg class="size-4 ms-1 opacity-0"/></span> <!-- col 3 (0rem): the voted check -->
            <span class="justify-self-end ps-3">57.5%</span>  <!-- col 4 -->
          </span>
        </div>
      </div>
    </div>
    <div class="x-middot-group text-subtext2 text-secondary">
      <span>17,502,391 votes</span><span>Final results</span>
    </div>
  </div>
</div></div>
```

What that means for `poll.rs`:

* The pill is `text-body` (15/20) with `px-4 py-2`, so a one-line choice is
  36 px (`min-h-9`) and the label's line box starts 8 px down, **left-aligned at
  16 px**. Nothing is centered, and the 48 px (`min-h-12`) pill I had taken from
  the bundle is the *voting* view's.
* Label track: `fit-content(100% - 5rem)` — capped at the content width minus
  80 px, never stretched. The winner's label and percentage are bold.
* Percentage: right-aligned 16 px from the end, one decimal, `.0` dropped
  (`57.5%`, `100%`) — `Intl` with `style:"percent", maximumFractionDigits:1`,
  not the rounded integer the bundle alone suggested.
* Bars: `bg-brand-wash` for the leader, `bg-(--x-border-active)` for the rest.
* Footer: `text-subtext2` (13/16) in `text-secondary`, 12 px under the list,
  `{grouped count} votes` · `Final results` (or `{n} hours left` while open).
  The count is *grouped*, not compact — `rules::spec::format_plain_count`.
* The selected choice's checkmark is `opacity-0` for a viewer who has not
  voted; it occupies a 0-width track.

Two poll shapes are **not** verified, because X renders them only for a signed-in
viewer: the open (voting) view — `min-h-12`, no bars, no percentages, columns
`[1fr_…]` — and three- and four-choice polls (the same row repeated, which the
two-choice capture already exercises twice). `poll.rs` draws the open view as
choices plus footer, with no bars and no percentages, and documents that it is a
reading of the bundle rather than a measurement.

## 7. Known gaps

| gap | effect | owner |
|---|---|---|
| Viewport bleed of a non-fitting carousel | cells past the slot edge are clipped at the slot, not at the viewport | frame (needs the column's x and the viewport width) |
| Open (voting) poll view | drawn from the bundle, not from a capture: row height 36 px, no bars or percentages | cards (needs a signed-in capture) |
| Three- and four-choice polls | same row template as the verified two-choice capture, but no capture of its own | cards |
| Player cards (`twitter:card` `player`) | laid out as the large-image card plus a play control (that is what X's markup shows in the corpus), but no capture of a player card exists, so it is unverified | cards |
| Ad formats (`unified_card`) | not implemented | cards |
| A quoted post's *link card* | a quote whose attachment is a link card draws nothing for it (the corpus has no capture of one; X's compact form would be the 96 px thumbnail plus the title) | cards |
| A quoted post's `media_tags` line | not drawn inside a quote (no capture) | cards |
| The photo placement of the source attribution | code-derived (`ie`'s classes inside Polygon's photo row, 4 px right of ALT); no captured photo carries a visible badge | cards (needs a capture of a photo embedding someone else's photo) |
| A compact quote's 96 px thumbnail | shows no source attribution (the full-size overlays do) | cards (no capture of a quoted video with a source) |
| A GIF's source attribution | drawn in the `GIF` pill, by the same `type !== 'photo'` branch of `BNn3ozGQ.js`; the corpus has no GIF at all | cards |

Resolved since the first pass (all verified by the gate): `tabular-nums` on the
video duration badge (`inline::Span::tnum`), media tags (`model::Post::media_tags`,
rendered as X's `mt-1` line under the media, 12 px `gap-3` above it), the quoted
author's affiliation badge (`model::Author::affiliate`, `rounded-xs` 7.2 px
squircle with a 1 px ring, one `gap-1` after the check), text lines (compared per
line rather than per baseline, §8), media and a quote in one slot, the quote's two
forms, and the `Replying to @handle` row inside a quote (§5).

## 8. The parity table

`cd tools && node oracle/cards-parity.mjs` — 32 fixtures × 3 widths × 2 themes.

Slot height per fixture at each width (Chrome and xeet agree to 1/64 — `video`
and `quote-2-media` land 1/64 apart, everything else is exact; the heights are
the same in both themes), and how many of that row's six runs pass. The slot
width is taken from Chrome's own attachment box at that viewport, never from our
idea of the page, so the table follows X's column when it changes:

| fixture | 320 | 390 | 600 | runs ok |
|---|---|---|---|---|
| `media-1` | 180.0781 | 232.6094 | 390.1875 | 6/6 |
| `media-1-square` | 240 | 310 | 520 | 6/6 |
| `media-1-portrait` | 300 | 387.5 | 510 | 6/6 |
| `media-tag` | 183 | 222.375 | 324.5 | 6/6 |
| `media-tag-one` | 352 | 445.3281 | 542 | 6/6 |
| `video` | 135 | 174.375 | 292.5 | 6/6 |
| `media-2` | 147.5 | 191.25 | 276.25 | 6/6 |
| `media-3` | 163.1875 | 210.7969 | 353.5938 | 6/6 |
| `media-4` | 163.1875 | 210.7969 | 353.5938 | 6/6 |
| `media-4-mixed` | 163.1875 | 210.7969 | 353.5938 | 6/6 |
| `card-large` | 146.5938 | 183.25 | 293.2031 | 6/6 |
| `card-large-2` | 146.5938 | 183.25 | 293.2031 | 6/6 |
| `quote-media` | 451.5 | 539 | 664 | 6/6 |
| `quote-2-media` | 287.2344 | 313.4375 | 432.0313 | 6/6 |
| `video-tag` | 167 | 206.375 | 324.5 | 6/6 |
| `video-portrait` | 300 | 387.5 | 510 | 6/6 |
| `media-quote` | 462 | 545.5 | 668 | 6/6 |
| `quote-full-video` | 227.875 | 267.25 | 365.375 | 6/6 |
| `media-quote-photo` | 462 | 545.5 | 668 | 6/6 |
| `quote-reply` | 286.8125 | 342.3438 | 508.9375 | 6/6 |
| `poll-2` | 108 | 108 | 108 | 6/6 |
| `card-large-fit` | 146.5938 | 183.25 | 293.2031 | 6/6 |
| `card-large-long` | 146.5938 | 183.25 | 293.2031 | 6/6 |
| `video-attributed` | 135 | 174.375 | 292.5 | 6/6 |
| `video-attributed-long` | 135 | 174.375 | 292.5 | 6/6 |
| `photo-attributed` | 125.5938 | 162.2188 | 272.125 | 6/6 |
| `quote-nested-text` | 214 | 194 | 174 | 6/6 |
| `quote-nested-photo` | 206 | 206 | 186 | 6/6 |
| `quote-nested-multi` | 206 | 206 | 186 | 6/6 |
| `quote-nested-video` | 206 | 206 | 186 | 6/6 |
| `quote-nested-q1-media` | 374.8125 | 430.3438 | 560.9375 | 6/6 |
| `card-summary` | 92 | 92 | 132 | 6/6 |

What each row is:

- `media-*`, `video`, `video-tag`, `video-portrait`: real posts from
  `assets/vendor/corpus/` (a single image in three shapes, a `Learn With …` tag
  line, a 16/9 video, NASA's video with a `media_tags` line, and NBA's portrait
  864×1080 video, which is capped to 408×510 instead of filling the slot).
- `media-2/3/4/4-mixed`: the 2, 3 and 4-cell carousels.
- `video-attributed`, `video-attributed-long`, `photo-attributed`: the source
  attribution badge, on a video (twice, the second with a name that cannot fit)
  and on a photo next to its ALT badge.
- `card-large`, `card-large-2`: real `summary_large_image` cards (nytimes,
  verge); `card-large-fit`, `card-large-long`: the same markup with a title that
  fits its pill and one that has to be clamped;
  `card-summary`: X's `summary` markup, reconstructed from `HlKpYMvh.js`.
- `quote-media`, `quote-2-media`, `quote-full-video`: real quotes in the
  full-width form (XDevelopers; levels.io with a 2-image carousel, an affiliate
  badge and a 320 px name clamp; XDevelopers quoting a landscape video).
- `media-quote`, `media-quote-photo`: a post with media of its own that quotes
  another (NBA: portrait video and portrait photo), which draws the compact
  quote with a 96 px thumbnail.
- `quote-reply`: a quote of a reply, with the `Replying to @handle` row.
- `poll-2`: the real @elonmusk poll ("Final results", 17,502,391 votes).
- `quote-nested-text`, `-photo`, `-multi`, `-video`, `-q1-media`: the nested quote
  preview, five shapes — synthetic, because **no post in the corpus quotes a
  quote**: the corpus's five nested-quote candidates all fail X's eligibility
  (two media, self-quote, `outer == q1`), and the client fetches q2 with a
  separate query the captured payloads do not carry. They render X's own classes
  (above) inside a quote card built from `XDevelopers.html`'s skeleton, so the
  comparison is Chrome's layout of X's markup against ours.

How text is compared: a line is the set of range rectangles sharing a top
(±1.5 px), and only the line count and each line's leftmost start are compared,
to 1/64 px. The vertical placement of a line box is not compared, because a DOM
range rectangle is not a line box — Chrome shifts it inside a
`-webkit-line-clamp` box — and because the font metrics are pinned by the text
stream's own gate. Three measurement details worth knowing: transitions are
disabled before measuring (X animates poll bar widths and label crossfades); an
element with `opacity: 0` paints nothing, so it is skipped (the poll's voted
checkmark is such an element); an `<img>` element is compared at 1/16 px, since
Chrome lays it out from its intrinsic ratio as well once the bytes decode and
the element then sits 2–4/64 px wider than the container's aspect box (all the
boxes painted from it stay at 1/64); and a poll label is painted by
`::before { content: attr(data-label) }` while its text node is transparent, so
the element box stands in for that line.

Two assertions go beyond boxes and line starts:

* **Which bytes an image draws, at what depth.** The dump names each image item's
  `ImageRef` (`media:0`, `quote:media:0`, `quote:quote:media:0`, `quote:avatar`,
  `card:<url>`, …) and Chrome says how deep in the quote nesting each `<img>` is
  (inside the quoted `<article>`, and inside the nested preview's
  `rounded-[9px]` wrapper); the number of `quote:` hops must match, and no ref
  may be used twice. `ImageRef::Media(i)` and
  `ImageRef::Quote(Media(i))` share the index, so only the prefix tells them
  apart — a quoted video emitted as the former painted the outer post's poster
  the moment real bytes arrived.
* **Glyph runs per line.** A fixture may declare the run count it expects
  (`runs: [1, 1]`), which is the only way geometry can see an ellipsis: Chrome
  paints `text-overflow` without a DOM node, and an ellipsized line has a second
  run for the `…`.

## 9. What the end-to-end harness found, and what changed

`node tools/ship/e2e.mjs` compares every payload in the corpus with Chrome
rendering the captured page. Triage had attributed three families to cards; each
was reproduced from its artifacts under `tmp/e2e/<file>-<id>/`:

| post | before | after | cause |
|---|---|---|---|
| `NASA.html` 2119833829389041896 (video + `media_tags`) | 450.5 / 419.0 (Δ-31.5) | 450.5 / 451.0 (`pass`) | the tag line is 16 px + `mt-1` 4 px + `gap-3` 12 px: the renderer drew it, the *converter* never mapped `media[].features.all.tags`, so `mediaTags` was missing |
| `NASA.html` 2119467718373941588 | 510.5 / 479.0 (Δ-31.5) | 510.5 / 511.0 | same |
| `NBA.html` 2120019063476785477 (media + quote) | 834.0 / 676.0 (Δ-158) | 834.0 / 834.0 (`pass`) | media and quote are drawn together, and the quote is compact |
| `NBA.html` 2120016790608658895 | 754.0 / 596.0 (Δ-158) | 754.0 / 754.0 (`pass`) | same |
| `text-karpathy.html` 2105909609487872075 (quote of a reply) | 634.9 / 611.0 (Δ-23.94) | 634.9 / 635.0 (`pass`) | the `Replying to @handle` row |
| `XDevelopers.html` 2107953725071626260 (quote of a video) | 491.4 / 272.0 (Δ-219.38) | 491.4 / 491.4 | the compact form is for quotes *under a post with media*; this one keeps the full-width video |

Whole corpus (`--json tmp/e2e-full.json`): **pass 25 → 132** of 169 compared
posts, `raster` 24 → 5, `layout` 18 → 12, `text` 7 → 0, `content` 46 → 0,
`error` 3 → 0. (The `text`, `content` and most of the `raster` movement is the
other streams' work; the table above is cards'.)

Two failure families remain that the harness reports on posts cards also
touches, and both are the harness's, not the renderer's:

- **A payload that appears as a *quoted* post is compared against the article
  that quotes it.** All 24 remaining `layout`/`long-post:layout` rows show
  Chrome's first line and ours as different *posts* (`lines 0/N`, `firstDiff` is
  the outer post's text). Example: `NBA.html` 2120015019408752696 is quoted by
  2120019063476785477, and the harness measures the outer cell (834) against the
  inner post's payload (616). Cards renders both correctly — the `media-quote`
  fixture is exactly that pair.
- **The pixel comparison's vertical alignment.** The cropped screenshot diff
  reports a body offset of 1–3.5 device px on several posts whose heights and
  boxes match to 1/64, which is a crop offset rather than a layout difference.
