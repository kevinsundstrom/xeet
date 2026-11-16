# Resolve: text or an X post URL → a complete `Post`

`crates/xeet-resolve` is the step between a paste and a preview. It turns one
string — draft text, an `x.com`/`twitter.com` post URL, or post JSON — into a
`model::Post` with link cards, media bytes, avatars, badges, quoted post and its
own card, and it does it **with every network call injected by the caller**. One
implementation, four hosts: the CLI, the playground, the web demo's resolver
function, and the browser.

```
text  ──┐                        ┌─→ post.links  {url: LinkMeta}    cards, display
x.com ──┼─→ resolve(input, opts, Fetch, Lookup?, Cache?, Clock?)
JSON  ──┘                        ├─→ post.media  {url: MediaAsset}  bytes + variant
                                 ├─→ post.quote  (two levels: .quote.quote)
                                 └─→ warnings, source
```

The resolver is deliberately a separate, optional layer outside the trusted
core: link metadata is an input to the renderer, and fetching it is the caller's
job. `xeet-core` still has no network code, no clock and no filesystem access.

## The API

```rust
pub async fn resolve(
    input: &str,
    options: Options,
    fetch: &impl Fetch,
    lookup: Option<&impl Lookup>,
    cache: Option<&impl Cache>,
    clock: Option<&impl Clock>,
) -> Result<Resolved, Error>;
```

- **`Fetch`** — the only required piece. `fetch(Request) -> Response` with
  `redirect: Manual` in every request: the library owns the chain, so the hop
  rules and the address guard are the same on every platform.
- **`Lookup`** — optional DNS. With it, every hop's host is resolved and every
  address must be public. Without it (a browser has no DNS) the library still
  refuses private **literals**, and the host's `fetch` must enforce the rest.
- **`Cache`** — optional storage (`get`/`set` of `{value, storedAt}`). The
  library owns the TTL policy (`Options::cache_ttl_ms`, one hour by default;
  `Options::refresh` ignores the cache).
- **`Clock`** — optional wall clock, for TTLs and timestamps.

`Options`: `media`, `width`, `dpr`, `surface`, `max_links` (4), `limits`
(`xeet-core`'s `Limits::standard()`), `now`, `now_ms`, `timeout_ms` (5 s per
URL), `hops` (10), `html_bytes` (1 MB), `image_bytes` (5 MB), cache TTLs, and
`allow_hosts` (a test seam, the same one the JS resolver has; no shipped wrapper
sets it).

`Resolved`: `post`, `links` (each with `meta`, `chain`, `final_url`, `tags`,
`image_url`, `notes`, `cached`), `media` (each with `variant`, `bytes`, `width`,
`height`, `role`, `data`), `source` (`url`, `id`, `app_version`, `page_html`,
`pinned`) and `warnings`.

`media` is keyed by the URL fetched, and `role` names the slot, so a caller can
serve the same bytes to a browser or to Chrome's page mode:

| Role | Slot | Variant |
| --- | --- | --- |
| `media:N` | the post's own grid | `small`/`medium`/`large` by slot × dpr |
| `avatar`, `badge` | the post's author | `_normal`/`_x96`/`_reasonably_small` by 40 px × dpr; the payload's own badge URL |
| `quoted media:N`, `quoted avatar`, `quoted badge` | the quoted post (level 1) | the quote card's own slot table |
| `quoted quoted media:0`, `quoted quoted avatar`, `quoted quoted badge` | the quoted post's quote (level 2, X's nested preview: one 64×64 thumbnail, a 16 px avatar) | `small` and `_normal` — a 64 px square never needs more, at any dpr |
| `media:N source avatar` (and `quoted media:N source avatar`) | the original author of a "Post video"/"Post photo" (`Media::source_author`) | `_normal` — X's attribution chip is 16 px |

For a post JSON the resolver fills links but has nothing to fetch: the model
carries no media URLs, only bytes. So a `post.quote.quote` that JSON already
describes — including any `media[].data` — is preserved exactly, and only a
third level is an error (the renderer's own).

`post.links` is keyed by the URL **as written in the text** — that is what
`rules` looks up — and a payload's own `display` form always wins (a `bit.ly`
link still reads `bit.ly/4esrsTj` while the card comes from the article).

## What it does, and the evidence

Every rule is a port of something that was verified against X, and the docs are
the reference:

| Rule | Where |
| --- | --- |
| `Twitterbot/1.0`, ≤10 hops, `<meta refresh>`, robots.txt (Twitterbot group, longest match), `twitter:*` → `og:*`, OG-only → `summary`, an X self-link has no card, 70/200/420-char limits, 144×144 and 5 MB image rules, the display form | `docs/LINK-CARDS.md` |
| Variant table (`small` 680 / `medium` 1200 / `large` 2048) by slot × dpr, avatars `_normal`/`_x96`/`_reasonably_small`, video/GIF posters as `Media::data`, never the original | `docs/MEDIA.md` |
| A post page's embedded payloads are the source (no API, no session); `longPostBody`, `appVersion`, `reposts = retweets + quotes`, reply-ness, `Pin` | `docs/E2E.md`, `tools/ship/corpus-post.mjs` |

Two rules the library adds, with the evidence that motivated them:

- **A trailing status URL in a draft is a quote — unless it names a media item.**
  X's composer attaches a post when a draft ends with its link, and
  `rules::trailing_attachment_entities` already hides that URL once
  `post.quote`'s handle matches. So `resolve` treats the last status URL in the
  text — trailing whitespace only, any of `x.com`/`twitter.com`/`mobile.`/`www.`,
  `/status/`, `/statuses/`, `/i/status/`, `/i/web/status/`, with a `?s=20&t=…`
  query — as the quote, fetches it with the same page path as a pasted URL, and
  fills `post.quote`.
- **`/status/<id>/video/<N>` and `/status/<id>/photo/<N>` are "Post video" /
  "Post photo", not a quote.** X's client distinguishes them
  (`quote-media-toggle-jMLU_r6g`, `post-media-menu-item-jECN8x_w`): the URL names
  one of that post's media items, and the draft attaches **that item**, credited
  to its original author — `Media::source_author`, which `rules` draws as the
  attribution chip. `resolve` fetches the post, takes
  `media_entities2[N-1]` (falling back to the first item), converts it (`kind`,
  `width`, `height`, `duration`, `alt`), sets `source_author` to the post's
  author — dropped when it is the draft author's own handle — inlines the poster
  at the outer post's slot and the source avatar at 16 px (`_normal`), and adds
  `post.links[url]` with `card: None`. **No `post.quote`.** The rule does not care
  where in the text the URL is, and only applies to a draft with no media and no
  poll of its own.
- **Direct `twimg` URLs are media too.** A `video.twimg.com/…` URL (`.mp4`,
  `.m3u8`) becomes a `Video` whose size is read from X's own path
  (`/vid/avc1/864x1080/…`, default 1280×720) and **whose stream is never fetched**
  — only a poster, if the draft supplies one (`video_twimg`/`/media/` URL next to
  it, which then does not become a second item). `pbs.twimg.com/amplify_video_thumb`
  and `ext_tw_video_thumb` become a `Video` with its thumbnail as `data` (the
  poster frame, as everywhere else); `tweet_video_thumb` becomes a `Gif`; and up
  to four `pbs.twimg.com/media/…` photos become `Image`s. Every one of them is
  recorded in `post.links` with `card: None` and the note
  `direct X media URL attached as post media`, and none of them is crawled for
  card tags.
- **Quotes go two levels deep, and no further.** X's nested quote preview
  (`nested-quote-preview-SIs_tkfq`) draws the quoted post's own quote as a
  compact row, and the renderer's model agrees: `limits::Limits::max_quote_depth`
  is 2 and `post.quote.quote.quote` is an `invalid_post`. So `resolve` fills
  `post.quote.quote` (author, text, `longPostBody`, links, entity labels,
  `replyTo`, `createdAt`, media) and drops a third level. The depth budget is the
  caller's `Options::limits.max_quote_depth`, so raising it in a test produces a
  deeper tree; a payload attached as level 1 (the draft-quote path) gets one
  level less, which is why `post.quote.quote` is filled and nothing below it is.
- **At each level, X sends the quoted post twice — and only one copy is real.**
  `quoted_tweet_results` and `nested_quoted_tweet_results` both exist, and at the
  second level the first is a six-key stub (`__typename`, `id`, `rest_id`) while
  the second carries the text and media. All five two-level quotes in the corpus
  have this shape (`elonmusk.html:2119812607117062451`, `NBA.html`,
  `binance.html`, `text-karpathy.html`, `text-levelsio.html`), so the resolver
  takes the **richer** of the two (`post::quote_payload`, scored by text plus
  media) — taking the stub would produce an empty quote card. `extract_payloads`
  applies the same rule when a page embeds a stub of a post it also embeds in
  full.
- **`t.co` must be followed even though its robots.txt says `User-agent: * /
  Disallow: /`.** It names `twitterbot` first with a bare `Disallow:`, i.e. the
  crawler is welcome; a parser that fell through to `*` would disallow every
  short link on X. `urlsafety::Robots` keeps a group that names us, and the unit
  test records the exact file.

## Safety

- `http`/`https`, **default ports only**, no userinfo in the authority.
- Every hop's host is classified: IP literals always (`127/8`, `10/8`,
  `172.16/12`, `192.168/16`, `100.64/10`, `169.254/16` — the cloud metadata
  endpoint —, multicast, reserved, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`,
  and the IPv4-mapped/NAT64/6to4 forms of those); with a `Lookup`, every resolved
  address too, re-resolved on every hop.
- 5 s per URL, 10 hops, 1 MB of HTML, 5 MB per image, content-type checked
  before parsing, robots.txt honoured per origin.
- No cookies, no credentials, no request bodies, `connection: close`.
- A redirect to another host is checked before it is followed, so a DNS-rebinding
  answer or a redirect to `127.0.0.1` cannot get through. (DNS pinning between
  the check and the connect is **not** closed: the host's `fetch` resolves again.
  A deployment that cares runs the guard and the connect in one place.)

## The hosts

### Native: `xeet resolve`

```console
$ xeet resolve "daemons: https://t.co/jO01BMGwXr" --media --compact
$ xeet resolve https://x.com/NASA/status/2119833829389041896 --media --width 390 --dpr 2
$ xeet resolve post.json --no-links        # fill in cards only, no network
```

`crates/xeet-resolve-net` provides the default `Fetch` (`ureq`, blocking, rustls
with bundled roots — no runtime, no OpenSSL), `Lookup` (the system resolver) and
`Clock`, plus a `DirCache` and a `block_on` driver. `ureq` is used with
`redirects(0)`: the library follows the chain, and each hop is checked.

### WASM + JS: `packages/xeet`

```js
import { loadXeet } from "@xeet/core/node";
const xeet = await loadXeet();

const resolved = await xeet.resolve("look: https://t.co/jO01BMGwXr", {
  media: true, width: 390, dpr: 2,
});
resolved.post.links["https://t.co/jO01BMGwXr"].card; // "summary_large_image"
```

The export is `resolve(input, optionsJson, host) -> Promise<json>`; the JS
wrapper (`packages/xeet/src/resolve.js`) adds `whatwgHost()` (a WHATWG `fetch` as
the host), `memoryCache()`, and the error shape (`{code, status, message,
fields}`). A host is an object with `fetch` and optionally `lookup`, `cacheGet`,
`cacheSet`, `now`:

```js
const host = xeet.whatwgHost({
  fetch: (url, init) => proxyFetch(url, init),      // must pass `redirect: "manual"`
  lookup: async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address),
});
```

**In a browser**, `fetch(…, { redirect: "manual" })` returns an opaque response
(`status: 0`, no headers), so a card cannot be read directly: a browser host
needs a CORS-capable proxy that fetches server-side and returns the status,
headers and body as JSON. The library itself is the same build; only the host
differs. `whatwgHost()` refuses an opaque redirect with `blocked:
"opaque_redirect"` rather than pretending the page was empty.

### Playground and the deployed resolver

- `tools/playground/lib/resolve-lib.mjs` — the Node adapter: `fetch` with manual
  redirects and an abort, `node:dns` for the guard, the disk cache under
  `assets/vendor/playground/` (git-ignored), page files for Chrome's page mode,
  and `source.media` (`{url: {file, bytes, width, height, variant, role}}`) so the
  oracle can serve the page's own image requests the same bytes.
- `/api/resolve` calls it; `resolve.mjs` keeps the previous JS pipeline as a
  fallback (`XEET_RESOLVE=js` pins it) and for the `offline` corpus path the
  smoke test uses.
- `POST /_playground/resolve-links` (`api/playground-resolve.mjs`, the web demo's
  only deployed function) calls `xeet.resolveLinks` per URL: one library, one set
  of rules. There is no public render or resolve API; `xeet` ships as
  `@xeet/core`, the Rust crates and `@xeet/cli`.

## Tests

| Command | What it covers |
| --- | --- |
| `cargo test -p xeet-resolve` | 49 unit tests + a doctest, in-memory `Fetch`, no network: cards (twitter/OG/OG-only/unknown/self-link/limits/entities), meta refresh, robots (incl. the `t.co` file verbatim), the address guard, image headers, the variant table, payload → post, quotes from text (two levels, with the nested preview's avatar, badge and first media inlined), the stub-vs-rich slot choice, the depth-3 refusal, a post JSON's nested quote, "Post video" vs quote (with the source author and avatar inlined), `source_user_results` in a payload, direct `twimg` video/photo URLs (the stream never fetched), cache reuse, truncation |
| `node tools/playground/test/resolve-parity.mjs` | the library against the JS resolver it replaces, on a local fixture server (redirect chain, OG-only, meta refresh, robots deny, tiny image, oversized image, x.com self-link, video poster, quoted post, quote from text, plain text), plus the nested quote — two levels, the rich payload, the roles and sizes — which the JS resolver does not do and so is asserted on the library alone |
| `node tools/playground/test/resolve-parity.mjs --recorded` | …and on recordings of the real pages: t.co → Vercel, NASA, NBA, F1, GIPHY, MrBeast, the long rauchg quote post, the quoted post, a bit.ly chain |
| `node tools/playground/test/record.mjs` | records those pages once (1 req/s/host) into the git-ignored `assets/vendor/playground/recordings/`, from both implementations so their variants are covered |
| `node tools/ship/determinism.mjs` | 12 cases byte-identical between the native and wasm renderers, i.e. the render ABI did not move when `resolve` was added |

Accepted differences, stated rather than hidden: on a recording the JS resolver
serves images from its own disk cache and so asks for fewer URLs (its bytes are
compared on the fixtures instead); the two resolvers differ on which
display-only entry they keep for a `t.co` that lands on an X post (no card either
way, and `rules` hides the ones an attachment claims); and the JS resolver found
none of the long rauchg post's real links in one replay because its `explain`
callback failed on that post.
