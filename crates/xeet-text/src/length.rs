//! Weighted length, configuration v3.
//!
//! This is `TwitterTextParser.parseTweet` with the default configuration:
//!
//! - NFC-normalize the text first.
//! - A URL counts 23, whatever its length.
//! - An emoji sequence counts 2 (see [`crate::emoji`]).
//! - Otherwise each code point is weighed by the v3 ranges: 1 for Latin,
//!   Cyrillic, Greek, Arabic, ... (U+0000-U+10FF and a few punctuation blocks),
//!   2 for everything else (CJK, emoji, astral).
//! - The post is valid when it is non-empty, at most 280 weighted, and free of
//!   U+FFFE, U+FEFF and U+FFFF.

use crate::chars::is_invalid_char;
use crate::emoji::{self, EmojiTable};
use crate::text::Text;
use crate::url;

/// Maximum weighted length of a post (config v3).
pub const MAX_WEIGHTED_LENGTH: u32 = 280;
/// Weight of a URL (config v3: `transformedURLLength`, scale 100).
pub const URL_WEIGHT: u32 = 23;
/// Weight of one emoji sequence (config v3: `defaultWeight`, scale 100).
pub const EMOJI_WEIGHT: u32 = 2;

/// The weighted length of `text` as X's client counts it: what the character
/// counter in the composer shows.
pub fn weighted_length(text: &str) -> u32 {
    let normalized = normalize(text);
    let t = Text::new(&normalized);
    let urls = url::extract(&t, true);
    measure(&t, crate::utf16_len(text), Config::X, &urls).weighted_length
}

/// A weighted-length configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Config {
    /// Which emoji table to segment with, or `None` to weigh emoji code point by
    /// code point (twitter-text configuration v2 and earlier).
    pub emoji: Option<EmojiTable>,
    /// Whether a blank post measures zero instead of measuring its spaces.
    /// twitter-text's Java implementation treats a blank post as empty; X's
    /// client counts the spaces.
    pub blank_is_empty: bool,
    /// The weighted limit: 280 everywhere.
    pub max_weighted_length: u32,
}

impl Config {
    /// What X's shipped web client computes: configuration v3 weights, its own
    /// emoji regex, and spaces counted like any other character. This is the
    /// default for [`crate::parse`].
    pub const X: Config = Config {
        emoji: Some(EmojiTable::X),
        blank_is_empty: false,
        max_weighted_length: 280,
    };

    /// twitter-text 3.1.0 configuration v3, which the conformance suite pins: the
    /// Java implementation's emoji table, and a blank post measures zero.
    pub const V3: Config = Config {
        emoji: Some(EmojiTable::TwitterText2021),
        blank_is_empty: true,
        max_weighted_length: 280,
    };

    /// twitter-text configuration v2: v3 without emoji sequence parsing.
    pub const V2: Config = Config {
        emoji: None,
        blank_is_empty: true,
        max_weighted_length: 280,
    };
}

/// The weight ranges of config v3, in order.
const RANGES: [(u32, u32, u32); 4] = [
    (0, 4351, 1),
    (8192, 8205, 1),
    (8208, 8223, 1),
    (8242, 8247, 1),
];

fn char_weight(cp: u32) -> u32 {
    for (lo, hi, weight) in RANGES {
        if cp >= lo && cp <= hi {
            return weight;
        }
    }
    2
}

/// NFC-normalize, but only when the text is not already normalized: the check
/// is a quick scan and the copy is the expensive part.
pub(crate) fn normalize(text: &str) -> std::borrow::Cow<'_, str> {
    if unicode_normalization::is_nfc(text) {
        std::borrow::Cow::Borrowed(text)
    } else {
        use unicode_normalization::UnicodeNormalization;
        std::borrow::Cow::Owned(text.nfc().collect())
    }
}

/// The result of measuring a text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Weighted {
    pub(crate) weighted_length: u32,
    pub(crate) valid: bool,
    pub(crate) permillage: u32,
    /// Exclusive end of the text twitter-text considers displayed, in UTF-16
    /// units of the *input* (twitter-text reports this inclusive, as
    /// `display_text_range`'s end).
    pub(crate) display_end: usize,
    /// Exclusive end of the valid prefix, in UTF-16 units of the input.
    pub(crate) valid_end: usize,
}

impl Weighted {
    pub(crate) const EMPTY: Weighted = Weighted {
        weighted_length: 0,
        valid: false,
        permillage: 0,
        display_end: 0,
        valid_end: 0,
    };
}

/// Measure an NFC-normalized text. `original_utf16` is the UTF-16 length of the
/// text as the caller received it, which is what the reported ranges index into.
pub(crate) fn measure(
    t: &Text,
    original_utf16: usize,
    config: Config,
    urls_in: &[url::RawUrl],
) -> Weighted {
    if config.blank_is_empty && t.slice(0, t.len()).trim().is_empty() {
        return Weighted::EMPTY;
    }
    let units: Vec<u16> = t.slice(0, t.len()).encode_utf16().collect();

    // Entities are keyed by UTF-16 offset, which is what the scan below walks.
    let mut urls: Vec<(usize, usize)> = urls_in
        .iter()
        .map(|u| (t.utf16(u.start), t.utf16(u.end)))
        .collect();
    urls.sort_unstable();
    let emojis: Vec<(usize, usize)> = match config.emoji {
        Some(table) => {
            let mut v: Vec<(usize, usize)> = emoji::find(t, table.table())
                .into_iter()
                .map(|(a, b)| (t.utf16(a), t.utf16(b)))
                .collect();
            v.sort_unstable();
            v
        }
        None => Vec::new(),
    };

    let mut weighted = 0u32;
    let mut valid_units = 0usize;
    let mut offset = 0usize;
    let mut has_invalid = false;
    let (mut url_i, mut emoji_i) = (0usize, 0usize);
    while offset < units.len() {
        if url_i < urls.len() && urls[url_i].0 == offset && urls[url_i].1 > offset {
            let len = urls[url_i].1 - offset;
            weighted += URL_WEIGHT;
            offset += len;
            if weighted <= config.max_weighted_length {
                valid_units += len;
            }
            url_i += 1;
            continue;
        }
        if emoji_i < emojis.len() && emojis[emoji_i].0 < offset {
            emoji_i += 1;
            continue;
        }
        let cp = code_point_at(&units, offset);
        let (weight, width) = match emojis.get(emoji_i) {
            Some(&(start, end)) if start == offset && end > offset => {
                emoji_i += 1;
                (EMOJI_WEIGHT, end - start)
            }
            _ => (char_weight(cp), if cp > 0xFFFF { 2 } else { 1 }),
        };
        weighted += weight;
        // twitter-text only looks at the first code unit of a code point, and
        // the invalid characters are all in the BMP.
        if let Some(c) = char::from_u32(units[offset] as u32) {
            has_invalid |= is_invalid_char(c);
        }
        offset += width;
        if !has_invalid && weighted <= config.max_weighted_length {
            valid_units += width;
        }
    }

    // Combining or composing characters can change the length under NFC, and
    // the ranges are reported against the input.
    let norm_offset = original_utf16 as isize - units.len() as isize;
    let shift = |n: usize| (n as isize + norm_offset).max(0) as usize;
    Weighted {
        weighted_length: weighted,
        // `weighted > 0` is what makes the empty string invalid in both
        // implementations, whatever they do about blank text.
        valid: !has_invalid && weighted > 0 && weighted <= config.max_weighted_length,
        permillage: weighted * 1000 / config.max_weighted_length,
        display_end: shift(units.len()),
        valid_end: shift(valid_units),
    }
}

fn code_point_at(units: &[u16], offset: usize) -> u32 {
    let first = units[offset] as u32;
    if (0xD800..0xDC00).contains(&first) && offset + 1 < units.len() {
        let second = units[offset + 1] as u32;
        if (0xDC00..0xE000).contains(&second) {
            return 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00);
        }
    }
    first
}
