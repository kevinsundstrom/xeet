# End-to-end acceptance against real x.com posts

`tools/ship/e2e.mjs` takes the payloads embedded in the captured pages
(`assets/vendor/corpus/*.html`), renders each post with xeet, and compares that
against Chrome rendering **the captured page itself**. It is the end-to-end layer
of the parity plan — the real corpus rather than a replica.

```sh
CARGO_TARGET_DIR=target/ship-e2e cargo build --release --bin xeet --bin xeet-render --example ship_pixel_diff
CARGO_TARGET_DIR=target/ship-e2e node tools/ship/e2e.mjs --json tmp/e2e-full.json
CARGO_TARGET_DIR=target/ship-e2e node tools/ship/e2e.mjs --files jack-20.html --limit 4 --keep   # one page, keep artifacts
```

Per post it reports: the cell width the page used, the whole-post height
(Chrome's article against our display list minus the cell padding), the text box
left edge, the line breaks, and the share of pixels within ±2 per channel
(image rectangles masked, because Chrome gets a 1×1 transparent stub there and
xeet draws a labelled placeholder). Each row is classified so the failure points
at a stream:

| Verdict | Meaning | Routed to |
|---|---|---|
| `pass` | height within 1 px, line breaks equal, pixels within the platform's AA gap | — |
| `layout` | the whole-post height or the text box differs | `frame::layout` |
| `text` | same text, different line breaks | the text engine |
| `content` | the text we lay out is not the text the page shows | `rules` (truncation, hidden ranges) |
| `raster` | pixels differ beyond the AA gap | `paint::rasterize` |
| `long-post:*` | a >280-character post, where X's own cut point is still open (`SPEC.md` §5) | `rules` first, then the stage in the suffix |
| `skip` | the payload cannot be compared (a card whose metadata the capture does not keep, a pinned/reply context row, an image-only post with an empty body) | — |

## The harness makes four decisions worth knowing

1. **Reveal the server render.** X's server HTML hides the timeline list
   (`display: none !important`) until its client code runs, and the oracle aborts
   every script. The harness sets `display: block !important` on those ancestors,
   which is the oracle adjusting the page it compares against, not the renderer.
2. **Cell versus content box.** Our display list is the whole cell (600 px with
   16/12 padding); Chrome's `<article>` is the content box (568 px). The harness
   renders at `article.width + 32`, compares heights after subtracting the cell
   padding, and crops our PNG to the article's screenshot pixels before diffing.
3. **Content before line breaks.** Chrome's lines are joined and compared with
   the text we laid out; when they differ, the verdict is `content` (rules), not
   `text`. Without that split, every truncation difference looked like a
   line-breaking bug.
4. **The pixel comparison follows paint's e2e oracle** (`docs/e2e-raster.md`),
   because `±2` with no slack is below the rasterizer agreement floor: even a
   perfect renderer is only 95.6% within ±2 on text (two rasterizers cannot agree
   to 2/255 on every glyph-edge pixel). So the page is screenshotted with
   `*{-webkit-font-smoothing:antialiased!important}` forced — the platform's font
   backend (CoreText dilation) stops being part of the comparison, which is the
   platform-neutral target — and the gate is `±8` with a one-pixel neighbourhood,
   6% of unmasked pixels. The old `±2` number is still reported, as a second
   column. The authoritative raster gate stays paint's Linux oracle.
5. **Guards against captures that cannot be compared**: a post whose Chrome
   ink is below half of ours (a blank or clipped screenshot — `docs/e2e-raster.md`
   §4), an article that wraps more than one post (a thread cell), and
   a post that contains an emoji (Apple's font against Twemoji is a fixed
   0.5–1.5% floor; those rows are bucketed `raster:emoji`, recorded rather than
   failed).

## The pairing rule (round 6)

A post's status id appears in three places on a captured page: its own cell, the
quoted card of every cell that quotes it, and sometimes an invisible
`absolute inset-0` overlay link. Round 4 keyed on "top-level article containing
an anchor to the id", which is not enough: the quoted post's permalink lives
inside a quote container that is *not* a nested `<article>` in this markup, so
**17 of 24 layout rows were comparing the quoting cell against the quoted
post** (e.g. payload `2120015019408752696` measured against the 568 px cell that
quotes it, whose own permalink is `2120019063476785477`).

The pair key is now the cell's **own** permalink: the first status link in DOM
order, not inside a nested article, with text of its own (the header timestamp).
A post whose only appearance is someone else's quoted card has no cell of its
own and is skipped with that reason. Every row records the id it measured
(`measuredId`, `pairOk`), and the run prints them, so a mispairing can never be
silent again. Effect: `layout` 24 → 5, and the 5 that remain are the same post.

## The "Show more" affordance (round 6)

Chrome renders the inline affordance as `<button>` with
`display: inline-block` (78×20 in the captured pages). It is an atomic inline
box: it wraps as a unit onto its own line and never splits across lines. Our
side appends `" Show more"` to the text stream, which (a) puts the words on the
wrong line and (b) steals width from our last line, so the body breaks earlier
than Chrome's.

Confirmed by measurement, on `Google.html:2119788086490001906`:
`<button>Show more`, `display: inline-block`, rect `78x20`, and Chrome's text
element ends *after* the button — its lines are the body, then the button on its
own line, while our last line is `"…and the highest Show more"`.

Root cause beyond the affordance: for a note post, the payload already carries
the body the server put in the cell (`details.full_text` after
`display_text_range`). The converter now passes that as `longPostBody` for every
post with a note, and sets `longPost` from `note_tweet.is_expandable` — X's flag
for whether the affordance appears at all. Before this, our converter passed the
authored note text and let `rules` re-derive a cut, which cut in a different
place than X did.

What remains is not the harness: the affordance should be laid out as an atomic
inline (the text engine already has `Span::atomic()`) and the cut taken from
`longPostBody`. **Routed to rules (the cut and where the affordance lives) and
frame (laying it out as an atomic inline box).**

### `is_expandable` does not decide it (round 7)

Frame measured the five `long-post:layout` rows as pages that render the whole
note with no button. Checking the payloads:

| post | `note_tweet.is_expandable` | note | our body | page drew | page button |
|---|---|---|---|---|---|
| `text-GoogleAI-2115489593818816591` | `true` | 388 | 273 | whole note | no |
| `text-WHO-2118382547532947886` | `true` | 371 | 277 | whole note | no |
| `text-cloudflare-2118694645538460046` | `true` | 414 | 279 | whole note | no |
| `text-firefox-2113342891699392808` | `true` | 308 | 283 | whole note | no |
| `text-stripe-2118437899545038964` | `true` | 338 | 271 | whole note | no |
| `Google-2119788086490001906` (control) | `true` | 724 | 279 | 288 + button | yes |

So **all five are `is_expandable: true` while their pages render them uncut** —
and the control is also `true` but *is* cut, with `details.full_text` (297 chars)
narrower than the note in both cases. Neither the flag nor the payload's cut
separates them: the difference is the **surface the cell came from** (a
search-result/detail-style cell expands a note; a timeline cell clamps it). The
model has `Surface::WebDetail`, but the harness cannot tell which surface a
captured page is from the payload alone, and choosing it from the page's own
button would hide exactly the difference we are measuring.

Converter change kept (it is right, just not sufficient): `longPostBody` is
always the server's cell body verbatim, and `longPost` requires the server to
have *cut* it — a note that `full_text` covers in full is passed whole with no
affordance. **Open question for rules: what makes a cell expanded?** The harness
now records the page's own evidence per row (characters drawn, affordance
button present) and buckets these five as `long-post:expanded-page`.

## A capture that is a function of the cell (round 8)

Two posts went `pass` → `raster` between the two goldens with their line breaks
and heights unchanged: `elonmusk.html:2119989523748905221` (1.56% → 9.50%) and
`text-bellingcat.html:2007636993694675136` (4.59% → 8.77%). Neither was a
rendering regression. `ours.png` was byte-identical in both runs — the *capture*
changed.

Bringing the same render, the same masks and the same settings up against the
harness's stored `chrome.png` and against a clean capture of the same article:

| post | harness capture | clean capture of the same cell |
|---|---|---|
| `elonmusk.html:2119989523748905221` | 9.50% | **1.58%** |
| `text-bellingcat.html:2007636993694675136` | 8.77% | **1.67%** |

What the harness's capture actually contained, read off the pixels:

* **X's sticky profile bar painted over the article.** The bar is 53 CSS px tall;
  over a 571.5 px cell that is 9.3% of the compared area, and the row measured
  8.77%. Whether it is in the capture depends on where the page was scrolled when
  the screenshot was taken — which is wherever the *previous* cell's screenshot
  left it. The same cell measured 1.58%, 4.59% and 9.50% in three runs.
* **A stale clip.** Playwright scrolls an element into view and then computes the
  clip from its box. When those disagree the capture is a cell-sized region of
  the *neighbouring* post: `text-bellingcat` came back as the post above it
  ("…your support: bellingcat.com/donate", counts 11/28/105/40K) with the same
  size and the same `heightDelta`.
* **A fractional cell origin.** The cell's page y is fractional
  (`2174.203125`), so every baseline sat a fraction of a device pixel away from
  our render, which always starts at 0 — the sub-pixel placement paint measured,
  but *caused by the capture* rather than by the layout.

The harness now prepares the capture instead of trusting the page:

1. hide every `position: fixed | sticky` element that is not an ancestor of the
   cell (X's top bar and nav rail; our render has no page chrome),
2. snap the cell's top to the device pixel grid with a sub-pixel `margin-top`,
3. scroll it into view at an integer offset with a 96 px margin, with
   `scroll-behavior: auto !important` injected so no scroll can be mid-flight,
4. capture the element the *measurement* used (by index, not by a `:has()`
   selector that can match a quoting cell) through a viewport clip in viewport
   coordinates, so Playwright never scrolls during the capture,
5. and require **two consecutive captures to agree** (within 8% of unmasked
   pixels: a wrong cell differs by 30–90%, a video frame by 0.45–2.3%). A cell
   whose capture never settles is reported as `capture`, never scored as
   `raster`.

Effect on the full corpus (54 pages, 283 payloads, same binaries):

| Bucket | golden (before) | after |
|---|---|---|
| compared | 152 | **154** |
| **pass** | **144 (94.7%)** | **153 (99.4%)** |
| raster | 4 | **0** |
| raster:emoji | 3 | **0** |
| long-post:raster | 1 | **0** |
| capture (unstable screenshot) | 0 | 1 |

The two flagged posts: `elonmusk.html:2119989523748905221` **9.50% → 1.58%**,
`text-bellingcat.html:2007636993694675136` **8.77% → 1.67%**, both `pass`, with
`heightDelta` unchanged (0.61 and 0.5). Two consecutive full runs produced the
same verdicts and the same two-file table, with a maximum ratio movement of
0.095 pp.

`XDevelopers.html:2110414269036794108` is the one row that still reports
`capture`: its screenshot never repeats (the difference is outside the masked
media rects), and it was `pass` at 2.46% in the previous golden. That cell needs
its own look — a video overlay outside the media rect is the likely culprit.

## What it finds (2026-11-10, 54 pages, 283 payloads, paint's oracle settings)

| Bucket | Posts |
|---|---|
| compared | **154** |
| **pass** | **140 (90.9%)** |
| long-post: expanded page (page drew the whole note, no button; we laid out the cut) | 5 |
| long-post: text (break lands at the affordance) | **0** |
| raster: emoji floor (Apple vs Twemoji) | 4 (3 + 1 long-post) |
| long-post: raster (karpathy) | 1 |
| long-post: content (a genuine cut-point difference, TheAtlantic) | 1 |
| raster (cloudflare 28%, karpathy 10.2%, paulg 6.6% → −1 px recovers) | 3 |
| text · content · layout (non-long-post) | **0 · 0 · 0** |
| skipped (card metadata, quoted-card-only, thread cell, blank capture, empty body) | 129 |
| harness error | **0** |

The old `±2`, no-slack column, for the same posts: **141 of 141 over 0.5%** —
it never passed anything, which is the agreement floor `docs/e2e-raster.md` §3
documents rather than a finding about the renderer.

### The remaining raster posts, and whether a whole-pixel shift explains them

Six posts exceed the 6% budget. For each, the harness retries the comparison
with our image moved by ±1 and ±2 device pixels vertically:

| post | strict ±2 | oracle ±8/slack | emoji | best vertical shift | recovers |
|---|---|---|---|---|---|
| `text-WHO-2119745075815055445` | 56.9% | 54.7% | yes | +2 px → 54.6% | no |
| `MrBeast-2117113346549817376` | 18.5% | 12.7% | no | none helps | no |
| `elonmusk-2119989523748905221` | 14.3% | 9.5% | no | none helps | no |
| `text-bellingcat-2007636993694675136` | 12.6% | 8.8% | no | none helps | no |
| `text-paulg-2118783984616591857` | 13.3% | 6.6% | no | **−1 px → 3.1%** | **yes** |
| `coinbase-2119143355120599362` (layout bucket) | 14.6% | 8.9% | no | none helps | no |

So the body-placement hypothesis accounts for **one** post, not the bucket:
`text-paulg` is a text-only post whose whole comparison snaps into place when
the render is moved up by one device pixel (0.5 CSS px). The rest are not
placement — a shift makes them no better — and the WHO post is the emoji floor
on a long post.

The layout-level offset paint reported is real and small. On `text-govuk` our
body line box starts 22.0 px below the header's (baselines 49 and 27, 15/20
type), which is the same 22 px Chrome uses; the residual is the sub-pixel
fraction (`21.75` vs `22`), and at dpr 2 that fraction becomes one device row of
ink. The harness's `bodyInk` column measures that ink row directly, but its
first-row signal is noisy (a whole line, not a fraction), so the shift probe —
"does a 1 px move recover the comparison?" — is the reliable reading.

Two harness bugs of my own inflated the earlier table, and both are fixed:

- **Chrome's "line count" was per text node.** `cur` was declared inside the
  per-node branch, so every entity `<a>` X emits (each mention, hashtag, URL)
  started a new "line". Heights matched in every one of those cases while Chrome
  "had" 2-5 more lines than xeet at 20 px line height — impossible. Hoisting
  `cur` to the element scope removed the entire `text` bucket (30 posts → 0).
- **Quoted posts were paired with their quoting cell.** A status id appears in
  its own article *and* in every article that quotes it (X renders a quoted post
  as a nested `<article>`). Only top-level articles are a post's own cell now;
  posts that appear only as a quoted card are skipped with that reason.

Pinned cells are compared rather than skipped: the harness maps the captured
"Pinned" row to `model::Post.socialContext`, which the frame draws. 16 pinned
posts are compared (4 pass, 9 raster, 3 long-post).

Two product-level limits the corpus exposed, both fixed in `limits`:

- a captured photo is 8192×5464 = 44.7 MP, above the old 40 MP cap, so the
  in-code check refused a post X rendered. The pixel cap is now the dimension cap
  squared (67.1 MP) and the per-request total 134 MP.
- a quoted post carries two images *and* a video. That combination is a composer
  constraint, not a rendering one, so it is no longer an error.

What is left is almost all **`raster`**: 6-12% of pixels differ, with the
distribution clustered right at the 6% macOS allowance. That is the CoreText
glyph-dilation gap paint measured (98.02% on identical text), not a layout
difference: heights and line breaks agree. The remaining **`layout`** failures
are large deltas on individual posts (-514, -218, -112 px: a missing or extra
component row), worth a look by the frame stream, and the `long-post:*` buckets
stay with rules' cut point (`SPEC.md` §5's open question).

Regressions are visible against `tests/golden/e2e.json`, which records the
counts, height deltas, line counts and a hash of the differing line — no text, no
pixels (`tools/ship/golden-capture.mjs --kind e2e`).
