# The post frame: what x.com draws, and how we know

This file is the frame stream's evidence log: the geometry of a post as x.com
lays it out, the numbers behind it, and what is still unverified. The code is
`crates/xeet-core/src/frame/`; the constants it uses come from
`assets/vendor/tokens.json` (extracted by `tools/extract-tokens.mjs` from X's
stylesheet) and reach it through `crates/xeet-core/src/tokens.rs`.

X's behavior rules (what is shown, hidden, which attachment wins) live in
`SPEC.md`, which the rules stream owns. This file is layout only.

## Where the numbers come from

- **Markup and colors:** the nine public post pages in
  `assets/vendor/corpus/` (fetched logged out, 2026-11-09, app version
  `3e351742…`). They are server-rendered: the post markup, the embedded
  payload (`full_text`, `counts`, `created_at_ms`) and the rendered timestamp
  labels are all in the same document.
- **Class → number:** X's stylesheet, `assets/vendor/upstream/styles.css`,
  resolved by `tools/extract-tokens.mjs` (it also asserts that every
  declaration the frame needs still exists).
- **Geometry:** `tools/oracle/replica.mjs` renders X's real markup with our
  data under headless Chrome and dumps every box and text line. The frame's
  gate is `crates/xeet-core/examples/frame_parity.rs`, which compares
  `frame::layout_debug` against those dumps at 1/64 px per box.

## The column

```
cell      0 .. w                     16px horizontal / 12px vertical padding
content   16 .. w-16
avatar    (16, 12) 40x40 rounded-full
text col  64 .. w-16                 avatar + 8px gap
```

`max-w-[600px]`; the media `sizes` attribute says `calc(100vw - 80px)`, which
is the text column exactly. The cell also carries a 1px bottom divider, which
a single-post preview does not draw: the frame's height is the padding box.

## Timeline (`web-timeline`)

```
header row  (64, 12, w-80, 20)      name ✓ @handle · 3h              [...]
text        (64, 34, w-80)          2px below the header (`gap-0.5`)
attachment  (64, ...)               12px above (`gap-3`)
action row  (56, ..., w-64, 20)     12px above, 8px bleed each side (`-mx-2`)
```

## Post detail (`web-detail`)

```
avatar+header (16, 12, w-32, 40)    name row over handle row, 20px each
text          (16, ..., w-32)       17/24 (`text-lead`), full width, under the avatar
attachment    (16, ...)             12px above
timestamp     (16, ..., w-32, 20)   "8:50 PM · Mar 21, 2006 · 987K Views"
action row    (8, ..., w-16, 20)    8px + 12px above (`gap-2` + `mt-3`)
```

The detail view's text starts at the cell's left edge, *under* the avatar:
the markup puts the text div outside the avatar row. That is the whole
structural difference between the surfaces, and why detail text is 24px wider.

On **both** surfaces the header is `text-body` (15/20) even though the detail
post text is `text-lead` (17/24), and the detail timestamp row is `text-body`
too. Getting that wrong makes the detail header 44px tall instead of 40.

## The context row (`Pinned`)

A profile timeline's pinned cell carries a row **inside the `<article>`**, above
the avatar/header row — the article is `flex flex-col gap-1`, so one 4px gap
separates them:

```html
<article class="group/post flex flex-col gap-1">
  <div class="max-w-full text-subtext2 font-bold text-secondary flex items-center gap-2">
    <span class="flex w-10 shrink-0 justify-end"><svg data-icon="icon-pin-fill" class="size-4">…</svg></span>
    <span>Pinned</span>
  </div>
  <div class="flex gap-2">…avatar + header…</div>
```

Measured in Chrome at a 600px cell: row 16px tall (`text-subtext2` 13/16), the
16px icon right-aligned in the 40px avatar column (x 40..56), the label starting
exactly at the text column (x 64), and the avatar/header row 4px below — 20px
added to the post. `frame::social` draws it from `Post::social_context`, and the
label and icon colours are `text-secondary`. The icon never scales; the label
does, so the row is `max(16, subtext2 line-height)`.

`model::SocialContext` currently has one variant (`Pinned`); the 21 pinned cells
in the corpus are the evidence. The detail surface has no such row (the reply
post fetched for `docs/E2E.md`-style checking shows none), so the frame draws it
on `web-timeline` only.

## The header shares its width like this

1. The row is `content − "More" outer − 8`. "More" is 32px with a negative end
   margin (`-me-[5px]` timeline, `-me-0.5` detail), so its outer width is 27
   and 30; it overhangs into the padding.
2. The timestamp never shrinks. Its width is `4 + "·" + 4 + text`: X's
   `.x-middot-group > :not(:first-child)::before` inserts the separator with
   `padding-inline: 4px`, which is why the gap before the time reads as 12px.
3. The name/handle group takes the rest: `min(natural, row − time)`.
4. Inside it the name is `shrink-0` + `max-w-full`, so the name is
   `min(natural, group)` and the handle gets `group − name − 4`, clamped at 0.
   When the name is long the handle collapses to 0px, the group overflows by
   the 4px gap, and Chrome still puts the timestamp at the group's width. We
   reproduce that, including the consequence: a 0px handle whose box is
   `overflow: hidden` paints nothing at all, so the frame clips the name and
   handle glyphs to their boxes.
5. The affiliation badge is a second `size-[1em]` square one `gap-1` after the
   check, so the name span grows by 19px (`acme ✓ ▣ @acme`). Measured on
   `jack`'s post: check 15px, 4px, affiliate 15px, 4px, handle. Without image
   bytes the frame draws a neutral `bg-secondary` square with a 1px
   `border-normal` edge in the same shape.
5. On the detail view the handle row is capped at the *row* width, not the
   full column: both rows live in a flex column that is a flex item of the
   header row.

Box widths must be snapped up to 1/64 px (`ceil64`). Chrome sizes a text box
in layout units, and laying out at the raw advance sum makes the last grapheme
wrap: `Vercel` at 15/700 is a 45.390625px box, not 45.389984.

## Radii and corner shape

X sets `--x-radius-m: 1.8` inside `@supports (corner-shape: squircle)` for
`:is(.rounded-xs,.rounded-sm,.rounded,.rounded-md,.rounded-lg,.rounded-xl)`,
and Chrome satisfies that query. So those utilities are 1.8x their base value
and drawn as superellipses:

| utility | round | effective (Chrome) |
|---|---|---|
| `rounded-xs` | 4 | 7.2 + squircle |
| `rounded-sm` | 8 | 14.4 + squircle |
| `rounded-md` | 16 | 28.8 + squircle |
| `rounded-lg` | 24 | 43.2 + squircle |
| `rounded-xl` | 32 | 57.6 + squircle |
| `rounded-2xl` | 16 | 16, round (not in the list) |
| `rounded-full` | 9999 | 9999, round |
| `rounded-[10%]` | 10% | 4 on the 40px avatar slot, round |

The avatar uses the last two: a normal account is `rounded-full` (a 20px
circle on the 40px slot), a business/gold account is
`<div class="x-avatar rounded-[10%] size-10">`, and `rounded-[10%]` is *not* in
the squircle selector list, so its corner is round and resolves against the box
— Chrome reports `border-radius: 10%` on a 40×40 box, i.e. **4px**
(`avatar_radius` in `frame/mod.rs`; `cards::quote` already used the same 10%
for the quote's smaller avatar). A sharp 0px square was wrong; the gate now
compares our avatar radius against Chrome's computed `border-radius` on the
`business-square` fixture, and reports `avatarShape radius: 0 vs 4` if it drifts.

`tools/extract-tokens.mjs` applies `@supports` blocks whose feature the pinned
Chrome supports (the list is in the file; every applied and skipped condition
is recorded in `tokens.json`'s `supports`), and records both numbers:
`radii` / `radiiRound` / `cornerShape` plus `units.radiusMultiplier` (1) and
`units.radiusMultiplierSquircle` (1.8). `tokens.rs` exposes them as
`RADIUS_*`, `RADIUS_*_ROUND` and `RADIUS_*_SHAPE`, wrapped in
`tokens::Radius { value, round, corner }`.

## Breakpoints

The frame has no breakpoint-dependent constant, checked two ways:

- The stylesheet's width queries start at 512px (`sm:`), then 768/1024/1280/
  1536, and `@media (width<=600px)`. No utility the frame reads is redefined
  inside one — the extractor skips `@media` blocks entirely and records them in
  `tokens.json`'s `supports.skippedMedia`, and an audit of the sheet finds only
  `.x-engagement-pill` there (hover/pointer/reduced-motion decoration).
- The replica now renders **one page per (theme, width)** so the page's media
  queries see exactly the fixture's viewport, instead of one wide page that
  could resolve `sm:` rules for a narrow fixture.

## Type, features, weights

| What | Style |
|---|---|
| timeline body | `text-body` 15/20, `pre-wrap`, `overflow-wrap: anywhere`, `dir=auto` |
| detail body | `text-lead` 17/24, same wrapping |
| name | `text-body font-bold`, `line-clamp-1`, `word-break: break-all` |
| handle | `text-body`, `line-clamp-1`, `overflow-wrap: break-word`, `ss01` |
| middot, timestamp | `text-body text-secondary` |
| counts | `text-subtext2` 13/16, `font-variant-numeric: tabular-nums` |

Every type size multiplies by X's font-scale setting; spacing, avatar and icon
sizes do not (the badges are 1em, so they follow the text). `tabular-nums` is not cosmetic: `1.2K` is 28.25px at 13px with
`tnum` against 25.17px without, and the captured numbers are the wide ones.
Counts are laid out by `inline` with `Span::tnum`, like every other string.

Chirp's ascent and descent are 952/1000 and 241/1000 of an em: 14/4 at 15px
(a font box of 18, which is what Chrome reports for a `Range` rect). Chrome
*floors* the half-leading when it places a line's text box: at line-height 30
with a 25px font box the box sits 2px down, not 2.5. `inline::make_line` does
the same, and the frame follows it when it records line boxes. Counts are an
exception the frame handles: their line box is centered in the pill by flex,
and the glyph box inside it starts at the exact half-leading.

## The action row

Pills, not plain buttons:

| | timeline | detail |
|---|---|---|
| columns | reply, repost, like, views | reply, repost, like |
| numbers on | those four | those three plus bookmark |
| pill height | 36 (`h-9`) | 40 (`h-10`) |
| pill padding | 10 (`px-2.5`) | 12 (`px-3`) |
| icon | 18.75px | 20px |
| row box | 20px tall (`h-5`), pills overflow 8px above and below | same |

The leading columns share the leftover width equally (`flex-1`); bookmark and
share are packed to the right. The row is 8px wider than the text column on
each side, so the first pill's padding lines up with the text.

**Bookmark hides at narrow widths.** The markup wraps it in
`@max-[290px]:hidden` under the `post-actions` container query and the
container is the post, so it is gone when the article is ≤ 290px wide: hidden
at viewport 320 (article 288), shown at 390 (article 358).

A count of zero shows nothing: X renders the icon without a number. Not in the
corpus (every captured post has engagement), so it is an assumption.

## Timestamps

`formatRelativePastTimestamp` with `precision: "Hours"`: `Now`, `42s`, `5m`,
`3h`, then `Nov 9`, then `Nov 9, 2025` across a year boundary. The full
timestamp is `h:mm AM · Mon D, YYYY`. The space before AM/PM is U+0020 (checked
byte by byte in the captured markup), and the separator is U+00B7 with one
space each side.

## Clamped text and the ellipsis

`-webkit-line-clamp: N` clips at the line limit *and* paints an ellipsis on the
last visible line; the shared paragraph helper (`inline::layout` with
`max_lines`) now does both, so every clamped block gets it: the quote body
(`line-clamp-5`), card titles and descriptions, the one-line name and handle
clamps, and any block the rules stage clamps.

The rule, as Chrome draws it (verified in pixels — see below):

- the `…` is a glyph in the line's font and colour, placed **after** the
  truncated content;
- content is dropped a grapheme at a time until content + `…` fits the column,
  so the cut is at a cluster boundary (an emoji is never split) and it may land
  mid-word;
- an **empty** last visible line gets `…` alone at the line's start. This is
  the quoted post the lead pointed at (status 2118152230260092940): four lines
  and a blank paragraph line, so the clamp lands on the blank line and X shows
  a lone `…`;
- a **space** at the end of a soft-wrapped line is *interior* once the ellipsis
  follows it, so it keeps its advance and the `…` sits one space further right.
  Chrome keeps it (`clamp-overflow` at 600: the line's ink ends at 564px, 500px
  of content rather than 497); we used to trim it, which moved the ellipsis
  3.39px left. The space is only dropped when the line has to give up clusters;
- on a right-to-left line the `…` is at the line's **visual end** (the left
  edge, since bidi reverses the line).

Chrome's DOM cannot be asked about any of this: a Range over a clamped block
still reports every line the clamp hides, and the `…` is not a text node. So it
is checked in pixels. `tools/oracle/clamp-ink.mjs` measures the ink bounding box
of the last visible line in the replica's screenshot and in our render; the four
`clamp-*` fixtures (`blank`, `overflow`, `emoji`, `rtl`, at 320/390/600, both
themes, both surfaces) agree with Chrome to **0.5px** everywhere:

```text
                     chrome ink        our ink
clamp-blank     600   64.5 .. 74.5    65 .. 74        (a lone `…`)
clamp-overflow  600   64   .. 564     64 .. 564
clamp-emoji     390   64.5 .. 326     64.5 .. 326
clamp-rtl       320   79   .. 303.5   79.5 .. 303.5  (ellipsis at the left)
```

Because a clamped line's DOM rect is Chrome's *unclamped* layout, `frame_parity`
compares `y`/`h` and a prefix of the text for clamped blocks, not `x`/`w`
(a right-to-left clamped line would otherwise "fail" by the ellipsis width).

## The inline "Show more" of a long post

The server's cut body ends with X's own button, in the body's flow:

```html
<span …>…rolling out starting</span> <button class="max-w-full
  text-[length:inherit] font-normal text-brand hover:underline">Show more</button>
```

Measured in Chrome (`Google.html`, 600px cell): the button is `display:
inline-block`, 77.703 × 20 at 15/20 (`padding: 0`, `margin: 0`,
`vertical-align: baseline`), and the space in front of it is an ordinary text
node **outside** the button (3.391 advance at 15px). So:

- it is one **atomic** box: it never splits, and its edges are break
  opportunities (`Span::atomic`);
- when it does not fit after the body's last word the space hangs at the end of
  that line (Chrome: the space's rect ends the line at x 456.313) and the button
  starts the next line at x 0;
- when it fits it trails the last line (Chrome's other long post: button at
  x 152.266 on the text's last line).

`frame::build_body` pushes the body's space as an ordinary span and the button
as an atomic `show-more` span; `record_show_more` records its box as the line
box (top = the line's top, height = the line's height), not the glyph box, which
is one half-leading higher. Four fixtures cover both cases at every width and theme (`longpost-fit`,
`longpost-wrap`, `longpost-tail`, and `longpost-google-real`, which is the exact
`Google.html` post the e2e harness reports as `long-post:text`), and the replica
injects the captured `<button>` itself rather than our own markup.

Two details that decide the fit, both measured on that real post (520px column):

- **The space in front of the atomic box counts.** Chrome's last line of text
  ends at 456.3125, the space adds 3.390625, the button is 77.703125:
  537.416 > 520, so the button wraps. A space only hangs when it is *trailing*
  (the line ends there); before an `inline-block` it is interior and occupies
  its advance. Our engine agrees: the last text line is 459.70313 wide
  (456.3125 + 3.390625, to 1e-4) and the button starts the next line at x 0.
- **The button's box is snapped up to Chrome's 1/64px LayoutUnit.** Our shaped
  advance is 77.69995; Chrome lays the `inline-block` out as 77.703125
  (`ceil64`), which is what `record_show_more` records, so the box is
  bit-identical rather than merely within tolerance. The *fit* still uses the
  engine's paragraph positions, like every other line break; 0.003px there is
  far below any break decision.

`Report::text::visible` includes the button's label (`… and the highest Show
more`). Anything that re-lays that string as plain text — rather than reading
the frame's own lines — will split `Show more` across two lines, which is what
a pre-atomic version of this code did. `tools/ship/e2e.mjs`'s `xeetLines()` does
exactly that, which is why its `long-post:text` rows reported a difference on
this post.

The detail surface is left out: `rules::decide` keeps the body whole there, so
no button is drawn (and the captured detail views have none).

Captured long posts are inconsistent about the cut: some cells end with the
button after ~280 characters (`Google.html`, `NASA.html`, `text-OurWorldInData`),
while others render the whole note tweet with no button at all
(`text-GoogleAI.html#2115489593818816591`: 388 characters, no button). That is
`Post::long_post` / `long_post_body` — a rules/converter question, not a frame
one: whenever the cut is drawn, the geometry above is what Chrome does.

## Counts

Truncated, never rounded up: `1938 → 1.9K`, `5264 → 5.2K`, `8071 → 8K`,
`10355 → 10K`, `987654 → 987K`, `4082915 → 4M`, `4252767 → 4.2M`,
`37047269 → 37M`. The rule is the action-row formatter: compact with one
truncated fraction digit, and if that rendering is five characters or longer,
again with none. It is implemented once, in `rules::spec::format_count`
(SPEC.md "Counts"), and `frame/numbers::compact` delegates to it. The table in
`frame/numbers.rs` keeps all 464 `aria-label`/rendered pairs from the corpus as
the regression test. Billions follow the same ladder by extrapolation; the
corpus stops at 37M. Other call sites use other formatters: the detail Views
label and profile stats are plain below 10,000 and one-decimal compact above,
and poll totals are never abbreviated.

## What x.com draws that this frame does not

Everything the page itself renders is drawn, with one exception that belongs to
`cards`: **a quoted post that is itself a reply** shows `Replying to @handle`
inside the quote, one `gap-1` below the quote's header row:

```html
<div class="max-w-full text-body font-normal text-secondary">Replying to
  <a class="… text-brand" href="/celestepoasts"><span class="… [font-feature-settings:'ss01']">@celestepoasts</span></a>
</div>
```

(`text-levelsio`-style quotes in `text-karpathy.html`.) It is 20px tall plus the
4px gap, which is exactly the height difference measured on that post
(`text-karpathy.html` `2105909609487872075`: Chrome 634.94, ours 610.94). The
field it needs, `Post::reply_to`, already exists; the row belongs in
`cards::quote::layout`.

Rows that X shows in other contexts but that **no capture contains**, so this
frame does not model them yet: community notes ("Readers added context"),
"Translated from …", edited labels, promoted labels, and sensitive-media covers.
When a capture with one of them appears, the replica harness is the place to pin
its geometry down first (inject the captured row's markup the way the `Pinned`
row and the affiliation badge are injected).

## Unverified, or known to disagree

- **The line-clamp cut.** Timeline and detail main text have no `line-clamp`
  (verified). When a clamp does apply (quoted posts clamp to 5), Chrome's DOM
  rects still report the *unclamped* layout while it paints an ellipsis-cut
  line, so the cut point cannot be read from the DOM. The gate therefore
  compares the first line's position and a prefix of its text, not the exact
  cut or the width. Verifying the cut needs pixels (paint, or a screenshot
  diff), and is not done yet.
- **Count formatting is verified now.** `rules::spec::format_count` matches all
  464 captured pairs; `frame/numbers::compact` delegates to it, so there is one
  implementation and the frame's table tests it.
- **The affiliation badge's shape** is taken from the stylesheet
  (`rounded-xs` = 7.2px squircle, 1px border) and its box is verified against
  Chrome, but the artwork is the caller's bytes: without them the frame draws a
  neutral square, which is not what a reader sees on x.com.
- **Views on the detail surface.** The captured detail pages have no view
  count in the timestamp row (their payloads omit impressions), so the
  markup for `"987K Views"` is synthesized from the row's own span classes and
  is only verified against itself.
- **RTL line start.** For a right-to-left line our reported line x can sit
  0.026px left of Chrome's, because `inline::make_line` aligns the line with
  the unsnapped run total while Chrome aligns with the snapped one.

## Verified

`examples/frame_parity.rs` against `tools/oracle/replica.mjs`, 60 fixtures per
theme (10 posts × 2 surfaces × 3 widths):

```
147 fixtures, 0 failing; 3409 boxes and 613 lines checked; worst delta 0.0156px
```

(light and dark, identical numbers; the matrix is 17 posts × the surfaces they
apply to × widths 320/390/600, plus three font-scale 1.25 cases, rendered as one
page per width). 0.0156px is exactly one Chrome layout
unit, the gate's tolerance. Frame heights are identical for every fixture.

Round trip on real captured posts (`node tools/oracle/replica.mjs --verify
jack-20.html --article 2 --width 526`): read a post's data back out of the
delivered DOM, re-render it through the replica at the same cell width, and
diff — 0 differences for `jack-20.html#2` and `#3` (text-only timeline posts),
apart from the 1px cell divider the preview does not draw.
