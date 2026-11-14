//! An X post page (or payload) → `model::Post`.
//!
//! This is a port of `tools/ship/corpus-post.mjs`'s `payloadToPost` and
//! `tools/oracle/samples.mjs`'s `extractTweets`, which is what the playground's
//! `resolve.mjs` has always done: fetch `https://x.com/i/status/<id>` **logged
//! out with a browser user agent**, and read the payloads the server render
//! embeds in the HTML. There is no API, no session, no GraphQL call: the page's
//! own JSON is the source, which is why a captured page and a live fetch produce
//! the same post (`docs/E2E.md`).
//!
//! The details that matter, and why (each is in the converter's own docs):
//!
//! - `display_text_range` indexes **code points** in the compact logged-out
//!   payload, so the slice is by `char`, not UTF-16 or bytes.
//! - The payload is escaped JSON inside a JSON string; `&amp;` in a post's text
//!   is markup, so entities are decoded once.
//! - `longPostBody` is the body X's server put in the cell; `longPost` says
//!   whether the cell draws the inline affordance. A note exists for short posts
//!   too, and `is_expandable` alone does not distinguish them — whether the
//!   server cut the body does.
//! - `reposts` is retweets **plus** quotes: X prints one number.
//! - Reply-ness is server state: a payload with `reply_to_results` hides its
//!   leading mentions, a plain post keeps them.
//! - **Two quote levels.** X's nested quote preview (`nested-quote-preview-SIs_tkfq`)
//!   draws the quoted post's own quoted post, and no further: `quote.quote` is
//!   filled, `quote.quote.quote` is dropped. Each level arrives in *two* slots —
//!   `quoted_tweet_results` and `nested_quoted_tweet_results` — and only one of
//!   them is the real copy: at the second level `quoted_tweet_results` is a
//!   six-key stub (`id`, `rest_id`, `__typename`) while
//!   `nested_quoted_tweet_results` carries the text and media. All five
//!   two-level quotes in the corpus have that shape (`elonmusk.html`
//!   `2119812607117062451`, `NBA.html`, `binance.html`, `text-karpathy.html`,
//!   `text-levelsio.html`), so the resolver takes the richer of the two.
//! - A pinned post's payload is wrapped in a timeline entry whose
//!   `socialContext.context_type` is `Pin` (not `Pinned`); the tweet object does
//!   not carry it.

use serde_json::Value;
use xeet_core::model::{Author, Counts, Media, MediaKind, Post, SocialContext, Verified};

/// How many quote levels a post carries: `post.quote` and `post.quote.quote`.
///
/// Two, because that is what X draws (`nested-quote-preview-SIs_tkfq` shows the
/// quoted post's quote as a compact row — 16 px avatar, one 64×64 thumbnail —
/// and stops), and because it is the renderer's own cap:
/// `limits::Limits::max_quote_depth` is 2 and `post.quote.quote.quote` is a
/// validation error. A third level is dropped rather than modeled.
///
/// [`resolve`](crate::resolve) passes the limit it was given, so a caller that
/// raises `Options::limits` gets a deeper tree; this constant is what
/// [`payload_to_post`] uses on its own.
pub const QUOTE_DEPTH: usize = 2;

/// One payload that looks like a post (`__typename: "Tweet"`, `details`,
/// `rest_id`).
pub fn extract_payloads(html: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut seen: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for candidate in quoted_strings_containing(html, "full_text") {
        // The HTML holds `"<escaped JSON>"`; decode the JSON string, then parse
        // the JSON inside it.
        let decoded = match serde_json::from_str::<String>(&format!("\"{candidate}\"")) {
            Ok(decoded) => decoded,
            Err(_) => continue,
        };
        let value: Value = match serde_json::from_str(&decoded) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let mut found = Vec::new();
        walk_tweets(&value, &mut found);
        for tweet in found {
            let id = tweet
                .get("rest_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if id.is_empty() {
                continue;
            }
            // A page embeds the same post more than once — as the post itself,
            // as a *stub* inside someone's `quoted_tweet_results` (six keys: id,
            // rest_id, __typename), and as the slim client-extension fragment X
            // ships in a later SSR chunk (same `full_text`, same media, but a
            // `user_results` with no `profile_image_shape` and no affiliation
            // label — the very fields a cell draws). The richest copy is the
            // real one; a strictly richer one replaces it, and whatever the
            // winner lacks is filled in from the loser, so neither text nor user
            // metadata is ever lost.
            match seen.get(&id) {
                Some(index) => {
                    if richness(&tweet) > richness(&out[*index]) {
                        let mut winner = std::mem::replace(&mut out[*index], Value::Null);
                        merge_missing(&mut winner, &tweet);
                        out[*index] = winner;
                    } else {
                        merge_missing(&mut out[*index], &tweet);
                    }
                }
                None => {
                    seen.insert(id, out.len());
                    out.push(tweet);
                }
            }
        }
    }
    out
}

/// The ids of posts whose timeline entry says `Pin`, from a captured page.
///
/// The marker is `\"context_type\":\"Pin\"`; the first `rest_id` within 800
/// characters is the post it belongs to.
pub fn pinned_ids(html: &str) -> Vec<String> {
    let marker = "\\\"context_type\\\":\\\"Pin\\\"";
    let mut ids = Vec::new();
    let mut from = 0;
    while let Some(at) = html[from..].find(marker) {
        let start = from + at + marker.len();
        from = start;
        let window: String = html[start..].chars().take(800).collect();
        if let Some(id) = first_rest_id(&window) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

/// `"appVersion":"<hex>"` from a page, the client version the payload came from.
pub fn app_version(html: &str) -> Option<String> {
    let index = html.find("\"appVersion\":\"")?;
    let rest = &html[index + "\"appVersion\":\"".len()..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn first_rest_id(text: &str) -> Option<String> {
    let marker = "\\\"rest_id\\\":\\\"";
    let index = text.find(marker)?;
    let rest = &text[index + marker.len()..];
    let end = rest.find("\\\"")?;
    let id = &rest[..end];
    if id.chars().all(|c| c.is_ascii_digit()) {
        Some(id.to_string())
    } else {
        None
    }
}

/// Every quoted JSON string in `html` that contains `needle`, with its escapes
/// intact (the caller decodes it).
fn quoted_strings_containing(html: &str, needle: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = html.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'"' {
            index += 1;
            continue;
        }
        let start = index + 1;
        let mut end = start;
        let mut escaped = false;
        while end < bytes.len() {
            match bytes[end] {
                b'\\' if !escaped => {
                    escaped = true;
                    end += 1;
                    continue;
                }
                b'"' if !escaped => break,
                _ => escaped = false,
            }
            end += 1;
        }
        if end >= bytes.len() {
            break;
        }
        if let Some(candidate) = html.get(start..end) {
            if candidate.contains(needle) {
                out.push(candidate.to_string());
            }
        }
        index = end + 1;
    }
    out
}

fn walk_tweets(value: &Value, out: &mut Vec<Value>) {
    match value {
        Value::Object(map) => {
            let is_tweet = map.get("__typename").and_then(Value::as_str) == Some("Tweet")
                && map.get("rest_id").and_then(Value::as_str).is_some()
                && map
                    .get("details")
                    .and_then(|details| details.get("full_text"))
                    .map(|text| !text.is_null())
                    .unwrap_or(false);
            if is_tweet {
                out.push(value.clone());
            }
            for child in map.values() {
                walk_tweets(child, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                walk_tweets(item, out);
            }
        }
        _ => {}
    }
}

/// The quoted post's payload: whichever of X's two slots carries the real copy.
///
/// At the first level it is `quoted_tweet_results`; at the second level X puts a
/// six-key stub there and the post itself in `nested_quoted_tweet_results`
/// (see the module docs). Ties go to `quoted_tweet_results`, the canonical slot.
pub fn quote_payload(tweet: &serde_json::Value) -> Option<&serde_json::Value> {
    let quoted = tweet.pointer("/quoted_tweet_results/result");
    let nested = tweet.pointer("/nested_quoted_tweet_results/result");
    match (quoted, nested) {
        (Some(quoted), Some(nested)) => Some(if richness(nested) > richness(quoted) {
            nested
        } else {
            quoted
        }),
        (Some(quoted), None) => Some(quoted),
        (None, Some(nested)) => Some(nested),
        (None, None) => None,
    }
}

/// How much a payload actually says: its text, its media, **and the author
/// metadata a cell draws**.
///
/// The user fields are not decoration. X's detail pages ship the same post in
/// several SSR chunks, and the client-extension fragment repeats the `full_text`
/// and the media verbatim while dropping `profile_image_shape` and
/// `identity_profile_labels_highlighted_label` — `@cursor_ai`'s page
/// (`2118458629091426304`) has three copies, the middle one slim in exactly those
/// fields. Scoring only text and media ties them, and a later tie used to
/// overwrite the real copy, which is why the playground showed a round avatar
/// with no gold badge for a square business account.
///
/// The weights put a copy that can draw the author above one that cannot, while
/// still preferring more text and more media among copies that both can.
fn richness(payload: &serde_json::Value) -> usize {
    let text = payload
        .pointer("/details/full_text")
        .and_then(serde_json::Value::as_str)
        .map(|text| text.chars().count())
        .unwrap_or(0);
    let note = payload
        .pointer("/note_tweet/note_tweet_results/result/text")
        .and_then(serde_json::Value::as_str)
        .map(|text| text.chars().count())
        .unwrap_or(0);
    let media = payload
        .get("media_entities2")
        .and_then(serde_json::Value::as_array)
        .map(|media| media.len())
        .unwrap_or(0);
    // One image is worth more than a short sentence: a stub with neither is 0.
    let mut score = text + note + media * 64;
    let user = payload.pointer("/core/user_results/result");
    let has = |value: Option<&serde_json::Value>| {
        value
            .map(|value| {
                !value.is_null()
                    && value
                        .as_object()
                        .map(|object| !object.is_empty())
                        .unwrap_or(true)
            })
            .unwrap_or(false)
    };
    if has(payload.get("profile_image_shape"))
        || has(user.and_then(|user| user.get("profile_image_shape")))
    {
        score += 512;
    }
    if has(user.and_then(|user| {
        user.pointer("/identity_profile_labels_highlighted_label/label/description")
    })) {
        score += 512;
    }
    if has(user.and_then(|user| user.pointer("/avatar/image_url"))) {
        score += 256;
    }
    if has(user.and_then(|user| user.get("verification"))) {
        score += 256;
    }
    if has(user.and_then(|user| user.get("core"))) {
        score += 256;
    }
    if has(payload.get("counts")) {
        score += 128;
    }
    score
}

/// Fills what `into` lacks from `from`: the author object
/// (`core.user_results.result`) and the post's own `profile_image_shape`.
///
/// The copies of a post on one page are the same post, so this never invents a
/// value — it only repairs one that a slim chunk dropped. Objects merge one level
/// deep, which is where the differences are (`core`, `avatar`, `verification`,
/// `identity_profile_labels_highlighted_label`).
fn merge_missing(into: &mut serde_json::Value, from: &serde_json::Value) {
    if into.is_null() {
        *into = from.clone();
        return;
    }
    let Some(source) = from.as_object() else {
        return;
    };
    let Some(target) = into.as_object_mut() else {
        return;
    };
    // The square-avatar flag sits on the tweet itself on some pages and inside
    // the author on others; either way the resolver reads both.
    if target.get("profile_image_shape").is_none() {
        if let Some(value) = source.get("profile_image_shape") {
            target.insert("profile_image_shape".to_string(), value.clone());
        }
    }
    let Some(source_user) = source
        .get("core")
        .and_then(|core| core.pointer("/user_results/result"))
        .and_then(serde_json::Value::as_object)
    else {
        return;
    };
    let user = user_mut(into);
    for (key, value) in source_user {
        match user.get_mut(key) {
            None => {
                user.insert(key.clone(), value.clone());
            }
            Some(existing) => fill_missing(existing, value),
        }
    }
}

/// Copies into `into` every field `from` has and `into` lacks, at any depth. A
/// slim copy can keep `identity_profile_labels_highlighted_label.label` (the
/// name) and drop `label.badge.url`; a one-level merge kept the name and lost
/// the badge, which drew an empty square next to a quoted author. Scalars both
/// copies have stay as the kept copy wrote them.
fn fill_missing(into: &mut serde_json::Value, from: &serde_json::Value) {
    if into.is_null() {
        *into = from.clone();
        return;
    }
    let (Some(target), Some(source)) = (into.as_object_mut(), from.as_object()) else {
        return;
    };
    for (key, value) in source {
        match target.get_mut(key) {
            None => {
                target.insert(key.clone(), value.clone());
            }
            Some(existing) => fill_missing(existing, value),
        }
    }
}

/// `value` as an object, replacing anything else with an empty one.
fn as_object_mut_or_new(
    value: &mut serde_json::Value,
) -> &mut serde_json::Map<String, serde_json::Value> {
    if !value.is_object() {
        *value = serde_json::Value::Object(serde_json::Map::new());
    }
    match value {
        serde_json::Value::Object(map) => map,
        _ => unreachable!("just made it an object"),
    }
}

/// The author object of a tweet payload, created if a slim copy omitted it.
fn user_mut(tweet: &mut serde_json::Value) -> &mut serde_json::Map<String, serde_json::Value> {
    let empty = || serde_json::Value::Object(serde_json::Map::new());
    let core = as_object_mut_or_new(tweet)
        .entry("core")
        .or_insert_with(empty);
    let user_results = as_object_mut_or_new(core)
        .entry("user_results")
        .or_insert_with(empty);
    let result = as_object_mut_or_new(user_results)
        .entry("result")
        .or_insert_with(empty);
    as_object_mut_or_new(result)
}

/// Converts one payload into a `Post`.
///
/// `now` is the reference time for relative timestamps (as an ISO 8601 string);
/// `app_version` lets `rules` pick the behavior of the client that rendered the
/// page (SPEC.md §5).
pub fn payload_to_post(tweet: &Value, now: Option<&str>, app_version: Option<&str>) -> Post {
    payload_to_post_with(tweet, now, app_version, QUOTE_DEPTH)
}

/// `payload_to_post` with an explicit budget of quote levels below the payload.
///
/// `budget` is how many levels the caller will draw: 2 for a post that is the
/// root of the tree, 1 for a payload that is itself going to sit at level 1
/// (`attach_quote_from_text` fetches a post that becomes `post.quote`, so it may
/// only carry one level of its own).
pub fn payload_to_post_with(
    tweet: &Value,
    now: Option<&str>,
    app_version: Option<&str>,
    budget: usize,
) -> Post {
    payload_to_post_at(tweet, now, app_version, 0, budget)
}

/// `depth` is how many quote levels are above this payload (0 for the root), so
/// a quote is built while `depth < budget` and the level past the budget is
/// never constructed.
fn payload_to_post_at(
    tweet: &Value,
    now: Option<&str>,
    app_version: Option<&str>,
    depth: usize,
    budget: usize,
) -> Post {
    let text_full = get_str(tweet, &["details", "full_text"]);
    let body_shown = display_text(tweet);
    let note_text = get_str(
        tweet,
        &["note_tweet", "note_tweet_results", "result", "text"],
    );
    let has_note = note_text
        .as_deref()
        .map(|text| !text.is_empty())
        .unwrap_or(false);
    let server_cut = has_note
        && body_shown.chars().count()
            < note_text
                .as_deref()
                .unwrap_or("")
                .chars()
                .count()
                .saturating_sub(1)
        && !body_shown.ends_with('…');
    let is_expandable = tweet
        .pointer("/note_tweet/is_expandable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let is_long = is_expandable && has_note && server_cut;
    let body = if is_long {
        well_formed(note_text.as_deref().unwrap_or(""))
    } else {
        body_shown
    };

    let mut post = Post {
        text: body,
        author: author_of(tweet),
        media: media_of(tweet),
        poll: poll_of(tweet),
        ..Post::default()
    };
    if let Some(shown) = text_full.as_deref().filter(|_| has_note) {
        post.long_post_body = Some(well_formed(shown));
    }
    if let Some(version) = app_version {
        post.app_version = Some(version.to_string());
    }
    if let Some(links) = display_links(tweet) {
        post.links = links;
    }
    if let Some(labels) = entity_labels(tweet) {
        post.entity_labels = labels;
    }
    if let Some(id) = tweet
        .pointer("/reply_to_results/rest_id")
        .or_else(|| tweet.pointer("/details/in_reply_to_status_id_str"))
        .and_then(Value::as_str)
    {
        post.reply_to = Some(id.to_string());
    }
    if let Some(handle) = tweet
        .pointer("/reply_to_user_results/result/core/screen_name")
        .or_else(|| tweet.pointer("/details/in_reply_to_screen_name"))
        .and_then(Value::as_str)
    {
        post.reply_to_handle = Some(handle.to_string());
    }
    if let Some(created) = tweet
        .pointer("/details/created_at_ms")
        .and_then(Value::as_i64)
    {
        post.created_at = Some(iso8601_ms(created));
    }
    let retweets = get_u64(tweet, &["counts", "retweet_count"]);
    let quotes = get_u64(tweet, &["counts", "quote_count"]);
    post.counts = Some(Counts {
        replies: get_u64(tweet, &["counts", "reply_count"]),
        reposts: retweets + quotes,
        likes: get_u64(tweet, &["counts", "favorite_count"]),
        views: get_u64(tweet, &["views", "count"]),
        bookmarks: get_u64(tweet, &["counts", "bookmark_count"]),
    });
    if is_long {
        post.long_post = Some(true);
    }
    let tags: Vec<String> = tweet
        .get("media_entities2")
        .and_then(Value::as_array)
        .map(|media| {
            media
                .iter()
                .flat_map(|entry| {
                    entry
                        .pointer("/features/all/tags")
                        .and_then(Value::as_array)
                        .map(|tags| tags.as_slice())
                        .unwrap_or(&[])
                        .iter()
                        .filter(|tag| {
                            tag.get("name").and_then(Value::as_str).is_some()
                                && tag
                                    .get("type")
                                    .and_then(Value::as_str)
                                    .map(|kind| kind == "user")
                                    .unwrap_or(true)
                        })
                        .filter_map(|tag| {
                            tag.get("name").and_then(Value::as_str).map(str::to_string)
                        })
                        .collect::<Vec<_>>()
                })
                .collect()
        })
        .unwrap_or_default();
    if !tags.is_empty() {
        post.media_tags = tags;
    }
    if let Some(now) = now {
        post.now = Some(now.to_string());
    }
    if depth < budget {
        if let Some(quoted) = quote_payload(tweet) {
            post.quote = Some(Box::new(payload_to_post_at(
                quoted,
                now,
                app_version,
                depth + 1,
                budget,
            )));
        }
    }
    post
}

/// The displayed body: `full_text` cut to `display_text_range`, in code points.
pub fn display_text(tweet: &Value) -> String {
    let full = get_str(tweet, &["details", "full_text"]).unwrap_or_default();
    let chars: Vec<char> = full.chars().collect();
    let range = tweet
        .pointer("/details/display_text_range")
        .and_then(Value::as_array);
    let Some(range) = range else {
        return well_formed(&full);
    };
    let start = range.first().and_then(Value::as_i64).unwrap_or(0).max(0) as usize;
    let end = range
        .get(1)
        .and_then(Value::as_i64)
        .unwrap_or(chars.len() as i64)
        .max(0) as usize;
    let start = start.min(chars.len());
    let end = end.clamp(start, chars.len());
    well_formed(&chars[start..end].iter().collect::<String>())
}

fn author_of(tweet: &Value) -> Author {
    author_from_user(
        tweet
            .pointer("/core/user_results/result")
            .unwrap_or(&Value::Null),
    )
}

/// A payload's `.../result` user object as an [`Author`].
///
/// The same object is the post's author (`core.user_results.result`) and, on a
/// "Post video"/"Post photo", the media's original author
/// (`media_entities2[i].source_user_results.result` — `ESPN.html`
/// `2120005259485425936` credits `@NFL` that way), so both go through here.
pub fn author_from_user(user: &Value) -> Author {
    let user = user.clone();
    let name = get_str(&user, &["core", "name"]).unwrap_or_default();
    let handle = get_str(&user, &["core", "screen_name"]).unwrap_or_default();
    let verified_type = get_str(&user, &["verification", "verified_type"]).unwrap_or_default();
    let blue = user
        .pointer("/verification/is_blue_verified")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let verified = match verified_type.as_str() {
        "Business" => Verified::Business,
        "Government" => Verified::Government,
        _ if blue => Verified::Blue,
        _ => Verified::None,
    };
    let mut author = Author {
        name: well_formed(&name),
        handle,
        verified,
        ..Author::default()
    };
    if let Some(label) = user.pointer("/identity_profile_labels_highlighted_label/label") {
        if let Some(description) = label.get("description").and_then(Value::as_str) {
            if !description.is_empty() {
                author.affiliate = Some(xeet_core::model::Affiliate {
                    name: well_formed(description),
                    badge: None,
                });
            }
        }
    }
    if user
        .pointer("/privacy/protected")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        author.protected = true;
    }
    if user.get("profile_image_shape").and_then(Value::as_str) == Some("Square") {
        author.square_avatar = true;
    }
    author
}

fn media_of(tweet: &Value) -> Vec<Media> {
    let mut out = Vec::new();
    let Some(entries) = tweet.get("media_entities2").and_then(Value::as_array) else {
        return out;
    };
    for entry in entries {
        let width = entry
            .pointer("/original_info/width")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let height = entry
            .pointer("/original_info/height")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if width == 0 || height == 0 {
            continue;
        }
        let kind = match entry.get("type").and_then(Value::as_str) {
            Some("video") => MediaKind::Video,
            Some("animated_gif") => MediaKind::Gif,
            _ => MediaKind::Image,
        };
        let mut media = Media {
            kind,
            width: width as u32,
            height: height as u32,
            ..Media::default()
        };
        if let Some(alt) = entry.get("ext_alt_text").and_then(Value::as_str) {
            if !alt.is_empty() {
                media.alt = Some(well_formed(alt));
            }
        }
        if let Some(millis) = entry
            .pointer("/video_info/duration_millis")
            .and_then(Value::as_f64)
        {
            if millis > 0.0 {
                media.duration = Some((millis / 1000.0) as f32);
            }
        }
        // "Post video" / "Post photo": the media came from another post, and X
        // credits that post's author in the attribution badge. A source that is
        // the post's own author is not an attribution, so it is dropped.
        if let Some(source) = entry.pointer("/source_user_results/result") {
            let author = author_from_user(source);
            if !author.handle.is_empty()
                && !author
                    .handle
                    .eq_ignore_ascii_case(tweet_handle(tweet).as_str())
            {
                media.source_author = Some(author);
            }
        }
        out.push(media);
    }
    out
}

/// Extracts `poll2choice_text_only` .. `poll4choice_text_only` from X's card
/// `binding_values` (both SSR array `[{key, value}]` and Syndication map forms).
fn poll_of(tweet: &Value) -> Option<xeet_core::model::Poll> {
    let card = tweet
        .pointer("/card/legacy")
        .or_else(|| tweet.get("card"))?;
    let name = card.get("name").and_then(Value::as_str)?;
    if !name.starts_with("poll") {
        return None;
    }
    let bv = card.get("binding_values")?;
    let lookup_str = |wanted: &str| -> Option<String> {
        if let Some(arr) = bv.as_array() {
            for item in arr {
                if item.get("key").and_then(Value::as_str) == Some(wanted) {
                    return item
                        .pointer("/value/string_value")
                        .and_then(Value::as_str)
                        .map(well_formed);
                }
            }
            None
        } else {
            bv.get(wanted)
                .and_then(|v| v.get("string_value"))
                .and_then(Value::as_str)
                .map(well_formed)
        }
    };
    let mut choices = Vec::new();
    let mut counts = Vec::new();
    for i in 1..=4 {
        let Some(label) = lookup_str(&format!("choice{i}_label")) else {
            break;
        };
        if label.trim().is_empty() {
            break;
        }
        let n: u64 = lookup_str(&format!("choice{i}_count"))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        choices.push(label);
        counts.push(n);
    }
    if choices.len() < 2 {
        return None;
    }
    let has_votes = counts.iter().any(|&c| c > 0);
    let seconds_left = if has_votes {
        None
    } else {
        lookup_str("duration_minutes")
            .and_then(|m| m.parse::<u64>().ok())
            .filter(|&m| m > 0)
            .map(|m| m.saturating_mul(60))
    };
    Some(xeet_core::model::Poll {
        choices,
        votes: has_votes.then_some(counts),
        seconds_left,
    })
}

/// The payload's own display forms for links, keyed by the token in the text.
fn display_links(
    tweet: &Value,
) -> Option<std::collections::BTreeMap<String, xeet_core::model::LinkMeta>> {
    let mut links = std::collections::BTreeMap::new();
    let mut add = |written: &str, display: &str| {
        if written.is_empty() || display.is_empty() {
            return;
        }
        let entry = links
            .entry(written.to_string())
            .or_insert_with(xeet_core::model::LinkMeta::default);
        entry.display = Some(well_formed(display));
    };
    if let Some(urls) = tweet.get("url_entities").and_then(Value::as_array) {
        for url in urls {
            let written = url.get("url").and_then(Value::as_str).unwrap_or_default();
            if let Some(display) = url.get("display_url").and_then(Value::as_str) {
                add(written, display);
            }
        }
    }
    // A note's entity set is separate, and the t.co it names can differ from the
    // token written in the note; the indices point at the text, so key by that.
    let note_text = tweet
        .pointer("/note_tweet/note_tweet_results/result/text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let note_chars: Vec<char> = note_text.chars().collect();
    for set in ["urls", "url_entities"] {
        let Some(urls) = tweet
            .pointer(&format!(
                "/note_tweet/note_tweet_results/result/entity_set/{set}"
            ))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for url in urls {
            let display = url
                .get("display_url")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if let (Some(start), Some(end)) = (
                url.pointer("/indices/0").and_then(Value::as_u64),
                url.pointer("/indices/1").and_then(Value::as_u64),
            ) {
                let (start, end) = (start as usize, (end as usize).min(note_chars.len()));
                if start < end {
                    let written: String = note_chars[start..end].iter().collect();
                    add(&written, display);
                }
            }
            if let Some(written) = url.get("url").and_then(Value::as_str) {
                add(written, display);
            }
        }
    }
    if links.is_empty() {
        None
    } else {
        Some(links)
    }
}

fn entity_labels(tweet: &Value) -> Option<std::collections::BTreeMap<String, String>> {
    let mentions = tweet.get("mention_entities")?.as_array()?;
    let chars: Vec<char> = get_str(tweet, &["details", "full_text"])
        .unwrap_or_default()
        .chars()
        .collect();
    let mut labels = std::collections::BTreeMap::new();
    for mention in mentions {
        let start = mention
            .pointer("/indices/0")
            .and_then(Value::as_u64)
            .map(|v| v as usize);
        let end = mention
            .pointer("/indices/1")
            .and_then(Value::as_u64)
            .map(|v| v as usize);
        let Some(screen_name) = mention.get("screen_name").and_then(Value::as_str) else {
            continue;
        };
        let (Some(start), Some(end)) = (start, end) else {
            continue;
        };
        if start >= end || end > chars.len() {
            continue;
        }
        let written: String = chars[start..end].iter().collect();
        if !written.is_empty() {
            labels.insert(written, format!("@{screen_name}"));
        }
    }
    if labels.is_empty() {
        None
    } else {
        Some(labels)
    }
}

/// Decodes HTML entities and drops unpaired surrogates. The payload is escaped
/// JSON inside a JSON string, so a post's text really does contain `&amp;`.
pub fn well_formed(text: &str) -> String {
    let decoded = crate::cards::decode_entities(text);
    // `String` cannot hold a lone surrogate, so nothing to drop here; kept as a
    // named step so the port reads like the converter it came from.
    decoded
}

fn get_str(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_string)
}

fn get_u64(value: &Value, path: &[&str]) -> u64 {
    let mut current = value;
    for key in path {
        current = match current.get(*key) {
            Some(next) => next,
            None => return 0,
        };
    }
    current
        .as_u64()
        .or_else(|| current.as_str().and_then(|text| text.parse().ok()))
        .unwrap_or(0)
}

fn iso8601_ms(ms: i64) -> String {
    // Days-from-civil, as in `commands/serve.rs`; valid for any `i64` millis.
    let seconds = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// The status id in an `x.com`/`twitter.com` URL, if there is one.
pub fn status_id(url: &str) -> Option<String> {
    status_ref(url).map(|reference| reference.id)
}

/// The screen name an `x.com/<handle>/status/<id>` URL names, if it is a valid
/// one (1–15 of `[A-Za-z0-9_]`, and not the `i` of `/i/status/<id>`).
pub fn status_handle(url: &str) -> Option<String> {
    let parsed = crate::urlsafety::Url::parse(url)?;
    if !crate::cards::is_x_host(&parsed.host) {
        return None;
    }
    let segments: Vec<&str> = parsed.path.split('/').filter(|s| !s.is_empty()).collect();
    // `/i/status/<id>` and `/i/web/status/<id>` carry no handle.
    if segments.first() == Some(&"i") {
        return None;
    }
    let at = segments
        .iter()
        .position(|s| *s == "status" || *s == "statuses")?;
    let handle = segments.get(at.checked_sub(1)?)?;
    let valid = (1..=15).contains(&handle.len())
        && handle
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        && *handle != "i";
    valid.then(|| (*handle).to_string())
}

/// The tweet's own screen name, lower-cased, or an empty string.
fn tweet_handle(tweet: &Value) -> String {
    tweet
        .pointer("/core/user_results/result/core/screen_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// A status URL, and which of the post's media items it names.
///
/// X's composer treats the two differently: a plain status URL at the end of a
/// draft becomes a **Quote Tweet**, while `/status/<id>/video/<N>` and
/// `/status/<id>/photo/<N>` ("Post video" / "Post photo") embed **that media
/// item** with the original author credited
/// (`quote-media-toggle-jMLU_r6g`, `post-media-menu-item-jECN8x_w`). The suffix
/// is 1-based, as X writes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusRef {
    pub id: String,
    /// `Some((kind, index))` for `/video/<N>` or `/photo/<N>`; `index` is 0-based.
    pub media: Option<(xeet_core::model::MediaKind, usize)>,
}

/// The status URL in `url`, with its media suffix if it has one.
pub fn status_ref(url: &str) -> Option<StatusRef> {
    let parsed = crate::urlsafety::Url::parse(url)?;
    if !crate::cards::is_x_host(&parsed.host) {
        return None;
    }
    let segments: Vec<&str> = parsed.path.split('/').filter(|s| !s.is_empty()).collect();
    for (index, segment) in segments.iter().enumerate() {
        if (*segment == "status" || *segment == "statuses") && index + 1 < segments.len() {
            let id = segments[index + 1];
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            // `/status/<id>`, `/status/<id>/video/1`, `/status/<id>/photo/2`,
            // and the `/status/<id>/video/1?t=1s` a share sheet adds (the query
            // is not part of the path).
            let media = match (segments.get(index + 2), segments.get(index + 3)) {
                (Some(kind), Some(number)) => {
                    let kind = match kind.to_ascii_lowercase().as_str() {
                        "video" => Some(xeet_core::model::MediaKind::Video),
                        "photo" => Some(xeet_core::model::MediaKind::Image),
                        _ => None,
                    };
                    kind.and_then(|kind| {
                        number
                            .parse::<usize>()
                            .ok()
                            .filter(|number| *number >= 1)
                            .map(|number| (kind, number - 1))
                    })
                }
                _ => None,
            };
            return Some(StatusRef {
                id: id.to_string(),
                media,
            });
        }
    }
    None
}

/// `https://x.com/i/status/<id>`, the form the page fetch and cache keys use.
pub fn canonical_url(id: &str) -> String {
    format!("https://x.com/i/status/{id}")
}

/// The post's own pinned state, from the page.
pub fn social_context(html: &str, id: &str) -> Option<SocialContext> {
    if pinned_ids(html).iter().any(|pinned| pinned == id) {
        Some(SocialContext::Pinned)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_fills_a_badge_a_slim_copy_dropped() {
        let mut slim = serde_json::json!({ "core": { "user_results": { "result": {
            "core": { "name": "Guillermo Rauch", "screen_name": "rauchg" },
            "identity_profile_labels_highlighted_label": { "label": { "description": "Vercel" } }
        } } } });
        let rich = serde_json::json!({ "core": { "user_results": { "result": {
            "core": { "name": "Someone Else", "screen_name": "rauchg" },
            "identity_profile_labels_highlighted_label": { "label": {
                "description": "Vercel",
                "badge": { "url": "https://pbs.twimg.com/profile_images/1/badge_bigger.png" }
            } }
        } } } });
        merge_missing(&mut slim, &rich);
        let label = slim
            .pointer("/core/user_results/result/identity_profile_labels_highlighted_label/label")
            .unwrap();
        assert_eq!(
            label
                .pointer("/badge/url")
                .and_then(serde_json::Value::as_str),
            Some("https://pbs.twimg.com/profile_images/1/badge_bigger.png")
        );
        // Values both copies have are the kept copy's.
        assert_eq!(
            slim.pointer("/core/user_results/result/core/name")
                .and_then(serde_json::Value::as_str),
            Some("Guillermo Rauch")
        );
    }

    /// A minimal page in the compact logged-out shape: the payload is escaped
    /// JSON inside a JSON string, as X's server render embeds it.
    fn page(payload: serde_json::Value) -> String {
        let escaped = serde_json::to_string(&serde_json::to_string(&payload).unwrap()).unwrap();
        format!(r#"<html><head><script>__DATA__ = {escaped};</script></head></html>"#)
    }

    fn payload() -> serde_json::Value {
        serde_json::json!({
            "__typename": "Tweet",
            "rest_id": "20",
            "details": {
                "full_text": "just setting up my twttr https://t.co/abc",
                "display_text_range": [0, 24],
                "created_at_ms": 1143492614000i64
            },
            "core": { "user_results": { "result": {
                "core": { "name": "jack", "screen_name": "jack" },
                "verification": { "verified_type": "Business", "is_blue_verified": true },
                "identity_profile_labels_highlighted_label": { "label": { "description": "Block" } }
            } } },
            "url_entities": [{
                "url": "https://t.co/abc",
                "expanded_url": "https://example.com/a",
                "display_url": "example.com/a"
            }],
            "counts": { "reply_count": 1, "retweet_count": 2, "quote_count": 3, "favorite_count": 4, "bookmark_count": 5 },
            "views": { "count": "6" }
        })
    }

    #[test]
    fn extracts_and_converts_a_payload() {
        let html = page(payload());
        let payloads = extract_payloads(&html);
        assert_eq!(payloads.len(), 1);
        let post = payload_to_post(
            &payloads[0],
            Some("2026-11-10T00:00:00.000Z"),
            Some("3e351742"),
        );
        assert_eq!(post.text, "just setting up my twttr");
        assert_eq!(post.author.handle, "jack");
        assert_eq!(post.author.verified, Verified::Business);
        assert_eq!(
            post.author.affiliate.as_ref().map(|a| a.name.as_str()),
            Some("Block")
        );
        assert_eq!(
            post.links
                .get("https://t.co/abc")
                .unwrap()
                .display
                .as_deref(),
            Some("example.com/a")
        );
        let counts = post.counts.unwrap();
        assert_eq!(counts.reposts, 5);
        assert_eq!(counts.likes, 4);
        assert_eq!(counts.views, 6);
        assert_eq!(post.created_at.as_deref(), Some("2006-03-27T20:50:14.000Z"));
        assert_eq!(post.app_version.as_deref(), Some("3e351742"));
    }

    #[test]
    fn display_range_is_code_points() {
        let mut tweet = payload();
        tweet["details"]["full_text"] = serde_json::json!("ESPN \u{1f440} tail");
        tweet["details"]["display_text_range"] = serde_json::json!([0, 6]);
        assert_eq!(display_text(&tweet), "ESPN \u{1f440}");
    }

    #[test]
    fn decodes_markup_entities() {
        assert_eq!(
            well_formed("Peace &amp; Development"),
            "Peace & Development"
        );
        assert_eq!(well_formed("&#x1f440;"), "\u{1f440}");
    }

    #[test]
    fn status_handles() {
        assert_eq!(
            status_handle("https://x.com/rauchg/status/1").as_deref(),
            Some("rauchg")
        );
        assert_eq!(
            status_handle("https://twitter.com/NASA_Goddard/statuses/1?s=20").as_deref(),
            Some("NASA_Goddard")
        );
        assert_eq!(status_handle("https://x.com/i/status/1"), None);
        assert_eq!(status_handle("https://x.com/i/web/status/1"), None);
        assert_eq!(status_handle("https://x.com/not-a-handle!/status/1"), None);
        assert_eq!(status_handle("https://example.com/rauchg/status/1"), None);
    }

    #[test]
    fn status_ids_and_canonical_urls() {
        assert_eq!(
            status_id("https://x.com/jack/status/20").as_deref(),
            Some("20")
        );
        assert_eq!(
            status_id("https://twitter.com/i/web/status/123?s=20").as_deref(),
            Some("123")
        );
        assert_eq!(status_id("https://x.com/jack"), None);
        assert_eq!(status_id("https://example.com/status/20"), None);
        assert_eq!(canonical_url("20"), "https://x.com/i/status/20");
    }

    #[test]
    fn pinned_posts_are_found() {
        let html = r#"{\"socialContext\":{\"context_type\":\"Pin\",\"text\":\"Pinned\"},\"tweet_results\":{\"rest_id\":\"2119752393839800427\",\"result\":{}}}"#;
        assert_eq!(pinned_ids(html), vec!["2119752393839800427".to_string()]);
        assert_eq!(
            social_context(html, "2119752393839800427"),
            Some(SocialContext::Pinned)
        );
        assert_eq!(social_context(html, "1"), None);
    }

    #[test]
    fn long_posts_take_the_note_body() {
        let mut tweet = payload();
        // Not ending in an ellipsis: X's own "was it cut" test, see the module docs.
        tweet["details"]["full_text"] = serde_json::json!("short");
        tweet["note_tweet"] = serde_json::json!({
            "is_expandable": true,
            "note_tweet_results": { "result": { "text": "a much longer body that was cut" } }
        });
        let post = payload_to_post(&tweet, None, None);
        assert_eq!(post.text, "a much longer body that was cut");
        assert_eq!(post.long_post, Some(true));
        assert_eq!(post.long_post_body.as_deref(), Some("short"));
    }
}
