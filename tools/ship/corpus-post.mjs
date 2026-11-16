// Turning a captured x.com payload into a `model::Post`, for the end-to-end
// acceptance run (PLAN.md §10 layer 2, §15 Phase 0 gate).
//
// The payloads come out of `assets/vendor/corpus/*.html` with
// `tools/oracle/samples.mjs extractTweets`: they are the same GraphQL objects
// the server used to render the page, so this is a translation, not a guess.
//
// Everything that cannot be recovered from a logged-out capture is either
// derived (relative timestamps need a reference time; the lockfile's fetch time
// is used) or explicitly marked so the harness can skip the case instead of
// comparing something it did not model:
//
//   - **Card metadata.** The payload carries only `card.id`; the title,
//     description and image live in a separate binding the capture does not
//     keep. Posts with a card are reported as such and excluded from the strict
//     comparison.
//   - **Image bytes.** Blocked at capture time, on purpose. The harness renders
//     placeholders on both sides, which is why the pixel comparison masks the
//     image rectangles.
//   - **Polls.** Not present in this corpus (`card` is where they would appear),
//     so there is nothing to translate yet.

/** The fields of a payload that this converter reads. */
const text = (s) => (typeof s === "string" ? s : "");

/**
 * Removes unpaired UTF-16 surrogates.
 *
 * `display_text_range` is in UTF-16 units, and a slice at a range boundary can
 * land between the halves of an emoji. A lone surrogate is not a valid JSON
 * string, so `JSON.stringify` would emit an escape that the strict parser (and
 * every other JSON parser) refuses. X never exposes such a range, but a
 * compromised capture or a translated text can.
 */
/**
 * Decodes the HTML entities that the server-rendered payload carries.
 *
 * The JSON blob is embedded in the page, so X escapes `&`, `<`, `>` and quotes
 * inside it: a post's `full_text` really contains `Peace &amp; Development`.
 * Left alone, xeet would render the escape.
 */
function unescapeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&");
}

function wellFormed(s) {
  s = unescapeEntities(s);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      }
      // else: a high surrogate with no low half, dropped
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // a low surrogate with no high half, dropped
    } else {
      out += s[i];
    }
  }
  return out;
}

function authoredBy(tweet) {
  const user = tweet?.core?.user_results?.result ?? {};
  const core = user.core ?? {};
  const verification = user.verification ?? {};
  let verified = "none";
  if (verification.verified_type === "Business") verified = "business";
  else if (verification.verified_type === "Government") verified = "government";
  else if (verification.is_blue_verified) verified = "blue";
  const affiliate = user.identity_profile_labels_highlighted_label?.label;
  return {
    name: text(core.name),
    handle: text(core.screen_name),
    verified,
    ...(affiliate?.description ? { affiliate: { name: text(affiliate.description), badge: null } } : {}),
    ...(user.privacy?.protected ? { protected: true } : {}),
    ...(user.profile_image_shape === "Square" ? { squareAvatar: true } : {}),
  };
}

function mediaOf(tweet) {
  const out = [];
  // The post's own author, to tell "this account's media" from "someone else's
  // media that this post embeds".
  const own = text(tweet?.core?.user_results?.result?.core?.screen_name).toLowerCase();
  for (const m of tweet?.media_entities2 ?? []) {
    const info = m.original_info ?? {};
    if (!info.width || !info.height) continue;
    const kind = m.type === "video" || m.type === "animated_gif" ? (m.type === "animated_gif" ? "gif" : "video") : "image";
    // Attribution: a post can carry another account's photo or video, and X
    // prints that account's name and avatar in the media's corner (ESPN embeds
    // the NFL's highlight reel). `source_user_results` is that account; it is
    // absent for the author's own media, and the same account can appear in
    // both cases, so compare screen names case-insensitively rather than
    // trusting presence.
    const source = m?.source_user_results?.result;
    const sourceHandle = text(source?.core?.screen_name);
    const attributed = Boolean(sourceHandle) && sourceHandle.toLowerCase() !== own;
    out.push({
      kind,
      width: Math.round(info.width),
      height: Math.round(info.height),
      ...(m.ext_alt_text ? { alt: text(m.ext_alt_text) } : {}),
      ...(m.video_info?.duration_millis ? { duration: m.video_info.duration_millis / 1000 } : {}),
      // `source_user_results` is already the `UserResults` object (`{ id, result }`),
      // so it slots in where a tweet's `core.user_results` sits.
      ...(attributed
        ? { sourceAuthor: authoredBy({ core: { user_results: m.source_user_results } }) }
        : {}),
      // No `data`: the capture has no image bytes, so the renderer draws its
      // placeholder with the right crop, and so does the Chrome side.
    });
  }
  return out;
}

/**
 * The displayed body: `full_text`, cut to `display_text_range` when present.
 *
 * The compact payload shape (what the logged-out pages embed) indexes
 * `display_text_range` and entity `indices` in **code points**, not UTF-16:
 * ESPN's post `2120010545872949671` has range `[0, 83]` where 83 falls between
 * the two UTF-16 halves of a trailing 👀, and a code-point slice reproduces the
 * page's text exactly. Slicing by UTF-16 units would drop the emoji and shift
 * every later character. A boundary that still lands inside a surrogate pair
 * (a caller passing a legacy range) rounds up to the next code point rather
 * than splicing it.
 */
export function displayText(tweet) {
  const details = tweet?.details ?? {};
  const full = text(details.full_text);
  const cps = [...full];
  const range = details.display_text_range;
  if (!Array.isArray(range) || range.length !== 2) return wellFormed(full);
  const start = Number.isFinite(range[0]) ? Math.max(0, Math.min(range[0], cps.length)) : 0;
  const end = Number.isFinite(range[1]) ? Math.max(start, Math.min(range[1], cps.length)) : cps.length;
  return wellFormed(cps.slice(start, end).join(""));
}

/**
 * Converts one payload into `{ post, meta }`.
 *
 * `meta` records what the converter could not model, so the harness can skip
 * or annotate the case instead of scoring a comparison it set up to fail.
 */
export function payloadToPost(tweet, { now, appVersion, byId } = {}) {
  const meta = { restId: tweet?.rest_id ?? null, unsupported: [] };
  const text_ = displayText(tweet);
  if (!text_) meta.unsupported.push("no text");

  const noteTweet = tweet?.note_tweet;
  const longPostText = noteTweet?.note_tweet_results?.result?.text;
  // A note exists for short posts too (a 103-character post with media carries
  // one), and those are not expandable: X shows the whole body and no
  // "Show more". `is_expandable` is the server flag for the inline mechanism.
  const hasNote = typeof longPostText === "string" && longPostText.length > 0;
  // `is_expandable` is the server flag for the *inline* Show more mechanism — but
  // it is not sufficient: every note payload we captured says `true`, including
  // cells that render the whole note with no button (see docs/E2E.md, "The
  // Show more affordance"). The payload fact that *does* separate them is
  // whether the server cut the body: `details.full_text` is what the cell gets,
  // and a note it covers in full was not cut.
  const serverCut = hasNote && text_.length < longPostText.length - 1 && !text_.endsWith("…");
  const isLong = noteTweet?.is_expandable === true && hasNote && serverCut;
  const body = wellFormed(isLong ? longPostText : text_);

  const media = mediaOf(tweet);
  // Accounts tagged in the media: X prints them under it ("Name and 2 others",
  // `div.text-subtext2` before the engagement row).
  const mediaTags = (tweet?.media_entities2 ?? []).flatMap((m) =>
    (m?.features?.all?.tags ?? [])
      .filter((t) => t?.name && (t.type ?? "user") === "user")
      .map((t) => text(t.name)),
  );

  // The payload's own display forms: `bbc.in/4foQRxp` for a `t.co` link the
  // text only names in redirect form. Rules prints these instead of reshaping
  // the t.co URL.
  const links = {};
  for (const u of tweet?.url_entities ?? []) {
    if (!u?.url || !u?.display_url) continue;
    links[u.url] = { display: u.display_url };
  }
  // A note's entity set is separate, and the t.co it names can differ from the
  // token written in the note (X re-shortens the URL when it appends it); the
  // indices are what point at the text, so key by the token actually written.
  const noteText = tweet?.note_tweet?.note_tweet_results?.result?.text;
  const noteEntitySet = tweet?.note_tweet?.note_tweet_results?.result?.entity_set;
  for (const u of [...(noteEntitySet?.urls ?? []), ...(noteEntitySet?.url_entities ?? [])]) {
    if (!u?.display_url) continue;
    const [start, end] = u.indices ?? [];
    if (Number.isInteger(start) && Number.isInteger(end) && noteText) {
      const written = [...text(noteText)].slice(start, end).join("");
      if (written) links[written] = { display: u.display_url };
    }
    if (u.url) links[u.url] = { display: u.display_url };
  }

  // Canonical entity labels: the payload renders a mention by its screen_name
  // (`@Bot` in the text is `@bot` on the page), so carry the label rules prints.
  const entityLabels = {};
  const all = [...text(tweet?.details?.full_text)];
  for (const m of tweet?.mention_entities ?? []) {
    const [s, e] = m?.indices ?? [];
    if (!Number.isInteger(s) || !Number.isInteger(e) || !m?.screen_name) continue;
    const written = all.slice(s, e).join("");
    if (written) entityLabels[written] = `@${m.screen_name}`;
  }

  // Reply-ness is server state: X hides a reply's leading mentions, but a plain
  // post that starts with a mention keeps them.
  const replyTo = tweet?.reply_to_results?.rest_id ?? tweet?.details?.in_reply_to_status_id_str ?? null;
  // The quote's `Replying to @handle` row needs the handle, not the status id.
  const replyToHandle =
    tweet?.reply_to_user_results?.result?.core?.screen_name ??
    tweet?.details?.in_reply_to_screen_name ??
    null;
  const counts = tweet?.counts ?? {};
  // X shows one number for reposts, and it is retweets plus quotes: jack's
  // post 20 has 126,458 retweets and 8,009 quotes and the page says "134K".
  const reposts = Number(counts.retweet_count ?? 0) + Number(counts.quote_count ?? 0);
  const post = {
    text: body,
    // The body the server put in the cell, verbatim: the cut when there is one,
    // the whole note when the note fit. Passing it means `rules` renders what X
    // rendered instead of re-deriving a cut. `longPost` says whether the cell
    // draws the inline affordance.
    ...(hasNote ? { longPostBody: wellFormed(text_) } : {}),
    // Rule behavior changed between client versions (SPEC.md §5): the page's
    // `data-app-version` lets `rules` pick the same one the page used.
    ...(appVersion ? { appVersion: String(appVersion) } : {}),
    ...(Object.keys(links).length ? { links } : {}),
    ...(Object.keys(entityLabels).length ? { entityLabels } : {}),
    ...(replyTo ? { replyTo: String(replyTo) } : {}),
    ...(replyToHandle ? { replyToHandle: String(replyToHandle) } : {}),
    author: authoredBy(tweet),
    createdAt: tweet?.details?.created_at_ms ? new Date(tweet.details.created_at_ms).toISOString() : null,
    ...(now ? { now } : {}),
    counts: {
      replies: Number(counts.reply_count ?? 0),
      reposts,
      likes: Number(counts.favorite_count ?? 0),
      views: Number(tweet?.views?.count ?? 0),
      bookmarks: Number(counts.bookmark_count ?? 0),
    },
    ...(isLong ? { longPost: true } : {}),
  };
  if (media.length) post.media = media;
  if (mediaTags.length) post.mediaTags = mediaTags;

  if (isLong) meta.longPost = true;
  if (tweet?.card) {
    meta.unsupported.push("card (metadata lives in a binding the capture does not keep)");
    meta.card = true;
  }
  if (Array.isArray(tweet.media_entities2) && tweet.media_entities2.some((m) => m.type === "video" || m.type === "animated_gif")) {
    meta.hasVideo = true;
  }
  // A quote, and the quote of that quote (depth 2 is the deepest X renders).
  //
  // The second level does not always arrive whole. When X decides a nested
  // preview is not worth sending, `nested_quoted_tweet_results.result` carries a
  // stub: `rest_id` and the author's `core`, no `details` (so no `full_text`).
  // That is not an unsupported *post* — the same page almost always carries the
  // full tweet somewhere else, because something else on it embeds it. Resolve
  // the stub by `rest_id` from the page's own payloads; if the page does not have
  // it either, leave the second level out rather than calling the outer post
  // unsupported (nothing about the outer post is unknown).
  const quotedResult =
    tweet?.quoted_tweet_results?.result ?? tweet?.nested_quoted_tweet_results?.result ?? null;
  if (quotedResult) {
    const stub = !quotedResult.details && !quotedResult.note_tweet;
    const full = stub && quotedResult.rest_id ? byId?.get(quotedResult.rest_id) : null;
    const quoted = full ?? quotedResult;
    if (stub) meta.quoteResolvedFromPage = Boolean(full);
    const inner = payloadToPost(quoted, { now, appVersion, byId });
    // A stub with no fuller copy on the page is a suppressed preview: report the
    // outer post as renderable, and say the inner level is missing rather than
    // "no text" (which reads as a conversion bug).
    const suppressed = stub && !full && !displayText(quoted);
    if (suppressed) {
      meta.suppressedQuote = quotedResult.rest_id ?? true;
    } else {
      if (inner.meta.unsupported.length)
        meta.unsupported.push(...inner.meta.unsupported.map((u) => `quoted: ${u}`));
      post.quote = inner.post;
      meta.hasQuote = true;
    }
  }

  // Drop nulls: the strict parser refuses unknown or mistyped keys, and a null
  // `createdAt` is not the same as an absent one for the frame.
  for (const [k, v] of Object.entries(post)) if (v === null) delete post[k];
  return { post, meta };
}

/**
 * Every payload in a captured page, in DOM order, as `{ post, meta }`.
 * `now` is the reference time for relative timestamps; the lockfile's fetch
 * time is the honest choice, because that is when the page was captured.
 */
export function postsFromHtml(html, { now, extractTweets }) {
  const appVersion = html.match(/"appVersion":"([0-9a-f]+)"/)?.[1] ?? null;
  const tweets = extractTweets(html);
  // Every payload on the page, by id: the source for resolving a nested quote
  // that arrived as a stub (see `payloadToPost`).
  const byId = new Map(tweets.map((t) => [t.rest_id, t]));
  return tweets.map((t) => payloadToPost(t, { now, appVersion, byId }));
}
