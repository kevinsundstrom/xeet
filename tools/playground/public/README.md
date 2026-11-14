# xeet playground — front end

Plain ES modules and CSS. No framework, no bundler: the files here are served
as they are. The server is `tools/playground/server.mjs` and the Chrome column is
`tools/playground/lib/chrome.mjs`.

```
index.html        the shell: paste box, controls, drawer, columns, diff, report
style.css         X's visual language (light/dark), Chirp from ./fonts
app.js            the loop: state → compose → render → columns/diff/report
js/state.js       state, URL-hash and localStorage persistence
js/model.js       Post model (crates/xeet-core/src/model.rs) + drawer merge
js/api.js         /api/* calls, SSE, and the ?mock switch
js/wasm.js        the in-browser target: /wasm/xeet_wasm.js, frame unframing
js/render.js      per-target request state machine + the column DOM
js/diff.js        pixel comparison (±8, 1 px slack) and diff painting
js/report.js      the explain report, the text map, the matrix
js/controls.js    the paste box, viewport options, the post-details drawer
dev/mock.js       a complete stand-in API for ?mock (renders real PNGs on canvas)
dev/serve.mjs     static dev server (page + /wasm + /fonts) for working alone
dev/verify.mjs    the browser verification script
fonts/            Chirp, copied from assets/vendor/fonts (see below)
```

## Run it

```sh
# the real thing
PORT=4178 node tools/playground/server.mjs      → http://127.0.0.1:4178

# without the server (mock API, the WASM column is the real renderer)
node tools/playground/public/dev/serve.mjs      → http://127.0.0.1:4179/?mock
```

`?mock` swaps in `dev/mock.js` for `/api/*` only; the WASM target always uses
the real `/wasm/*` build, so a mock session still exercises the real renderer
against a canvas stand-in for Chrome.

## What it asks the server, and when

| target | when | how |
|---|---|---|
| `wasm` | every input event | `/wasm/xeet_wasm.js`, `call(1, {op:"render",post,options})`, unframed here |
| `native`, `http` | 30 ms after the last change | `POST /api/render`, superseded (in-flight request is aborted) |
| `chrome` | 250 ms after the last change | `POST /api/render`, column shows "updating…" while it runs |
| targets/versions | boot, on `GET /events` (and on SSE reconnect) | `GET /api/targets` |
| resolve | JSON: 150 ms, URL: 400 ms | `POST /api/resolve {input}` |
| link cards | plain text: 400 ms, only when the set of URLs changes | `POST /api/resolve {input, media?}` |
| rebuild | the stale badge's button | `POST /api/build {target}`, then reload targets |

## Link cards

A pasted text with a URL gets its card from `/api/resolve`: the server follows
the redirect the way X's crawler does and answers `post.links` plus a `links`
map of `{url: {meta, chain, finalUrl, tags, notes}}`. The UI:

- resolves 400 ms after the last change, only when the set of URLs changed, and
  caches the answer per URL set (reword the prose, no second request);
- never waits for it: the post renders immediately without a card and
  re-renders when the answer lands, with a `resolving links…` chip meanwhile;
- merges the resolved metadata **under** the drawer's `patch.links`, so an
  edited card wins and `reset to resolved` (in the link section) brings the
  resolver's values back;
- shows each link in the report: the redirect chain (`t.co/… → 301 →
  vercel.com/…`), the final URL, the card type, the tags it came from, the image
  size and the resolver's notes;
- has two switches, both persisted: **resolve links** (off = no request, no
  card) and **real images** (`media: true`, which also fetches card images).

### Quotes

X turns a post whose text **ends** on another post's URL into a quote; the same
URL with text after it is just a link. `/api/resolve` already reads that post
into `post.quote`, and the UI now keeps it:

- the cache key includes whether the text ends on a status URL
  (`urlSetKey` → `…\n[quote]https://x.com/…`), so typing after the URL
  invalidates the cached answer and the quote disappears — and comes back when
  the extra word is removed;
- the resolved quote is merged onto the base post (under the drawer's `quote`
  override), so every target is sent `post.quote`;
- the chip says `quote @handle` (never "no card" or "1 link" for a resolved
  quote), and the report gets a **Quote** block: handle, name, preview, its
  localized `createdAt`, and the post it quotes when that is present;
- the Quote section in the drawer copies the resolved quote when enabled, and
  **reset to resolved** drops the override again. A quote override that was
  never hand-edited is dropped when the text moves to an unrelated post, so it
  cannot linger.

### Quote post slot

X's Quote Tweet composer attaches the quoted post **by URL** (`attachment_url`),
out of band: it costs no characters, and the body can still end on an ordinary
link whose card yields to the quote while the link stays in the text.

- `+ Quote post` under the textarea opens a URL field (`state.quoteUrl`,
  persisted in the hash as `q`). A status URL is resolved (debounced, cached by
  URL) and attached as `runtime.base.quote`; the pill reads
  `Quoting @handle · 0 chars` with the fetch time and the quoted text in its
  tooltip, and `×` clears it.
- Precedence: a manual drawer `quote` override beats the slot, the slot beats an
  inline trailing URL, and an inline trailing URL beats nothing.
- When the text ends on a status URL and the slot is empty, `Move to Quote slot
  (−23 chars)` moves that URL out of the text — trimming the whitespace before
  it — and into the slot, where it is free.

`post.quote.quote` (two levels) is composed, preserved and time-zone rewritten
ahead of the renderers: `composePost` keeps `links`, `entityLabels`, `replyTo`,
`replyToHandle`, `longPost`, `longPostBody`, `appVersion` and the nested quote,
and `localizeTimes` walks both levels. Depth 2 is supported end to end: the
renderer draws the inner post as X does (inside the quote card, with the
eligibility rules in [`SPEC.md`](../../../SPEC.md) §14), and only a third level —
`post.quote.quote.quote` — is refused with an `invalid_post` naming that path.

### A draft for @vercel

An author with handle `vercel` and no avatar of its own is drawn with Vercel's
real black-square/white-triangle mark, generated in `js/vercel-avatar.js` from
the proportions measured on @vercel's 400×400 X avatar (apex `(200.5, 120.5)`,
base `(109.0, 279.5)`–`(292.0, 279.5)`). It is injected into the composed post
just before rendering, never into the state: the share hash and `localStorage`
stay free of image bytes. The module has a canvas path for the browser and a
dependency-free analytic PNG writer (stored-deflate + CRC32/Adler32) for Node,
so it can be unit tested and used where there is no DOM.

Business accounts are drawn with a rounded-square avatar; a session saved
before that default existed is upgraded on load (`decode()` sets
`squareAvatar: true` for `verified: "business"` unless the patch said
otherwise), and unchecking `square` in the drawer still wins.

## Time zones

X shows times in the **viewer's** zone, and the core formats whatever offset the
string carries — so before a post reaches any target, the UI rewrites
`createdAt` and `now` (post and quote) into the chosen zone as ISO with an
explicit offset, using the offset in effect at that instant (DST included):

```
2026-11-05T02:12:00.000Z  →  2026-11-04T18:12:00.000-08:00   (US Pacific, Nov)
2026-07-04T02:12:00.000Z  →  2026-07-03T19:12:00.000-07:00   (US Pacific, Jul)
2026-11-05T02:12:00.000Z  →  2026-11-05T11:12:00.000+09:00   (Tokyo)
```

The drawer's Timestamp section has a **time zone** control: the browser's zone
by default, plus UTC, US Pacific/Eastern, London, Berlin, Tokyo, India, Sydney —
handy for previewing a post as another viewer sees it. An explicit timestamp
override in the same section wins over the rewrite (it is the user's own string)
and disables the zone control.

The renderers still format a **quoted** post's short date in UTC (and Chrome's
replica ignores the quote's `createdAt` altogether), so that one label can still
fall on the UTC date; the post's own timestamp is viewer-local in every target.
The strings the UI sends are already correct — see the "quote date" note in the
verification output.

## The clock

The core has no clock, so a post without times let every target invent its own:
Chrome stamped the current time ("5:06 PM · Nov 10, 2026"), the renderer printed
"Now". Now one timestamp is sent as both `createdAt` and `now`:

- a draft's instant is captured when the input changes, so every target draws
  the same time; the drawer's Timestamp section shows it (`post time`) and can
  **freeze** it so renders stay stable while typing, or re-stamp it (`now`);
- a resolved x.com URL keeps the payload's `createdAt` and the capture's `now`;
  a JSON post keeps whatever it declares, and only gets the draft instant when
  it has none;
- an explicit Timestamp override in the drawer wins over all of it, and dims the
  clock row.


`POST /api/render` gets `{target, post, options}` and, for `chrome` only,
`{mode, source}` when the input came from an x.com URL. `mode` is `"page"`
(the captured page itself, the default for a URL) or omitted for replica; the
toolbar switch `page | replica` appears only when a URL is resolved. The
resolver's `source.page` doubles as the cache key.

`options.smoothing` (`"antialiased"` default, `"platform"`) is Chrome-only: the
Chrome column carries the switch, it is added to the chrome request, and it is
stripped from every other target's options (native and the `http` target reject
unknown option fields with `invalid_options`) and from their cache keys.

A render answer may be `{superseded: true}` with no `png` — the server's way of
saying a newer request for that target is on its way. The UI drops those instead
of showing them, and keeps the previous PNG (see Convergence below).

## Convergence

Every target tracks two keys: the task it was asked for (`wanted`) and the PNG
it is showing (`shown`). If an answer is superseded, aborted, or belongs to an
older input, it is dropped — and the runner **re-issues the newest task**, with
a small backoff so two clients cannot ping-pong supersessions at full speed.
Only an error for the current key is terminal (typing or Re-render retries it).

While `shown !== wanted` the column is visibly stale: dimmed PNG, `updating…`
chip, amber dot. A column may lag behind the input, but it can never silently
show an older one.

Each page session also sends its own `client` id with render and resolve
requests (the server supersedes per client+target), so two tabs no longer knock
each other's renders out.


Fields consumed from a render: `png` (base64), `width`, `height`, `dpr`,
`report`, `geometry`, `ms.{total,render,encode}`, `version.{rev,dirty,builtAt,
ruleset,upstream}`. `report.size` is used only as a fallback for `width`/`height`
on the WASM target, which returns no `width`/`height` of its own.

`geometry` is expected as `{lines: [{text?, x, y, w, h?}], boxes: [{name?,
kind?, x, y, w, h}]}` in **CSS px** of the render (the same space as `report.size`).
Line boxes with no `h` get the line height inferred from their neighbours.
Device-pixel coordinates are also accepted: if a box extends past the render's
CSS size, everything is treated as device px.

Empty hashes of targets: the UI keeps a fixed list (`chrome`, `wasm`, `native`,
`http`) and merges `/api/targets` into it, so a missing build shows "not built"
instead of losing a column.

## Persistence

The whole state lives in the URL hash as `#s=<base64url(json)>` and in
`localStorage["xeet.playground.v2"]`. The hash wins on load. Base64 payloads
(media, avatars, card images) are dropped from the hash — but not from
localStorage — once the encoded state is longer than 24 kB, because a URL is
not a place for images; dimensions survive, so the layout does not change.

## Fonts

X's Chirp, subset per `assets/upstream.lock.json`, is copied into `fonts/` so
the chrome looks like X's under any server. If the files are ever missing the
CSS falls back to `system-ui`. Refresh them with:

```sh
cp assets/vendor/fonts/Chirp-{Regular,Bold,Heavy}.{latin,latin-ext}.woff2 tools/playground/public/fonts/
```

## Verify (real browser)

```sh
node tools/playground/public/dev/verify.mjs --url http://127.0.0.1:4178/
node tools/playground/public/dev/verify.mjs --mock         # against dev/serve.mjs
```

It loads the page, waits for every column's PNG, checks the delta, types into
the box, opens the heatmap and outlines, toggles theme, round-trips the hash
through a reload, checks the keyboard, renders the matrix, resolves a URL,
switches Chrome to replica, edits the drawer, adds media, reorders columns and
fails on 5xx responses or page errors. Screenshots land under `tmp/`.

## Devices

`Device` sets width and dpr together; the raw width slider (280–1200) and the
dpr buttons stay authoritative, and moving them makes the picker read
`custom · <width> @<dpr>x`. The presets come from `js/devices.js`:

| device | width | dpr |
|---|---|---|
| iPhone Duo · closed | 382 | 3 |
| iPhone Duo · closed landscape | 594 | 3 |
| iPhone Duo · open | 669 | 3 |
| iPhone Duo · open landscape | 951 | 3 |
| iPhone Duo · split view | 385 | 3 |
| iPhone SE / 16 / 17 Pro Max / Plus | 375 / 390 / 430 / 440 | 2–3 |
| Desktop column / Desktop | 600 / 1200 | 2 |

The Duo figures are WebKit's, from *WebKit Features for Safari 27.1*
(2026-10-23), CSS px at dpr 3 — the tooltip on the picker says so. The closed
outer display is **382, not 466**: Safari keeps an 84 pt system strip there.

X's post column is `min(viewport, 600)`, so the wide poses (669, 951, 1200)
render a 600 column inside a wider viewport. The UI draws that viewport as a
dashed frame around the column, labelled `669 px viewport · 600 column`, at true
CSS size — so you can see how the post sits on the device. The matrix renders
`382, 669, 320, 390, 600 × light, dark` by default (the two Duo poses first),
with the same framing and a `600 col` note in each caption; the composed sheet
PNG draws the viewport box too.

## Performance (measured on this machine, real server)

| | wasm render | pixel compare | diff mask |
|---|---|---|---|
| 390 CSS px, dpr 2 | 17 ms | 12 ms | 24 ms |
| 600 CSS px, dpr 3 | 63 ms | 56 ms | 56 ms |

**Everything in the UI is paint time.** A column footer reads `N ms paint` and
nothing else — `ms.paint ?? ms.render ?? ms.total` from the server's answer, or
the WASM module's own render call — and the full breakdown (paint, layout,
screenshot, encode, fetch, wall) lives in the footer's tooltip. Loading the WASM
module happens *before* the clock starts, so a cold first keystroke does not pay
for fetching and instantiating 11 MB. Data fetching is reported where it
happens: the resolve time is on `#linksChip` and on the quote pill, never in a
render column.

The WASM render runs once per input event (scheduled after paint, so typing is
never blocked by it). Server targets are debounced and superseded. Pixel
comparisons run on the main thread but are spaced proportionally to their own
duration, and the diff mask only recomputes while the diff panel is in view;
typing at the heaviest settings keeps a median 17 ms between frames.

## Known limits

- The link resolver is the server's: if `/api/resolve` answers without a `links`
  map, the chip says "no card" and the post renders without one (the UI is
  wired for `links`, and the mock implements it so the whole path is testable).
- `options.smoothing` is sent to Chrome; whether the pixels change is up to the
  oracle (the replica currently forces antialiased, so both settings
  render identically until that lands). The switch, the request and the
  persistence are wired and verified.
- `POST /api/resolve` may return `options`; the UI ignores them and keeps the
  viewport the user chose.
- Page mode screenshots the captured article, so drawer overrides do not change
  the Chrome column while it is on; the replica switch is one click away.
- The diff paints at 1× (CSS pixels) by default and zooms with pixelated
  rendering; `fit` resets zoom and pan rather than scaling to the stage.
