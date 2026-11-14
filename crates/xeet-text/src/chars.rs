//! The character classes of twitter-text, as predicates.
//!
//! Every table in [`crate::gentables::unicode`] is a sorted list of code point
//! ranges generated from the upstream regular expressions (see
//! `vendor/README.md`). This module names the derived classes the grammar
//! needs, so the scanners in [`crate::url`] and friends read like the grammar
//! instead of like character soup.

use crate::gentables::unicode as t;

/// ASCII lookup in a `[bool; 128]` table.
#[inline]
fn ascii_lookup(table: &[bool; 128], c: char) -> bool {
    table[c as usize]
}

fn in_table(table: &[(u32, u32)], c: char) -> bool {
    let cp = c as u32;
    // Tables are sorted and non-overlapping.
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

/// `\p{L}\p{M}` in the Basic Multilingual Plane (twitter-text's Unicode 8.0 table).
pub(crate) fn is_bmp_letter_or_mark(c: char) -> bool {
    in_table(t::BMP_LETTER_AND_MARKS, c)
}

/// `\p{L}\p{M}` above the Basic Multilingual Plane.
pub(crate) fn is_astral_letter_or_mark(c: char) -> bool {
    in_table(t::ASTRAL_LETTER_AND_MARKS, c)
}

pub(crate) fn is_bmp_numeral(c: char) -> bool {
    in_table(t::BMP_NUMERALS, c)
}

pub(crate) fn is_astral_numeral(c: char) -> bool {
    in_table(t::ASTRAL_NUMERALS, c)
}

pub(crate) fn is_latin_accent(c: char) -> bool {
    in_table(t::LATIN_ACCENT, c)
}

pub(crate) fn is_cyrillic(c: char) -> bool {
    in_table(t::CYRILLIC, c)
}

/// U+FFFE, U+FEFF, U+FFFF: the code points a post may never contain.
pub(crate) fn is_invalid_char(c: char) -> bool {
    in_table(t::INVALID_CHARS, c)
}

pub(crate) fn is_directional_marker(c: char) -> bool {
    in_table(t::DIRECTIONAL_MARKERS, c)
}

#[inline]
pub(crate) fn is_space(c: char) -> bool {
    if c.is_ascii() {
        return ascii_lookup(&t::ASCII_SPACES, c);
    }
    in_table(t::SPACES, c)
}

#[inline]
pub(crate) fn is_punct(c: char) -> bool {
    if c.is_ascii() {
        return ascii_lookup(&t::ASCII_PUNCT, c);
    }
    // The punctuation table is ASCII-only.
    false
}

/// `validDomainChars`: anything that is not punctuation, a space, an invalid
/// character or a bidi control. Deliberately permissive: it admits every
/// script, which is what lets unicode domains through.
#[inline]
pub(crate) fn is_domain_char(c: char) -> bool {
    if c.is_ascii() {
        return !(ascii_lookup(&t::ASCII_PUNCT, c) || ascii_lookup(&t::ASCII_SPACES, c));
    }
    // Every space and bidi control sits at or below U+3000, and the three
    // invalid code points are at the top of the BMP, so the whole middle of the
    // range needs no lookup at all.
    let cp = c as u32;
    if (0x3001..0xFFFE).contains(&cp) {
        return true;
    }
    !(is_space(c) || is_invalid_char(c) || is_directional_marker(c))
}

/// `validDomainChars` plus the `-` and `_` that only subdomain labels allow.
#[inline]
pub(crate) fn is_label_char(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_alphanumeric() || c == '-' || c == '_';
    }
    is_domain_char(c)
}

/// The character that may precede a URL: anything but a letter, digit, `@`,
/// `$` or `#` (which would make it part of an email, cashtag or hashtag).
pub(crate) fn is_url_preceding_char(c: char) -> bool {
    !(c.is_ascii_alphanumeric()
        || matches!(
            c,
            '@' | '\u{FF20}' | '$' | '#' | '\u{FF03}' | '\u{FFFE}' | '\u{FEFF}' | '\u{FFFF}'
        ))
}

/// `validGeneralUrlPathChars`.
pub(crate) fn is_path_char(c: char) -> bool {
    if c.is_ascii_alphanumeric() || is_cyrillic(c) || is_latin_accent(c) {
        return true;
    }
    matches!(
        c,
        '!' | '*'
            | '\''
            | ';'
            | ':'
            | '='
            | '+'
            | ','
            | '.'
            | '$'
            | '/'
            | '%'
            | '#'
            | '['
            | ']'
            | '-'
            | '\u{2013}'
            | '_'
            | '~'
            | '@'
            | '|'
            | '&'
    )
}

/// `validUrlPathEndingChars` (the single-character alternative; balanced
/// parentheses are handled structurally in [`crate::url`]).
#[inline]
pub(crate) fn is_path_ending_char(c: char) -> bool {
    matches!(c, '+' | '-' | '=' | '_' | '#' | '/')
        || c.is_ascii_alphanumeric()
        || is_cyrillic(c)
        || is_latin_accent(c)
}

/// `validUrlQueryChars`.
pub(crate) fn is_query_char(c: char) -> bool {
    if c.is_ascii_alphanumeric() {
        return true;
    }
    matches!(
        c,
        '!' | '?'
            | '*'
            | '\''
            | '@'
            | '('
            | ')'
            | ';'
            | ':'
            | '&'
            | '='
            | '+'
            | '$'
            | '/'
            | '%'
            | '#'
            | '['
            | ']'
            | '-'
            | '_'
            | '.'
            | ','
            | '~'
            | '|'
    )
}

/// `validUrlQueryEndingChars`.
pub(crate) fn is_query_ending_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '&' | '=' | '#' | '/')
}

/// The label characters in `validAsciiDomain` (no underscores).
pub(crate) fn is_ascii_domain_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || is_latin_accent(c)
}

/// The character that ends a TLD match: `(?=[^0-9a-zA-Z@+-]|$)`.
pub(crate) fn is_tld_boundary(c: char) -> bool {
    !(c.is_ascii_alphanumeric() || matches!(c, '@' | '+' | '-'))
}

/// The character that may precede an `@mention`.
pub(crate) fn is_mention_preceding_excluded(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(
            c,
            '_' | '!' | '#' | '$' | '%' | '&' | '*' | '@' | '\u{FF20}'
        )
}

/// What may follow a mention: another `@`, an accented Latin letter, or `://`.
pub(crate) fn is_end_mention_char(c: char) -> bool {
    matches!(c, '@' | '\u{FF20}') || is_latin_accent(c)
}

/// `hashtagAlpha`: a letter or mark, BMP or astral.
pub(crate) fn is_hashtag_alpha(c: char) -> bool {
    is_bmp_letter_or_mark(c) || is_astral_letter_or_mark(c)
}

/// `hashtagAlphaNumeric`: letters, marks, digits and the special characters
/// twitter-text allows inside a hashtag.
pub(crate) fn is_hashtag_alphanumeric(c: char) -> bool {
    is_bmp_letter_or_mark(c)
        || is_astral_letter_or_mark(c)
        || is_bmp_numeral(c)
        || is_astral_numeral(c)
        || in_table(t::HASHTAG_SPECIAL_CHARS, c)
}

pub(crate) fn is_hash_sign(c: char) -> bool {
    matches!(c, '#' | '\u{FF03}')
}

pub(crate) fn is_at_sign(c: char) -> bool {
    matches!(c, '@' | '\u{FF20}')
}

/// `[^a-zA-Z0-9_+~.-]`, the character that must precede an `rt` prefix.
pub(crate) fn is_retweet_prefix_boundary(c: char) -> bool {
    !(c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '~' | '.' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ASCII bitmaps are hand-optimized copies of the upstream tables, so
    /// they are checked against them rather than trusted.
    #[test]
    fn ascii_bitmap_matches_tables() {
        for cp in 0..128u32 {
            let c = char::from_u32(cp).unwrap();
            assert_eq!(
                ascii_lookup(&t::ASCII_PUNCT, c),
                in_table(t::PUNCT, c),
                "punct mismatch at U+{cp:04X}"
            );
            assert_eq!(
                ascii_lookup(&t::ASCII_SPACES, c),
                in_table(t::SPACES, c),
                "space mismatch at U+{cp:04X}"
            );
        }
    }

    /// The short-circuit in `is_domain_char` must agree with the definition.
    #[test]
    fn domain_char_shortcuts() {
        for cp in [
            0x21u32, 0x2Fu32, 0x30, 0x41, 0x2D, 0x5F, 0x7F, 0x3000, 0x3001, 0x4E00, 0x1F600,
            0xFFFE, 0xFFFF, 0x202A, 0x061C, 0xA0, 0x85,
        ] {
            let c = char::from_u32(cp).unwrap();
            let want = !(in_table(t::PUNCT, c)
                || in_table(t::SPACES, c)
                || in_table(t::INVALID_CHARS, c)
                || in_table(t::DIRECTIONAL_MARKERS, c));
            assert_eq!(is_domain_char(c), want, "U+{cp:04X}");
        }
    }
}
