//! X's behavior rules: what a post shows, hides, truncates and attaches.
//!
//! This stage answers the questions a picture cannot: where "Show more" cuts
//! the body, which trailing URL disappears because a card took its place, which
//! attachment wins, and what the composer's dismissed card means. The answers
//! are data in `rules/x-web.json` (values, status, evidence), and SPEC.md
//! explains each one with the capture that proves it.
//!
//! Everything here is a pure function of `Post` + `RenderOptions`. Optionally
//! the caller supplies wall-clock facts (`createdAt`, `now`) and the server's
//! long-post flag; nothing is read from the environment.
//!
//! # What the frame does with this
//!
//! `Decisions.body` is the text as displayed, in order. Entity spans carry
//! their displayed form (a shortened URL), hidden ranges are already removed,
//! and a long post on the timeline is already cut. The frame lays the spans out
//! and applies `Decisions.clamp`. If the clamp cuts lines it reports
//! `showMore: "clamped"`; `decide` reports `ShowMore::Inline` for the server
//! cut, because that one is known before layout.
//!
//! # Verified against
//!
//! The client code X serves today (pinned in `assets/rules.lock.json`) and a
//! corpus of public payloads (270 posts, 83 accounts, `tools/capture.mjs`).
//! `tools/rules/canary.mjs` re-checks the derived rules against fresh payloads.
//!
//! # Ranges
//!
//! `BodySpan::source`, `Report::hidden` and `Report::entities` are UTF-16 code
//! unit ranges of `Post::text`, the unit X's payloads use.

pub mod spec;
pub mod textport;

use crate::model::{self, CardState, Post, RenderOptions, Surface};
use crate::model::{
    Attachment as ReportAttachment, Entity as ReportEntity, Hidden, Length, TextReport,
};

/// Everything the rules stage decided.
#[derive(Clone, Debug, Default)]
pub struct Decisions {
    pub ruleset: &'static str,
    /// The report fields that do not depend on layout (`size` and `lines` are
    /// filled in by the frame).
    pub report: model::Report,
    /// The body as displayed: plain text and entities in order, hidden ranges
    /// removed, URLs in their shortened form.
    pub body: Vec<BodySpan>,
    /// `Inline` when the server's long-post cut applies. A clamp overflow is
    /// only known after layout, so the frame sets `"clamped"` itself.
    pub show_more: Option<ShowMore>,
    /// Line clamp for this post's body, if any. Timeline and detail main text
    /// have none (verified); a quoted post is clamped to five lines.
    pub clamp: Option<usize>,
    pub attachment: Option<AttachmentKind>,
    /// Present for the nested-quote preview (q2 inside q1).
    pub nested: Option<NestedQuotePreview>,
}

/// What `cards` needs to draw X's nested-quote preview.
///
/// X renders q2's text with `render-entity-as-text`: mentions, hashtags,
/// cashtags and URLs keep their display text but inherit the body color
/// instead of the link color. q2's first media becomes a 64px thumbnail (with a
/// `+N` overlay, and a play icon for video).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NestedQuotePreview {
    /// Entities are plain text (`color: inherit`), not brand-colored links.
    pub plain_entities: bool,
    /// Draw `nested.media[0]` as the 64px thumbnail.
    pub media_thumb: bool,
}

impl Decisions {
    /// The body as one string, for reports and tests.
    pub fn body_text(&self) -> String {
        self.body.iter().map(|s| s.text.as_str()).collect()
    }
}

/// One run of the displayed body.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BodySpan {
    pub text: String,
    pub kind: SpanKind,
    /// The source range this span came from, in UTF-16 code units of
    /// `Post::text`. A shortened URL maps the whole entity range to the
    /// shortened text.
    pub source: [usize; 2],
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpanKind {
    #[default]
    Plain,
    Url,
    Mention,
    Hashtag,
    Cashtag,
}

impl SpanKind {
    /// The `role` recorded on display-list spans, so reports and tests can tell
    /// which glyphs are links.
    pub fn role(self) -> &'static str {
        match self {
            SpanKind::Plain => "text",
            SpanKind::Url => "url",
            SpanKind::Mention => "mention",
            SpanKind::Hashtag => "hashtag",
            SpanKind::Cashtag => "cashtag",
        }
    }

    /// Entity spans are drawn in the brand color.
    pub fn is_entity(self) -> bool {
        self != SpanKind::Plain
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShowMore {
    /// Long post, cut by the server; the body already ends at the cut and the
    /// frame draws the inline "Show more" link.
    Inline,
    /// The line clamp cut lines; the frame detects this and draws the link
    /// below the text.
    Clamped,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttachmentKind {
    /// A link card. `url` keys `Post::links`; `card` is its `twitter:card`
    /// type ("summary", "summary_large_image", "player", "app").
    Card { url: String, card: String },
    /// One to four attached images, or a single video or GIF.
    Media,
    /// The quoted post, taken from `Post::quote`.
    Quote,
    /// The poll, taken from `Post::poll`.
    Poll,
}

/// Decides what X shows for `post` on the surface in `opts`.
pub fn decide(post: &Post, opts: &RenderOptions) -> Decisions {
    decide_with(post, opts, Mode::Main)
}

/// Same, for a post shown *inside* another post (a quote).
///
/// A quoted post is clamped to five lines (`rules/x-web.json` `clamp.quote`)
/// and its overflow is detected by layout, so this returns
/// `show_more: None` with `clamp: Some(5)`; the frame reports `"clamped"` if
/// the clamp actually cut lines.
pub fn decide_quote(post: &Post, opts: &RenderOptions) -> Decisions {
    decide_with(post, opts, Mode::Quoted)
}

/// The nested quote inside a quote (`outer.quote.quote`), or `None` when X's
/// eligibility check rejects it.
///
/// `outer` is the post being rendered, `quoted` is `q1` (the post the outer one
/// quotes) and `nested` is `q2` (the post `q1` quotes). Passing all three means
/// the caller does not have to thread `Post::quote` itself. On success the
/// decisions carry `clamp = Some(2)` and `nested` with `plain_entities` and
/// `media_thumb` set; `cards` draws q2's first media as a 64px thumbnail.
pub fn decide_nested_quote(
    outer: &Post,
    quoted: &Post,
    nested: &Post,
    opts: &RenderOptions,
) -> Option<Decisions> {
    if !nested_quote_eligible(outer, quoted, nested) {
        return None;
    }
    let mut decisions = decide_with(nested, opts, Mode::NestedQuoted);
    decisions.clamp = Some(spec::ruleset().rules.nested_quote_preview.clamp);
    decisions.nested = Some(NestedQuotePreview {
        plain_entities: true,
        media_thumb: !nested.media.is_empty(),
    });
    Some(decisions)
}

/// X's `H(e, t, n)` for the nested quote preview (`dfWSwB9n.js`).
///
/// Rejects a crowded outer cell, a missing q2 author, a quote of oneself
/// (`outer == q1` or `q1 == q2`), a q2 with a card or poll, and anything where
/// more than one of outer/q1/q2 renders media (`[rendersMedia, z(q1), I(q2)]
/// .filter(Boolean).length <= 1`). Promoted/mid-conversation/birdwatch state
/// and sensitive-media flags are not in `Post`, so only `reply_to` can make the
/// outer cell crowded and only card/poll/unknown media can veto q2.
pub fn nested_quote_eligible(outer: &Post, quoted: &Post, nested: &Post) -> bool {
    if outer.reply_to.is_some() {
        return false;
    }
    let Some(nested_handle) = handle_key(nested) else {
        return false;
    };
    if let (Some(a), Some(b)) = (handle_key(outer), handle_key(quoted)) {
        if a == b {
            return false;
        }
    }
    if let Some(q1_handle) = handle_key(quoted) {
        if q1_handle == nested_handle {
            return false;
        }
    }
    // `ie(q2)`: a card, a poll or media X cannot preview.
    if has_card_metadata(nested) || nested.poll.is_some() {
        return false;
    }
    let outer_renders = !outer.media.is_empty() || has_card_metadata(outer) || outer.poll.is_some();
    let quoted_renders =
        !quoted.media.is_empty() || has_card_metadata(quoted) || quoted.poll.is_some();
    let nested_media = !nested.media.is_empty();
    [outer_renders, quoted_renders, nested_media]
        .iter()
        .filter(|renders| **renders)
        .count()
        <= 1
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Main,
    /// A post shown inside another post (q1).
    Quoted,
    /// The nested quote inside a quote (q2).
    NestedQuoted,
}

impl Mode {
    fn is_quoted(self) -> bool {
        matches!(self, Mode::Quoted | Mode::NestedQuoted)
    }

    fn is_nested_quote(self) -> bool {
        matches!(self, Mode::NestedQuoted)
    }
}

/// The ranges X removes from a body: the leading mentions of a reply and the
/// trailing URLs an attachment claims. Returns where the visible text starts.
fn hidden_ranges(
    post: &Post,
    chars: &[char],
    entities: &[Entity],
    attachment: &Option<AttachmentKind>,
    hide_leading: bool,
) -> (usize, Vec<HiddenRange>) {
    let mut hidden: Vec<HiddenRange> = Vec::new();
    let visible_start = if hide_leading {
        leading_mention_end(chars, entities).unwrap_or(0)
    } else {
        0
    };
    if visible_start > 0 {
        hidden.push(HiddenRange {
            start: 0,
            end: visible_start,
            why: "leading mentions of a reply are hidden from the body".to_string(),
        });
    }
    // Trailing ranges: the client walks from the end, across whitespace, and
    // stops at the first URL that no rendered attachment claims.
    let trailing: Vec<&Entity> = trailing_attachment_entities(chars, entities, attachment, post);
    for e in trailing.iter().rev() {
        let why = match attachment {
            Some(AttachmentKind::Card { .. }) => "trailing URL replaced by its card",
            Some(AttachmentKind::Quote) => "trailing URL replaced by the quoted post",
            Some(AttachmentKind::Media) => "trailing URL replaced by attached media",
            _ => "trailing URL replaced by its attachment",
        };
        // X hides the whitespace before a trailing URL with it: in the corpus
        // all 137 posts whose display range hides a trailing t.co end the range
        // before that whitespace (SPEC.md §3). For a payload the converter has
        // already trimmed it; a draft would otherwise keep a blank line.
        let mut start = e.start;
        while start > 0 && chars[start - 1].is_whitespace() {
            start -= 1;
        }
        hidden.push(HiddenRange {
            start,
            end: e.end,
            why: why.to_string(),
        });
    }
    // A media URL can sit mid-text: "Post video" / "Post photo" embeds the
    // media and removes its permalink from the text, taking one preceding
    // space with it (`tU-nr9vs.js`: `text[n-1] === " " ? n-1 : n`). The same
    // applies to a pasted direct twimg URL that resolve turned into media.
    if matches!(attachment, Some(AttachmentKind::Media)) {
        for e in entities.iter().filter(|e| e.kind == SpanKind::Url) {
            if hidden.iter().any(|h| h.start <= e.start && e.start < h.end) {
                continue;
            }
            let written: String = chars[e.start..e.end].iter().collect();
            if !is_embedded_media_url(&written)
                && !link_display(post, &written).is_some_and(is_embedded_media_url)
            {
                continue;
            }
            let start = if e.start > 0 && chars[e.start - 1] == ' ' {
                e.start - 1
            } else {
                e.start
            };
            hidden.push(HiddenRange {
                start,
                end: e.end,
                why: "embedded media URL replaced by attached media".to_string(),
            });
        }
    }
    (visible_start, hidden)
}

fn decide_with(post: &Post, opts: &RenderOptions, mode: Mode) -> Decisions {
    let rules = &spec::ruleset().rules;
    // The authored text, for the length report, and the text the cell displays.
    // For a long post a payload can carry the server's own cut
    // (`long_post_body`), which is what the page shows; a draft has none and the
    // cut below is derived.
    let parsed = textport::parse(&post.text);
    // The body the server put in the cell, when the payload carries it: X's own
    // cut for a long post, the whole note for a short one. On iOS, X lays out
    // the full `post.text` (`note_tweet`) directly and clamps by visual lines
    // in the frame stage; when `opts.expanded` is true, the full note is used
    // on every surface.
    let expand_main = opts.expanded && !mode.is_quoted();
    let ios_main = opts.surface.is_ios() && !mode.is_quoted();
    let short_source: &str = if expand_main || ios_main {
        &post.text
    } else {
        post.long_post_body.as_deref().unwrap_or(&post.text)
    };
    let mut chars: Vec<char> = short_source.chars().collect();
    let mut utf16_at = utf16_offsets(&chars);
    // Entities belong to the text being laid out. For a long post the server's
    // body can differ from the note inside a URL (the payload stores a
    // different t.co), so offsets from the note would land in the wrong place.
    let short_parsed;
    let short_text_entities = if std::ptr::eq(short_source, post.text.as_str()) {
        &parsed.entities
    } else {
        short_parsed = textport::parse(short_source);
        &short_parsed.entities
    };
    let mut entities = char_entities(short_text_entities, &utf16_at, post);

    let surface_name = surface_key(opts.surface);
    let mut warnings: Vec<String> = Vec::new();

    // ------------------------------------------------------------- attachment
    let card_candidate = card_candidate(post, &parsed.entities);
    let (attachment, attachment_why) =
        choose_attachment(post, card_candidate.as_ref(), &mut warnings);

    // ---------------------------------------------------------- hidden ranges
    // X hides the leading mentions of a *reply*. A plain post that starts with
    // `@name` keeps them (the captured pages show this), so the decision needs
    // the reply fact rather than the shape of the text.
    let hide_leading = (!mode.is_quoted() || mode.is_nested_quote())
        && post.reply_to.is_some()
        && rules.hidden_ranges.leading_mentions_in_reply
        && (opts.surface.is_ios()
            || rules
                .leading_mentions
                .hide_in
                .iter()
                .any(|s| s == surface_name));
    let (mut visible_start, mut hidden) =
        hidden_ranges(post, &chars, &entities, &attachment, hide_leading);

    // ------------------------------------------------------------- truncation
    let long = post
        .long_post
        .unwrap_or(parsed.weighted_length > rules.length.limit);
    let truncates = !expand_main
        && rules
            .long_post
            .truncate_on
            .iter()
            .any(|s| s == surface_name);
    let mut visible_end = chars.len();
    let mut inline = false;
    if long && truncates {
        // A payload's `long_post_body` is already the cut X shows; only a draft
        // needs the derived cut. Either way the inline link is the long post's
        // mechanism.
        if post.long_post_body.is_some() {
            inline = rules
                .long_post
                .inline_show_more_on
                .iter()
                .any(|s| s == surface_name)
                && !mode.is_quoted();
        } else if let Some(cut) = long_post_cut(&chars, &entities, rules.long_post.cut_units) {
            if cut < visible_end {
                visible_end = cut;
                inline = rules
                    .long_post
                    .inline_show_more_on
                    .iter()
                    .any(|s| s == surface_name)
                    && !mode.is_quoted();
            }
        }
    }
    if visible_end <= visible_start {
        visible_end = visible_start;
    }

    // ------------------------------------------------------------------ body
    let mut body = build_body(
        &chars,
        &utf16_at,
        &entities,
        &hidden,
        visible_start,
        visible_end,
    );

    // X's newer client expands some long posts instead of showing the cut: when
    // almost the whole note is already visible (the cut body is long enough and
    // only a little is hidden), it renders the note whole and drops the inline
    // "Show more". The old client always shows the cut. The client version the
    // page was rendered with selects the behavior (SPEC.md §5).
    // Only a payload that carries the server's cut is measured: the client's
    // gate compares the note with the cut X actually sent, so a draft (no
    // `long_post_body`) keeps the derived cut until it is posted.
    let elision = &rules.long_post.show_more_elision;
    if long
        && truncates
        && inline
        && post.long_post_body.is_some()
        && elision.enabled_for(post.app_version.as_deref())
    {
        let note_utf16 = post.text.encode_utf16().count();
        let body_utf16: usize = body.iter().map(|s| s.text.encode_utf16().count()).sum();
        if note_utf16 > body_utf16
            && body_utf16 >= elision.min_displayed_length
            && note_utf16.saturating_sub(body_utf16) <= elision.max_hidden_remainder
        {
            chars = post.text.chars().collect();
            utf16_at = utf16_offsets(&chars);
            entities = char_entities(&parsed.entities, &utf16_at, post);
            let (start, fresh) = hidden_ranges(post, &chars, &entities, &attachment, hide_leading);
            visible_start = start;
            visible_end = chars.len();
            hidden = fresh;
            body = build_body(
                &chars,
                &utf16_at,
                &entities,
                &hidden,
                visible_start,
                visible_end,
            );
            inline = false;
        }
    }

    // ----------------------------------------------------------------- clamp
    let clamp = if mode.is_nested_quote() {
        rules.clamp.nested_quote
    } else if mode.is_quoted() {
        rules.clamp.quote
    } else if expand_main {
        None
    } else {
        match opts.surface {
            Surface::WebTimeline | Surface::IosTimeline => rules.clamp.timeline_main,
            Surface::WebDetail | Surface::IosDetail => rules.clamp.detail_main,
        }
    };

    // --------------------------------------------------------------- warnings
    if post.card_state == CardState::Dismissed && has_card_metadata(post) {
        warnings.push(
            "the card preview was dismissed in this draft; no card is shown and no other link takes it"
                .to_string(),
        );
    }
    if inline {
        warnings.push(format!(
            "the timeline cuts this post after {} characters; \u{201c}Show more\u{201d} reveals the rest",
            chars[visible_start..visible_end].len()
        ));
    }
    if parsed.weighted_length > rules.length.limit && !long {
        warnings.push(format!(
            "weighted length is {}; a post over {} needs a Premium account",
            parsed.weighted_length, rules.length.limit
        ));
    }
    if parsed.weighted_length > rules.length.long_post_limit {
        warnings.push(format!(
            "weighted length is {}; the limit for a long post is {}",
            parsed.weighted_length, rules.length.long_post_limit
        ));
    }

    let mut report = model::Report::default();
    report.ruleset = spec::ruleset_id().to_string();
    report.verified_for = if opts.surface.is_ios() {
        vec![Surface::IosTimeline, Surface::IosDetail]
    } else {
        vec![Surface::WebTimeline, Surface::WebDetail]
    };
    report.length = Length {
        weighted: parsed.weighted_length,
        limit: rules.length.limit,
        valid: parsed.valid,
    };
    report.text = TextReport {
        lines: 0,
        // The server's cut is already in the body, so the source length does
        // not reveal it; `inline` is the fact that part of the note is hidden.
        truncated: inline,
        has_show_more: inline,
        show_more: if inline {
            Some("inline".to_string())
        } else {
            None
        },
        visible: body.iter().map(|s| s.text.as_str()).collect(),
    };
    report.entities = parsed
        .entities
        .iter()
        .map(|e| ReportEntity {
            kind: match e.kind {
                textport::EntityKind::Url { .. } => "url".to_string(),
                textport::EntityKind::Mention => "mention".to_string(),
                textport::EntityKind::Hashtag => "hashtag".to_string(),
                textport::EntityKind::Cashtag => "cashtag".to_string(),
            },
            range: [e.start, e.end],
            text: e.text.clone(),
            display: match &e.kind {
                textport::EntityKind::Url { display, .. } => Some(display.clone()),
                _ => None,
            },
        })
        .collect();
    report.hidden = hidden
        .iter()
        .map(|h| Hidden {
            range: [utf16_at[h.start], utf16_at[h.end]],
            why: h.why.clone(),
        })
        .collect();
    report.attachment = attachment.as_ref().map(|a| match a {
        AttachmentKind::Card { url, card } => ReportAttachment {
            shown: "card".to_string(),
            url: Some(url.clone()),
            why: format!("the last link in the text has a {card} card"),
        },
        AttachmentKind::Media => ReportAttachment {
            shown: "media".to_string(),
            url: None,
            why: attachment_why.clone(),
        },
        AttachmentKind::Quote => ReportAttachment {
            shown: "quote".to_string(),
            url: None,
            why: attachment_why.clone(),
        },
        AttachmentKind::Poll => ReportAttachment {
            shown: "poll".to_string(),
            url: None,
            why: attachment_why.clone(),
        },
    });
    report.warnings = warnings;

    Decisions {
        ruleset: spec::ruleset_id(),
        report,
        body,
        show_more: if inline { Some(ShowMore::Inline) } else { None },
        clamp,
        attachment,
        nested: None,
    }
}

/// A handle for the self-quote check: trimmed of `@`, lowercase, or `None`
/// when the post carries no author.
fn handle_key(post: &Post) -> Option<String> {
    let handle = post.author.handle.trim().trim_start_matches('@');
    if handle.is_empty() {
        None
    } else {
        Some(handle.to_ascii_lowercase())
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// `utf16_at[i]` is the UTF-16 offset of char index `i`; length chars+1.
fn utf16_offsets(chars: &[char]) -> Vec<usize> {
    let mut out = Vec::with_capacity(chars.len() + 1);
    let mut n = 0;
    out.push(0);
    for c in chars {
        n += c.len_utf16();
        out.push(n);
    }
    out
}

/// One parsed entity, indexed by `char` position with its displayed text.
#[derive(Clone, Debug)]
struct Entity {
    start: usize,
    end: usize,
    kind: SpanKind,
    display: String,
}

fn char_entities(entities: &[textport::Entity], utf16_at: &[usize], post: &Post) -> Vec<Entity> {
    // A UTF-16 boundary that bisects a surrogate pair rounds up to the next
    // code point (`position(|u| u >= units)`): X does not emit such a range, but
    // a converter or a caller can, and half an emoji is worse than one more.
    let to_char = |units: usize| {
        utf16_at
            .partition_point(|&u| u < units)
            .min(utf16_at.len().saturating_sub(1))
    };
    entities
        .iter()
        .map(|e| {
            let start = to_char(e.start);
            let end = to_char(e.end).max(start);
            let (kind, display) = match &e.kind {
                textport::EntityKind::Url { display, .. } => {
                    (SpanKind::Url, url_display(post, &e.text, display))
                }
                textport::EntityKind::Mention => (SpanKind::Mention, entity_label(post, &e.text)),
                textport::EntityKind::Hashtag => (SpanKind::Hashtag, entity_label(post, &e.text)),
                textport::EntityKind::Cashtag => (SpanKind::Cashtag, entity_label(post, &e.text)),
            };
            Entity {
                start,
                end,
                kind,
                display,
            }
        })
        .collect()
}

/// The display form of a URL: the payload's `display_url` when the input
/// carries one (a captured post's `t.co` link has no usable form of its own),
/// otherwise the form derived from the URL as written (a draft).
/// The text X prints for a mention, hashtag or cashtag: the server's canonical
/// label when the input carries one (`@Bot` → `@bot`), otherwise the token as
/// written.
fn entity_label(post: &Post, written: &str) -> String {
    post.entity_labels
        .get(written)
        .cloned()
        .unwrap_or_else(|| written.to_string())
}

fn url_display(post: &Post, written: &str, computed: &str) -> String {
    lookup_link(&post.links, written)
        .and_then(|(_, meta)| meta.display.clone())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| computed.to_string())
}

#[derive(Clone, Debug)]
struct HiddenRange {
    start: usize,
    end: usize,
    why: String,
}

fn surface_key(surface: Surface) -> &'static str {
    match surface {
        Surface::WebTimeline => "web-timeline",
        Surface::WebDetail => "web-detail",
        Surface::IosTimeline => "ios-timeline",
        Surface::IosDetail => "ios-detail",
    }
}

/// A link in the text that has card metadata: `(url_as_written, card_type)`.
/// Picks the last such link (see `rules/x-web.json` `cardLink`).
fn card_candidate(post: &Post, entities: &[textport::Entity]) -> Option<(String, String)> {
    if post.card_state == CardState::Dismissed {
        return None;
    }
    let mut best: Option<(usize, String, String)> = None;
    for e in entities {
        let textport::EntityKind::Url { expanded, display } = &e.kind else {
            continue;
        };
        for key in [e.text.as_str(), expanded.as_str(), display.as_str()] {
            if let Some((found, meta)) = lookup_link(&post.links, key) {
                if let Some(card) = meta.card.as_ref().filter(|c| !c.is_empty()) {
                    if best.as_ref().is_none_or(|(start, _, _)| e.start >= *start) {
                        best = Some((e.start, found.clone(), card.clone()));
                    }
                }
            }
        }
    }
    best.map(|(_, url, card)| (url, card))
}

/// Returns the `Post::links` key and its metadata. The key matters: the card
/// layout looks metadata up by it, so a link written in a slightly different
/// form still has to resolve to the stored key.
fn lookup_link<'a>(
    links: &'a std::collections::BTreeMap<String, model::LinkMeta>,
    key: &str,
) -> Option<(&'a String, &'a model::LinkMeta)> {
    if let Some((k, meta)) = links.get_key_value(key) {
        return Some((k, meta));
    }
    let norm = normalize_url(key);
    links.iter().find(|(k, _)| normalize_url(k) == norm)
}

/// The `display` a `Post::links` entry gives a URL, if any.
fn link_display<'a>(post: &'a Post, url: &str) -> Option<&'a str> {
    post.links.get(url).and_then(|meta| meta.display.as_deref())
}

/// An X media permalink or a direct twimg media URL: what "Post video" /
/// "Post photo" embeds, and what `xeet-resolve` turns into `Post::media`.
///
/// Permalink: `x.com|twitter.com/[www.|mobile.|m.]/<handle|i>/status/<id>/
/// (video|photo)/<1..4>`, any query (`?t=…`, `?s=20`). Direct:
/// `video.twimg.com/...` or `pbs.twimg.com/(media|amplify_video_thumb|
/// ext_tw_video_thumb|tweet_video_thumb)/...`.
fn is_embedded_media_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    let without_scheme = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .unwrap_or(&lower);
    let without_prefix = without_scheme
        .strip_prefix("www.")
        .or_else(|| without_scheme.strip_prefix("mobile."))
        .or_else(|| without_scheme.strip_prefix("m."))
        .unwrap_or(without_scheme);
    let (host, rest) = without_prefix
        .split_once('/')
        .unwrap_or((without_prefix, ""));
    if host == "video.twimg.com" {
        return !rest.is_empty();
    }
    if host == "pbs.twimg.com" {
        let first = rest.split(['/', '?', '#']).next().unwrap_or("");
        return matches!(
            first,
            "media" | "amplify_video_thumb" | "ext_tw_video_thumb" | "tweet_video_thumb"
        );
    }
    if !matches!(host, "x.com" | "twitter.com") {
        return false;
    }
    let path = rest.split(['?', '#']).next().unwrap_or("");
    let segments: Vec<&str> = path.trim_end_matches('/').split('/').collect();
    // <handle> / status / <id> / <video|photo> / <index>
    if segments.len() != 5 {
        return false;
    }
    let handle_ok = segments[0] == "i"
        || (segments[0].len() <= 15
            && segments[0]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_'));
    handle_ok
        && segments[1] == "status"
        && !segments[2].is_empty()
        && segments[2].chars().all(|c| c.is_ascii_digit())
        && matches!(segments[3], "video" | "photo")
        && matches!(segments[4], "1" | "2" | "3" | "4")
}

fn normalize_url(url: &str) -> String {
    let lower = url.trim().to_ascii_lowercase();
    let without_scheme = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .unwrap_or(&lower);
    let without_www = without_scheme
        .strip_prefix("www.")
        .unwrap_or(without_scheme);
    without_www.trim_end_matches('/').to_string()
}

/// Whether any link in the draft carries card metadata, regardless of whether
/// the card will render (the dismissal warning needs the intent, not the
/// outcome).
fn has_card_metadata(post: &Post) -> bool {
    post.links
        .values()
        .any(|m| m.card.as_ref().is_some_and(|c| !c.is_empty()))
}

fn choose_attachment(
    post: &Post,
    card: Option<&(String, String)>,
    warnings: &mut Vec<String>,
) -> (Option<AttachmentKind>, String) {
    let has_media = !post.media.is_empty();
    let has_quote = post.quote.is_some();
    let has_poll = post.poll.is_some();
    let has_card = card.is_some();

    if has_media && has_poll {
        warnings.push(
            "media and a poll cannot be attached to the same post; the poll is shown".to_string(),
        );
    }
    if has_card && (has_media || has_quote || has_poll) {
        let winner = if has_poll {
            "a poll is attached"
        } else if has_media {
            "media is attached"
        } else {
            "a post is quoted"
        };
        warnings.push(format!("{winner}, so the link card will not render"));
    }

    if let Some(poll) = post.poll.as_ref() {
        let _ = poll;
        return (
            Some(AttachmentKind::Poll),
            "the post has a poll".to_string(),
        );
    }
    if has_media {
        return (
            Some(AttachmentKind::Media),
            if has_card {
                "media is attached; the link card is suppressed"
            } else {
                "media is attached"
            }
            .to_string(),
        );
    }
    if has_quote {
        return (
            Some(AttachmentKind::Quote),
            if has_card {
                "the post quotes another post; the link card is suppressed"
            } else {
                "the post quotes another post"
            }
            .to_string(),
        );
    }
    if let Some((url, card)) = card {
        return (
            Some(AttachmentKind::Card {
                url: url.clone(),
                card: card.clone(),
            }),
            String::new(),
        );
    }
    (None, "nothing is attached".to_string())
}

/// End of the leading reply mentions and the whitespace after them, if the
/// body starts with an `@mention` (a `.@` prefix escapes the reply form).
fn leading_mention_end(chars: &[char], entities: &[Entity]) -> Option<usize> {
    let mut saw = false;
    let mut end = 0;
    loop {
        match entities
            .iter()
            .find(|e| e.kind == SpanKind::Mention && e.start == end)
        {
            Some(m) => {
                saw = true;
                end = m.end;
            }
            None => break,
        }
        let mut k = end;
        while k < chars.len() && chars[k].is_whitespace() {
            k += 1;
        }
        if k < chars.len()
            && chars[k] == '@'
            && entities
                .iter()
                .any(|e| e.kind == SpanKind::Mention && e.start == k)
        {
            end = k;
            continue;
        }
        // Hide the whitespace between the mentions and the body, not the body.
        end = k;
        break;
    }
    if saw {
        Some(end)
    } else {
        None
    }
}

/// Trailing URL entities that a rendered attachment claims, innermost first.
///
/// Mirrors the client's walk (`_D0BurxE.js` `W`/`Oe`): start at the trimmed end,
/// step left across whitespace and claimed URLs, and stop at the first URL that
/// no attachment claims. A media attachment in a draft has no URL in the text
/// (the composer does not add one), so only cards and the quoted post's own
/// link can claim a trailing URL here.
fn trailing_attachment_entities<'a>(
    chars: &[char],
    entities: &'a [Entity],
    attachment: &Option<AttachmentKind>,
    post: &Post,
) -> Vec<&'a Entity> {
    let Some(kind) = attachment else {
        return Vec::new();
    };
    let mut out: Vec<&Entity> = Vec::new();
    let mut scan_end = chars.len();
    loop {
        let n = trim_end(chars, scan_end);
        if n == 0 {
            break;
        }
        let next = entities
            .iter()
            .rev()
            .find(|e| e.end >= n && e.end <= scan_end && e.start < n);
        let Some(e) = next else { break };
        let claimed = match kind {
            AttachmentKind::Card { url, .. } => {
                url_matches(&chars[e.start..e.end].iter().collect::<String>(), url)
            }
            AttachmentKind::Quote => {
                claims_quoted_url(post, &chars[e.start..e.end].iter().collect::<String>())
            }
            AttachmentKind::Media => {
                // The server appends the media's own bare `t.co` to the text.
                // A link the author wrote is either not a t.co or carries link
                // metadata (the payload resolved it to a display URL), and
                // those stay visible: media outranks a card, so nothing
                // claims them (captured IGN/Polygon media posts show `bit.ly`
                // and `polygon.com` links). Only an unresolved t.co counts as
                // the appended URL — unless the post also quotes another post
                // and the trailing URL is that quote's permalink.
                let written: String = chars[e.start..e.end].iter().collect();
                is_embedded_media_url(&written)
                    || link_display(post, &written).is_some_and(is_embedded_media_url)
                    || (normalize_url(&written).starts_with("t.co/")
                        && !post.links.contains_key(&written))
                    || claims_quoted_url(post, &written)
            }
            _ => false,
        };
        if !claimed {
            break;
        }
        out.push(e);
        scan_end = e.start;
    }
    out
}

fn url_matches(written: &str, card_url: &str) -> bool {
    normalize_url(written) == normalize_url(card_url)
}

#[derive(PartialEq, Eq)]
enum PostUrlTarget {
    /// `/<handle>/status/<id>`
    Handle(String),
    /// `/i/status/<id>` or `/i/web/status/<id>`
    AnyStatus,
}

/// Whether `written` is a permalink to `post.quote` — either directly
/// (`x.com/handle/status/123?s=20`, `mobile.twitter.com/…`, `x.com/i/status/…`)
/// or via a `t.co` whose display URL names the quoted post.
fn claims_quoted_url(post: &Post, written: &str) -> bool {
    let Some(q) = post.quote.as_deref() else {
        return false;
    };
    let q_handle = q.author.handle.trim_start_matches('@');
    if let Some(target) = post_url_target(written) {
        return match target {
            PostUrlTarget::AnyStatus => true,
            PostUrlTarget::Handle(name) => {
                !q_handle.is_empty() && q_handle.eq_ignore_ascii_case(&name)
            }
        };
    }
    // A note_tweet or raw payload text can end in a `t.co` whose display URL is
    // `x.com/<handle>/st…` (truncated before `/status/<id>`).
    if normalize_url(written).starts_with("t.co/") {
        if let Some((_, meta)) = lookup_link(&post.links, written) {
            if let Some(disp) = meta.display.as_deref() {
                let d = normalize_url(disp);
                let d = d.strip_prefix("mobile.").unwrap_or(&d);
                if let Some(rest) = d
                    .strip_prefix("x.com/")
                    .or_else(|| d.strip_prefix("twitter.com/"))
                {
                    if rest.starts_with("i/status/") || rest.starts_with("i/web/status/") {
                        return true;
                    }
                    if let Some((name, after)) = rest.split_once('/') {
                        if !q_handle.is_empty()
                            && q_handle.eq_ignore_ascii_case(name)
                            && after.starts_with("st")
                        {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

fn post_url_target(url: &str) -> Option<PostUrlTarget> {
    let normalized = normalize_url(url);
    let normalized = normalized
        .split(['?', '#'])
        .next()
        .unwrap_or(&normalized)
        .trim_end_matches('/');
    let normalized = normalized.strip_prefix("mobile.").unwrap_or(normalized);
    let rest = normalized
        .strip_prefix("x.com/")
        .or_else(|| normalized.strip_prefix("twitter.com/"))?;
    if let Some(id_rest) = rest
        .strip_prefix("i/web/status/")
        .or_else(|| rest.strip_prefix("i/status/"))
    {
        let id = id_rest.split('/').next()?;
        if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
            return Some(PostUrlTarget::AnyStatus);
        }
        return None;
    }
    let mut parts = rest.split('/');
    let name = parts.next()?;
    let status = parts.next()?;
    let id = parts.next()?;
    if name.is_empty() || !matches!(status, "status" | "statuses") {
        return None;
    }
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(PostUrlTarget::Handle(name.to_string()))
}

fn trim_end(chars: &[char], mut end: usize) -> usize {
    while end > 0 && chars[end - 1].is_whitespace() {
        end -= 1;
    }
    end
}

/// The server's long-post cut: the first `limit` code points, backed off to a
/// word boundary and trimmed. Approximate, see SPEC.md "The long-post cut".
fn long_post_cut(chars: &[char], entities: &[Entity], limit_units: usize) -> Option<usize> {
    // X's preview budget counts UTF-16 code units: a surrogate pair (emoji, the
    // math-bold digits in a note) is two. Counting code points here cuts a
    // draft visibly later than X (SPEC.md §5).
    let units: usize = chars.iter().map(|c| c.len_utf16()).sum();
    if units <= limit_units {
        return None;
    }
    let mut end = 0;
    let mut used = 0;
    while end < chars.len() && used + chars[end].len_utf16() <= limit_units {
        used += chars[end].len_utf16();
        end += 1;
    }
    let next_space = chars.get(end).is_none_or(|c| c.is_whitespace());
    let last_space = chars[end - 1].is_whitespace();
    if !next_space && !last_space {
        let mut i = end;
        while i > 0 && !chars[i - 1].is_whitespace() {
            i -= 1;
        }
        if i > 0 {
            end = i;
        }
    }
    // Do not cut inside an entity: a half-rendered display URL is worse than a
    // slightly earlier cut.
    if let Some(e) = entities.iter().find(|e| e.start < end && end < e.end) {
        end = e.start;
    }
    end = trim_end(chars, end);
    if end == 0 {
        None
    } else {
        Some(end)
    }
}

fn build_body(
    chars: &[char],
    utf16_at: &[usize],
    entities: &[Entity],
    hidden: &[HiddenRange],
    start: usize,
    end: usize,
) -> Vec<BodySpan> {
    let mut spans: Vec<BodySpan> = Vec::new();
    let hidden_at = |i: usize| hidden.iter().find(|h| h.start <= i && i < h.end);
    let entity_at = |i: usize| entities.iter().find(|e| e.start == i);
    let mut i = start;
    while i < end {
        if let Some(h) = hidden_at(i) {
            i = h.end.min(end);
            continue;
        }
        if let Some(e) = entity_at(i) {
            if e.end <= end {
                spans.push(BodySpan {
                    text: e.display.clone(),
                    kind: e.kind,
                    source: [utf16_at[e.start], utf16_at[e.end]],
                });
                i = e.end;
                continue;
            }
            // The cut landed inside the entity; render its visible prefix as
            // plain text.
            let text: String = chars[i..end].iter().collect();
            if !text.is_empty() {
                spans.push(BodySpan {
                    text,
                    kind: SpanKind::Plain,
                    source: [utf16_at[i], utf16_at[end]],
                });
            }
            break;
        }
        let mut j = i + 1;
        while j < end && hidden_at(j).is_none() && entity_at(j).is_none() {
            j += 1;
        }
        let text: String = chars[i..j].iter().collect();
        if !text.is_empty() {
            spans.push(BodySpan {
                text,
                kind: SpanKind::Plain,
                source: [utf16_at[i], utf16_at[j]],
            });
        }
        i = j;
    }
    spans
}

#[cfg(test)]
mod tests;
