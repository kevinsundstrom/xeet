//! The contract the rest of xeet codes against: offsets, entity accessors and
//! the handful of edge cases that are easy to get wrong.

use xeet_text as tt;

#[test]
fn offsets_are_utf16_code_units() {
    // An astral character before the mention: byte offsets, char offsets and
    // UTF-16 offsets all differ here.
    let text = "\u{1F680}\u{1F680} @jack #ai $VRS https://x.com/a";
    let parsed = tt::parse(text);
    let kinds: Vec<_> = parsed
        .entities
        .iter()
        .map(|e| (e.start, e.end, e.text.clone()))
        .collect();
    assert_eq!(
        kinds,
        vec![
            (5, 10, "@jack".to_string()),
            (11, 14, "#ai".to_string()),
            (15, 19, "$VRS".to_string()),
            (20, 35, "https://x.com/a".to_string()),
        ]
    );
    // And the conversion helpers round-trip.
    for entity in &parsed.entities {
        let byte_start = tt::utf16_to_byte(text, entity.start);
        let byte_end = tt::utf16_to_byte(text, entity.end);
        assert_eq!(&text[byte_start..byte_end], entity.text);
        assert_eq!(tt::byte_to_utf16(text, byte_start), entity.start);
        assert_eq!(tt::byte_to_utf16(text, byte_end), entity.end);
    }
    assert_eq!(tt::utf16_len(text), text.encode_utf16().count());
    // Out-of-range offsets clamp instead of panicking.
    assert_eq!(tt::utf16_to_byte(text, 9999), text.len());
    assert_eq!(tt::byte_to_utf16(text, 9999), tt::utf16_len(text));
}

#[test]
fn entity_accessors() {
    let parsed = tt::parse("hey @user_name/list-01 and @plain #tag_1 $BRK.B");
    let mentions: Vec<_> = parsed
        .entities
        .iter()
        .filter(|e| e.kind == tt::EntityKind::Mention)
        .map(|e| {
            (
                e.screen_name().unwrap().to_string(),
                e.list_slug().map(|s| s.to_string()),
            )
        })
        .collect();
    assert_eq!(
        mentions,
        vec![
            ("user_name".to_string(), Some("/list-01".to_string())),
            ("plain".to_string(), None),
        ]
    );
    assert_eq!(tt::hashtags("a #tag_1 b"), vec!["tag_1".to_string()]);
    assert_eq!(tt::cashtags("$BRK.B"), vec!["BRK.B".to_string()]);
    assert_eq!(tt::mentions("@a/list @b"), vec!["b".to_string()]);
    assert!(tt::reply_screenname("@first hello").is_some());
    assert!(tt::reply_screenname("hello @first").is_none());
}

#[test]
fn urls_keep_display_and_expanded_forms() {
    let parsed = tt::parse("see vercel.com/blog/a-really-long-post-slug-here ok");
    let url = parsed
        .entities
        .iter()
        .find_map(|e| match &e.kind {
            tt::EntityKind::Url { display, expanded } => Some((display.clone(), expanded.clone())),
            _ => None,
        })
        .expect("a url");
    assert_eq!(url.0, "vercel.com/blog/a-really-…");
    assert_eq!(url.1, "http://vercel.com/blog/a-really-long-post-slug-here");
}

#[test]
fn empty_and_blank_text() {
    // Empty is empty.
    let empty = tt::parse("");
    assert!(empty.entities.is_empty());
    assert_eq!(empty.weighted_length, 0);
    assert!(!empty.valid);
    assert_eq!(empty.permillage, 0);
    assert_eq!(empty.display_end, 0);

    // A blank post is not empty to X's client: it counts the spaces (and calls
    // the result valid, because the counter has no other rule). twitter-text's
    // Java build treats it as Empty instead, which is what Config::V3 keeps.
    for text in ["   ", "\n\t\n"] {
        let parsed = tt::parse(text);
        assert_eq!(
            parsed.weighted_length,
            text.chars().count() as u32,
            "{text:?}"
        );
        assert!(parsed.valid, "{text:?}");
        assert!(
            tt::parse_with(text, tt::Config::V3).weighted_length == 0,
            "{text:?}"
        );
        assert!(!tt::parse_with(text, tt::Config::V3).valid, "{text:?}");
    }
}

#[test]
fn weighted_length_limits() {
    // 280 Latin characters is exactly the limit; one more is too long.
    assert_eq!(tt::weighted_length(&"a".repeat(280)), 280);
    assert!(tt::parse(&"a".repeat(280)).valid);
    assert_eq!(tt::weighted_length(&"a".repeat(281)), 281);
    assert!(!tt::parse(&"a".repeat(281)).valid);
    // CJK weighs two per character.
    assert_eq!(tt::weighted_length(&"の".repeat(140)), 280);
    // A URL counts 23 whatever its length, which is how a link can make a post
    // fit that looks far too long.
    let long_url = format!("https://example.com/{}", "x".repeat(200));
    assert_eq!(tt::weighted_length(&long_url), 23);
    // An emoji sequence counts 2 (config v3), a family ZWJ sequence included.
    assert_eq!(
        tt::weighted_length("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}"),
        2
    );
    // Invalid characters (U+FEFF) make a post unpostable.
    assert!(!tt::is_valid_tweet_text("hi\u{FEFF}"));
}

#[test]
fn display_url_is_idempotent() {
    for url in [
        "https://vercel.com/blog/a-really-long-post-slug-here",
        "vercel.com/x",
        "http://www.example.com",
        "",
    ] {
        let once = tt::display_url(url);
        assert_eq!(tt::display_url(&once), once, "{url}");
    }
}

#[test]
fn validators() {
    assert!(tt::is_valid_username("@name"));
    assert!(!tt::is_valid_username("@name/list"));
    assert!(tt::is_valid_list("@name/list"));
    assert!(tt::is_valid_hashtag("#tag"));
    assert!(!tt::is_valid_hashtag("#123"));
    assert!(tt::is_valid_url(
        "https://example.com/path?q=1#f",
        true,
        true
    ));
    assert!(!tt::is_valid_url("example.com", true, true));
    assert!(tt::is_valid_url("example.com", true, false));
}

#[test]
fn media_text_is_not_an_entity() {
    // A `.com` inside a sentence with no scheme is still a link; a bare word
    // with a dot is not.
    assert!(tt::urls("read node.js docs").is_empty());
    assert_eq!(
        tt::urls("read nodejs.org docs"),
        vec!["nodejs.org".to_string()]
    );
}
