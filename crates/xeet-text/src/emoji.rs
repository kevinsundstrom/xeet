//! Emoji sequence segmentation, which is what makes the weighted length of an
//! emoji agree with X.
//!
//! twitter-text counts an emoji *sequence* as one emoji (weight 2) instead of
//! weighing every code point, and two things have to be reproduced exactly: the
//! segmentation and the table. They differ between implementations, so there are
//! two tables here:
//!
//! # X's client ([`Table::X`], the default)
//!
//! X's shipped client builds its counter around this regex. It is quoted from
//! `assets/vendor/upstream/js/CFyVwPZu.js` (194,335 bytes, sha256
//! `1e66b5068c31898e11f38c9f70dce7b0b457d7d8d6c5c22cdc546371688c8b4e`), and the
//! identical literal appears in `B5hEoqI4.js` and `D9DiKaD3.js`, the other two
//! chunks that carry the counter:
//!
//! ```text
//! /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}
//!  |\p{Regional_Indicator}{2}
//!  |\p{Extended_Pictographic}(?:\uFE0F|\p{EMod})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{EMod})?)*
//!  |[#*0-9]\uFE0F?\u20E3/gu
//! ```
//!
//! So: England/Scotland/Wales tag flags; regional-indicator pairs; any
//! pictographic character with at most one variation selector or skin-tone
//! modifier, extended by any number of `ZWJ` + pictographic links; and keycaps.
//! Because it is property-based, emoji that were added to Unicode after
//! twitter-text's tables were generated (🫩, 🐦‍🔥) segment correctly too.
//!
//! `\p{Extended_Pictographic}` and `\p{EMod}` come from Unicode's
//! `emoji-data.txt` (vendored at 17.0 and checked against a V8 that reports
//! Unicode 17.0, so the table is exactly what a current browser engine matches);
//! `\p{Regional_Indicator}` is the single block U+1F1E6..U+1F1FF.
//!
//! [`Table::X`] is that regex written out by hand over
//! [`crate::gentables::emoji_props`]: the same alternatives in the same order,
//! each greedy, with a longest-match preference.
//!
//! # twitter-text 3.1.0 ([`Table::TwitterText2021`])
//!
//! The conformance suite encodes the *Java* implementation's generated emoji
//! regex, which predates the property-based approach: it groups the ZWJ
//! sequences it lists explicitly and nothing else, so it misses newer emoji and
//! weighs `👍🏽` and `❤️` as two sequences. Kept because the suite is a gate;
//! not the default.

use crate::gentables::emoji::{EMOJI_CANDIDATES, EMOJI_FIRST, EMOJI_ITEMS, EMOJI_SEQS, EMOJI_SETS};
use crate::gentables::emoji_props::{EMOJI_MODIFIER, EXTENDED_PICTOGRAPHIC};
use crate::text::Text;

/// Which emoji table a weighted-length configuration uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmojiTable {
    /// X's shipped client.
    X,
    /// twitter-text 3.1.0's Java build, which the conformance suite pins.
    TwitterText2021,
}

impl EmojiTable {
    pub(crate) fn table(self) -> Table {
        match self {
            EmojiTable::X => Table::X,
            EmojiTable::TwitterText2021 => Table::TwitterText2021,
        }
    }
}

/// Which emoji table to segment with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Table {
    /// X's shipped client: Unicode properties, so skin tones, variation
    /// selectors, ZWJ chains and new emoji all collapse to one emoji.
    X,
    /// twitter-text 3.1.0's Java emoji regex, which the conformance suite pins.
    TwitterText2021,
}

// ---------------------------------------------------------------------------
// X's client
// ---------------------------------------------------------------------------

/// `\p{Regional_Indicator}`: one contiguous block, and emoji-data.txt does not
/// carry it as a property of its own.
const REGIONAL_INDICATOR: (u32, u32) = (0x1F1E6, 0x1F1FF);
const VS16: char = '\u{FE0F}';
const ZWJ: char = '\u{200D}';
const KEYCAP: char = '\u{20E3}';

fn in_ranges(table: &[(u32, u32)], c: char) -> bool {
    let cp = c as u32;
    table
        .binary_search_by(|&(lo, hi)| {
            if hi < cp {
                std::cmp::Ordering::Less
            } else if lo > cp {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

fn is_pictographic(c: char) -> bool {
    // Everything below U+00A9 is not pictographic, which skips most text fast.
    (c as u32) >= 0xA9 && in_ranges(EXTENDED_PICTOGRAPHIC, c)
}

fn is_modifier(c: char) -> bool {
    (c as u32) >= 0x1F3FB && in_ranges(EMOJI_MODIFIER, c)
}

fn is_regional_indicator(c: char) -> bool {
    let cp = c as u32;
    cp >= REGIONAL_INDICATOR.0 && cp <= REGIONAL_INDICATOR.1
}

/// The three tag-flag sequences the client special-cases: England, Scotland,
/// Wales (subdivision flags of the United Kingdom).
fn match_tag_flag(t: &Text, pos: usize) -> Option<usize> {
    if t.at(pos) != Some('\u{1F3F4}') {
        return None;
    }
    let rest: String = (1..=6).filter_map(|i| t.at(pos + i)).collect();
    const SUFFIXES: [&str; 3] = [
        "\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}",
        "\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}",
        "\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}",
    ];
    let tail = t.at(pos + 6)?;
    if tail != '\u{E007F}' {
        return None;
    }
    for suffix in SUFFIXES {
        if rest.starts_with(suffix) {
            return Some(pos + 7);
        }
    }
    None
}

/// `\p{Extended_Pictographic}(?:\uFE0F|\p{EMod})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{EMod})?)*`
fn match_pictographic_chain(t: &Text, pos: usize) -> Option<usize> {
    let first = t.at(pos)?;
    if !is_pictographic(first) {
        return None;
    }
    let mut end = pos + 1;
    // At most one variation selector or modifier per link, and only one of them.
    if matches!(t.at(end), Some(c) if c == VS16 || is_modifier(c)) {
        end += 1;
    }
    while t.at(end) == Some(ZWJ) {
        let Some(next) = t.at(end + 1) else { break };
        if !is_pictographic(next) {
            break;
        }
        end += 2;
        if matches!(t.at(end), Some(c) if c == VS16 || is_modifier(c)) {
            end += 1;
        }
    }
    Some(end)
}

/// `[#*0-9]\uFE0F?\u20E3`
fn match_keycap(t: &Text, pos: usize) -> Option<usize> {
    let c = t.at(pos)?;
    if !matches!(c, '#' | '*' | '0'..='9') {
        return None;
    }
    let mut end = pos + 1;
    if t.at(end) == Some(VS16) {
        end += 1;
    }
    if t.at(end) == Some(KEYCAP) {
        return Some(end + 1);
    }
    None
}

/// One leftmost match of X's emoji regex at `pos`, in the regex's own
/// alternative order.
fn match_x_at(t: &Text, pos: usize) -> Option<usize> {
    if let Some(end) = match_tag_flag(t, pos) {
        return Some(end);
    }
    if let (Some(a), Some(b)) = (t.at(pos), t.at(pos + 1)) {
        if is_regional_indicator(a) && is_regional_indicator(b) {
            return Some(pos + 2);
        }
    }
    if let Some(end) = match_pictographic_chain(t, pos) {
        return Some(end);
    }
    match_keycap(t, pos)
}

fn find_x(t: &Text) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < t.len() {
        // Only a handful of ASCII characters can start an emoji, and a small
        // set of blocks can contain a pictographic one.
        let c = t.ch(pos);
        let maybe = match c {
            '#' | '*' | '0'..='9' => true,
            c if c.is_ascii() => false,
            c => {
                let cp = c as u32;
                cp >= 0xA9 && (cp <= 0x33FF || (0x1F000..=0x1FAFF).contains(&cp))
            }
        };
        if !maybe {
            pos += 1;
            continue;
        }
        match match_x_at(t, pos) {
            Some(end) => {
                out.push((pos, end));
                pos = end;
            }
            None => pos += 1,
        }
    }
    out
}

// ---------------------------------------------------------------------------
// twitter-text 3.1.0's generated table
// ---------------------------------------------------------------------------

fn first_candidates(c: char) -> &'static [u16] {
    let cp = c as u32;
    let idx = match EMOJI_FIRST.binary_search_by(|(lo, hi, _, _)| {
        if *hi < cp {
            std::cmp::Ordering::Less
        } else if *lo > cp {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    }) {
        Ok(i) => &EMOJI_FIRST[i],
        Err(_) => return &[],
    };
    let (_, _, start, count) = *idx;
    &EMOJI_CANDIDATES[start as usize..start as usize + count as usize]
}

fn in_set(set: usize, c: char) -> bool {
    in_ranges(EMOJI_SETS[set], c)
}

fn match_table_at(t: &Text, pos: usize) -> Option<usize> {
    let c = t.at(pos)?;
    for &seq in first_candidates(c) {
        let (start, count) = EMOJI_SEQS[seq as usize];
        let items = &EMOJI_ITEMS[start as usize..start as usize + count as usize];
        if pos + items.len() > t.len() {
            continue;
        }
        if items
            .iter()
            .enumerate()
            .all(|(k, &set)| in_set(set as usize, t.ch(pos + k)))
        {
            return Some(pos + items.len());
        }
    }
    None
}

fn find_table(t: &Text) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < t.len() {
        // Only the keycap digits and symbols start a sequence in this table with
        // an ASCII character.
        let c = t.ch(pos);
        if c.is_ascii() && !matches!(c, '0'..='9' | '#' | '*') {
            pos += 1;
            continue;
        }
        match match_table_at(t, pos) {
            Some(end) => {
                out.push((pos, end));
                pos = end;
            }
            None => pos += 1,
        }
    }
    out
}

/// Every emoji sequence, as non-overlapping character ranges, left to right.
pub(crate) fn find(t: &Text, table: Table) -> Vec<(usize, usize)> {
    match table {
        Table::X => find_x(t),
        Table::TwitterText2021 => find_table(t),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spans(s: &str, table: Table) -> Vec<(usize, usize)> {
        find(&Text::new(s), table)
    }

    fn x(s: &str) -> Vec<(usize, usize)> {
        spans(s, Table::X)
    }

    #[test]
    fn regional_indicator_block_is_26_halves() {
        assert_eq!(REGIONAL_INDICATOR.1 - REGIONAL_INDICATOR.0 + 1, 26);
        assert!(is_regional_indicator('\u{1F1E6}'));
        assert!(is_regional_indicator('\u{1F1FF}'));
        assert!(!is_regional_indicator('\u{1F1E5}'));
        assert!(!is_regional_indicator('\u{1F200}'));
    }

    #[test]
    fn x_sequences() {
        // One emoji each: skin tone, variation selector, ZWJ family, flag,
        // keycap, tag flag, and an emoji newer than twitter-text's tables.
        assert_eq!(x("\u{1F44D}\u{1F3FD}"), vec![(0, 2)]);
        assert_eq!(x("\u{2764}\u{FE0F}"), vec![(0, 2)]);
        assert_eq!(
            x("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}"),
            vec![(0, 7)]
        );
        assert_eq!(x("\u{1F1FA}\u{1F1F8}"), vec![(0, 2)]);
        assert_eq!(x("1\u{FE0F}\u{20E3}"), vec![(0, 3)]);
        assert_eq!(
            x("\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}"),
            vec![(0, 7)]
        );
        assert_eq!(x("\u{1F426}\u{200D}\u{1F525}"), vec![(0, 3)]);
        assert_eq!(x("\u{1FAE9}"), vec![(0, 1)]);
    }

    #[test]
    fn x_does_not_group_what_the_regex_does_not() {
        // An unknown subdivision flag: the tags are not part of any alternative,
        // so only the base is an emoji.
        assert_eq!(
            x("\u{1F3F4}\u{E0067}\u{E0062}\u{E0075}\u{E007F}"),
            vec![(0, 1)]
        );
        // A lone regional indicator is not a pair.
        assert_eq!(x("\u{1F1FA}"), Vec::<(usize, usize)>::new());
        // A ZWJ before a non-pictographic character stops the chain.
        assert_eq!(x("\u{1F44D}\u{200D}a"), vec![(0, 1)]);
        // A keycap needs the enclosing keycap character.
        assert_eq!(x("1\u{FE0F}"), Vec::<(usize, usize)>::new());
    }

    #[test]
    fn twitter_text_table_still_available() {
        // The conformance table lists its sequences explicitly: thumbs up with a
        // skin tone is in the list, a victory hand or a raised hand with one is
        // not, and a ZWJ sequence invented after 2018 is not either.
        let cases = [
            ("\u{1F44D}\u{1F3FD}", 2, 2),         // thumbs up + tone: both group
            ("\u{270C}\u{1F3FF}", 2, 4),          // victory hand + tone
            ("\u{261D}\u{1F3FB}", 2, 4),          // index finger + tone
            ("\u{1F426}\u{200D}\u{1F525}", 2, 5), // bird + ZWJ + fire (Emoji 15.1)
            ("\u{1F441}\u{FE0F}\u{200D}\u{1F5E8}\u{FE0F}", 2, 5), // eye in speech bubble
            (
                "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}",
                2,
                2,
            ),
            ("\u{1F1FA}\u{1F1F8}", 2, 2),
            ("1\u{FE0F}\u{20E3}", 2, 2),
        ];
        for (text, want_x, want_v3) in cases {
            assert_eq!(crate::parse(text).weighted_length, want_x, "X: {text:?}");
            assert_eq!(
                crate::parse_with(text, crate::Config::V3).weighted_length,
                want_v3,
                "twitter-text 3.1.0: {text:?}"
            );
        }
    }
}
