# SPEC: what X shows, and how we know

This is the behavior contract behind `rules::decide`. Every rule has a **value**,
a **status**, and **evidence**: either a location in the client code X serves
today, or a statistic over captured public payloads. When X changes, the evidence
stops matching and the ruleset needs a bump; that is the point.

Statuses:

| Status | Means |
|---|---|
| **verified** | Read from the shipped client code that X serves today, or measured on every captured payload the rule applies to. |
| **derived** | Measured on a sample of public payloads. The rule is a statistic with a stated fit, not a guarantee. |
| **prior** | Industry knowledge or the plan's prior, with no evidence in this snapshot. Marked in the report and listed in the behavior lab (§10). |

The machine-readable copy of these values lives in
`crates/xeet-core/rules/x-web.json`, embedded at build time; `rules/spec.rs`
reads it and `rules/mod.rs` implements it. This file is the prose and the
evidence.

## 0. The snapshot this was verified against

| | |
|---|---|
| App versions | `55591fe0f5ae6815fa853ab25bc30b5118d1d017` (newest; live post/profile captured 2026-11-10), `1037d89b2e16b39ce3ae53affdf45722259d018f` (corpus pages captured 21:21), `89824c04747e706b687e3af193963c4d00251b8e` (corpus pages captured 12:45; one page uses the older `3e351742…`) |
| Captured | 2026-11-10, logged out |
| Entry bundles | `entry-client-logged-out-CBWpPkB-.js` (55591fe0), `entry-client-logged-out-DdM74YKr.js` (1037d89b), `entry-client-logged-out-DLOx4QCm.js` (89824c04) |
| Client JS | 1,170 + 1,169 + 1,154 chunks, 49.9 + 49.0 + 48.4 MiB, pinned per version by sha256 in `assets/rules.lock.json` (`versions[appVersion]`); not committed |
| Fetch tool | `node tools/rules/fetch-client.mjs` (`--refresh` for today, `--from <captured page>` to pin the client that page used) |
| Corpus | 269 unique public posts from 83 accounts, `assets/vendor/capture/payloads.jsonl` |
| Capture tool | `node tools/capture.mjs` (≥1.1 s between requests, stops on a block) |
| Reducer | `node tools/rules/derive.mjs` (no network) |
| Canary | `node tools/rules/canary.mjs` (passive, fresh sample) |

Chunk names below are content hashes; the first 16 hex characters of the sha256
are quoted so a later chunk rename does not invalidate the pointer. Exact
hashes are in `assets/rules.lock.json`.

Two payload shapes appear in captured pages: the compact profile/timeline
shape (`result.details.full_text`, `url_entities`, `media_entities2`,
`note_tweet`) and the API shape (`legacy.full_text`, `legacy.entities`). Both
carry the same facts; `tools/capture.mjs` normalizes them.

## 1. Text, links and weighted length

| Rule | Value | Status | Evidence |
|---|---|---|---|
| Entity parsing | URLs, `@mentions` (and `@list/slug`), `#hashtags`, `$cashtags` | verified | twitter-text's open-source rules; `xeet-text` passes all 2,119 conformance cases and agrees with `twitter-text@3.1.0` on 3,029 texts (0 entity mismatches). `rules/textport.rs` re-exports `xeet-text`. |
| Weighted length | A URL counts 23. Otherwise each code point counts 1 for U+0000–U+10FF, U+2000–U+200D, U+2010–U+201F, U+2032–U+2037, and 2 for everything else. An **emoji sequence counts 2**: a regional-indicator pair, a keycap `[#*0-9]️⃣`, the England/Scotland/Wales tag flags, or a `\p{Extended_Pictographic}` character with at most one U+FE0F or skin-tone modifier, chained through any number of ZWJ links. So `👍🏽`, `✌🏿`, `❤️`, `👨‍👩‍👧‍👦`, `🇺🇸` and `🐦‍🔥` each weigh 2. Blank text counts its spaces (`"   "` → 3, valid); empty text is invalid. Limit 280; the composer warns at 260. | verified (composer) | X's composer, not twitter-text's 2017 table: config and emoji regex in `assets/vendor/upstream/js/CFyVwPZu.js` (sha256 `1e66b506…`; same code in `B5hEoqI4.js`, `D9DiKaD3.js`). The code was extracted and run in Node over 3,029 texts with 0 disagreements against `xeet_text::weighted_length` (`crates/xeet-text/tests/x_client.rs`, `tools/x-client/`). Caveat: this is the client's count; the server's counter is not observable from public data. |
| Long-post limit | 25,000; the composer warns at 24,920 | verified (composer) | `B5hEoqI4.js`: `Pr={max:25e3,warningAt:24920}`, used by `selectCanSend` when the account can post long posts. |
| URL display form | Scheme stripped, `www.` stripped, host lowercased, path+query cut at 15 UTF-16 units + `…` | **verified on 85/87 corpus URLs** | See §2. |

## 2. How a URL is displayed

Value: `https://www.anthropic.com/research/components-of-agent-memory` →
`anthropic.com/research/compo…`.

The rule (`xeet-text`, verified by the text stream on 122
`display_url`/`expanded_url` pairs across 35 accounts, fetched 2026-11-10;
details in `crates/xeet-text/src/display.rs`):

1. Strip a leading `http://` or `https://`.
2. Strip a leading `www.`.
3. Split at the first `/`, `?` or `#`: that is the host; everything after it is
   the tail.
4. If the tail is **longer than 15 characters**, keep the host, the first 15
   characters of the tail, and `…`. Otherwise keep the whole tail.

A trailing slash survives (`hackertube.org/`), the host keeps its case
(`GamesIndustry.biz`), and only the front of the tail is ever cut, never the
middle: X never hides the host, because that is the part people use to judge a
link.

My own reduction of 87 captured `display_url` values agrees: **85 of 87** match,
including long hosts (`docs.github.com/copilot/concep…`), short hosts
(`x.com/i/article/2077…`), and paths that fit (`example.com/a`). The two
exceptions are informative and are why the text stream keeps the tail form:

- `youtu.be/vDjW_dRyKXY?si…` — the query is part of the tail and is kept when
  it fits the 15-character budget, so the budget is on `pathname + search`, not
  path alone.
- `▲.to` — an IDN is displayed in Unicode, not punycode.

The tail split at `?`/`#` in step 3 is the reading that produces both of those
shapes: a URL with no path keeps its query in the tail.

Client corroboration: the text renderer prints `e.displayUrl` for a URL entity
(`CbDtO_Fz.js` sha256 `40030b8818a3d7c3…`, `Spe()`: `text:e.kind===WO.Url?e.displayUrl:...`),
and the client's own truncator is grapheme-aware
(`CbDtO_Fz.js`, `jz(e,t)`: accumulates grapheme clusters while
`n.length+r.length>t-1` is false, then `${n.trimEnd()}…`).

## 3. What is hidden from the body

Two mechanisms, and they are different:

1. **Server ranges**: `display_text_range` (`[start, end]`, UTF-16). The client
   slices the visible text to it (`_D0BurxE.js` sha256 `5ce0361e999eae52…`,
   `rt()`: `visibleRange:c==null?u(0,s):Ie(I(c),s,l)`). Corpus: 122 of 269 posts
   have `end < length`; **all 122 hide exactly one ` https://t.co/XXXXXXXXXX`
   (24 code points), and all 122 have media**. A card post is different: its
   `full_text` ends with the card's `t.co` URL and `display_text_range` includes
   it — the client hides it, not the server.
2. **Client attachment ranges**: ranges the client hides because a rendered
   attachment claims them. This is the rule to implement for a draft, because a
   draft has no server ranges yet.

### 3.1 The client's attachment-range algorithm (transcribed)

From `_D0BurxE.js` (sha256 `5ce0361e999eae52…`), function names as shipped:

```js
function W(e,t,n){                     // e: text, t: urls, n: media range
  let r=Ee(e), i=[], a=r.length, o=Ce(r,a);   // r = code points; Ce trims trailing whitespace
  for(;o>0;){
    let e=o, s=a,
        c=t.find(({indices:t})=>Te(t,e,s)),   // URL ending in [e,s], starting before e
        l=n!==null&&Te(n,e,s);
    if(c!==void 0){ ... i.push(kind===Media?{kind:MediaUrl,...}:{kind:Url,...}); a=c.indices[0] }
    else if(l) i.push({kind:Media}), a=n[0];
    else break;
    o=Ce(r,a);
  }
  return i;                            // innermost first
}
function Oe(e,n,r){                    // state, url entity, {articleRestId,cardUrl,quotedTweetRestId}
  ...
  let c=e.card===null&&a!==null&&(n.tcoUrl===a||n.expandedUrl===a),   // card URL
      l=e.quote===null&&s!==null&&o!==null&&(0,t.n)(s)===o,           // quoted post id
      u=e.article===null&&...;
  return !c&&!l&&!u ? null : {...};
}
function je(e,t,n,r){
  let i={article:null,card:null,media:r,quote:null};
  ...
  for(let a of W(e,t,r)) switch(a.kind){
    case Url: { let e=Oe(i,a.url,n); if(e===null)return i; i=e; break; }
    case Media: break;
    case MediaUrl: i=Oe(i,a.url,n)??i; break;
  }
}
```

Consequences, all encoded in `rules/mod.rs`:

- Scanning starts at the **trimmed end** and walks left across whitespace.
- A URL is hidden only when it **matches** a rendered attachment: the card's
  `legacy.url` (compared to the entity's `t.co` URL or expanded URL), the quoted
  post's status id, or an article id.
- The first trailing URL that matches nothing **stops the walk** (`return i`), so
  nothing to its left is hidden either. This is why "the last link gets the
  card": the card is bound to one specific URL, and a later, unrelated link
  prevents an earlier one from being hidden.
- Only ranges whose attachment actually renders are removed
  (`CbDtO_Fz.js`, `ck()`: `C[article: t.article?i:null, card: t.card?a:null, media:
  t.media?o:null, quote: t.quote?s:null]`).
- The rendered text of a URL entity is its `display_url`; everything else is the
  source text (`CbDtO_Fz.js`, `Spe()`).

### 3.1.1 The whitespace before a hidden trailing URL

X hides the whitespace that precedes a trailing URL together with the URL.
Corpus: of the **137** posts whose `display_text_range` hides a trailing `t.co`,
**137 of 137** end the range on the last non-whitespace character — none of them
leaves the preceding space or newline in the body. (The converter applies the
same range, so a payload already arrives trimmed; the rule matters for a
draft.)

`rules` therefore starts a trailing hidden range at the first whitespace
character (space, newline, tab) before the URL. Without it a draft ending
`… says “Show more”.\n\nhttps://vercel.com/blog/the-thing` with that link as
the card would lay out the blank line before the card (one extra 20 px line).
It also refuses to trim a link in the middle of the text. On a media post only
a **bare `t.co` with no link metadata** counts as the server-appended URL and is
hidden with its whitespace; a link the payload resolved to a display URL stays
visible (captured IGN/Polygon media posts show `bit.ly/…` and `polygon.com/…`),
because media outranks a card and nothing claims it (§6).

A payload's `report.text.visible` is built from the same body spans as
`Decisions.body`, so the two agree by construction; the rules matrix asserts it
for the card, media and mid-text rows.

### 3.1.2 Embedded media URLs ("Post video" / "Post photo")

When the composer embeds media by URL, it removes that URL from the text.
`tU-nr9vs.js` (sha256 `55cb51684c9fe415…`) module
`quote-media-toggle-jMLU_r6g`:

```js
n = function(e, t) {
  let [n, i] = t,                       // URL indices
      a = e.text[n - 1] === ` ` ? n - 1 : n;
  r.updateText(e.text.slice(0, a) + e.text.slice(i));
}
```

So the URL plus **one preceding space** disappears; a preceding newline is not
a space and stays. `BNn3ozGQ.js` (sha256 `60ad8cfa33fd2665…`),
`post-media-menu-item-jECN8x_w` + `get-embeddable-media-url-X8kC4tDT`, builds
the permalink it embeds from `source_status_id_str` and the media's
`expanded_url`:

```
/<handle|i>/status/<id>/(video|photo)/<N>   // N from /(?:photo|video)/(\d+)(?:[/?#]|$)/
new URL(pathname + search + hash, "https://x.com").href
```

`rules` hides these when `Post::media` is non-empty (the attachment is Media):

- **Trailing**: an X media permalink (`x.com`/`twitter.com`, `www.`/`mobile.`/
  `m.`, `/<handle|i>/status/<id>/(video|photo)/<1..4>`, any query or trailing
  slash) or a direct `video.twimg.com/…` / `pbs.twimg.com/(media|
  amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)/…` URL, even when
  `Post::links` has an entry for it with no card. The range starts at the
  whitespace before it (§3.1.1), so no blank line is left.
- **Mid-text**: the URL and one preceding space are hidden, with
  `hiddenRanges.embeddedMedia.strips` mirroring `n()`; a following space stays,
  so `"check <url> now"` becomes `"check now"`.
- **Left alone**: external links (`bit.ly`, `vercel.com`, `polygon.com`, …),
  non-media twimg URLs (`profile_images`, `card_img`) and `/status/<id>` links
  without `/video|photo/<n>` remain visible. With no attached media the URL is
  an ordinary link and stays.

Corpus: `ESPN.html:2120005259485425936` is a video post whose `full_text` ends
with the server-appended media `t.co`, hidden by `display_text_range`. No
captured post puts an X media permalink or a twimg media URL in its visible
text (0 of 288), so the corpus's external-link parity is unchanged.

### 3.2 Leading mentions: only in a reply

| Rule | Value | Status |
|---|---|---|
| Leading `@mentions` of a **reply** are hidden from the body, on both web surfaces | hide the leading run of mentions and the whitespace after them | **prior** (reply fact) |
| A plain post that starts with `@name` keeps the mention | not hidden | **verified** |
| A leading `.@name` escapes the reply form | not hidden | **prior** (twitter-text parses it as a mention at offset 1, so rules does not treat it as leading) |

Evidence that reply-ness, not the text shape, decides: captured post
`levelsio/2119915360849727842` opens with `@TermiusHQ` and the page prints it;
its `display_text_range` starts at **0**. The payload's reply marker (the status
it replies to, `reply_to_results`) is the fact rules needs, so `Post::replyTo`
gates the hide. `replyToHandle` alone is *not* the signal: it is also used for
the "Replying to" context row and can appear without X hiding the mention.
Replies are absent from the captured profile timelines (0/269), so the hidden
range itself still needs the behavior lab (§10).

### 3.3 Entity labels: the server's canonical spelling

| Rule | Value | Status |
|---|---|---|
| A mention/hashtag/cashtag prints the server's label when the payload has one | `Post::entityLabels[token]`, else the token as written | **verified** |

Captured post `elonmusk/2119617455102333206` says `Grok @Bot` in `full_text`,
its `mention_entities` carries `{indices:[44,48], screen_name:"bot"}`, and the
page prints `Grok @bot`. Rules uses the label; for a draft the map is empty and
the typed token is what shows.

### 3.4 Range units

The compact payload shape (what the logged-out pages embed) indexes
`display_text_range`, `url_entities.indices` and `media_entities2.indices` in
**code points**. ESPN's post `2120010545872949671` has range `[0, 83]` where 83
falls *between* the two UTF-16 halves of a trailing 👀, and a code-point slice
reproduces the page exactly. Rules maps any incoming UTF-16 boundary that
bisects a surrogate pair up to the next code point, never splicing the emoji.

## 4. Show more: two mechanisms

| # | Mechanism | Trigger | Status | Evidence |
|---|---|---|---|---|
| 1 | **Inline**, inside the text | A long post (`note_tweet.is_expandable: true`). The server sends a truncated `full_text`; the client appends `" Show more"` after the cut. | verified (mechanism) / derived (cut, §5) | `DBT-6Eh8.js` sha256 `2f2903ce42e05235…`: `we()` renders `jsxs(Fragment,{children:[\` \`,button]})`; `Ee()` label `t(\`Show more\`)`, color brand, `action:\`expand_read_more_inline\``. Still the markup today (`55591fe0`, captured `2120188488628977819` profile page): `<span …>TEXT</span> <button class="max-w-full text-[length:inherit] font-normal text-brand hover:underline" type="button">Show more</button>` — the button is an inline sibling inside the body div, with no block wrapper. |
| 2 | **Clamped**, below the text | A CSS line clamp overflowed. The client measures `scrollHeight > offsetHeight + 1` (or, for one line, `scrollWidth > offsetWidth + 1`) and switches state from `Collapsed` to `Truncated`. | verified | `CbDtO_Fz.js` `Mpe()`: `(r.scrollHeight>r.offsetHeight+1||n===1&&r.scrollWidth>r.offsetWidth+1)!==a&&o()?.()`. State machine `{Collapsed:0,Truncated:1,Expanded:2}` in `DBT-6Eh8.js`; the clamped button gets `className:\`self-start\`` (`Te()`). |

A "Show more" that looks like a block below the text is this inline button
**wrapped to the next line**: the `<button>` is `max-w-full`, so when the cut
ends near the line's width it moves to its own line instead of breaking
mid-word. The `self-start` variants in the same bundle (`Se`/`Ag`/`kg`) belong
to flex-column hosts (Grok answers, clamp overflows), not to the tweet text.
There is no second, block mechanism for long posts.

`note_tweet.is_expandable` is the server flag for mechanism 1. Corpus: 55 posts
carry `note_tweet`; 52 have `is_expandable: true`. The three `false` ones are
short notes (103–148 code points) whose `full_text` is the note plus an appended
media `t.co`; they never show "Show more" — captured pages of all three render
the whole body with no link, so `is_expandable` (not the presence of a note) is
the signal the converter and the engine use.

### 4.1 Clamps per surface

| Where | Clamp | Status | Evidence |
|---|---|---|---|
| Timeline main text | **none** | verified | Server-rendered cells: `class="… text-body … whitespace-pre-wrap wrap-anywhere"` with no `line-clamp-*` (`assets/vendor/upstream/probe.html`, `assets/vendor/capture/*.html`). Client: `numberOfLines = withShowMore ? undefined : 5` (`DIdg36-I.js` sha256 `8ee525ba2953ed75…`), so a timeline cell with Show more has no clamp. |
| Detail main text | **none** | verified | Post-detail markup, same classes; full text comes from `note_tweet`. |
| Quoted post | **5 lines** | verified | Captured profile markup: the quoted tweet's text carries `line-clamp-5` (`assets/vendor/capture/vercel.html`); client constant `WT=5` (`DIdg36-I.js`). The live `55591fe0` quote body has `line-clamp-5 whitespace-pre-wrap wrap-anywhere` (`2120188488628977819`). |
| Nested quote (quote of a quote) | **2 lines** | verified | Client constant `eT=2` (`DIdg36-I.js`, quote-preview component). |
| Profile bio | 3 lines | verified | `line-clamp-3` on the bio element (`probe.html` "Relevant people"). |
| Card title / description | 2 / 1 lines | verified (client) | `sm:line-clamp-1` with `numberOfLines:2` for the title, `max-sm:hidden sm:line-clamp-2` with `numberOfLines:1` for the description (`CbDtO_Fz.js`). Cards stream owns the card layout. |

The clamp class map only goes to five (`CbDtO_Fz.js`:
`numberOfLines:{1:\`line-clamp-1\`,…,5:\`line-clamp-5\`}`), which is why a quoted
post cannot clamp to six.

A clamped quote's ellipsis is CSS's, placed at the end of the **last visible
line**. When that line is blank, the result is a lone `…` line — the reported
quote card (`2118152230260092940`) has four text lines, then a blank paragraph
break as its fifth line. `rules::decide_quote` returns `clamp = Some(5)` for
exactly this; drawing the `…` on that line is the frame's job (it currently
only clips and reports the ellipsis).

`Decisions.clamp` therefore is `None` for both web main surfaces and `Some(5)`
from `rules::decide_quote`. The frame decides whether the clamp actually cut
lines and reports `showMore: "clamped"`.

## 5. The long-post cut (derived, approximate)

The server, not the client, cuts a long post. A captured payload already
carries the result: `display_text_range[1]` **is** the cut (271, 277, 279, 280,
281 across the corpus) and `full_text[..range[1]]`, followed by the media/card
`t.co`, is exactly what the page renders. The converter passes that body as
`Post::longPostBody` and rules lays it out verbatim; the derived cut below is
the fallback for a draft, which has no server state.

The derived cut, recovered from `note_tweet.text` versus `details.full_text`:

- The visible body is a **prefix** of `note_tweet.text`, ending on a whitespace
  boundary, with trailing whitespace trimmed.
- Then the server appends `" " + t.co` for the attached media or card, so
  `full_text.length = visible + 24`.
- Cut positions over the corpus's 32 truncated long posts: **263–282 UTF-16
  code units** (median 276), not code points. The live post
  `2120188488628977819` is the case that separates the two: X cuts at **259 code
  points = 273 UTF-16 units**, because its note uses math-bold digits and ✓/①/②
  (each a surrogate pair). A 280-code-point cut would run to 294 units.

Model: *take the first 280 **UTF-16 code units** (never splitting a surrogate
pair), back off to the last whitespace, trim the end.* Counting code points
here was a bug: it cut visibly later than X on any note with emoji or
math-bold text (the reported live post is exactly this). The unit change keeps
the corpus fit (44 of 52 exact, 84.6%; 44 of 49 comparable, 89.8%). Reproduce
with `node tools/rules/derive.mjs` ("long-post cut model").

The residual is the **preview length itself**: the server's cut varies inside
263–282 units (273 here, 281 for `Google.html`), so a draft can land within a
few characters but not exactly. The cut is not a fixed code-point or weighted
cap (a 280-unit word-end cut would keep the next word, `agent`, at 279 units;
X stopped at 273). What sets the exact preview length is not in the client; a
logged-in **home-timeline** capture of
`https://x.com/rauchg/status/2120188488628977819` would settle it.

### 5.1 The newer client expands a note that hides little (verified)

`1037d89b` changed what the *client* does with the server's cut. `BsiDb726.js`
(sha256 `e46395f6d8bf…`) wraps the text cell in:

```js
function f(e){ … let l=i;                       // i: Collapsed | Truncated | Expanded
  if (i.kind !== a.h.Expanded && i.onShowMore != null && s.note_tweet?.is_expandable === !0) {
    let e = s.note_tweet.note_tweet_results?.result?.text,
        n = pt(t.r(s, c)).text.plainText.length;
    e != null && n >= h && e.length - n <= g && (l = a.m)   // a.m = Expanded
  }
  return r(l)
}
… h = 200, g = 140
```

So a `1037d89b` timeline cell starts **expanded** (whole note, no inline link)
when the server's cut body is at least **200** characters and the note hides at
most **140** more. It only expands when the payload actually hides text
(`note > body`): a converter that passes the cut body as the text too has
nothing to expand. Both lengths are JavaScript string lengths, i.e. UTF-16 code
units; `n` is the plain text of the cut body (URLs in their displayed form) and
`e.length` is the raw `note_tweet.text`. The old client (`DIdg36-I.js`, sha256
`8ee525ba…`, `89824c04`) has the same `tweetNoteShowMore` button but no such
gate: it always shows the cut and the link.

The gate is an **allow-list** in `rules/x-web.json`
(`longPost.showMoreElision.enabledForAppVersions: ["1037d89b…"]`). The live
`55591fe0` bundle still ships the function (`D8W400Me.js`, same `h=200, g=140`),
but the live timeline does not apply it: captured post
`2120188488628977819` (note 356, cut 259, 97 hidden — which `1037d89b` would
expand) is shown **cut with a "Show more" button**. So an unknown or newer
version, and a draft (no version), render the cut. The gate only runs when the
payload carries `longPostBody`, the cut X actually sent: a draft keeps the
derived cut.

Corpus boundary (1037d89b pages): `text-cloudflare.html` note 414 hides 135 →
expanded; `text-stripe.html` `2114799287645393098` note 412 hides 139 →
expanded; `elonmusk.html` `2119857279361073655` note 429 hides 150 → cut. The
same stripe post `2118437899545038964` (note 338) is cut on the `89824c04` page
and whole on the `1037d89b` page, which is the cleanest same-post A/B.

This is why the rule is `derived` and `approximate: true`. It is good enough to
tell an author "the visible hook ends here" within a few characters, and it is
listed in the behavior lab for an exact settle. The engine never cuts inside an
entity: a half-rendered shortened URL would be worse than an earlier cut.

## 6. Which attachment wins

A post has at most a few attachments and X renders some, drops others. The model
exposes **one** attachment slot (`AttachmentKind`), so the rules stage picks the
one that X renders.

| Case | Decision | Status | Evidence |
|---|---|---|---|
| Media + a link in the text | Media; no card; the URL stays visible as text; warning | verified | 0 of 78 card posts have media, and 0 of 124 media posts have a card in the corpus. Client fragments render media and card from the same attachment slot. |
| Several links in the text | The **last** link with card metadata gets the card; earlier links stay visible | prior (pick), verified (mechanism) | The client hides the URL that equals `card.legacy.url` and stops at the first unmatched trailing URL (§3.1). Which link the crawler picked is server-side; the corpus has only single-URL card posts (61/61 card URLs match the sole URL entity). |
| Link + quoted post | Quote; no card; warning. If the author pasted the quoted post's own link at the end, it is hidden (handle must match the quoted author, since the model has no quoted id). | prior | Client renders quote and card from one slot; composer keeps one. No quote posts in the corpus (0/269). |
| Link + poll | Poll; no card; warning | prior | Composer cannot attach a poll with media; card preview is suppressed. No polls in the corpus (logged-out sampling). |
| Card dismissed in the composer | No card at all; no other link inherits it; both URLs stay visible | verified (mechanism) | `B5hEoqI4.js` sha256 `62035a684ae84fc4…`: `g=\`tombstone://card\``, `getSendPayload(e){return _.get(e).dismissed?{card_uri:g}:{}}`, and a subscription on the joined URL list resets `cardPreview` when it changes. |
| Card dismissed, then a link is added/removed/edited | The dismissal clears and the card returns | verified | Same subscription: `r.subscribeSelector(d,…)` where `d(e)` joins `url_entities` with `jetfuelUrl`. |
| Link whose page has no card tags | No card; URL shown as text | verified | `Post::links[url].card == None` by contract; the engine shows nothing and the URL stays. |
| Link position (start, middle, end) | Only trailing links can be replaced by the attachment | verified (client algorithm) | §3.1: a mid-text URL stays visible; a card URL is hidden only when it is the trailing entity. |
| Media and a poll in one draft | Poll, with a warning (X cannot attach both) | prior | Composer mutual exclusion; not observable logged out. |

Recognized card types in the client: `summary`, `summary_large_image`,
`player`, `app`, `unified_card` (`CbDtO_Fz.js`: `SNe=\`unified_card\``, binding
values with `binding_values`), plus `x.com` broadcast cards
(`745291183405076480:broadcast` in the corpus). Corpus card names:
`summary_large_image` 65, `summary` 4, broadcast 2, unnamed 7 (video/player
cards that the compact payload normalizes to no legacy name). Ad `unified_card`
formats need an ads account and are out of scope for now.

### 6.1 Why card URLs are not in `url_entities` for media posts

For a media post the server appends the media's `t.co` to `full_text` and hides
it with `display_text_range`; for a card post it appends the card's `t.co` and
**does not** hide it in `display_text_range` — the client hides it via the
attachment range. Both shapes were observed; the engine models the draft
(authored text only), so it hides a trailing card URL and leaves leading/media
URLs alone.

## 7. Report fields the rules stage fills

| Field | Value |
|---|---|
| `ruleset` | `x-web@89824c04` (ruleset id + first 8 of the app version it was derived from) |
| `verifiedFor` | `web-timeline`, `web-detail` (native surfaces are unverified) |
| `length` | weighted length, 280 limit, `valid` |
| `text.visible` | the body spans joined; shortened URLs, hidden ranges removed, cut applied |
| `text.truncated` | true when the timeline cut or the clamp cut |
| `text.showMore` | `"inline"` when the server cut applies; the frame sets `"clamped"` |
| `entities` | every parsed entity with its UTF-16 range and, for URLs, the display form |
| `hidden` | UTF-16 ranges with a reason ("leading mentions…", "trailing URL replaced by its card") |
| `attachment` | the chosen kind, the card URL, and why |
| `warnings` | suppressed card, dismissed card, cut point, over-limit, poll+media |

Warnings are the product for agents: "an image is attached, so the link card
will not render", "the timeline cuts this post after 277 characters; Show more
reveals the rest", "the card preview was dismissed in this draft; no card is
shown and no other link takes it".

## 8. Where the code is

| File | Contents |
|---|---|
| `crates/xeet-core/rules/x-web.json` | the ruleset values, statuses and evidence pointers |
| `src/rules/spec.rs` | embedded ruleset, `ruleset_id()`, `format_count()`, `format_relative_time()` |
| `src/rules/mod.rs` | `decide`, `decide_quote`, body spans, hidden ranges, attachment precedence, warnings |
| `src/rules/textport.rs` | shim for entity parsing, weighted length and `display_url` until `xeet-text` exports them; swap point documented in the file |
| `src/rules/tests.rs` | the rules matrix (one test per rule row in this document) |

`decide` is pure. It reads no clock: `Post::created_at`/`now` are inputs, and
the formatting helpers take milliseconds. It performs no I/O; the ruleset is
embedded with `include_str!`.

## 9. Formatting (needed by the frame)

### Relative timestamps

Verified in `CbDtO_Fz.js` sha256 `40030b8818a3d7c3…`,
`formatRelativePastTimestamp`:

| Age | Label |
|---|---|
| ≤ 0 s | `Now` (`nowLabel`) |
| < 60 s | `Ns` |
| < 60 min | `Nm` |
| < 24 h | `Nh`, plus ` Nm` when minutes ≠ 0 and `precision` is not `Hours` (timeline cells pass `Hours`, so `3h`) |
| same calendar year | `MMM d` (e.g. `Nov 5`) |
| earlier year | `MMM d, yyyy` |

The seconds/minutes/hours plurals are locale tables; English is `{0}s`,
`{0}m`, `{0}h`. The full timestamp on the detail page is
`h:mm AM · MMM d, yyyy` (`formatFullTimestamp`).

### Counts

There is no single count formatter. Which rule applies is a **call site**, and
they disagree: the action row abbreviates `1938` to `1.9K`, while the detail
view's Views label would show `1,938` for the same number. All four are recorded
in `rules/x-web.json` (`formatting.counts`) with their evidence.

| Call site | Rule | Examples |
|---|---|---|
| **Action row** — replies, reposts, likes, bookmarks (engagement pill) | Compact with `roundingMode: trunc` and **one** fraction digit; if that rendering is **5 characters or longer**, format again with **no** fraction digit. | `735`→`735`, `1938`→`1.9K`, `5264`→`5.2K`, `8071`→`8K`, `10355`→`10K`, `12490`→`12K`, `139073`→`139K`, `987654`→`987K`, `4082915`→`4M`, `4252767`→`4.2M`, `37047269`→`37M` |
| **Views** (detail label) and **profile stats** (`view-count-utils`) | Plain and grouped below 10,000; compact with one truncated fraction digit above. | `9999`→`9,999`, `10000`→`10K`, `12490`→`12.4K`, `987654`→`987.6K` |
| **Community member count** (`format-member-count`) | Compact with one truncated fraction digit at every magnitude. | `1234`→`1.2K`, `987654`→`987.6K` |
| **Poll totals** | Plain grouped integer, never abbreviated. | `1234`→`1,234` |

Evidence for the action row, which is the one the frame lays out:
`B8JKwKas.js` sha256 `95b6e2a00ef2968b…`, `engagement-button-Oyb-Yev6`:

```js
function a(e,t){ let n=d.get(t); ... n=new Intl.NumberFormat(t,f),d.set(t,n);
                 return n.format(e).length>=5?0:1 }
f={maximumFractionDigits:1,notation:`compact`,roundingMode:`trunc`}
// ... <AnimatedCount format={{...f,maximumFractionDigits:a(m,T.language)}} value={m} />
```

The 464 `aria-label`/rendered pairs in the captured markup confirm it exactly;
that table is the regression test in `frame/numbers.rs`, which now delegates to
`rules::spec::format_count`.

My earlier reading (plain below 10,000, one-decimal compact above) came from
`view-count-utils` (`29V4YPN-.js` sha256 `10b603cd9f5fe610…`:
`{compactCount: e<1e4 ? plain : compact(1 digit, trunc), fullCount}`). That is
the Views/profile-stats formatter, not the action row: using it for likes
renders `1938` as `1,938` where x.com shows `1.9K`, and `987654` as `987.6K`
where x.com shows `987K`. `spec::format_views_count` now carries that rule for
its own call site, and `spec::format_count` carries the action-row rule.
`spec::format_count`, `format_views_count`, `format_member_count` and
`format_plain_count` are the four implementations; frame's `numbers::compact`
delegates to the first.

### Media duration (the video's badge)

This one is the attachment slot's, not the frame's, but it lives here with the
other formatters. X does not hand-roll the clock: `BEV1NdT5.js`
sha256 `b616c69066203ef22484…` registers the i18n module
`unit-duration-to-video-timestamp-FqoFhlvP`, and the media badge in the same
chunk formats `duration - currentTime` with it
(`(0, d.n)(r, "seconds")`, `r = duration >= currentTime ? duration - currentTime : 0`):

```js
function r(e, t = `milliseconds`) {
  let n = [], r = Math.floor(e / (t === `milliseconds` ? 1e3 : 1)),
      i = Math.floor(r / 3600), a = Math.floor(r % 3600 / 60), o = r % 60;
  return i && n.push(i.toString().padStart(2, `0`)),
         n.push(a.toString().padStart(2, `0`)),
         n.push(o.toString().padStart(2, `0`)),
         n.join(`:`)
}
```

| Input (seconds) | Label | Note |
|---|---|---|
| 11.679 | `00:11` | **truncated**, not rounded (`Math.floor`); two-digit minutes |
| 86.708 | `01:26` | NASA's video; 87 would be wrong |
| 0 or no duration | `00:00` | the badge is always drawn; the server renders it before the player has metadata, which is why every captured timeline cell shows `00:00` |
| 3600 | `01:00:00` | hours appear **only** once non-zero, padded like the rest |
| 3723.4 | `01:02:03` | |
| 360000 | `100:00:00` | `padStart` never truncates a longer number |

Two captures agree with the code: `NBA.html`'s quoted video
(`duration_millis: 11679`) carries the server-rendered badge `00:11` — the
floored 11, not the rounded 12 — and 67 timeline cells carry `00:00`. A LIVE
stream shows `LIVE` instead of the clock, and a GIF's pill is a separate case
(no capture yet). `cards::media::duration_label` implements this rule and is
what both the full-size badge and the quoted-post thumbnail use; the
playground's replica (`tools/playground/lib/chrome-markup.mjs`,
`videoTimestamp`) transcribes the same function.

## 10. Behavior-lab checklist (unverified here)

These rows need the protected test account (the weekly
`.github/workflows/behavior-canary.yml` run).
Each says what to post and what to read back.

1. **Reply mentions.** Reply to one, two and three accounts; once with a body
   starting at the mention and once with `.@name`. Read `display_text_range[0]`
   and the rendered body. Settles §3.2.
2. **Repeated card-worthy link.** Put the same link at the start, middle and end.
   Confirm the card renders and which URL disappears.
3. **Two different card-worthy links.** Confirm which one wins (expect the last)
   and whether the other stays visible.
4. **Dismissed card.** Dismiss, post, read `card_uri` and the render. Then
   dismiss, edit a link, post: the card must be back.
5. **Link plus quote.** Post a link and quote a post. Confirm quote renders, card
   does not, URL stays as text.
6. **Link plus poll.** Same for a poll.
7. **Media plus link.** Confirm media renders, card does not, URL stays visible.
8. **Long-post cut.** With Premium, post notes of exactly 279, 280, 281 and 300
   characters with a trailing link and with a trailing media; read
   `full_text`/`note_tweet` and confirm the cut and the boundary rule. Settles
   §5 exactly.
9. **Long post in a quote.** Quote a long post; confirm the five-line clamp and
   where "Show more" sits.
10. **Poll forms.** Two, three and four choices, with and without votes; confirm
    the poll replaces a card and how the remaining-time label reads.
11. **Card types.** One URL per type (`summary`, `summary_large_image`,
    `player`, `app`, and an X Article). Confirm which render and their clamps.
12. **Native surfaces.** iOS and Android captures for the same rows; until then
    `verifiedFor` must stay web-only.

## 11. Keeping this current

- `node tools/rules/canary.mjs` pulls a fresh sample and re-asserts the derived
  rules: display URL form, the long-post cut bounds, hidden trailing URL shape,
  media-vs-card exclusivity. Exit code 0 means no drift. The canary is the
  passive half of the behavior canary; the active half is the behavior lab, run
  weekly by `.github/workflows/behavior-canary.yml` with the test account.
- `node tools/rules/derive.mjs --json …` re-derives the statistics from a fresh
  corpus; compare with the numbers quoted here.
- `node tools/rules/fetch-client.mjs --refresh` re-pins the client bundle. Any
  hash change means the evidence moved: re-read §2–§4 against the new chunks
  before trusting the ruleset.
- To change a rule: edit `rules/x-web.json` together with this file, bump
  `verifiedAt`, and let the rules matrix show the behavioral diff. A rule that
  changed between client versions goes under a `versions`-keyed object with
  `disabledForAppVersions` (see `longPost.showMoreElision`); `Post::appVersion`
  selects one, and an absent version means the newest.

## 12. Validated against the real pages (2026-11-10)

`node tools/ship/e2e.mjs` (docs/E2E.md) renders every payload in
`assets/vendor/corpus` and compares it with Chrome rendering the captured page.
The rules-owned buckets at the start of this round and after the fixes below:

| Bucket | Before | After |
|---|---|---|
| `content` (our text ≠ the page's text) | 46 | **0** |
| `long-post:content` | 5 | **0** |
| `long-post:text` | 13 | **0** |
| `long-post:layout` | 12 | **0** |
| `pass` | 25 | **144** |
| `error` | 3 | 0 |

The other remaining buckets are `raster`/`raster:emoji` (paint stream) and 131
`skip` rows (cards whose metadata the capture does not keep, quoted-card
duplicates, thread cells, blank captures; ship's harness decides those).

### Causes found and fixed

| Cause | Posts | Fix | Evidence |
|---|---|---|---|
| `display_text_range` is **code points** in the compact payload, not UTF-16 | 25 | converter slices code points; rules rounds any bisecting UTF-16 boundary up | ESPN `2120010545872949671` range `[0,83]` splits 👀; the code-point slice matches the page (§3.4) |
| A `t.co` URL must print the payload's `display_url` | most link posts | `Post::links[url].display` wins in `rules::url_display`; converter fills it | BBCWorld `2119986659206832581`: text `t.co/vAuRqIz67b`, page `bbc.in/4foQRxp` (§2) |
| Leading mentions were hidden on any post that starts with one | 1 | hide only when `Post::replyTo` is set | levelsio `2119915360849727842` (§3.2) |
| A long post's body is the server's cut, which the payload already carries | all long posts | `Post::longPostBody` is laid out verbatim; derived cut only for drafts | §5 |
| Short notes (`is_expandable: false`) were treated as long posts | 2 | long only when `is_expandable === true` | paulg `2119414341980012850`, jack `1833951636005552366` (§4) |
| A mention prints the server's canonical label | 1 | `Post::entityLabels` override | elonmusk `2119617455102333206`: `@Bot` → `@bot` (§3.3) |
| Entity offsets came from the note but were applied to the server body (different `t.co` inside) | 1 | parse the text actually laid out | TheAtlantic `2119988471032844498` before the fix |
| The harness started a new line at every entity span (per-text-node cursor) | 12 false `content` rows | harness fixed by ship during this round | `tools/ship/e2e.mjs` line walker comment |

### The note URL quirk the expansion exposed

Once the expanded cells were compared, three of them still differed on the last
line: a note's URL is stored with a `t.co` that differs from the token written
in the note text (`text-TheAtlantic.html`: entity `4AZpPEetg9`, text
`EGWRXJDhJ6`), and WHO's note entity set is not in `url_entities` at all. The
display URL belongs to the **indices**, so the converter now keys
`note_tweet…entity_set.urls` by the token at those indices. Those three pass.

No long-post case is left unexplained: every captured long post matches the
page's body, line breaks and height, on both client versions.

## 13. The live timeline report (2026-11-10)

Report: a long post quoting another post showed its body cut after *"…② the
ease at which the"* with "Show more" on its own line, while xeet cut later at
*"…the agent automatically"* with an inline " Show more". Captured through the
playground resolver (server-rendered, current client `55591fe0`):

| Question | Answer | Evidence |
|---|---|---|
| Which mechanism is the "block" Show more? | The **same inline mechanism**, wrapped to its own line. The markup is `<span>…</span> <button class="max-w-full … text-brand hover:underline">Show more</button>` inside the body div; `max-w-full` moves the button to the next line when the cut ends near the line width. There is no block long-post mechanism in the tweet cell. | captured `2120188488628977819` profile page (`55591fe0`), and three sibling posts in the same page; client `D8W400Me.js` still renders the inline fragment (`xe`, a space + button) |
| Why cut at 259, not 280? | The server's `display_text_range` for this post is `[0,259]`. **259 code points = 273 UTF-16 units**, because the note's ✓/①/② and math-bold digits (`𝟱𝟳…`) are surrogate pairs. A 280-**code-point** cut runs to 294 units — that was our bug. | payload `details.display_text_range`, `note_tweet.text` (356); corpus's 32 note cuts are 263–282 UTF-16 units |
| The quote card's lone `…` | The quote is clamped to 5 lines (`line-clamp-5`). Its text has four lines and then a blank paragraph break, which is line 5; CSS puts the ellipsis at the end of that blank line, so it renders alone. `rules::decide_quote` already returns `clamp = 5`. | quoted post `2118152230260092940` (161 code points, 6 lines at 468 px); live quote body class `line-clamp-5 whitespace-pre-wrap wrap-anywhere` |

Fixes: the derived cut counts **UTF-16 units** (§5); the 1037d89b expansion
gate is an allow-list and does not run for `55591fe0`, unknown versions or
drafts, so this post keeps its cut and link; the gate also requires the payload
to hide text (`note > body`), so a converter that passes the cut body as
`Post::text` still gets "Show more".

Still open: **the exact server preview length**. It varies (263–282 units in the
corpus, 273 here), and a 280-unit word-end cut would keep the next word
(`agent`, 279 units). The constant is not in the client. A logged-in
home-timeline capture of
`https://x.com/rauchg/status/2120188488628977819` (the resolver captured the
detail page, which shows the whole note and no button) would settle it; until
then a draft can be within a word of X but not exact.

## 14. Nested quote previews (outer → q1 → q2)

When the quoted post `q1` itself quotes `q2`, X may render a **nested quote
preview** inside the quote card. The code is `nested-quote-preview-SIs_tkfq` in
`dfWSwB9n.js` (55591fe0, sha256 `d44215ba04fa6bfd…`). The same eligibility
function and fragment hash (`eb326beec0968fb72285af4ec33cf74d`) live in
`89824c04` (`DIdg36-I.js`, sha256 `8ee525ba…`) and `1037d89b` (`BsiDb726.js`,
sha256 `e46395f6…`): the logic did **not** change across the three pinned
versions. `cards` gets the decision from
`rules::decide_nested_quote(outer, quoted, nested, opts) -> Option<Decisions>`
(see §14.3).

### 14.1 Eligibility (`H(e, t, n)`)

```js
function H(e,t,n){
  let r=ae(e), i=F(t), a=F(n),
      o=i.core…user.rest_id, s=a.core…user.rest_id;
  return r.isCrowded || s==null || a.rest_id===r.restId
      || (r.authorId!=null && r.authorId===o) || o===s
      || i.possibly_sensitive===true || i.birdwatch_pivot!=null
      || a.birdwatch_pivot!=null || ie(a)
    ? false
    : [r.rendersMedia, z(i), I(a)].filter(Boolean).length <= 1
}
```

Mapped to `model::Post`:

| Check | Rule | Notes |
|---|---|---|
| crowded outer | `outer.reply_to.is_some()` rejects | X also counts promoted, mid-conversation and birdwatch state; `Post` has none of those |
| missing q2 author | empty `nested.author.handle` rejects | mirrors `s == null` |
| same status | not modeled | `a.rest_id === r.restId` needs status ids, which `Post` does not carry |
| self-quote | `outer.author == q1.author` or `q1.author == q2.author` rejects | handles trimmed of `@`, ASCII-lowercased; both must be non-empty |
| q2 card/poll | any `nested.links` with `card: Some`, or `nested.poll` rejects | X's `ie()` also vetoes article/jetfuel/sensitive media, which `Post` does not model |
| media budget | at most **one** of: outer renders media (`media`, card, poll), q1 renders media (same), q2 has `media` | `[rendersMedia, z(q1), I(q2)].filter(Boolean).length <= 1` |

`rendersMedia` in X also counts articles, jetfuel attachments and a broadcast
card; here a link card or poll stands in for those.

### 14.2 What the preview renders

- **q2's text**: clamp **2 lines** (`numberOfLines: ke`, `ke = 2`; the component
  passes `size: "subtext1"`).
- **Entities**: `renderEntity: render-entity-as-text` (`B0X1tFzr.js`, sha256
  `e48f50b2…`). Mentions print `@screen_name`, hashtags `#text`, cashtags
  `$text`, timestamps their text and URLs their `displayUrl`; every span is
  `color: inherit; size: inherit; weight: inherit`, so **entities are plain
  primary text, not brand-colored links**. `Decisions.nested.plain_entities`
  tells `cards` this.
- **Media**: only q2's first media, as a **64px square thumbnail** with a `+N`
  overlay when it has more, and a play icon for video; the eligibility budget
  guarantees q2 is the only cell with media.
- **Frame**: a 3px `bg-tertiary` vertical rule on the left, a 64px (xs) avatar,
  the name line with a `since` timestamp, and a screen-reader-only `Quote`.
- **Hidden ranges on q2**: the same body rules as any post — a leading reply
  mention when `nested.reply_to` is set, and a trailing media `t.co` when q2 has
  media. There is no inline "Show more": the clamp is the only mechanism.
- **q1's own trailing permalink** is hidden whether or not the preview renders.
  Captured `elonmusk.html:2119812607117062451`: q1's `full_text` ends
  `…economic impact of the project is https://t.co/b9jaRGUqZv` (the quote's
  permalink) and the rendered quote ends at `…of the project is`. For a payload
  the server range already excludes it; for a draft the quote attachment hides
  a matching `x.com/<q2>/status/…` link (§3.1).

### 14.3 API

```rust
pub fn decide_nested_quote(
    outer: &Post,
    quoted: &Post,   // q1, the post `outer` quotes
    nested: &Post,   // q2, the post `quoted` quotes
    opts: &RenderOptions,
) -> Option<Decisions>;

pub fn nested_quote_eligible(outer: &Post, quoted: &Post, nested: &Post) -> bool;
```

`Some(decisions)` carries `clamp = Some(2)` and
`nested = Some(NestedQuotePreview { plain_entities: true, media_thumb: !q2.media.is_empty() })`;
`None` means X shows q1 alone (no preview). `cards` draws q2's text and, when
`media_thumb` is set, `nested.media[0]` as the 64px thumbnail. `Decisions` gained
one additive field (`nested`), and `NestedQuotePreview` is new.

### 14.4 Corpus check: all five nested quotes are rejected

| Post | Why X rejects it | Preview markup in the page |
|---|---|---|
| `elonmusk.html:2119812607117062451` (elonmusk → SawyerMerritt [photo] → SERobinsonJr [video]) | q1 and q2 both render media (2 in the budget) | none |
| `NBA.html:2120015774983008464` (NBA → NBA → NBA) | self-quote `q1 == q2` (also two media) | none |
| `binance.html:2119655363385659500` (binance → binance → binance) | self-quote `q1 == q2` | none |
| `text-karpathy.html:2109361546505966046` (karpathy → karpathy → staysaasy) | self-quote `outer == q1` | none |
| `text-levelsio.html:2116843791214629021` (levelsio → levelsio → iamgingertrash) | self-quote `outer == q1` (and outer media) | none |

Confirmed against the captured HTML: none of the five pages contains the
preview's markup (`w-[3px]`, `rounded-[9px]`, the sr-only `Quote`). Note that
the compact payload does not include q2's content (no text/media; the client
fetches it with `getNestedQuotePreviewTweet_quoted`), so for elonmusk the
"two media" fact comes from live evidence against the real post, not from our
payload copy; the other four are rejected by the handle checks on the payload
alone.

Unverified here: promoted/mid-conversation/birdwatch crowding, sensitive-media
flags and article/jetfuel attachments are not in `Post`. A positive preview
cannot be produced from the captured corpus (all five are rejected, and q2 is
fetched separately); the rules matrix covers it with constructed posts.
