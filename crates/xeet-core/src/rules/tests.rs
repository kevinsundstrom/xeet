//! The rules matrix: one row per behavior in PLAN.md §9, with the decision X
//! makes and the report that explains it. A row fails when the engine changes
//! its mind; the evidence for each expected value is in `rules/x-web.json` and
//! SPEC.md.

use super::*;
use crate::model::{CardState, LinkMeta, Media, MediaKind, Poll, RenderOptions, Surface, Verified};

fn post(text: &str) -> Post {
    Post {
        text: text.to_string(),
        author: model::Author {
            name: "Vercel".into(),
            handle: "vercel".into(),
            verified: Verified::Business,
            ..Default::default()
        },
        ..Default::default()
    }
}

fn opts(surface: Surface) -> RenderOptions {
    RenderOptions {
        surface,
        ..RenderOptions::default()
    }
}

fn timeline() -> RenderOptions {
    opts(Surface::WebTimeline)
}

fn detail() -> RenderOptions {
    opts(Surface::WebDetail)
}

fn with_card(mut p: Post, url: &str, card: &str) -> Post {
    p.links.insert(
        url.to_string(),
        LinkMeta {
            card: Some(card.to_string()),
            title: Some("A title".into()),
            description: Some("A description".into()),
            domain: Some("vercel.com".into()),
            image: None,
            display: None,
        },
    );
    p
}

fn long_text(words: usize) -> String {
    (0..words)
        .map(|i| format!("word{i:04}"))
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Text and links
// ---------------------------------------------------------------------------

#[test]
fn resolves_entities_and_weighted_length() {
    let p = post("Ship it with https://vercel.com/blog/thing @vercel #launch $BRK");
    let d = decide(&p, &timeline());
    assert_eq!(d.report.length.limit, 280);
    // URL counts 23, the rest one each.
    let expected = 23 + "Ship it with  @vercel #launch $BRK".len() as u32;
    assert_eq!(d.report.length.weighted, expected);
    assert!(d.report.length.valid);
    let kinds: Vec<&str> = d.report.entities.iter().map(|e| e.kind.as_str()).collect();
    assert_eq!(kinds, ["url", "mention", "hashtag", "cashtag"]);
}

#[test]
fn a_url_is_displayed_in_xs_shortened_form() {
    let p = post("Read https://vercel.com/blog/introducing-vercel-schedules today");
    let d = decide(&p, &timeline());
    assert_eq!(
        d.body_text(),
        "Read vercel.com/blog/introduci\u{2026} today"
    );
    assert_eq!(
        d.report.entities[0].display.as_deref(),
        Some("vercel.com/blog/introduci\u{2026}")
    );
    // The whole written URL is the source range of the shortened span.
    let url_span = d.body.iter().find(|s| s.kind == SpanKind::Url).unwrap();
    assert_eq!(url_span.source[0], "Read ".len());
    assert_eq!(
        url_span.source[1],
        "Read ".len() + "https://vercel.com/blog/introducing-vercel-schedules".len()
    );
}

#[test]
fn leading_mentions_of_a_reply_are_hidden() {
    let mut p = post("@alice @bob thanks for the review, shipping now");
    p.reply_to = Some("2110000000000000000".into());
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text(), "thanks for the review, shipping now");
    assert_eq!(d.report.hidden.len(), 1);
    assert_eq!(d.report.hidden[0].range, [0, "@alice @bob ".len()]);
    assert!(d.report.hidden[0].why.contains("leading mentions"));
}

#[test]
fn a_plain_post_that_starts_with_a_mention_keeps_it() {
    // Captured post (levelsio): the page shows "@TermiusHQ feature request…",
    // because the post is not a reply even though it opens with a mention.
    let p = post("@TermiusHQ feature request: sync my tabs");
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text(), "@TermiusHQ feature request: sync my tabs");
    assert!(d.report.hidden.is_empty());
}

#[test]
fn a_dot_prefix_is_not_a_reply() {
    let p = post(".@alice thanks for the review");
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text(), ".@alice thanks for the review");
    assert!(d.report.hidden.is_empty());
}

#[test]
fn a_trailing_url_that_became_the_card_is_hidden() {
    let p = with_card(
        post("We shipped the thing.\n\nRead more: https://vercel.com/blog/thing"),
        "https://vercel.com/blog/thing",
        "summary_large_image",
    );
    let d = decide(&p, &timeline());
    assert_eq!(
        d.attachment,
        Some(AttachmentKind::Card {
            url: "https://vercel.com/blog/thing".into(),
            card: "summary_large_image".into(),
        })
    );
    // The space before the hidden URL goes with it (SPEC.md §3).
    assert_eq!(d.body_text(), "We shipped the thing.\n\nRead more:");
    assert_eq!(d.report.hidden.len(), 1);
    assert_eq!(
        d.report.hidden[0].range,
        [
            "We shipped the thing.\n\nRead more:".len(),
            "We shipped the thing.\n\nRead more: https://vercel.com/blog/thing".len(),
        ]
    );
    assert_eq!(d.report.hidden[0].why, "trailing URL replaced by its card");
}

#[test]
fn a_mid_text_url_stays_visible_when_a_later_url_gets_the_card() {
    let p = with_card(
        post("https://first.example.com/a is the writeup, code at https://second.example.com/b"),
        "https://second.example.com/b",
        "summary",
    );
    let d = decide(&p, &timeline());
    assert!(d
        .body_text()
        .starts_with("first.example.com/a is the writeup, code at"));
    assert!(!d.body_text().contains("second.example"));
    assert_eq!(d.report.hidden.len(), 1);
    assert_eq!(
        d.report.hidden[0].range[0],
        "https://first.example.com/a is the writeup, code at".len()
    );
}

#[test]
fn a_link_without_card_metadata_stays_visible() {
    let mut p = post("Read https://vercel.com/blog/thing");
    p.links.insert(
        "https://vercel.com/blog/thing".into(),
        LinkMeta {
            card: None,
            ..Default::default()
        },
    );
    let d = decide(&p, &timeline());
    assert_eq!(d.attachment, None);
    assert!(d.report.hidden.is_empty());
    assert_eq!(d.body_text(), "Read vercel.com/blog/thing");
}

// ---------------------------------------------------------------------------
// Show more
// ---------------------------------------------------------------------------

#[test]
fn a_long_post_is_cut_inline_in_the_timeline() {
    let text = long_text(80); // 80 * 9 = 719 characters
    let mut p = post(&text);
    p.long_post = Some(true);
    let d = decide(&p, &timeline());
    assert_eq!(d.show_more, Some(ShowMore::Inline));
    assert_eq!(d.report.text.show_more.as_deref(), Some("inline"));
    assert!(d.report.text.truncated);
    assert!(
        d.clamp.is_none(),
        "the timeline main body has no line clamp"
    );
    let visible = d.body_text();
    assert!(visible.len() <= 280, "cut at {} characters", visible.len());
    assert!(visible.len() >= 270, "cut too early: {}", visible.len());
    assert!(!visible.ends_with(' '));
    assert!(d.report.warnings.iter().any(|w| w.contains("Show more")));
}

#[test]
fn a_server_cut_body_wins_over_the_derived_cut() {
    // A captured long post carries the exact body X's timeline shows; a draft
    // does not and falls back to the 280-code-point rule.
    let full = long_text(80);
    let mut p = post(&full);
    p.long_post = Some(true);
    p.long_post_body = Some(
        full.chars()
            .take(271)
            .collect::<String>()
            .trim_end()
            .to_string(),
    );
    let d = decide(&p, &timeline());
    assert_eq!(
        d.body_text(),
        full.chars()
            .take(271)
            .collect::<String>()
            .trim_end()
            .to_string()
    );
    assert_eq!(d.show_more, Some(ShowMore::Inline));
    assert_eq!(d.report.text.show_more.as_deref(), Some("inline"));
}

#[test]
fn a_payload_display_url_is_what_the_body_shows() {
    let mut p = post("Read more: https://t.co/TqcDRZUVZr");
    p.links.insert(
        "https://t.co/TqcDRZUVZr".into(),
        LinkMeta {
            display: Some("bbc.in/4foQRxp".into()),
            ..Default::default()
        },
    );
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text(), "Read more: bbc.in/4foQRxp");
}

#[test]
fn a_server_entity_label_replaces_the_token() {
    // Captured post (elonmusk): the text says "@Bot", the page prints the
    // canonical "@bot" from the payload's mention entity.
    let mut p = post("Just did a round table review with the Grok @Bot team.");
    p.entity_labels.insert("@Bot".into(), "@bot".into());
    let d = decide(&p, &timeline());
    assert_eq!(
        d.body_text(),
        "Just did a round table review with the Grok @bot team."
    );
    assert_eq!(d.report.hidden.len(), 0);
}

#[test]
fn a_utf16_range_that_bisects_a_surrogate_rounds_up() {
    // The page shows "NFL \u{1F440}" for this payload; its range ends between
    // the two UTF-16 halves of the emoji. Rules must cover the whole code point.
    let text = "NFL \u{1F440} tail";
    let chars: Vec<char> = text.chars().collect();
    let utf16_at = utf16_offsets(&chars);
    let end_inside_emoji = "NFL ".encode_utf16().count() + 1; // between the halves
    let entities = vec![textport::Entity {
        kind: textport::EntityKind::Mention,
        start: 0,
        end: end_inside_emoji,
        text: "NFL \u{1F440}".into(),
    }];
    let post = super::Post::default();
    let mapped = char_entities(&entities, &utf16_at, &post);
    // The whole emoji stays: the boundary rounds up, it is never spliced.
    assert_eq!(mapped[0].end, "NFL \u{1F440}".chars().count());
    assert!(mapped[0].end > "NFL ".chars().count());
}

#[test]
fn the_detail_view_never_truncates() {
    let text = long_text(80);
    let mut p = post(&text);
    p.long_post = Some(true);
    let d = decide(&p, &detail());
    assert_eq!(d.show_more, None);
    assert_eq!(d.report.text.show_more, None);
    assert!(!d.report.text.truncated);
    assert_eq!(d.body_text(), text);
    assert!(d.clamp.is_none());
}

#[test]
fn a_long_post_without_the_server_flag_is_still_cut_when_over_weight() {
    // 300 weighted characters of plain text: the server would have made this a
    // note post, so no server flag is needed to decide the timeline cut.
    let text = long_text(40); // 359 characters
    let p = post(&text);
    let d = decide(&p, &timeline());
    assert_eq!(d.show_more, Some(ShowMore::Inline));
}

#[test]
fn a_quoted_post_is_clamped_to_five_lines_and_not_truncated_inline() {
    let text = long_text(80);
    let mut quote = post(&text);
    quote.long_post = Some(true);
    let d = decide_quote(&quote, &timeline());
    assert_eq!(d.clamp, Some(5));
    assert_eq!(
        d.show_more, None,
        "the clamped mechanism is decided by layout"
    );
}

#[test]
fn the_cut_lands_on_a_word_boundary() {
    let text = "a".repeat(275) + " boundaryword " + &"b".repeat(100);
    let mut p = post(&text);
    p.long_post = Some(true);
    let d = decide(&p, &timeline());
    assert!(
        d.body_text().len() <= 275,
        "cut inside the long word: {}",
        d.body_text().len()
    );
}

// ---------------------------------------------------------------------------
// Which attachment wins (PLAN.md §9)
// ---------------------------------------------------------------------------

#[test]
fn media_beats_a_link_card() {
    let mut p = with_card(
        post("Look at this https://vercel.com/blog/thing"),
        "https://vercel.com/blog/thing",
        "summary_large_image",
    );
    p.media.push(Media {
        kind: MediaKind::Image,
        width: 1600,
        height: 900,
        ..Default::default()
    });
    let d = decide(&p, &timeline());
    assert_eq!(d.attachment, Some(AttachmentKind::Media));
    assert_eq!(d.report.attachment.as_ref().unwrap().shown, "media");
    assert!(d
        .report
        .warnings
        .iter()
        .any(|w| w.contains("link card will not render")));
    // The URL stays in the body: no card is rendered, so nothing claims it.
    assert!(d.body_text().contains("vercel.com/blog/thing"));
    assert!(d.report.hidden.is_empty());
}

#[test]
fn a_quoted_post_beats_a_link_card() {
    let mut p = with_card(
        post("This https://vercel.com/blog/thing"),
        "https://vercel.com/blog/thing",
        "summary",
    );
    p.quote = Some(Box::new(post("original")));
    let d = decide(&p, &timeline());
    assert_eq!(d.attachment, Some(AttachmentKind::Quote));
    assert!(d
        .report
        .warnings
        .iter()
        .any(|w| w.contains("link card will not render")));
}

#[test]
fn a_poll_beats_a_link_card() {
    let mut p = with_card(
        post("Vote https://vercel.com/blog/thing"),
        "https://vercel.com/blog/thing",
        "summary",
    );
    p.poll = Some(Poll {
        choices: vec!["Yes".into(), "No".into()],
        ..Default::default()
    });
    let d = decide(&p, &timeline());
    assert_eq!(d.attachment, Some(AttachmentKind::Poll));
    assert!(d
        .report
        .warnings
        .iter()
        .any(|w| w.contains("link card will not render")));
}

#[test]
fn a_pasted_link_to_the_quoted_post_is_hidden() {
    let mut p = post("worth reading https://x.com/alice/status/123456");
    p.quote = Some(Box::new(Post {
        text: "original".into(),
        author: model::Author {
            handle: "alice".into(),
            ..Default::default()
        },
        ..Default::default()
    }));
    let d = decide(&p, &timeline());
    assert_eq!(d.attachment, Some(AttachmentKind::Quote));
    assert_eq!(d.body_text(), "worth reading");
    assert_eq!(
        d.report.hidden[0].why,
        "trailing URL replaced by the quoted post"
    );

    // A link to somebody else's post stays visible.
    let mut other = post("worth reading https://x.com/bob/status/123456");
    other.quote = p.quote.clone();
    let d = decide(&other, &timeline());
    assert_eq!(d.body_text(), "worth reading x.com/bob/status/123\u{2026}");
    assert!(d.report.hidden.is_empty());
}

#[test]
fn the_last_link_with_metadata_gets_the_card() {
    let mut p = post("First https://one.example.com/a then https://two.example.com/b");
    for url in ["https://one.example.com/a", "https://two.example.com/b"] {
        p.links.insert(
            url.into(),
            LinkMeta {
                card: Some("summary".into()),
                ..Default::default()
            },
        );
    }
    let d = decide(&p, &timeline());
    match d.attachment {
        Some(AttachmentKind::Card { ref url, .. }) => assert_eq!(url, "https://two.example.com/b"),
        other => panic!("{other:?}"),
    }
    assert_eq!(d.body_text(), "First one.example.com/a then");
}

#[test]
fn a_dismissed_card_shows_nothing_and_is_not_inherited() {
    let mut p = with_card(
        post("First https://one.example.com/a then https://two.example.com/b"),
        "https://one.example.com/a",
        "summary",
    );
    if let Some(m) = p.links.get_mut("https://two.example.com/b") {
        m.card = Some("summary_large_image".into());
    }
    p.card_state = CardState::Dismissed;
    let d = decide(&p, &timeline());
    assert_eq!(d.attachment, None);
    assert!(d.report.attachment.is_none());
    // Both URLs stay in the body: the dismissal is all-or-nothing.
    assert!(d.body_text().contains("one.example.com/a"));
    assert!(d.body_text().contains("two.example.com/b"));
    assert!(d.report.warnings.iter().any(|w| w.contains("dismissed")));
}

#[test]
fn an_empty_card_type_is_not_a_card() {
    let mut p = post("Read https://vercel.com/blog/thing");
    p.links.insert(
        "https://vercel.com/blog/thing".into(),
        LinkMeta {
            card: Some(String::new()),
            ..Default::default()
        },
    );
    let d = decide(&p, &timeline());
    assert_eq!(d.attachment, None);
}

#[test]
fn a_poll_and_media_in_one_draft_is_a_warning() {
    let mut p = post("Vote");
    p.poll = Some(Poll {
        choices: vec!["Yes".into()],
        ..Default::default()
    });
    p.media.push(Media {
        kind: MediaKind::Image,
        width: 10,
        height: 10,
        ..Default::default()
    });
    let d = decide(&p, &timeline());
    assert_eq!(d.attachment, Some(AttachmentKind::Poll));
    assert!(d.report.warnings.iter().any(|w| w.contains("poll")));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

#[test]
fn the_report_names_its_ruleset_and_surfaces() {
    let d = decide(&post("hello"), &timeline());
    assert!(d.ruleset.starts_with("x-web@"));
    assert_eq!(d.report.ruleset, d.ruleset);
    assert_eq!(
        d.report.verified_for,
        vec![Surface::WebTimeline, Surface::WebDetail]
    );
}

#[test]
fn hidden_ranges_are_in_utf16_units() {
    // The rocket is one code point but two UTF-16 units, so the trailing URL's
    // source range shifts by one.
    let p = with_card(
        post("\u{1F680} shipped https://vercel.com/blog/thing"),
        "https://vercel.com/blog/thing",
        "summary",
    );
    let d = decide(&p, &timeline());
    let hidden = &d.report.hidden[0];
    let expected_start = "\u{1F680} shipped".encode_utf16().count();
    assert_eq!(hidden.range[0], expected_start);
    let expected_end = "\u{1F680} shipped https://vercel.com/blog/thing"
        .encode_utf16()
        .count();
    assert_eq!(hidden.range[1], expected_end);
}

#[test]
fn the_same_input_decides_the_same_way() {
    let p = with_card(
        post("Read https://vercel.com/blog/thing"),
        "https://vercel.com/blog/thing",
        "summary",
    );
    let a = decide(&p, &timeline());
    let b = decide(&p, &timeline());
    assert_eq!(
        serde_json::to_string(&a.report).unwrap(),
        serde_json::to_string(&b.report).unwrap()
    );
    assert_eq!(a.body, b.body);
}

#[test]
fn attachments_are_reported_with_a_reason() {
    let p = with_card(
        post("Read https://vercel.com/blog/thing"),
        "https://vercel.com/blog/thing",
        "summary_large_image",
    );
    let d = decide(&p, &timeline());
    let a = d.report.attachment.unwrap();
    assert_eq!(a.shown, "card");
    assert_eq!(a.url.as_deref(), Some("https://vercel.com/blog/thing"));
    assert!(a.why.contains("summary_large_image"));
}

#[test]
fn formatting_helpers_are_available_to_the_frame() {
    assert_eq!(spec::format_count(12_345), "12K");
    let now = 1_800_000_000_000i64;
    assert_eq!(
        spec::format_relative_time(now - 3 * 3_600_000, now, true),
        "3h"
    );
    assert_eq!(spec::verified_at().len(), 10);
}

// ---------------------------------------------------------------------------
// Long-post expansion changed with the client version (SPEC.md §5)
// ---------------------------------------------------------------------------

const NEW_CLIENT: &str = "1037d89b2e16b39ce3ae53affdf45722259d018f";
const OLD_CLIENT: &str = "89824c04747e706b687e3af193963c4d00251b8e";
const LIVE_CLIENT: &str = "55591fe0f5ae6815fa853ab25bc30b5118d1d017";

/// A captured long post: the note, and the server's cut body for the cell.
fn captured_note(body: &str, hidden_tail: &str, version: &str) -> Post {
    let mut p = post(&format!("{body}{hidden_tail}"));
    p.long_post = Some(true);
    p.long_post_body = Some(body.to_string());
    p.app_version = Some(version.to_string());
    p
}

#[test]
fn a_new_client_expands_a_note_that_hides_at_most_140_characters() {
    // BsiDb726.js `f`: the cell starts expanded when the cut body is at least
    // 200 characters and at most 140 are hidden, so there is no "Show more".
    let body = "a".repeat(271);
    let p = captured_note(&body, &"b".repeat(140), NEW_CLIENT);
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text(), p.text, "the whole note is shown");
    assert_eq!(d.show_more, None);
    assert!(!d.report.text.truncated);
    assert!(!d.report.warnings.iter().any(|w| w.contains("Show more")));
}

#[test]
fn a_new_client_still_cuts_a_note_that_hides_more_than_140_characters() {
    let body = "a".repeat(271);
    let p = captured_note(&body, &"b".repeat(141), NEW_CLIENT);
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text(), body);
    assert_eq!(d.show_more, Some(ShowMore::Inline));
    assert!(d.report.text.truncated);
}

#[test]
fn a_new_client_does_not_expand_a_short_cut_body() {
    // The other half of the gate: `n >= 200`.
    let body = "a".repeat(199);
    let p = captured_note(&body, "bbbbb", NEW_CLIENT);
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text(), body);
    assert_eq!(d.show_more, Some(ShowMore::Inline));
}

#[test]
fn the_old_client_always_shows_the_cut_and_the_link() {
    // Same post, page captured with 89824c04: that client has no elision gate.
    let body = "a".repeat(271);
    let p = captured_note(&body, &"b".repeat(140), OLD_CLIENT);
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text(), body);
    assert_eq!(d.show_more, Some(ShowMore::Inline));
}

#[test]
fn the_expansion_gate_counts_utf16_units_like_the_client() {
    // The client compares JavaScript string lengths: an emoji is two units.
    // 260 code points of which 60 are emoji = 320 UTF-16 units.
    let body: String = std::iter::repeat_n("a", 200)
        .chain(std::iter::repeat_n("\u{1F600}", 60))
        .collect();
    let p = captured_note(&body, &"b".repeat(140), NEW_CLIENT);
    let short_utf16: usize = body.encode_utf16().count();
    let note_utf16: usize = p.text.encode_utf16().count();
    assert_eq!(short_utf16, 320);
    assert_eq!(note_utf16 - short_utf16, 140);
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text(), p.text, "140 hidden units still expands");
}

#[test]
fn a_draft_card_link_takes_the_blank_line_before_it() {
    // The playground case: a draft ending "… says “Show more”.\n\n<card URL>".
    // X hides the whitespace with the URL, so the body has no trailing blank
    // line (137/137 corpus posts end the range before the whitespace, §3).
    let text = "Someone says \u{201c}Show more\u{201d}.\n\nhttps://vercel.com/blog/the-thing";
    let p = with_card(
        post(text),
        "https://vercel.com/blog/the-thing",
        "summary_large_image",
    );
    let d = decide(&p, &timeline());
    assert!(d.attachment.is_some());
    assert_eq!(d.body_text(), "Someone says \u{201c}Show more\u{201d}.");
    assert_eq!(
        d.report.text.visible,
        d.body_text(),
        "report.text.visible and Decisions.body must agree"
    );
    assert_eq!(d.report.hidden.len(), 1);
    assert_eq!(
        d.report.hidden[0].range,
        [
            "Someone says \u{201c}Show more\u{201d}."
                .encode_utf16()
                .count(),
            text.encode_utf16().count(),
        ]
    );
}

#[test]
fn a_draft_media_link_takes_the_space_before_it() {
    let mut p = post("Launch day. https://t.co/abc123");
    p.media.push(Media {
        kind: MediaKind::Image,
        ..Default::default()
    });
    let d = decide(&p, &timeline());
    assert_eq!(d.attachment, Some(AttachmentKind::Media));
    assert_eq!(d.body_text(), "Launch day.");
    assert_eq!(d.report.text.visible, d.body_text());
    assert_eq!(d.report.hidden[0].range[0], "Launch day.".len());
}

#[test]
fn a_mid_text_link_is_never_trimmed() {
    // Only a *trailing* URL an attachment claims is hidden; the whitespace rule
    // must not touch a link in the middle of the text.
    let p = with_card(
        post("see https://one.example.com/a for details"),
        "https://one.example.com/a",
        "summary",
    );
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text(), "see one.example.com/a for details");
    assert!(d.report.hidden.is_empty());
    assert_eq!(d.report.text.visible, d.body_text());
}

#[test]
fn the_live_client_shows_the_cut_and_the_inline_link() {
    // 55591fe0 still ships the 1037d89b gate but the live timeline does not
    // apply it: post 2120188488628977819 (note 356) is cut at 259 with a link.
    let body = "a".repeat(259);
    let p = captured_note(&body, &"b".repeat(97), LIVE_CLIENT);
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text(), body);
    assert_eq!(d.show_more, Some(ShowMore::Inline));
    assert!(d.report.text.truncated);
}

#[test]
fn the_expansion_gate_needs_text_the_payload_actually_hides() {
    // A converter can pass the server's cut body as Post::text as well (the
    // playground resolver does). Nothing is hidden then, so the cell must keep
    // its "Show more" instead of "expanding" to the same text.
    let body = "a".repeat(271);
    let mut p = post(&body);
    p.long_post = Some(true);
    p.long_post_body = Some(body.clone());
    p.app_version = Some(NEW_CLIENT.to_string());
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text(), body);
    assert_eq!(d.show_more, Some(ShowMore::Inline));
}

#[test]
fn the_derived_cut_counts_utf16_units() {
    // 200 emoji = 400 UTF-16 units. The budget is 280 units, so the cut keeps
    // 140 code points; a code-point budget would keep 280 and cut much later.
    let text = "\u{1F600}".repeat(200);
    let p = post(&text);
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text().encode_utf16().count(), 280);
    assert_eq!(d.body_text().chars().count(), 140);
}

// ---------------------------------------------------------------------------
// Nested quote preview: outer.quote.quote (dfWSwB9n.js `H`)
// ---------------------------------------------------------------------------

fn by(handle: &str, text: &str) -> Post {
    let mut p = post(text);
    p.author.handle = handle.to_string();
    p
}

fn with_media(mut p: Post) -> Post {
    p.media.push(Media {
        kind: MediaKind::Image,
        width: 1600,
        height: 900,
        ..Default::default()
    });
    p
}

#[test]
fn an_eligible_nested_quote_clamps_q2_to_two_plain_lines() {
    let outer = by("alice", "outer");
    let q1 = by("bob", "the quote");
    let q2 = with_media(by("carol", "the nested quote"));
    let d = decide_nested_quote(&outer, &q1, &q2, &timeline()).expect("eligible");
    assert_eq!(d.clamp, Some(2));
    assert_eq!(d.body_text(), "the nested quote");
    assert_eq!(d.show_more, None);
    let nested = d.nested.expect("nested preview metadata");
    assert!(nested.plain_entities);
    assert!(nested.media_thumb, "q2's only media is the thumbnail");
}

#[test]
fn a_nested_quote_uses_plain_entity_text() {
    let outer = by("alice", "outer");
    let q1 = by("bob", "quote");
    let mut q2 = by("carol", "@dave read https://t.co/abc123");
    q2.links.insert(
        "https://t.co/abc123".into(),
        LinkMeta {
            display: Some("example.com/story".into()),
            ..Default::default()
        },
    );
    let d = decide_nested_quote(&outer, &q1, &q2, &timeline()).expect("eligible");
    // `render-entity-as-text`: the mention and URL print their display text;
    // `plain_entities` tells cards to draw them in the inherited color.
    assert_eq!(d.body_text(), "@dave read example.com/story");
    assert!(d.nested.expect("metadata").plain_entities);
}

#[test]
fn a_reply_as_the_nested_quote_hides_its_leading_mentions() {
    let outer = by("alice", "outer");
    let q1 = by("bob", "quote");
    let mut q2 = by("carol", "@dave this is the reply");
    q2.reply_to = Some("2111111111111111111".into());
    let d = decide_nested_quote(&outer, &q1, &q2, &timeline()).expect("eligible");
    assert_eq!(d.body_text(), "this is the reply");
    assert_eq!(d.report.hidden.len(), 1);
}

#[test]
fn a_nested_quote_with_media_hides_its_trailing_media_link() {
    let outer = by("alice", "outer");
    let q1 = by("bob", "quote");
    let q2 = with_media(by("carol", "look https://t.co/abc123"));
    let d = decide_nested_quote(&outer, &q1, &q2, &timeline()).expect("eligible");
    assert_eq!(d.body_text(), "look");
    assert!(d.nested.expect("metadata").media_thumb);
}

#[test]
fn a_crowded_outer_cell_has_no_nested_preview() {
    let mut outer = by("alice", "a reply");
    outer.reply_to = Some("2111111111111111111".into());
    let q1 = by("bob", "quote");
    let q2 = by("carol", "nested");
    assert!(decide_nested_quote(&outer, &q1, &q2, &timeline()).is_none());
    assert!(!nested_quote_eligible(&outer, &q1, &q2));
}

#[test]
fn a_nested_quote_needs_its_author() {
    let outer = by("alice", "outer");
    let q1 = by("bob", "quote");
    let q2 = Post {
        text: "no author".into(),
        ..Default::default()
    };
    assert!(decide_nested_quote(&outer, &q1, &q2, &timeline()).is_none());
}

#[test]
fn quoting_yourself_hides_the_nested_preview() {
    let outer = by("alice", "outer");
    let q1 = by("Alice", "quote of myself");
    let q2 = by("carol", "nested");
    assert!(decide_nested_quote(&outer, &q1, &q2, &timeline()).is_none());

    let q1 = by("bob", "quote");
    let q2 = by("BOB", "nested");
    assert!(decide_nested_quote(&outer, &q1, &q2, &timeline()).is_none());
}

#[test]
fn a_nested_card_or_poll_hides_the_preview() {
    let outer = by("alice", "outer");
    let q1 = by("bob", "quote");
    let q2 = with_card(by("carol", "nested"), "https://example.com/x", "summary");
    assert!(decide_nested_quote(&outer, &q1, &q2, &timeline()).is_none());

    let mut q2 = by("carol", "nested");
    q2.poll = Some(Poll {
        choices: vec!["a".into(), "b".into()],
        ..Default::default()
    });
    assert!(decide_nested_quote(&outer, &q1, &q2, &timeline()).is_none());
}

#[test]
fn at_most_one_of_the_three_cells_may_render_media() {
    let outer = by("alice", "outer");
    let q1 = by("bob", "quote");
    let q2 = by("carol", "nested");

    // One: outer media, q2 media, or q1 media alone is allowed.
    assert!(decide_nested_quote(&with_media(outer.clone()), &q1, &q2, &timeline()).is_some());
    assert!(decide_nested_quote(&outer, &with_media(q1.clone()), &q2, &timeline()).is_some());
    let d = decide_nested_quote(&outer, &q1, &with_media(q2.clone()), &timeline()).unwrap();
    assert!(d.nested.unwrap().media_thumb);
    let d = decide_nested_quote(&with_media(outer.clone()), &q1, &q2, &timeline()).unwrap();
    assert!(!d.nested.unwrap().media_thumb);

    // Two: any pair rejects.
    assert!(decide_nested_quote(
        &with_media(outer.clone()),
        &with_media(q1.clone()),
        &q2,
        &timeline()
    )
    .is_none());
    assert!(decide_nested_quote(
        &with_media(outer.clone()),
        &q1,
        &with_media(q2.clone()),
        &timeline()
    )
    .is_none());
    assert!(decide_nested_quote(
        &outer,
        &with_media(q1.clone()),
        &with_media(q2.clone()),
        &timeline()
    )
    .is_none());

    // A card or poll counts as rendering media for outer and q1.
    let outer_card = with_card(outer.clone(), "https://example.com/a", "summary");
    assert!(decide_nested_quote(&outer_card, &q1, &with_media(q2.clone()), &timeline()).is_none());
    let q1_card = with_card(q1.clone(), "https://example.com/b", "summary");
    assert!(decide_nested_quote(&outer, &q1_card, &with_media(q2.clone()), &timeline()).is_none());
    assert!(decide_nested_quote(&with_media(outer), &q1_card, &q2, &timeline()).is_none());
}

#[test]
fn a_long_nested_quote_shows_no_inline_link() {
    let outer = by("alice", "outer");
    let q1 = by("bob", "quote");
    let body = "a".repeat(260);
    let mut q2 = by("carol", &format!("{body}hidden tail"));
    q2.long_post = Some(true);
    q2.long_post_body = Some(body.clone());
    let d = decide_nested_quote(&outer, &q1, &q2, &timeline()).expect("eligible");
    assert_eq!(d.body_text(), body);
    assert_eq!(d.clamp, Some(2));
    assert_eq!(
        d.show_more, None,
        "the preview clamps, it never adds a link"
    );
}

#[test]
fn trailing_quote_url_variants_are_hidden() {
    for url in [
        "https://x.com/better_auth/status/2117734443452699061?s=20&t=abc",
        "https://mobile.twitter.com/better_auth/status/2117734443452699061/photo/1",
        "https://x.com/i/status/2117734443452699061",
    ] {
        let mut p = by("rauchg", &format!("hi there\n{url}"));
        p.quote = Some(Box::new(by("better_auth", "Security Update")));
        let d = decide(&p, &timeline());
        assert_eq!(d.body_text(), "hi there", "failed to hide {url}");
    }

    // Shortened t.co permalink on a quoted post (as in note_tweet payloads).
    let mut q1 = by("bob", "Look at this https://t.co/b9jaRGUqZv");
    q1.links.insert(
        "https://t.co/b9jaRGUqZv".to_string(),
        crate::model::LinkMeta {
            display: Some("x.com/carol/status/2…".to_string()),
            ..Default::default()
        },
    );
    q1.quote = Some(Box::new(by("carol", "inner")));
    let d = decide_quote(&q1, &timeline());
    assert_eq!(d.body_text(), "Look at this");
}

// ---------------------------------------------------------------------------
// Post video / embedded media URLs (tU-nr9vs.js, BNn3ozGQ.js)
// ---------------------------------------------------------------------------

fn media_post(text: &str) -> Post {
    with_media(post(text))
}

#[test]
fn a_trailing_x_media_permalink_is_hidden_with_its_space() {
    // Even with a `Post::links` entry (resolve can record the URL with no
    // card), the permalink belongs to the attached media.
    let url = "https://x.com/cursor_ai/status/2118458629091426304/video/1";
    let mut p = media_post(&format!("check this out {url}"));
    p.links.insert(
        url.into(),
        LinkMeta {
            display: None,
            ..Default::default()
        },
    );
    let d = decide(&p, &timeline());
    assert_eq!(d.attachment, Some(AttachmentKind::Media));
    assert_eq!(d.body_text(), "check this out");
    assert_eq!(d.report.hidden.len(), 1);
    assert_eq!(
        d.report.hidden[0].why,
        "trailing URL replaced by attached media"
    );
}

#[test]
fn a_trailing_twimg_media_url_is_hidden() {
    let p = media_post(
        "look https://video.twimg.com/amplify_video/2118458629091426304/vid/avc1/1280x720/foo.mp4",
    );
    assert_eq!(decide(&p, &timeline()).body_text(), "look");
}

#[test]
fn a_mid_text_x_media_permalink_takes_one_space() {
    let p = media_post("check https://x.com/cursor_ai/status/123/video/1 now");
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text(), "check now");
    assert_eq!(
        d.report.hidden[0].why,
        "embedded media URL replaced by attached media"
    );
}

#[test]
fn a_mid_text_twimg_url_takes_one_space() {
    let p = media_post("before https://pbs.twimg.com/media/AbCdEf.jpg after");
    assert_eq!(decide(&p, &timeline()).body_text(), "before after");
}

#[test]
fn every_permalink_shape_is_claimed() {
    for url in [
        "https://twitter.com/foo/status/123/photo/2?s=20",
        "https://mobile.twitter.com/foo/status/123/video/1?t=abc",
        "https://www.x.com/foo/status/123/photo/4",
        "https://mobile.x.com/foo/status/123/video/3/",
        "https://x.com/i/status/123/video/1",
        "https://x.com/i/status/123/video/1?s=20",
    ] {
        let p = media_post(&format!("see {url} here"));
        let d = decide(&p, &timeline());
        assert_eq!(d.body_text(), "see here", "url {url}");
    }
}

#[test]
fn a_media_url_without_an_attachment_stays_visible() {
    let p = post("see https://x.com/cursor_ai/status/123/video/1 here");
    let d = decide(&p, &timeline());
    assert!(d.report.hidden.is_empty());
    assert!(d.body_text().contains("x.com"), "got {:?}", d.body_text());
}

#[test]
fn external_links_on_a_media_post_stay_visible() {
    let p = media_post("read https://bit.ly/abc and https://polygon.com/story");
    let d = decide(&p, &timeline());
    assert!(d.report.hidden.is_empty());
    assert_eq!(d.body_text(), "read bit.ly/abc and polygon.com/story");
}

#[test]
fn non_media_twimg_and_status_urls_are_not_claimed() {
    for text in [
        "pic https://pbs.twimg.com/profile_images/123/avatar.jpg",
        "post https://x.com/foo/status/123",
        "card https://pbs.twimg.com/card_img/123/foo.jpg",
    ] {
        let p = media_post(text);
        let d = decide(&p, &timeline());
        assert!(d.report.hidden.is_empty(), "text {text}");
    }
}

#[test]
fn a_mid_text_media_url_after_a_newline_only_takes_the_url() {
    // X's composer strips one preceding *space*; a newline is not a space, so
    // it stays (and so does the space after the URL).
    let p = media_post("line1\nhttps://video.twimg.com/foo/bar.mp4 end");
    let d = decide(&p, &timeline());
    assert_eq!(d.body_text(), "line1\n end");
    assert_eq!(
        d.report.hidden[0].why,
        "embedded media URL replaced by attached media"
    );
}
