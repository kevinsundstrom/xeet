//! Mentions (with lists), hashtags and cashtags.

use crate::chars::{
    is_at_sign, is_end_mention_char, is_hash_sign, is_hashtag_alpha, is_hashtag_alphanumeric,
    is_mention_preceding_excluded, is_punct, is_retweet_prefix_boundary, is_space,
};
use crate::text::Text;

/// A `@name` or `@name/list` mention. Character indices cover the whole token,
/// including the `@` and the `/<list>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawMention {
    pub(crate) start: usize,
    pub(crate) end: usize,
}

/// `validMentionOrList` with the `endMentionMatch` guard.
pub(crate) fn extract_mentions(t: &Text) -> Vec<RawMention> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < t.len() {
        if !is_at_sign(t.ch(i)) {
            i += 1;
            continue;
        }
        if !mention_can_start_at(t, i) {
            i += 1;
            continue;
        }
        match match_mention(t, i) {
            Some(end) => {
                // `endMentionMatch`: an `@`, an accented Latin letter or `://`
                // right after means this was part of something else.
                let after = t.at(end);
                let after_ok = !match after {
                    Some(c) if is_end_mention_char(c) => true,
                    _ => t.starts_with_ci(end, "://"),
                };
                if after_ok {
                    out.push(RawMention { start: i, end });
                }
                // The regex engine consumed the match either way.
                i = end;
            }
            None => i += 1,
        }
    }
    out
}

/// `validMentionPrecedingChars`: the start of the string, a character that
/// cannot be part of a name, or an `rt`/`RT`/... retweet prefix.
fn mention_can_start_at(t: &Text, at: usize) -> bool {
    if at == 0 {
        return true;
    }
    if !is_mention_preceding_excluded(t.ch(at - 1)) {
        return true;
    }
    // `(?:^|[^a-zA-Z0-9_+~.-])(?:rt|RT|rT|Rt):?`
    let mut j = at;
    let mut has_colon = false;
    if j > 0 && t.ch(j - 1) == ':' {
        j -= 1;
        has_colon = true;
    }
    if j < 2 {
        return false;
    }
    let r = t.ch(j - 2);
    let x = t.ch(j - 1);
    let is_rt = matches!(r, 'r' | 'R') && matches!(x, 't' | 'T');
    if !is_rt {
        return false;
    }
    if j == 2 {
        return true;
    }
    // `(?:^|[^a-zA-Z0-9_+~.-])` before the prefix.
    let _ = has_colon;
    is_retweet_prefix_boundary(t.ch(j - 3)) || j - 2 == 0
}

/// `(@)([a-zA-Z0-9_]{1,20})(/[a-zA-Z][a-zA-Z0-9_-]{0,24})?` at the `@`.
fn match_mention(t: &Text, at: usize) -> Option<usize> {
    let mut j = at + 1;
    let name_start = j;
    while j < t.len() && j - name_start < 20 && is_name_char(t.ch(j)) {
        j += 1;
    }
    if j == name_start {
        return None;
    }
    // `(/[a-zA-Z][a-zA-Z0-9_-]{0,24})?`
    if t.at(j) == Some('/') {
        if let Some(c) = t.at(j + 1) {
            if c.is_ascii_alphabetic() {
                let mut k = j + 2;
                while k < t.len() && k - (j + 2) < 24 && is_list_char(t.ch(k)) {
                    k += 1;
                }
                return Some(k);
            }
        }
    }
    Some(j)
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_list_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// A `#hashtag`. Character indices cover the `#` as well.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawHashtag {
    pub(crate) start: usize,
    pub(crate) end: usize,
}

/// `validHashtag` with the `endHashtagMatch` guard.
pub(crate) fn extract_hashtags(t: &Text) -> Vec<RawHashtag> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < t.len() {
        if !is_hash_sign(t.ch(i)) {
            i += 1;
            continue;
        }
        // `hashtagBoundary` tries the variation selectors before the general
        // "any code point that is not alphanumeric" alternative, so a hashtag
        // right after an emoji drawn with a selector still counts.
        let boundary_ok = i == 0 || {
            let prev = t.ch(i - 1);
            matches!(prev, '\u{FE0E}' | '\u{FE0F}')
                || (!is_hashtag_alphanumeric(prev) && prev != '&')
        };
        if !boundary_ok {
            i += 1;
            continue;
        }
        // `(?!\uFE0F|\u20E3)`: the keycap sequences `#️⃣` and `1️⃣` are not tags.
        if matches!(t.at(i + 1), Some('\u{FE0F}' | '\u{20E3}')) {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        let mut has_alpha = false;
        while j < t.len() && is_hashtag_alphanumeric(t.ch(j)) {
            if is_hashtag_alpha(t.ch(j)) {
                has_alpha = true;
            }
            j += 1;
        }
        if !has_alpha {
            i = j.max(i + 1);
            continue;
        }
        // `endHashtagMatch`: `#hashtag#other` and `#hashtag://` are rejected.
        let after_is_hash_or_scheme =
            matches!(t.at(j), Some(c) if is_hash_sign(c)) || t.starts_with_ci(j, "://");
        if !after_is_hash_or_scheme {
            out.push(RawHashtag { start: i, end: j });
        }
        i = j.max(i + 1);
    }
    out
}

/// A `$cashtag`. Character indices cover the `$`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawCashtag {
    pub(crate) start: usize,
    pub(crate) end: usize,
}

/// `validCashtag`.
pub(crate) fn extract_cashtags(t: &Text) -> Vec<RawCashtag> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < t.len() {
        if t.ch(i) != '$' {
            i += 1;
            continue;
        }
        let boundary_ok = i == 0 || is_space(t.ch(i - 1));
        if !boundary_ok {
            i += 1;
            continue;
        }
        match match_cashtag(t, i + 1) {
            Some(end) => {
                out.push(RawCashtag { start: i, end });
                i = end;
            }
            None => i += 1,
        }
    }
    out
}

/// `[a-z]{1,6}(?:[._][a-z]{1,2})?(?=$|\s|[punct])`, greedily preferring the
/// longest form.
fn match_cashtag(t: &Text, start: usize) -> Option<usize> {
    let mut j = start;
    while j < t.len() && j - start < 6 && t.ch(j).is_ascii_alphabetic() {
        j += 1;
    }
    if j == start {
        return None;
    }
    // Longest first: `[._][a-z]{1,2}`, then `[._][a-z]`, then no suffix.
    for suffix in [2usize, 1] {
        if matches!(t.at(j), Some('.' | '_')) {
            let mut k = j + 1;
            if k < t.len() && t.ch(k).is_ascii_alphabetic() {
                k += 1;
                for _ in 1..suffix {
                    if k < t.len() && t.ch(k).is_ascii_alphabetic() {
                        k += 1;
                    } else {
                        break;
                    }
                }
                if cashtag_boundary(t, k) {
                    return Some(k);
                }
            }
        }
    }
    if cashtag_boundary(t, j) {
        return Some(j);
    }
    // The lookahead can also succeed when the greedy body was too long: shorten
    // the alphabetic run until the boundary holds.
    let mut k = j;
    while k > start + 1 {
        k -= 1;
        if cashtag_boundary(t, k) {
            return Some(k);
        }
    }
    None
}

fn cashtag_boundary(t: &Text, at: usize) -> bool {
    match t.at(at) {
        None => true,
        Some(c) => is_js_whitespace(c) || is_punct(c),
    }
}

/// JavaScript's `\s`, which is not the same set as twitter-text's `spaces`.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}
