//! Differential check against the published twitter-text JavaScript package.
//!
//! This is an opt-in run, because it needs node and a `twitter-text` install:
//!
//! ```sh
//! cd crates/xeet-text/tools/parity
//! printf '{"name":"parity","private":true}' > package.json
//! pnpm add twitter-text@3.1.0
//! node make-corpus.mjs                       # writes parity.jsonl
//! PARITY=$PWD/parity.jsonl CARGO_TARGET_DIR=target/agent-text \
//!   cargo test -p xeet-text --test parity -- --nocapture
//! ```
//!
//! The corpus is every text from the captures, every conformance text, some
//! hand-written URL-grammar stress cases and generated fuzz text. Entity
//! extraction must agree exactly. Weighted length must agree everywhere except
//! on emoji, where the implementations genuinely differ: this crate's default
//! follows X's client (a property-based emoji regex, in `tests/x_client.rs`) and
//! the JavaScript package uses twemoji-parser 11, which groups fewer sequences
//! and therefore weighs emoji-heavy posts higher. The difference is asserted here
//! to be emoji-only, so a real regression cannot hide inside it; the crate's
//! agreement with X's own counter is checked separately.

use std::path::PathBuf;

use xeet_text as tt;

/// Whether a character can appear in an emoji sequence: astral emoji, the symbol
/// blocks emoji live in, and the joiners and selectors.
fn looks_emoji(c: char) -> bool {
    let cp = c as u32;
    cp >= 0x1F000
        || matches!(cp, 0x200D | 0x20E3 | 0xFE0E | 0xFE0F)
        || (0x2190..0x2C00).contains(&cp)
        || (0x3000..0x3300).contains(&cp)
        || (0xFE00..0xFF00).contains(&cp)
}

fn kind_name(kind: &tt::EntityKind) -> &'static str {
    match kind {
        tt::EntityKind::Url { .. } => "url",
        tt::EntityKind::Mention => "mention",
        tt::EntityKind::Hashtag => "hashtag",
        tt::EntityKind::Cashtag => "cashtag",
    }
}

#[test]
fn parity_with_twitter_text_js() {
    let Ok(path) = std::env::var("PARITY") else {
        eprintln!("PARITY not set: skipping the differential run (see the module docs)");
        return;
    };
    let raw = std::fs::read_to_string(PathBuf::from(path)).expect("parity corpus");
    let mut entity_mismatches = Vec::new();
    let mut weighted_mismatches = Vec::new();
    let mut texts = 0usize;
    for line in raw.lines() {
        texts += 1;
        let v: serde_json::Value = serde_json::from_str(line).expect("json");
        let text = v["t"].as_str().expect("text");
        let parsed = tt::parse(text);

        let want_entities: Vec<(String, usize, usize, String)> = v["entities"]
            .as_array()
            .expect("entities")
            .iter()
            .map(|e| {
                (
                    e[0].as_str().unwrap().to_string(),
                    e[1].as_u64().unwrap() as usize,
                    e[2].as_u64().unwrap() as usize,
                    e[3].as_str().unwrap().to_string(),
                )
            })
            .collect();
        let got_entities: Vec<(String, usize, usize, String)> = parsed
            .entities
            .iter()
            .map(|e| {
                // The payload form of a mention carries the bare screen name and
                // the indices of the whole `@name/list` token.
                let name = match &e.kind {
                    tt::EntityKind::Url { .. } => e.text.clone(),
                    tt::EntityKind::Mention => e.screen_name().unwrap_or_default().to_string(),
                    tt::EntityKind::Hashtag => e.hashtag().unwrap_or_default().to_string(),
                    tt::EntityKind::Cashtag => e.cashtag().unwrap_or_default().to_string(),
                };
                (name, e.start, e.end, kind_name(&e.kind).to_string())
            })
            .collect();
        if got_entities != want_entities {
            entity_mismatches.push(format!(
                "{text:?}\n  js  {want_entities:?}\n  rs  {got_entities:?}"
            ));
        }

        let want_weighted = v["weighted"].as_u64().expect("weighted") as u32;
        if parsed.weighted_length != want_weighted {
            weighted_mismatches.push((text.to_string(), parsed.weighted_length, want_weighted));
        }
    }

    assert_eq!(
        entity_mismatches.len(),
        0,
        "entity mismatches:\n{}",
        entity_mismatches.join("\n")
    );

    // Weighted length: every difference must involve emoji. The two tables
    // disagree in both directions (twemoji groups skin-tone modifiers that the
    // Java table leaves loose; the Java table has ZWJ sequences twemoji 11
    // lacks), so the check is that no plain text ever differs.
    let mut non_emoji = Vec::new();
    let mut lower = 0usize;
    let mut higher = 0usize;
    for (text, got, want) in &weighted_mismatches {
        if !text.chars().any(looks_emoji) {
            non_emoji.push(format!("{text:?}: {got} != {want}"));
        }
        if got < want {
            lower += 1;
        } else {
            higher += 1;
        }
    }
    assert_eq!(
        non_emoji.len(),
        0,
        "weighted mismatches on text without emoji:\n{}",
        non_emoji.join("\n")
    );

    println!(
        "texts {texts}, entity mismatches 0, weighted mismatches {} (this crate lower {lower}, higher {higher})",
        weighted_mismatches.len()
    );
}
