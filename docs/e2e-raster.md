# The e2e raster bucket, classified

`node tools/ship/e2e.mjs` compares each captured post against Chrome pixel by
pixel: at dpr 2, `--tolerance 2` (a channel may differ by 2), and at most 6% of
the unmasked pixels may differ. Posts that pass the layout and text checks but
exceed the pixel budget land in the `raster` bucket. On this machine, with the
painter's baseline snap in place, a full run puts **31 of 151 compared posts**
in that bucket. The table below classifies the 27 of them that come from a
16-file re-run (the other four — `SportsCenter`, `Polygon` ×2, one more
`MrBeast` — were not re-captured).

Reproduce (`CARGO_TARGET_DIR=target/agent-paint`; the tool lives in the paint
stream's `tools/oracle/raster*.mjs` namespace):

```sh
node tools/ship/e2e.mjs --keep --json tmp/e2e/report.json
node tools/oracle/raster-e2e.mjs --json tmp/e2e/report.json --take   # re-screenshot with CoreText smoothing off
node tools/oracle/raster-e2e.mjs --json tmp/e2e/report.json          # the table below
```

The classification of the 27 posts in the table above was made from a 16-file
re-run (`--files ...`, work dir `tmp/paint-e2e/keep`); the tool takes `--dir` and
`--aa` if the harness wrote its work elsewhere.

## The classification

`e2e` is what the harness reports, at tolerance 2. `antialiased` re-screenshots
the same article with `* { -webkit-font-smoothing: antialiased !important }`,
which removes macOS CoreText dilation, and compares at tolerance 8 — the
tolerance paint's own oracle uses. `slack 1` is the same comparison where a
pixel also counts as matching when a neighbour within one pixel matches, which
absorbs sub-pixel text placement.

| post | e2e (±2) | `antialiased` (±8) | slack 1 | verdict |
|---|---|---|---|---|
| `netflix-2119935569748754642` | 72.2% | 2.5% | 1.9% | harness row not reproducible: 72.2% was measured with missing media masks; 6.6% with the masks on disk |
| `text-levelsio-2119945847009862137` | 15.6% | 15.2% | 11.8% | **harness picked a conversation article**: Chrome's capture stacks two other posts above the target text |
| `elonmusk-2119989523748905221` | 14.9% | 8.2% | 4.3% | dilation + placement |
| `text-paulg-2118783984616591857` | 13.5% | 12.7% | 6.9% | text-only post with a full 1 px placement offset; at the edge of what slack 1 absorbs |
| `text-bellingcat-2007636993694675136` | 12.8% | — | — | my re-capture was unusable (different box); the harness capture is what e2e compared |
| `gamespot-2119928147399360826` | 11.2% | 2.5% | 1.4% | dilation + placement |
| `MrBeast-2117113346549817376` | 11.1% | 10.5% | 5.5% | dilation + placement |
| `text-paulg-2119410465126432939` | 10.9% | — | — | my re-capture was unusable (different box); the harness capture is what e2e compared |
| `coinbase-2119884951982383568` | 9.6% | 1.5% | 1.1% | dilation + placement |
| `text-govuk-2119377478514819364` | 9.3% | 8.8% | 4.5% | dilation + placement |
| `coinbase-2119479038683336714` | 9.2% | 8.8% | 4.2% | dilation + placement |
| `text-ProductHunt-2119797677177147635` | 9.1% | 8.5% | 4.7% | dilation + placement |
| `text-paulg-2119051661276742141` | 8.5% | 7.9% | 4.4% | dilation + placement |
| `text-firefox-2119847213828579413` | 8.4% | 7.8% | 5.9% | dilation + placement |
| `text-paulg-2119446638708301894` | 8.4% | 7.8% | 4.0% | the harness's own Chrome capture is blank (2.9k ink against our 2.8M) |
| `text-levelsio-2119775037687259452` | 8.3% | 7.9% | 3.6% | dilation + placement |
| `poll-musk-1605372724800393216` | 8.0% | 4.2% | 2.7% | dilation + placement |
| `text-ProductHunt-2119849881405972631` | 7.8% | 2.3% | 1.7% | dilation + placement |
| `coinbase-2119864402480706004` | 7.6% | — | — | my re-capture was unusable (different box); the harness capture is what e2e compared |
| `text-engadget-2119969897614651734` | 7.3% | — | — | my re-capture was unusable (different box); the harness capture is what e2e compared |
| `netflix-2119882721740640571` | 6.9% | 3.0% | 2.4% | dilation + placement |
| `text-levelsio-2119773878222549451` | 6.8% | 6.4% | 3.2% | dilation + placement |
| `ESPN-2119977988749922630` | 6.6% | 6.2% | 3.5% | dilation + placement |
| `netflix-2119837421357400445` | 6.5% | 6.1% | 3.3% | dilation + placement |
| `YouTube-2119837423337079090` | 6.4% | — | — | my re-capture was unusable (different box); the harness capture is what e2e compared |
| `elonmusk-2119989362725396589` | 6.3% | 3.2% | 2.2% | dilation + placement |
| `ESPN-2119997839765893389` | 6.1% | 2.5% | 2.0% | dilation + placement |

20 of the 22 posts with a usable antialiased re-capture fall under the 6% budget
with dilation removed, tolerance 8 and a 1 px slack. The two that do not are the
conversation article (`text-levelsio-2119945847009862137`, 11.8%) and a
text-only post sitting exactly 1 px off (`text-paulg-2118783984616591857`,
6.9%). Five rows have no antialiased number because my re-capture of that box
was unusable; their delivered ratios are still classified by the structural
split in the paragraphs below. Nothing in the table points at the painter.

## 1. CoreText dilation is the biggest single term, and it is not ours

Chrome on macOS rasterizes through CoreText, which dilates glyphs: for the same
15 px text, total ink is **1.13×** ours as delivered and **1.001×** with
`-webkit-font-smoothing: antialiased` forced (measured on `text-govuk`, and
across dpr 1/2/8 in `docs/paint.md`). X's own stylesheet defines an
`.antialiased` utility class, but the captured post markup does not use it, so
**X's real macOS page renders dilated text**.

Which one is "X's real rendering" depends on the platform, and xeet picks the
platform-neutral one: Chrome on Linux uses FreeType, which has no dilation, and
iOS/Android have their own rasterizers. A renderer cannot match both. The
painter therefore targets the *undilated* rendering, which is why its own oracle
always renders with `--smoothing antialiased`, and why the e2e oracle should do
the same (see the recommendation below). Dilation alone costs 0–8 points of
pixel agreement on text-heavy posts.

## 2. Sub-pixel text placement costs 4–9 points at tolerance 2

> Correction (round 8, `docs/E2E.md` §"A capture that is a function of the cell"):
> part of what this section attributes to the *layout* was the harness's own
> capture. X's sticky profile bar was painted over the article whenever the page
> was scrolled, and the cell's screenshot could be clipped from a stale box and
> land on the neighbouring cell, so a cell measured 1.58%, 4.59% or 9.50%
> depending on the run. With the capture prepared (furniture hidden, the cell
> snapped to the device grid, two agreeing captures required), the whole corpus
> passes bar one cell whose screenshot never repeats. The glyph-level findings
> below — Chrome snapping baselines to whole CSS pixels, and paint's baselines
> matching it — still stand.


Even with dilation removed, text posts sit at 6–11%. A single whole-pixel
vertical shift of the comparison recovers most of it:

* `MrBeast` 11.0% → 4.5%, `text-govuk` 9.3% → 4.1%, `coinbase` 9.0% → 2.9%,
  `text-paulg` 13.1% → 4.6%, `elonmusk` 8.4% → 2.4%, `gamespot` 2.5% → 1.2%.
* Ink row profiles show the same thing directly: for `text-govuk`, Chrome's body
  line starts at device row 53 with ink counts `31 87 111 121 82 76 …`, ours at
  row 51 with `31 87 113 120 84 77 …` — the same line, one CSS pixel higher.
* The offset is in the *text*, not the content: the action-row icons move by
  half a CSS pixel while the body text moves by one.

The painter is not the cause. `raster-text.mjs` renders the same block as Chrome
at the same geometry and the two agree on the first and last ink row exactly and
on total ink mass to ±0.3% for every sample; the painter draws the baseline the
display list hands it, and now snaps it to whole CSS pixels exactly as Blink does
(`docs/paint.md` § "Baselines snap to whole CSS pixels"). The remaining
half-to-one-pixel difference is produced before the display list exists: the
line boxes `inline`/`frame` build for a post put the body text 0.25–0.5 px above
where Chrome's own layout puts it (for `text-govuk`: Chrome's name row is at 0
and its body element at 22, ours computes the body line box at 21.75), and
because Chrome snaps baselines to whole CSS pixels, a quarter pixel of metric
difference becomes a whole pixel of ink.

At tolerance 2 every glyph edge pixel is a "difference", so a half-pixel offset
on a text-heavy post costs 5–9% — more than the whole 6% budget.

## 3. Tolerance 2 is below the rasterizer agreement floor

The text oracle compares our render against Chrome with antialiasing forced, for
identical text at identical geometry — the best case that exists. The share of
pixels within tolerance:

| tolerance | within |
|---|---|
| 2 | 95.62% |
| 4 | 96.51% |
| 8 | 97.88% |
| 16 | 99.01% |

So even a *perfect* renderer produces 4.4% "differing" pixels at tolerance 2 on
text, twice today's 2.1% at tolerance 8. Two different rasterizers (CoreText vs
a Skia port) cannot agree to ±2/255 on every coveraged pixel of a glyph edge.

## 4. Harness artifacts found along the way

* **Blank or offset captures.** `text-paulg-2119446638708301894` (the harness's
  own `chrome.png` has 2.9k ink where ours has 2.8M), and in my re-capture run
  `text-ProductHunt-2119797677177147635`, `text-paulg-2119410465126432939` and
  `ESPN-2119997839765893389`. `locator.screenshot()` occasionally clips a region
  with no content; a cheap guard is to skip a post whose Chrome capture has less
  than half our ink in the unmasked area.
* **Stale masks.** `netflix-2119935569748754642` is reported at 72.2%, but with
  the `masks.json` written next to it the same artifacts measure 6.6%. That
  row's media rects were missing when the screenshot was taken.
* **Thread articles.** `text-levelsio-2119945847009862137`: Chrome's capture
  contains two other posts, ours contains the one post, and the heights happen to
  match. The harness already skips articles whose text starts with "Pinned" or
  "Replying to"; this one starts with a video cell.
* **Emoji.** Chrome draws Apple's emoji, we draw Twemoji (Apple's font cannot be
  shipped). Any post containing an emoji carries a permanent ~0.5–1.5% pixel
  difference in the emoji's box; `YouTube-2119837423337079090` has a 💛.

## What the painter changed

One correctness fix: glyph baselines are snapped to whole CSS pixels, matching
Blink. A quarter of the glyph runs in the corpus (13 px action counts and
timestamps) had `.5` baselines. Over the raster posts it moved 16 ratios down and
2 up, mean 10.19% → 10.15% — correct, but not a bucket-changer: the placement
difference in §2 dominates it.

## Recommendation for the e2e oracle (ship)

1. Screenshot the comparison page with `* { -webkit-font-smoothing: antialiased
   !important }` injected, the same adjustment the harness already makes by
   revealing the hidden timeline. That removes the macOS-only dilation and makes
   the oracle test the renderer instead of the platform's font backend.
2. Use `--tolerance 8`, matching `raster-*.mjs`; keep the 6% budget.
3. Allow a one-pixel neighbourhood (`slack 1`): count a pixel as matching when
   any pixel within 1 px of it matches within tolerance. This absorbs the
   half-pixel text placement of §2 and still catches missing or misplaced
   components, which are much wider than a pixel.
4. Skip posts whose Chrome capture is blank (ink < 50% of ours in the unmasked
   area), and posts whose article wraps more than one cell.
5. Emoji: either mask the emoji boxes or expect a fixed 0.5–1.5% floor on posts
   that contain them.

Measured on the posts of the table that have a usable antialiased capture: **20
of 22 land under the 6% budget** with (1), (2) and (3) — the two that stay over
are the conversation article (11.8%) and the 1 px-off text post (6.9%).
Without `slack 1`, `text-govuk` (8.8%), `MrBeast` (10.5%) and `text-firefox`
(7.8%) stay over too, because Chrome's baseline snap turns a quarter pixel of
line-box difference into a whole pixel of ink.

## Round 9: the 0.5% gate, and why macOS cannot reach it

The green percentage above is a parity gate against Chrome **on this machine**.
Tightening it to 0.5% (`--max-pixel-diff 0.005`, §12's Linux-style target) was
tried after the painter's rasterizer was replaced with exact-area coverage, and
the measured answer is no: **5 of 158 compared posts pass 0.5%**
(min 0.366%, p50 1.413%, p90 1.971%, max 2.809%; 39 posts are under 1%).

The reason is not the painter. Chrome on macOS rasterizes text through CoreText,
and that mask is *not* analytic area coverage. Rendered at dpr 4 and downsampled
2×2 — which is what exact-area coverage looks like at dpr 2 — Chrome's own dpr-2
text differs from itself by **mean 11.9 levels, 30.4% of edge pixels more than
8, max 226** (`tmp/dpr-test.mjs` on `text-paulg-2118783984616591857`). In other
words the reference's own antialiasing moves by more than the ±8/255 the gate
allows merely by being rendered at a different resolution. Two consequences:

* For a *perfect* analytic rasterizer the floor is that 30%, not 0.5%. Our
  painter sits at 32–48% of edge pixels over ±8 depending on the post — i.e. it is
  within about 1.2× of the reference's own self-disagreement, and the rest is the
  AA model, not the geometry. Positions are exact (per-line and per-window
  sub-pixel cross-correlation finds 0.00 px on every line), ink mass agrees to
  0.4%, and the implied coverage→value gamma is 1.0 (0.93–1.0 across the range),
  so there is no gamma or colour bug to fix.
* Emoji are a separate, unavoidable floor: X draws Apple Color Emoji and xeet
  ships Twemoji, so the 51 posts with emoji in the body cannot reach any
  pixel gate below the artwork difference (0.5–1.5% of the cell).

Blurring our masks to imitate a softer rasterizer was measured too
(`tmp/blur-fit.mjs`): every blur radius made the comparison worse, so the
difference is not softness.

What the comparison *can* do is compare two renderers of the same platform-neutral
target — the Linux Chrome gate — which is why the authoritative raster
numbers stay with `tools/oracle/raster*.mjs` (`--smooth antialiased`, ±8, zero
pixels away from glyph edges) rather than with the e2e corpus on macOS.

