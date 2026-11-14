# The Chrome target (ground truth) for the playground

`tools/playground/lib/chrome.mjs` renders a `model::Post` the way x.com would,
with X's own markup, stylesheet and fonts in a warm headless Chrome. It is the
`chrome` column of the playground (`docs/PLAYGROUND.md`): the reference the other
targets are diffed against. Development only; nothing here ships.

```
node tools/playground/test/oracle-parity.mjs      # replica vs the captured page, 20 posts
node tools/playground/test/oracle-fixtures.mjs    # every shape × theme × width, + pixel audit
node tools/playground/test/oracle-stamps.mjs      # the timestamp port vs xeet's own literals
node tools/playground/test/oracle-timings.mjs     # latency table + concurrency guarantees
node tools/playground/test/oracle-media.mjs       # real pictures in both modes, and stubs where there are none
```

## API

```js
import { createChrome } from "./lib/chrome.mjs";

const chrome = await createChrome();            // ~260 ms: Chrome, templates, nothing else
const shot = await chrome.render({ post, options, mode = "replica", source, report, signal });
await chrome.close();

// Page mode's pictures: cache-only, or one throttled fetch per missing asset.
await createChrome({ media: { fetchOnMiss: false, warm: false } });
```

`shot` is `{ png, width, height, dpr, geometry: { boxes, lines, texts }, ms:
{ total, paint, fetch, load, layout, screenshot }, version: { chromium, upstream,
harness, ruleset, decisions, smoothing }, notes, frame: { padding, background } }`.

**`ms.paint` is the render time**, and it is the number to show: the Chrome DOM
update and layout plus the raster, taken *after* every byte is in memory and
decoded. The other waits are reported beside it, never inside it:

| field | what it measures |
|---|---|
| `paint` | `layout + screenshot` — writing the cell's DOM, laying it out, rasterizing it |
| `layout` | the DOM write and the measurement passes (`applyPlan`, page-mode framing, `measureCell`) |
| `screenshot` | the raster and PNG encode |
| `fetch` | network/asset prefetch: page mode's `media.prefetch` and the reload it causes |
| `load` | navigation (a page opening or reloading) and every `fonts.ready` / `img.decode()` settle |
| `total` | the wall clock of the whole call: the rules decision, the queue, `fetch`, `load` and `paint` |

So on a cold page-mode render `total` can be seconds while `paint` stays a few
hundred milliseconds: six pictures fetched from `pbs.twimg.com` into an empty
cache cost `fetch` 5.3 s, `load` 0.7 s and `paint` 0.34 s (`total` 6.3 s) —
`oracle-media.mjs`'s `page:prefetch-is-not-paint` row asserts exactly that
(`paint > 0`, `paint < total`, `paint + fetch ≤ total`). `options` is
`RenderOptions` (`surface`, `width`, `theme`, `dpr`, `fontScale`) plus one
Chrome-only setting, `smoothing` (below); `surface` accepts
`web-timeline`/`web-detail` or `timeline`/`detail`. Every box carries `x, y, w,
h` and its computed corner `radius`.

Failures reject with an `Error`. Two `code`s are meaningful to a caller:
`"superseded"` (a newer render for the same page arrived while this one was
queued), `"nested_only"` (the post only exists as a quoted card on that page) and
`"not_found"`/`"not_framed"` in page mode (the page has no such id, or the cell
could not be framed at the requested width).

## The frame: the cell, not the article

xeet's display list is the whole post cell: `min(width, 600)` wide including X's
16 px horizontal and 12 px vertical padding. Both modes therefore screenshot the
**padded cell** and report every box relative to its border box, on Chrome's
1/64 px grid. Chrome's cell carries a 1 px bottom divider that xeet never draws,
so the harness sets it to `0` before measuring — the same adjustment
`tools/ship/e2e.mjs` makes from the other side, where it compares
`article.width + 32`.

## Replica mode

X's server-rendered components, captured in `assets/vendor/corpus/`, with the
post's data injected. Nothing is written from scratch: `chrome-markup.mjs` names
one captured post per component and patches it, and every patch goes through
`swap()`, which **throws unless its pattern matches exactly once** — a change in
X's markup fails loudly instead of producing a replica that is quietly not X's.

| template | source | supplies |
|---|---|---|
| `cell.timeline` | `IGN.html` art 1 | the timeline cell: avatar column, header, body, action row |
| `cell.detail` | `poll-musk.html` art 0 | the detail cell (`text-lead`, full timestamp row, `N Views`) |
| `slot.media1` | `text-OurWorldInData.html` art 1 | one photo: ratio box, `View media` overlay, ALT badge |
| `slot.video` | `github.html` art 2 | one video: poster, play control, duration pill |
| `slot.carousel` | `NASA.html` art 0 | the image carousel, one cell per image |
| `slot.cardLarge` | `nytimes.html` art 0 | `summary_large_image`: 1.91 image, title bar, `From domain` |
| `slot.quoteFull` | `XDevelopers.html` art 3 | a quoted post, full form (24 px avatar, media below text) |
| `slot.quoteCompact` | `NBA.html` art 0 | a quoted post, compact form (16 px avatar, 96 px thumb) |
| `slot.quoteCarousel` | `MrBeast.html` #2117003477079761397 | a quoted card whose media is a carousel |
| `slot.poll` | `poll-musk.html` art 0 | the poll result list and its footer |
| `fragments.*` | see the file | `Show more`, `Pinned`, affiliation, duration/GIF pills, `Replying to`, tag line |

The detail skeleton is a post *page* with a poll because a detail cell only
carries an attachment slot when its post has one: that capture is the only place
X shows where the slot goes (between the body and the timestamp row) and how it
is wrapped.

**What is ours, not X's.** Two things: the text and numbers injected into those
components, and the sizes X's server computes on the client's behalf —
`aspect-ratio`, the 510 px height cap (`max-width: 510 × ar`), and the
carousel's `padding-bottom`. Those come from the client bundle's formulas,
ported in `carouselLayout()`; its seven documented cases reproduce X's
`padding-bottom` exactly (see the table in
`crates/xeet-core/src/cards/media.rs`). Everything else — spacing, radii,
colors, the grid, the fonts — is X's own CSS applied to X's own elements.

### The quoted post's body goes through the same rules

A quoted card's text is decided by `xeet-render explain` exactly as the cell's is
— `report.text.visible`, `report.hidden`, the entity display forms — rather than
by substituting entity displays by hand. The distinction is not academic: the
converter does not always apply a payload's `display_text_range`, so
`/api/resolve` hands the playground a quoted body that still ends with the quoted
post's own media link:

```
Jimmy Butler III is wearing the same outfit as the @warriors coaches with his own clipboard 🤣📋 https://t.co/1FQn6XU9rz
```

The rules answer `hidden: [{range: [96, 120], why: "trailing URL replaced by
attached media"}]` and a `visible` without it — and the hidden range starts at the
*space*, so the body ends `🤣📋` with no ellipsis and no gap, which is what X's
capture prints (`<span …> coaches with his own clipboard 🤣📋</span>`). Drawing the
entity's display form instead gave `🤣📋 t.co/1FQn6XU9rz`, with the space the
hidden range exists to swallow, and a card one line taller.

It is the **`web-detail`** decision, not the timeline one. A card prints the post's
server-cut body, while the timeline report answers a *cell's* question — `text`,
cut with an inline "Show more". The difference is visible on a quote whose payload
carries both forms: `text-ProductHunt`'s quoted post has `text` 400 characters and
a 280-character body, the captured card prints 280, the detail report answers 280
and the timeline report 400 (`text-stripe`: 412 against 273, same story). Across
every corpus post that quotes another — 25 of them, 23 render — the detail
report's `visible` equals the captured card's text; the two it cannot check are a
quote of a quoted post (the engine rejects it) and a quoted *article*, whose card
is not the text component at all.

The fixture row `quote:visible-text` renders
`x.com/NBA/status/2120019063476785477` with the payload's untrimmed text and
compares the replica's quote body to the captured copy character for character
(the row also refuses to pass if the payload no longer ends with a `t.co`, so it
cannot go quiet).

### A quote of a quote: X's nested preview

When the quoted post itself quotes another, X draws a small preview inside the
quote card (`nested-quote-preview-SIs_tkfq` in
`assets/vendor/upstream/js/dfWSwB9n.js`). The replica draws it from that module's
own markup and gate:

- **The gate is `H(outer, quoted, nested)`**, mapped onto the model: the outer
  post is not a reply (`replyTo`); no self-quote — X compares user ids, the model
  has handles, so `outer ≠ quoted` and `quoted ≠ nested` by handle; the nested
  post has no card and no unknown media kind (`ie`); and at most **one** of the
  three levels renders media of its own — `[L(outer), z(quoted), I(nested)]`. The
  subtlety: `L(outer)` is about the outer post's *own* media/card/poll, not about
  the fact that it quotes something, so a post that only quotes has
  `rendersMedia === false`. Every corpus page that carries a nested payload in
  its response (five of them: `NBA`, `binance`, `elonmusk`, `text-karpathy`,
  `text-levelsio`) fails the gate — two media levels, or a self-quote — which is
  exactly why X's captured HTML shows no preview there, and the replica draws
  none either (`nested:page-vs-replica` compares the two on `elonmusk`'s
  SawyerMerritt → SERobinsonJr case: two media levels, so no preview on either
  side, same height to 1/64 px).
- **The block is `ve`'s**: the `-mx-1.5 -my-1 rounded-[9px] px-1.5 py-1` hit
  wrapper over the `fe` frame's classes, the `<span class="sr-only">Quote</span>`,
  the `bg-tertiary w-[3px] shrink-0 rounded-full` spine, the
  `flex min-w-0 flex-1 flex-col gap-2 py-1 ps-3` column, the 64 px
  `border-normal bg-secondary relative size-16 shrink-0 overflow-hidden
  rounded-sm border` thumbnail with its `+N` (`bg-black/40`) and play
  (`size-6 rounded-full bg-black/60` + `icon-player-play`, `size-3.5`) overlays,
  and the `text-subtext1 line-clamp-2 whitespace-pre-wrap wrap-anywhere` body.
  It is the quoted `<article>`'s **last child**, after the quoted post's media,
  inside X's own conditional wrapper (`A_` in `DtaLJItK.js`):

  ```html
  <div class="p-3 [:first-child+&]:pt-0">{children}</div>
  ```

  The wrapper's top padding is the interesting part: it is the sibling right
  after the `p-3` header+text block, so when the quoted post draws nothing in
  between (no media) the selector matches and `pt` is **0**; when the quoted post
  draws media — the capture's media box is the article's second child, exactly as
  in the client — the wrapper is the *third* child, the selector does not match,
  and the full **12 px** separates the flush media from the preview. The replica
  relies on the selector itself, not a computed class: measured 0 px on
  `nested:text` and 12 px on `nested:q1-photo-q2-text`, asserted by the rows.
- **What is derived, and why**: the header row is `ce`/`ge`/`w.r`/`w.t`/`f.s` in
  the module — hashed design-system exports (`eT`/`oM` from `ZmTPkOMI.js`, `M_`
  from `user-name-MWOay3Xo`, `EH` from `condensed-media-bWilVP1J`) whose rendered
  class lists do not resolve inside the vendored bundle. The header is built from
  X's *captured* quote-card header instead (the same components on the server:
  `x-middot-group`, the name + badge row, `@handle`, the
  `inline-flex w-fit shrink-0 whitespace-nowrap` timestamp) at the preview's own
  sizes: a `size-4` avatar (the module's `size: "xs"`), the **`text-body`**
  middot group (15/20 — the header's line box is 20 px, as on x.com), and only the
  clamped body at `text-subtext1` (14/16).
- **The rules take the whole post** (`max_quote_depth = 2` in `limits.rs`): the
  outer post's report is what the cell needs, and the preview is the harness's.
  A build older than that refuses the post ("is a quote of a quote; X shows only
  one level"), so the render retries without the nested level and says so in
  `notes` instead of failing.
- **The quoted post's trailing link to the nested post is hidden.** The rules do
  the status-URL case themselves — measured on a quoted post whose text ends with
  `https://x.com/nested/status/…`: `hidden: [{range: [12, 60], why: "trailing URL
  replaced by the quoted post"}], visible: "Look at this"`. A `t.co` is opaque to
  them (they keep it: `visible: "… t.co/AbCdEf1234"`), and on a post that quotes
  another it *is* that permalink, so the harness trims it (whitespace included)
  and notes it.
- **Harness seams**: `data-xeet-nested`, `data-xeet-nested-thumb` and
  `data-xeet-nested-stamp` mark the block for `geometry.boxes` (`nestedQuote`,
  `nestedThumb`, `nestedStamp`, `nestedText`). They are attributes only; X's
  classes, and therefore every painted pixel, are untouched. The same labels also
  find a preview on a captured page, which is how the page-vs-replica gate row
  works.

### Timestamps come from the post, never from a clock

The replica formats `post.createdAt`/`post.now` itself, with a port of xeet's
`frame::time::{label, relative, full}` (which is X's `__xClientTextFormatters` at
`precision: "Hours"`, `nowLabel: "Now"`):

| input | surface | label |
|---|---|---|
| `2026-11-10T17:04:00.000Z` | detail | `5:04 PM · Nov 10, 2026` |
| `2026-11-10T17:04:00.000-05:00` | detail | `5:04 PM · Nov 10, 2026` — the string's own offset is the display zone |
| absent, or unparseable | detail **and** timeline | `Now` |
| 3 h before `now` | timeline | `3h` |
| 2 days before `now`, same year | timeline | `Nov 8` |
| 400 days before `now` | timeline | `Nov 9, 2025` |
| absent `now`, or `now` ≤ `createdAt` | timeline | `Now` |

xeet has no clock, so the replica must not have one either: it used to call
`Date.now()` for the detail surface's fallback, and a post with no `createdAt`
read "5:04 PM · Nov 10, 2026" in one column and "Now" in the other. The calendar
branch ("Nov 9" vs "Nov 8") is decided in the post's offset, as xeet shifts both
instants into the display zone before asking which day it was.

**A quoted card's label is the quoted post's instant and the post's clock.** The
quote is a nested `Post`, so it carries its own `createdAt` — but `now` is the
render clock, passed once on the outer post (`/api/resolve` and the UI never put
one on a quoted post). Reading `quote.now` therefore found `undefined` for every
real quote, `frame::time::relative` answered "Now" for all of them, and three
different `createdAt` values produced byte-identical PNGs. `quoteMarkup` now takes
the clock from `attachmentMarkup` (`post.now ?? quote.now`), so the label is
`stampLabel(quote.createdAt, post.now)`:

| quoted `createdAt` (`now` = `2026-11-10T18:12:00Z`) | label |
|---|---|
| `2026-11-05T02:12:00Z` | `Nov 5` |
| `2026-11-04T18:12:00-08:00` | `Nov 4` — a different day for the same UTC hour band |
| `2026-11-05T11:12:00+09:00` | `Nov 5` — the same instant as the first row, so the same label and the same pixels |
| `2026-11-10T15:12:00Z` | `3h` |
| no `now` anywhere | `Now` |

`stamp:quote-*` in `oracle-fixtures.mjs` asserts the labels for those four
strings, `quote:stamp-pixels` asserts that the two days and the relative case
render *different* images (and that the same instant renders the same one), and
the pure port cases live in `oracle-stamps.mjs`. The earlier `stamp:quote` row
passed only because it supplied `quote.now` itself; it no longer does.

### Media embedded from another account ("Post video" / "Post photo")

When a post plays someone else's clip or shows someone else's photo, X credits
them inside the media — `media[].sourceAuthor` in the model (X's
`source_user_results`):

- **a video** gets the credit appended to its duration pill, right after the
  clock: a 13 px avatar, the name in white and the verification icon, inside
  `<span class="inline-flex min-w-0 items-center gap-1 align-middle ms-2">`
  (`ESPN.html`'s post `2120005259485425936`, which embeds `@NFL`'s clip, carries
  exactly that);
- **a photo** gets X's bottom-left pill —
  `pointer-events-none absolute z-20 flex bottom-3 start-3` >
  `span.text-subtext2 … rounded-[6px] bg-black/70 py-1 ps-1 pe-2` — inside the
  photo box, in the corner the ALT badge occupies (the badge is dropped when the
  credit is drawn, as X shows one or the other). A carousel cell with an
  attributed photo gets the same pill in its own corner.

Nothing is drawn when the source is the post's own author (`@ESPN` embedding
`@ESPN`'s clip) or when the source has neither a name nor a handle. The pill is
in the flow of the duration badge, so it can widen that pill but never change the
cell's height — `media-source:page-vs-replica` measures the capture and the
replica on the ESPN post: same height, and the credit's box is identical to the
last 1/64 px (`x 131.97, y 368.5, 57.34 × 16` on both sides).

`data-xeet-media-source` marks the credit for `geometry.boxes.mediaSource`; the
same label finds it on a captured page (`span.inline-flex.align-middle.ms-2`).

### Bytes beat stubs

Wherever the model carries image bytes, the replica injects them instead of a
placeholder: `media[].data`, `author.avatar`, `author.affiliate.badge` and
`links[url].image.data` (the link resolver's card picture), in both card shapes
(`summary_large_image` and `summary`). A `srcset` on the captured element is
removed, since it would win over the injected `src`. Only a payload without bytes
gets a labelled box (or, for an avatar, X's default profile image).

A quoted post's media goes through the same rule. Its full form is a *photo* box
in the capture, so a quoted video or GIF gets X's play control (or `GIF` pill) and
duration badge inserted from the captured video fragments — the centred control,
not the full-size hit area around it, which also holds a badge and would draw a
second one.

### The sprite is moved, never copied

X serves one zero-sized `<svg>` full of `<symbol>`s, and the two fills of the
**gold** business badge are gradients whose `<defs>` live *inside* the symbol
(`fill="url(#icon-verified-business-color_a)"`). The premium and government
checks are flat fills (`#1d9bf0`, `#829aab`), so only the gold one exposes the
mistake: copying the symbols into a fresh container leaves the originals — and
the only `<defs>` — in the hidden part of the page and duplicates every id, the
`url(#…)` resolves to nothing, and the badge paints just its solid inner check.
That is a thin gold tick covering 0.04 of the badge's box instead of 0.46.
`initReplica` therefore **moves X's own sprite element** (clipping it with X's
own `absolute size-0 overflow-hidden` classes) and hides everything else.

### Avatars

The author's picture is the post's own bytes when it has them, and **X's real
default profile image** when it does not:
`assets/vendor/default-avatar.png` (vendored by `tools/sync-upstream.mjs`, pinned
in `upstream.lock.json` as `defaultAvatar`), served to the page at
`https://x.com/__xeet/default-avatar.png` so the `<img>` is an ordinary request
with real pixels. Page mode answers X's own
`…/default_profile_images/default_profile_…` URLs with the same bytes, so a
captured post by an account that never set an avatar draws the same picture;
every other avatar stays stubbed, like every image in a hermetic page.

The avatar's **shape is the model's `squareAvatar`** and nothing else: X uses
`rounded-full` (9999 px) or `rounded-[10%]`, and a skeleton captured from a
business account must not make a round-avatar account square. Never infer it
from the badge. Quoted posts take the same path for both picture and shape.

Warm pages are keyed by `(mode, surface, theme, dpr)`; the viewport width is set
per render, so a width change re-runs the media queries (X switches at 512, 768
and 1024 px) without a reload. A render rebuilds the cell from the skeleton,
injects the data, waits for fonts, then measures and screenshots in one pass.

## Where the decisions come from

Only layout and paint are being compared, so the replica must make the same
choices xeet makes — which body is displayed, which ranges are hidden, whether
the long-post cut applies, which attachment is drawn. Those come from xeet, in
this order, and `version.decisions` says which one answered:

1. `report` passed by the caller. `/api/render` should forward the **native
   target's `explain`**, so the Chrome column sees exactly what the native
   column saw.
2. A built `xeet-render explain` (newest `target/` profile, `target/playground/`
   first, or `XEET_EXPLAIN_BIN`). One process per render, ~7 ms including
   start-up: `version.decisions = "binary"`.
3. The in-process wasm build in `packages/xeet/` (`version.decisions = "wasm"`),
   which is what the `http` target runs. The committed build can lag the model
   by a field — as of this writing it rejects `appVersion`, which is why the
   binary is tried first; when it refuses a field the walk retries without it
   and says so (`"wasm-stale"`).
4. A JS fallback that is *not* the rules engine: the payload's text, a reply's
   leading mentions hidden, X's attachment priority. `"fallback"` marks results
   whose decisions are approximate, so a diff is never read as truth.

A quoted post's body is its whole text (a quoted card never truncates inline;
its `line-clamp-5` is CSS in the captured markup), with entity display forms.

## Smoothing

`options.smoothing` selects the glyph rasterization, in **both** modes:

- `"antialiased"` (default) forces `-webkit-font-smoothing: antialiased`, the
  platform-neutral reference the gates compare against (`docs/e2e-raster.md`
  §1: macOS CoreText dilates glyphs 1.13×, so a Mac's own rendering is not the
  target).
- `"platform"` leaves the page as Chrome draws it, which is what a Mac user sees
  on x.com.

It changes ink only, never metrics, so one warm page serves both: the style is
toggled in place and only when the setting changes, and `version.smoothing`
reports what a render used. Replica mode used to render with platform smoothing
while page mode forced antialiased — the same post could look bolder in one
column than the other for a reason that was not xeet's.

## Page mode

`source: { page, id }` (or `{ page, url }`): a captured page under
`assets/vendor/playground/` or `assets/vendor/corpus/`, rendered hermetically,
its post's own cell found by permalink, cropped and measured.

The pairing rule is `docs/E2E.md`'s: a status id appears in its own cell, in
every cell that quotes it, and in invisible overlay links, so the cell is the
top-level article whose **own** first status link (with text of its own — the
header timestamp) is that id. Marks from the previous post are cleared first;
without that, two marked cells left `querySelector` returning the first one and
three of the twenty parity rows compared the wrong post.

Three adjustments to the page, all of them the harness changing what it compares
against rather than the renderer:

- **Reveal.** X's server render hides the timeline list (`display: none`) until
  its client code runs, and every script is blocked. It happens once, when the
  page opens, and the fonts are awaited after it: revealing and framing in one
  pass left `<main>` at 0×0 on a cold page, which measured as an empty cell.
- **Frame.** The cell must *be* the frame, so: every element off the cell's
  ancestor chain is hidden (nav rail, sticky header, modals — and the other
  posts), the ancestors' own horizontal chrome is zeroed (a 1 px divider between
  nav and column put the cell at x=1, one pixel short of the viewport), the
  column is set to `min(width, 600)`, and the cell is scrolled to the origin
  with scrolling forced instant (X's stylesheet has `scroll-smooth` utilities).
  The SVG sprite is exempt from the hiding: a `<use>`d gradient whose `<defs>`
  live inside a `display: none` subtree stops resolving and the gold badge loses
  its scalloped fill. Hidden elements are remembered and restored at the start of
  the next render, because a page is reused for one post after another.
- **Smoothing** follows `options.smoothing`, exactly as in replica mode (above).

The crop is then taken from the cell's own box. Two guards keep it honest: the
frame step fails loudly if the cell is not at the origin with the requested width
(`code: "not_framed"`), and the capture re-measures afterwards and re-captures if
the cell moved in between (`verify`), re-framing first if it collapsed to nothing.
Before those, one run in ten produced a PNG of the wrong region — the pixel audit
caught it as a badge box that sampled background.

The cropped cell also gets `border-bottom-width: 0`, as in replica mode.

### The page's pictures

A captured page asks `pbs.twimg.com` for everything it draws: the posts'
photographs, video poster frames, avatars, verification badges, card images. All
of those requests are answered from bytes we already have, by a route registered
over `browser.mjs`'s stub-all-images policy:

1. `source.media` — `/api/resolve`'s `{url: {file, bytes, width, height,
   variant}}` map, registered on **every** render (a warm page must answer the
   latest resolver, and the same capture can come back with different inlined
   media).
2. the media cache in `assets/vendor/playground/media/`, keyed `sha256(url)` —
   the files `resolve.mjs` already downloaded, so a URL resolved for the native
   column is free for the page column.
3. on a miss, **one** fetch per asset, through `tools/playground/lib/links.mjs`'s
   `fetchImageAsset` — the same call `/api/resolve` makes, so the host
   allow-list, the robots check, the byte cap, the per-host politeness gap (one
   request a second, chained per host) and the LRU-evicted cache are the
   resolver's, not a copy of them, and the gap is shared process-wide.
4. X's vendored default profile image for its `default_profile_images` URLs.
5. the transparent stub, as before. A missing picture never fails a render.

Lookups go through an *asset key* — host + path with the query and the extension
removed, profile-image size suffixes folded — because a page asks for
`…/media/ABC?format=webp&name=large` while an older resolve cached
`…/media/ABC.jpg`. If the request's own URL misses, the query-less `.jpg` path is
tried: X serves the path at `.jpg`/`.png` and the encoding through the query, and
`/media/ABC.webp` is a 404 (measured — three of those in a row disabled the
store's fetching before this was fixed). Fetches are made against the URL the
page asked for, which is the variant the resolver inlined for the same slot.

**Fetching is not on the load path.** A document load answers from cache or a
stub, so a page with twenty posts' avatars cannot take twenty network timeouts.
Once the cell is framed, `warmCellMedia` reads the *cell's own* images (`src`,
`currentSrc`, `video[poster]`), fetches what is missing — bounded to ten, one at
a time — and reloads the page **once** if anything arrived. A cold cell therefore
costs one extra load; every later render of it is a cache hit (`+0` fetches on a
warm page, 138 ms). The store also has a circuit breaker: three consecutive
network failures disable fetching for the session, so a laptop with no route to X
degrades to stubs instead of spending a timeout per image.

Videos paint their **poster**, plus X's own play control and duration badge,
because that is the markup X serves: a `<video poster>` with no `src` (video
files are aborted) so the frame is the poster state and nothing plays. Both the
poster and `<img>`s inside the cell are decoded before the screenshot — a
`<video poster>` is an attribute, not an `document.images` entry — and every
`<img>` in the cell is switched to `loading="eager"` first: a lazy image below
the fold never starts, and its `decode()` then waits forever, which is exactly
how the first version of this hung a render.

One layering note, and it is the reason the replica raises a badge: in X's server
render the duration badge is `z-1` and the overlay holding the poster copy is
`z-10`, so the badge is laid out but covered. The replica draws what the client
shows (and what xeet's display list draws — `bottom_badge` in
`cards/media.rs`), so the replica's badge wrapper is `z-20`.

## Concurrency

Renders are serialized per page. A render that is still **queued** when a newer
one for the same page arrives is dropped and rejects with `code: "superseded"`:
with one debounced keystroke after another, the older frame is already stale and
would otherwise add a full render's latency. An `AbortSignal` is honoured while
queued. A page or context that died under a render is rebuilt and the render
retried once; a page that throws for any other reason is dropped and recreated
on the next call.

## What the tests show (2026-11-10, this machine)

```
node tools/playground/test/oracle-parity.mjs --n 20
  18/18 posts agree — height and boxes within 1/64 px, same line breaks
  (2 skipped: the post only appears as a quoted card on its page)

node tools/playground/test/oracle-stamps.mjs
  39/39 timestamp cases match xeet's frame::time literals (parse, relative
  ladder, full form, offsets, a quoted post's five clock cases, and "Now" when
  the post carries no clock)

node tools/playground/test/oracle-media.mjs
  40/40 rows show real pictures where the model has bytes, and flat
  placeholders where it does not (11 shapes × 2 themes with generated bytes,
  the same 11 without, page mode's own cell at 390/951, a video post's page,
  `source.media`, a warm page, and a cache-only page)

node tools/playground/test/oracle-fixtures.mjs
  307/307 renders satisfy the frame contract (27 shapes × 2 themes ×
  320/382/390/600, the iPhone Duo at 382/669/951 dpr 3 in both modes, page
  mode, dpr 1/3, the nested-preview rows, the media-attribution rows, the
  quoted-body and quoted-clock rows, and the pixel audit)

node tools/playground/test/oracle-timings.mjs --runs 20
  series                    cold    paint   fetch  load   total p50  total p95  layout  shot
  replica text, light dpr2  326.7   48.2    0      10.8   67.3       87.3       7.4     41.1
  replica text, dark dpr2   336.5   45.7    0      12.5   66.6       68.4       6.4     39.2
  replica text, detail dpr2 295.2   52.9    0      5.3    66.5       70.1       6.1     46.8
  replica media-4 dpr2       78.6   62.6    0      11.5   82.8       86.5       6.4     55.9
  replica page mode         857.1   246.1   0      1.4    247.5      268.8      15.4    230.7
  paint across 100 warm renders: p50 54.2 ms, p95 255.5 ms
  concurrency: 2 fulfilled, 3 superseded, 0 failed; abort → "aborted";
  a killed page is rebuilt and the render retried (same height)

Every render is asserted to carry a finite `ms.paint > 0` ≤ `ms.total`, and the
*replica* series are held to the 300 ms budget on **paint** as well as on total.
```

That run is on an **idle** machine (load average 3.7): page mode's 117 ms p50 is
`screenshot` (110 ms), Chrome rasterizing X's own document at dpr 2. On a machine
busy with other agents' builds (load average 20–100) the same capture takes
310–350 ms, and it is the same 306–336 ms *with the cell's pictures replaced by
stubs*, so the time is Chrome's raster of X's page, not our images. Page mode
therefore has its own budget in `oracle-timings.mjs` (600 ms, `--page-budget`)
while the replica series keep 300 ms — the target is about the interactive path.
Shrinking the viewport below the cell would make the capture cheaper (480 px →
250 ms under load) and changes it (509 KB vs 632 KB), so that is not a fix.

Those numbers are from a machine with a **load average of 30–100** (other agents
building), which is 2–12× the same work's idle cost: on an idle machine the same
series measured warm p50 33–67 ms, p95 ≤ 108 ms, with `layout` 3 ms and
`screenshot` 27 ms. Under load the p95 still fits the 300 ms budget; single
outliers are the machine, not the render (their `layout` is 14–25 ms against 3 ms
idle). The cold column is the page load the server pays once per
`(surface, theme, dpr)`.

### The pixel audit

Defects the *geometry* could not see — a badge drawn with a missing gradient, an
invented avatar, font smoothing, a timestamp from the wrong clock, a card picture
that stayed a stub — are checked at the end of `oracle-fixtures.mjs` by decoding
the rendered PNG and reading the box the geometry reported:

| row | what it asserts | measured |
|---|---|---|
| `badge:business` / `blue` / `government` | the badge paints, not just its outline | ink 0.46 / 0.53 / 0.45 of the box (a gradient-less gold badge: **0.04**) |
| `badge:page-vs-replica` | `IGN.html`'s business-verified cell, page against replica | 0.46 vs 0.46 |
| `badge:none` | no badge box for an unverified author | — |
| `avatar:default-round` | business-verified but `squareAvatar` unset → round | radius `9999px` |
| `avatar:square` | `squareAvatar: true` → X's 10% square | radius `10%` |
| `avatar:quote-default` | a quoted post with no bytes gets the same picture | 24×24, painted |
| `smoothing` | `platform` is heavier than `antialiased`, same height, toggles back to identical pixels | text ink 56.9 vs 48.8 per px (macOS CoreText) |
| `stamp:*` (13 rows) | the cell prints the label the post's own ISO strings imply, and nothing else | `5:04 PM · Nov 10, 2026`, `Now`, `3h`, `2m`, `45s`, `Nov 8`, `Nov 9, 2025` |
| `stamp:quote` | the quoted card prints the *quoted* post's label, from the post's `now` | cell `1h`, quote `Nov 5` |
| `stamp:quote-utc` / `-pacific` / `-tokyo` / `-relative` | the quote's clock is the post's, read in the quote's own offset | `Nov 5` / `Nov 4` / `Nov 5` / `3h` |
| `quote:stamp-pixels` | a quote's `createdAt` reaches the pixels: different days draw different images, the same instant the same one | 4 renders, 3 distinct PNGs; cell stamp constant |
| `nested:text` / `photo` / `three` / `video` | the nested preview X draws: spine + column inside the card, a two-line body, a 64×64 thumb with `+2` or a play pill | block 506×76, thumb 64×64, body ≤ 2 lines, header line box 20 px |
| `nested:*` wrappers | X's `p-3 [:first-child+&]:pt-0`: 0 px above the preview with no quoted media, 12 px when the quoted media is flush above it | `padding-top` 0px / 12px, sides 12px |
| `nested:q1-photo-q2-text` | the quoted level holds the media (compact card), the nested one none: one media level, eligible | preview present, no thumb |
| `nested:ineligible-media` / `-self` / `-reply` / `-card` | X's gate says no: two media levels, a self-quote, a reply, a card in the nested post | no nested box |
| `nested:page-vs-replica` | `elonmusk` quoting SawyerMerritt quoting SERobinsonJr (two media levels): the capture and the replica both draw nothing | page none / replica none, same height |
| `video:source-author` | the credit rides in the duration pill, after the clock | 57×16 box inside the `h-5` pill, 13×13 avatar, "NFL" |
| `video:same-author-suppressed` | a post cannot credit itself | no credit box |
| `photo:source-author` | the bottom-left `bg-black/70` pill inside the photo box | 65×24 box, 13×13 avatar, ALT badge dropped |
| `media-source:page-vs-replica` | `ESPN.html`'s embedded `@NFL` clip, capture against replica | same height; credit box identical (57.34×16) |
| `stamp:page-vs-replica` | `jack-20`'s post 20 in page mode vs replica | `8:50 PM · Mar 21, 2006` both, same height |
| `bytes:media` / `card` / `card-summary` / `avatar` | the model's bytes are drawn, not a stub (a 1×1 magenta PNG, stretched) | magenta 1.00 / 1.00 / 0.99 / 0.78 of the box |
| `bytes:none` | a card without bytes keeps the labelled stub | magenta 0.00 |
| `quote:visible-text` | the quoted body is the rules' visible text: media `t.co` hidden with the space before it, no ellipsis, adjacent emoji | replica `…clipboard 🤣📋` = the capture's copy |
| `media:*` (11 shapes × 2 themes) | every picture the model describes arrives with structure, in both themes | 219–320 colours, stdev 12–83, 0% placeholder grey |
| `stub:*` (the same 11 without bytes) | the control: a stub is *flat*, so the rows above prove something | 1–3 colours, stdev 0–4.7, 98–100% placeholder grey (avatar and quote-card boxes excepted: they hold X's portrait and the quoted text) |
| `page:…` (the captured cell, 390 dpr 2 / 951 dpr 3) | the truth column's own photograph | 1341–1810 colours, stdev 83–91, 0% placeholder grey |
| `page:video` | a video post's page: real poster + X's play control | structure in the poster, 5% white at the centre |
| `page:…:warm` | a second render of the same page does not fetch anything again | `+0` fetches, 138 ms |
| `page:source.media` | a file named by `source.media` is served, not the cache's | 58% of the box is the file's colour, `+0` fetches |

Through the playground server (`POST /api/render { target: "chrome" }`), warm
round trips measured 65–73 ms end to end, PNG base64 included, with
`version.decisions === "report"` — the server forwards the native target's
`explain`, so both columns answer the same question. A post with no `createdAt`
on the detail surface comes back with the label `Now` (it used to carry the
server's wall clock), and a card whose `links[url].image.data` carries bytes comes
back with those bytes drawn.

Parity rows whose *body text* differs from the page are reported as `content`,
not `layout`: they are rules differences the playground exists to show (the
`t.co` link's display form, a payload without `created_at_ms`). The height and
box geometry of those rows still match.

## Known gaps

- **Cards**: `summary_large_image` is captured; `summary` uses the client
  component's own markup (`tools/oracle/cards-markup.mjs`'s shape, inlined);
  `player` and `app` are drawn with the large-image component and a note.
- **GIF**: the corpus has no GIF capture, so a GIF is the video box with the
  play control removed and the duration pill relabelled `GIF` (noted per render).
- **Poll**: rows are the captured closed-poll row. The *voted* choice's bar
  shade and checkmark are not distinguished (all rows keep the first row's
  shade), and a 3rd/4th choice reuses that row.
- **Quoted card**: a compact quote with several images keeps one thumbnail; a
  full-form quote with several images uses the captured quote-carousel wrapper.
- **ALT badge**: inserted from the captured fragment when the template lacks one;
  its `id`/`aria-describedby` are the captured element's, so repeat them
  knowingly (X's own ids are per-instance; this does not affect layout).
- **Emoji** rasterize through Apple Color Emoji, not Twemoji: the same fixed
  0.5–1.5% pixel floor `docs/e2e-raster.md` records for every macOS comparison.
- **Page-mode pictures** come from the media cache, `source.media`, or one
  throttled fetch per asset — so a captured post whose author has a real avatar
  shows it in the truth column while the replica, whose model carries no avatar
  bytes, shows X's default portrait. That difference is the model's, not the
  harness's.
- **A page render can fetch.** The first look at a cell whose pictures are not
  cached costs one throttled request per image (≥1.1 s apart) plus one reload;
  after that it is a cache read. `createChrome({ media: { fetchOnMiss: false } })`
  makes it cache-only (that is what `PLAYGROUND_OFFLINE=1` does), and
  `{ media: { warm: false } }` skips the warm pass entirely.
- **`Pinned`** is read from the page in page mode, but a payload cannot say it;
  the parity test sets `post.socialContext` from the page's own context row.

## For the playground server

```js
import { createChrome } from "./lib/chrome.mjs";
const chrome = await createChrome();                       // once, at start-up

const report = await native.explain(post, options);         // the native target's own report
const shot = await chrome.render({ post, options, report }); // replica: same decisions
const page = await chrome.render({ post, options, mode: "page", source });
```

- **Show `ms.paint`, not `ms.total`.** `total` is the wall clock of the whole
  call — it contains the rules decision, the queue, page-mode navigation and any
  image prefetch — while `paint` is the render itself (DOM update + layout +
  raster on bytes already in memory). A cold page-mode render can be 6 s of
  `total` for 0.3 s of `paint`; the two are reported side by side so the number
  on screen cannot be a fetch.
- Pass `report` when the native target is up: it makes the two columns answer
  the same question, and `version.decisions === "report"` proves it.
- Pass `options.smoothing` through (`"antialiased"` default, `"platform"` for
  what the browser itself draws). The Rust options parsers ignore the key, so
  forwarding it to every target is safe.
- `png` is a Buffer; the API's `png` field wants base64.
- Expect `code: "superseded"` under rapid keystrokes; it is not an error to show.
- `version` carries `chromium`, `upstream` (`appVersion` from
  `assets/upstream.lock.json`), `harness` (a hash of the two modules) and
  `ruleset`/`decisions`, for the target badges.
- The decisions engine prefers a built `xeet-render`; set `XEET_EXPLAIN_BIN` to
  pin one if the playground should follow the native column's binary exactly.
