//! The text surface the rules engine uses: entity parsing, weighted length and
//! the display form of a URL.
//!
//! This is a thin re-export of `xeet-text`, the `text` stream's crate, so the
//! rules stage and the text engine cannot drift: both answer "what is a URL",
//! "how long is this post" and "how does X shorten that link" with the same
//! code. `xeet-text` runs the official twitter-text conformance suite.
//!
//! The rules stage only needs [`parse`], [`display_url`] and the [`Parsed`] /
//! [`Entity`] shapes. Keeping them behind this module means a future text
//! engine swap is one file.

pub use xeet_text::{display_url, parse, utf16_to_byte, Entity, EntityKind, Parsed};

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(text: &str) -> Vec<(String, String)> {
        parse(text)
            .entities
            .into_iter()
            .map(|e| {
                let kind = match e.kind {
                    EntityKind::Url { .. } => "url",
                    EntityKind::Mention => "mention",
                    EntityKind::Hashtag => "hashtag",
                    EntityKind::Cashtag => "cashtag",
                };
                (e.text, kind.to_string())
            })
            .collect()
    }

    #[test]
    fn finds_a_url_and_its_display_form() {
        let p = parse("read https://vercel.com/blog/introducing-vercel-schedules today");
        assert_eq!(p.entities.len(), 1);
        match &p.entities[0].kind {
            EntityKind::Url { display, expanded } => {
                assert_eq!(display, "vercel.com/blog/introduci\u{2026}");
                assert_eq!(
                    expanded,
                    "https://vercel.com/blog/introducing-vercel-schedules"
                );
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(p.entities[0].start, 5);
        assert_eq!(
            p.entities[0].end,
            5 + "https://vercel.com/blog/introducing-vercel-schedules".len()
        );
    }

    #[test]
    fn display_url_matches_the_captured_rule() {
        assert_eq!(
            display_url("https://vercel.com/blog/vercel-security-review"),
            "vercel.com/blog/vercel-se\u{2026}"
        );
        assert_eq!(
            display_url("https://www.anthropic.com/research/components-of-agent-memory"),
            "anthropic.com/research/compo\u{2026}"
        );
        assert_eq!(
            display_url("https://x.com/i/article/2077522774332153856"),
            "x.com/i/article/2077\u{2026}"
        );
        assert_eq!(display_url("https://developer.x.com"), "developer.x.com");
        assert_eq!(
            display_url("https://youtu.be/vDjW_dRyKXY?si=6FsfJXS22mk52gyu"),
            "youtu.be/vDjW_dRyKXY?si\u{2026}"
        );
    }

    #[test]
    fn finds_mentions_hashtags_and_cashtags() {
        let k = kinds("@vercel ship #ai with $BRK.A and @jack/list");
        assert_eq!(k[0], ("@vercel".into(), "mention".into()));
        assert_eq!(k[1], ("#ai".into(), "hashtag".into()));
        assert_eq!(k[2], ("$BRK.A".into(), "cashtag".into()));
        assert_eq!(k[3], ("@jack/list".into(), "mention".into()));
    }

    #[test]
    fn an_email_is_not_a_mention() {
        assert!(kinds("name@example.com").is_empty());
        // `.@jack` is a mention entity in twitter-text; it is the *reply*
        // reading that the dot escapes, which `rules` decides by requiring the
        // leading mention to start at offset zero.
        assert_eq!(kinds(".@jack hello")[0], ("@jack".into(), "mention".into()));
    }

    #[test]
    fn weighted_length_counts_urls_as_23_and_cjk_as_2() {
        assert_eq!(
            parse("https://example.com/a/very/long/path").weighted_length,
            23
        );
        assert_eq!(parse("你好").weighted_length, 4);
        assert_eq!(parse("hello").weighted_length, 5);
    }

    #[test]
    fn utf16_offsets_survive_astral_characters() {
        let p = parse("\u{1F680} https://example.com");
        assert_eq!(p.entities[0].start, 3); // rocket (2) + space
    }
}
