//! A Rust port of twitter-text: what X considers a link, a mention, a hashtag
//! and a cashtag, how long a post is, and how a link is displayed.
//!
//! This crate is the text half of xeet's rules gate. It is a port of the
//! open-source `twitter-text` library (Apache-2.0,
//! <https://github.com/twitter/twitter-text>), and it runs that library's
//! conformance suite in full: 2,119 cases in `crates/xeet-text/tests/conformance.rs`
//! against the vendored YAML in `/tests/conformance`. Where the library and X's
//! own shipped client disagree, this crate follows the client by default and
//! keeps the library's behavior behind a configuration.
//!
//! ```
//! let parsed = xeet_text::parse("hi @jack, see https://vercel.com/blog/a-long-post-title #ai");
//! assert_eq!(parsed.weighted_length, 41);
//! assert!(parsed.valid);
//! ```
//!
//! # What is here
//!
//! - [`parse`]: entities, weighted length, validity, as X's client computes them.
//! - [`display_url`]: the form X shows for a link.
//! - [`utf16_to_byte`], [`byte_to_utf16`], [`utf16_len`]: offsets. X's payloads
//!   index text in UTF-16 code units and Rust strings are UTF-8, so anything
//!   that crosses that boundary needs one of these.
//! - [`autolink`] and friends, [`hit_highlight`], and the `is_valid_*`
//!   validators, which exist because the conformance suite covers them and
//!   because they pin the entity grammar at its edges.
//!
//! # Decisions worth knowing
//!
//! **Offsets are UTF-16 code units.** [`Entity`] covers the full token,
//! including the `@`, `#` or `$` and any `/<list>` slug. [`Entity::screen_name`],
//! [`Entity::list_slug`], [`Entity::hashtag`] and [`Entity::cashtag`] return the
//! bare name, which is what a link target needs.
//!
//! **Entity extraction follows the JavaScript implementation.** Where the
//! library's own implementations disagree, the conformance data decides, and for
//! extraction it encodes the JS behavior: a URL typed without a scheme keeps only
//! the ASCII part of its host (`テスト.example.com` yields `example.com`), and
//! every ASCII domain inside one match is reported.
//!
//! **Weighted length follows X's shipped web client** ([`Config::X`], the
//! default). The client ships its own counter — the composer's character count
//! is computed in the browser — and it differs from twitter-text 3.1.0 in two
//! ways:
//!
//! - **Emoji.** The client's counter segments with a property-based regex
//!   (`\p{Extended_Pictographic}`, `\p{EMod}`, `\p{Regional_Indicator}`), quoted
//!   in [`emoji`]'s module docs. Any pictographic character with at most one
//!   variation selector or skin-tone modifier, chained through ZWJ with other
//!   pictographic characters, is **one emoji of weight 2** — so `👍🏽`, `❤️`,
//!   `👨‍👩‍👧‍👦`, `🇺🇸`, `1️⃣` and emoji added after 2018 (`🐦‍🔥`, `🫩`) all count 2.
//!   twitter-text's own table lists sequences explicitly, so it weighs `✌🏿` as 4
//!   and `🐦‍🔥` as 5. The weights themselves are configuration v3 in both:
//!   scale 100, default weight 200, ranges `0–4351`, `8192–8205`, `8208–8223` and
//!   `8242–8247` at 100, and a URL at 23.
//! - **Blank text.** The client counts spaces; twitter-text's Java build treats a
//!   blank post as empty. So `parse("   ").weighted_length == 3` here, and that
//!   post is "valid" as far as the counter is concerned (an empty string is still
//!   invalid: both implementations require a positive length).
//!
//! [`Config::V3`] and [`Config::V2`] are twitter-text's own configurations, which
//! the conformance suite pins. The suite turns out not to exercise the emoji
//! difference at all, so every case passes under either; the split exists so a
//! reader can ask for either answer by name.
//!
//! The display and valid ranges ([`Parsed::display_end`], [`Parsed::valid_end`])
//! are reported exclusive; twitter-text reports them inclusive.
//!
//! # How that was verified
//!
//! - The conformance suite: 2,119 cases, all passing, counts per file pinned in
//!   `tests/conformance.rs`.
//! - X's own counter, extracted verbatim from the captured client bundle
//!   (`assets/vendor/upstream/js/CFyVwPZu.js`, sha256 `1e66b506…`, and the same
//!   code in `B5hEoqI4.js` and `D9DiKaD3.js`) and run in Node over 3,029 texts
//!   (every conformance text, every captured post, generated fuzz): **0
//!   disagreements** on weighted length and validity. `tests/x_client.rs` holds a
//!   committed excerpt of that run and the opt-in harness.
//! - The published twitter-text 3.1.0 JavaScript package, over the same corpus,
//!   for entity extraction: 0 mismatches. `tests/parity.rs`.
//!
//! # Performance
//!
//! No regex engine: the extraction grammar is hand-written scanners over a
//! precomputed character table, so there is no compile step and no backtracking
//! blow-up. Measured on this machine, `cargo test --release -p xeet-text --test
//! perf -- --nocapture`:
//!
//! | Input | `parse` |
//! |---|---|
//! | 280-character post with a link, mention, hashtag, cashtag and emoji | 5–6 µs |
//! | 25,000-character post, half CJK | 0.8–1.0 ms |
//! | [`display_url`] | 0.2 µs |
//!
//! The only runtime dependency is `unicode-normalization`, for the NFC pass that
//! the weighted length is defined over (skipped when the text is already NFC,
//! which is the common case).

#![forbid(unsafe_code)]

mod autolink;
mod chars;
mod display;
mod emoji;
mod entities;
mod extract;
mod gentables;
mod highlight;
mod idna;
mod length;
mod text;
mod tld;
mod url;
mod validate;

pub use autolink::{
    autolink, autolink_cashtags, autolink_hashtags, autolink_mentions, autolink_urls,
    autolink_with_api_entities, ApiEntities, ApiMention, ApiTag, ApiUrl,
};
pub use display::display_url;
pub use emoji::EmojiTable;
pub use entities::{
    cashtags, entities, hashtags, mentions, parse, parse_with, reply_screenname, urls, Entity,
    EntityKind, Parsed,
};
pub use highlight::{hit_highlight, hit_highlight_with_tag};
pub use length::{weighted_length, Config, EMOJI_WEIGHT, MAX_WEIGHTED_LENGTH, URL_WEIGHT};
pub use text::{byte_to_utf16, utf16_len, utf16_to_byte};
pub use validate::{
    is_valid_hashtag, is_valid_list, is_valid_tweet_text, is_valid_url, is_valid_username,
};

/// The version of the twitter-text behavior this crate implements.
pub const TWITTER_TEXT_VERSION: &str = "3.1.0";
