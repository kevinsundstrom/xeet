//! Where a line may break, and where a grapheme cluster ends.
//!
//! The base rules are the Unicode line breaking algorithm (UAX #14) as
//! implemented by ICU4X, the same family of rules Chrome gets from ICU.
//! Chrome uses its own table for ASCII pairs; that table lives in
//! `blink_ascii.rs` and is regenerated from Chrome by `tools/oracle/breaks.mjs`.

use icu_segmenter::{
    GraphemeClusterSegmenter, GraphemeClusterSegmenterBorrowed, LineSegmenter,
    LineSegmenterBorrowed,
};
use std::sync::OnceLock;

fn line_segmenter() -> &'static LineSegmenterBorrowed<'static> {
    static S: OnceLock<LineSegmenterBorrowed<'static>> = OnceLock::new();
    S.get_or_init(|| LineSegmenter::new_auto(Default::default()))
}

fn grapheme_segmenter() -> &'static GraphemeClusterSegmenterBorrowed<'static> {
    static S: OnceLock<GraphemeClusterSegmenterBorrowed<'static>> = OnceLock::new();
    S.get_or_init(GraphemeClusterSegmenter::new)
}

/// Byte offsets strictly inside `text` at which a new line may start.
///
/// Chrome decides in two ways. Between two ASCII characters it uses its own
/// pair table and never consults Unicode's rules. Everywhere else (around a
/// space, or when either neighbor is non-ASCII) it uses ICU's UAX #14 rules
/// with full context.
///
/// The pair table alone decides Latin text, so that case is one tight pass and
/// returns. Only when a pair needs Unicode rules does the general pass run,
/// which builds ICU's segmenter and redoes the walk. (Building the segmenter
/// eagerly costs about as much as the whole ASCII pass: it is the difference
/// between 0.25 µs and 1 µs for a line of a post.)
pub fn line_breaks(text: &str) -> Vec<usize> {
    let mut out = Vec::new();
    if table_breaks(text, &mut out) {
        return out;
    }
    out.clear();
    general_breaks(text, &mut out);
    out
}

/// Break opportunities decided by Chrome's ASCII pair table and its space
/// rule. Returns false, with `out` incomplete, as soon as a pair needs the
/// Unicode rules.
fn table_breaks(text: &str, out: &mut Vec<usize>) -> bool {
    use crate::blink_ascii::{may_break, FIRST, LAST};
    let bytes = text.as_bytes();
    let in_table = |b: u8| (FIRST..=LAST).contains(&b);
    let mut i = 1;
    while i < bytes.len() {
        let (a, b) = (bytes[i - 1], bytes[i]);
        if a == b' ' || a == b'\t' {
            // Chrome handles spaces before any rule runs: the end of a run of
            // spaces is always an opportunity, whatever follows. UAX #14 would
            // forbid some of these (for example between two dashes).
            if b != b' ' && b != b'\t' && text.is_char_boundary(i) {
                out.push(i);
            }
        } else if in_table(a) && in_table(b) {
            // A hyphen before a digit may be a minus sign. Chrome breaks there
            // only when the hyphen follows a letter or digit ("ABCD-1234").
            let allowed = if a == b'-' && b.is_ascii_digit() {
                i >= 2 && bytes[i - 2].is_ascii_alphanumeric()
            } else {
                may_break(a, b)
            };
            if allowed {
                out.push(i);
            }
        } else if in_table(a) && (b == b' ' || b == b'\t') {
            // LB7: never break before a space or a tab. The run gains its
            // opportunity on the way out, which the `a == ' '` branch above
            // takes. Space and tab are outside Chrome's table (`FIRST` is
            // 0x21), so without this branch every post with a space would
            // decline here and redo the whole walk with ICU. A `a` outside the
            // table (a control character other than tab) still declines.
        } else {
            return false;
        }
        i += 1;
    }
    true
}

/// [`line_breaks`] for text with pairs outside Chrome's ASCII table.
fn general_breaks(text: &str, out: &mut Vec<usize>) {
    use crate::blink_ascii::{may_break, FIRST, LAST};
    let len = text.len();
    let bytes = text.as_bytes();
    let in_table = |b: u8| (FIRST..=LAST).contains(&b);
    let mut icu = line_segmenter()
        .segment_str(text)
        .filter(|&i| i > 0 && i < len)
        .peekable();
    let mut i = 1;
    while i < len {
        let (a, b) = (bytes[i - 1], bytes[i]);
        if a == b' ' || a == b'\t' {
            if b != b' ' && b != b'\t' && text.is_char_boundary(i) {
                out.push(i);
            }
        } else if in_table(a) && in_table(b) {
            let allowed = if a == b'-' && b.is_ascii_digit() {
                i >= 2 && bytes[i - 2].is_ascii_alphanumeric()
            } else {
                may_break(a, b)
            };
            if allowed {
                out.push(i);
            }
        } else {
            while icu.peek().is_some_and(|&p| p < i) {
                icu.next();
            }
            if icu.peek() == Some(&i) {
                out.push(i);
            }
        }
        i += 1;
    }
}

/// Byte offsets of grapheme cluster boundaries, including 0 and `text.len()`.
pub fn grapheme_boundaries(text: &str) -> Vec<usize> {
    if text.is_ascii() {
        // Every ASCII byte is its own cluster except CR LF.
        let bytes = text.as_bytes();
        let mut out = Vec::with_capacity(bytes.len() + 1);
        for i in 0..=bytes.len() {
            if i > 0 && i < bytes.len() && bytes[i - 1] == b'\r' && bytes[i] == b'\n' {
                continue;
            }
            out.push(i);
        }
        return out;
    }
    grapheme_segmenter().segment_str(text).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table-only pass must agree with the general one wherever it
    /// answers, and decline (rather than guess) everywhere else.
    #[test]
    fn table_pass_agrees_with_the_general_pass() {
        let cases = [
            "",
            "a",
            "we shipped the thing today, and it is fast.",
            "https://vercel.com/blog/the-thing",
            "a  b\tc",
            "hyphen-1234 and 12-34",
            "tab\tstop\there",
            "trailing spaces   ",
            "a\u{0}b",           // control character: not in the table
            "caf\u{e9} au lait", // non-ASCII
            "\u{1F600} emoji",
        ];
        for text in cases {
            let mut table = Vec::new();
            let decided = table_breaks(text, &mut table);
            let general = {
                let mut out = Vec::new();
                general_breaks(text, &mut out);
                out
            };
            if decided {
                assert_eq!(table, general, "disagreement on {text:?}");
            }
            assert_eq!(
                line_breaks(text),
                general,
                "line_breaks disagrees on {text:?}"
            );
        }
    }

    /// Latin text must never reach the general pass: space and tab are outside
    /// the pair table, so a space followed by a letter used to make the table
    /// pass decline and redo the whole walk with ICU. Every case here is ASCII,
    /// so the table decides all of it, and its answer must be ICU's.
    #[test]
    fn ascii_text_stays_on_the_table() {
        let cases = [
            "the quick brown fox jumps over the lazy dog",
            "we shipped the thing today, and it is fast.",
            "a b c d e f g h i j k l m n o p q r s t u v w x y z",
            "one  two   three    four",
            "   leading spaces",
            "trailing spaces   ",
            "\tindented with a tab",
            "col\ta\tb\tc",
            "https://vercel.com/blog/the-thing?x=1&y=2",
            "https://example.com/a-really-long-path/that/keeps/going",
            "hyphen-1234 12-34 -- --- A-1 ABC-9",
            "x: y; z, w. v? u! t",
            "!?:;,.*+%&()[]{}<>|~^_=#$@`'\"",
            "a\rb",    // CR is a control character: the table declines it
            "a\u{0}b", // and so is NUL
        ];
        for text in cases {
            let mut table = Vec::new();
            let decided = table_breaks(text, &mut table);
            let general = {
                let mut out = Vec::new();
                general_breaks(text, &mut out);
                out
            };
            let ascii = text.is_ascii();
            let control = text.bytes().any(|b| b < 0x20 && b != b'\t');
            assert_eq!(
                decided,
                ascii && !control,
                "unexpected decision on {text:?}"
            );
            if decided {
                assert_eq!(table, general, "disagreement on {text:?}");
            }
            assert_eq!(
                line_breaks(text),
                general,
                "line_breaks disagrees on {text:?}"
            );
        }
    }
}
