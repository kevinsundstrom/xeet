//! URL extraction: a port of twitter-text's `extractUrl` grammar and
//! `extractUrlsWithIndices`.
//!
//! The upstream code is three regular expressions composed at runtime
//! (`extractUrl`, `validDomain`, `validUrlPath`); this is the same grammar as a
//! hand-written scanner, which keeps the left-to-right, greedy, first-match
//! semantics of a backtracking engine while avoiding a regex dependency.
//!
//! The pieces, in the order the pattern tries them:
//!
//! ```text
//! (preceding char) ( (https?://)? domain (:port)? (/path*)? (?query)? )
//!                  ^--- group 3: the URL ---^
//! ```
//!
//! `domain` is `(subdomain '.')* label '.' (gTLD | ccTLD | punycode)`, `path` is
//! `/` followed by path units that may contain up to two levels of balanced
//! parentheses and must end on a path-ending character, and `query` is `?`
//! followed by query characters that must end on a query-ending character.

use crate::chars::{
    is_ascii_domain_char, is_label_char, is_path_char, is_path_ending_char, is_query_char,
    is_query_ending_char, is_url_preceding_char,
};
use crate::idna;
use crate::text::Text;
use crate::tld::match_tld;

/// twitter-text caps an extracted URL at this many characters (after punycode).
const MAX_URL_LENGTH: usize = 4096;
/// And a `t.co` slug at this many.
const MAX_TCO_SLUG_LENGTH: usize = 40;

/// A URL found in the text, with character indices.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawUrl {
    pub(crate) start: usize,
    pub(crate) end: usize,
    /// The URL as reported by twitter-text: the source text, except in two
    /// corners (`t.co` trimming and unicode-domain trimming) where the reported
    /// string is shorter than `start..end`.
    pub(crate) url: String,
}

/// Extract every URL, following `extractUrlsWithIndices`.
pub(crate) fn extract(t: &Text, without_protocol: bool) -> Vec<RawUrl> {
    // Upstream bails out early: with protocol-less extraction on, a URL needs a
    // dot; with it off, it needs a colon.
    let mut has_dot = false;
    let mut has_colon = false;
    for i in 0..t.len() {
        match t.ch(i) {
            '.' => has_dot = true,
            ':' => has_colon = true,
            _ => {}
        }
    }
    if without_protocol && !has_dot {
        return Vec::new();
    }
    if !without_protocol && !has_colon {
        return Vec::new();
    }

    let mut urls = Vec::new();
    let mut i = 0;
    while i < t.len() {
        // A URL starts with an ASCII letter or digit, or with a non-ASCII
        // character (a label in another script). Everything else is a cheap skip,
        // which matters because the scan visits every character.
        let first = t.ch(i);
        if !(first.is_ascii_alphanumeric() || !first.is_ascii()) {
            i += 1;
            continue;
        }
        // The preceding-character group of `extractUrl` is one character (or the
        // string start), so a match can only begin where `i` starts a URL and
        // the character before it allows one.
        let preceding_ok = if i == 0 {
            true
        } else {
            is_url_preceding_char(t.ch(i - 1))
        };
        let matched = if preceding_ok {
            match_url_at(t, i)
        } else {
            None
        };
        let Some(m) = matched else {
            i += 1;
            // After a tried non-ASCII label character finds no URL, every later
            // start in the same run fails the same way (same label chain, same
            // TLD), and trying each made a long label quadratic: skip the run.
            // A start the guard refused was never tried, and a non-label start is
            // not part of the run, so `@üü.com` and `中文　ü.co.uk` still match.
            if preceding_ok && !first.is_ascii() && is_label_char(first) {
                while i < t.len() && !t.ch(i).is_ascii() && is_label_char(t.ch(i)) {
                    i += 1;
                }
            }
            continue;
        };
        // `lastIndex` is the end of the match whether or not it is accepted, and
        // the next scan position consumes a fresh preceding character, so the
        // next URL can start one past this one.
        i = m.end + 1;

        if !valid_host_and_length(t, &m) {
            continue;
        }
        if m.protocol_len == 0 {
            if !without_protocol {
                continue;
            }
            // `INVALID_URL_WITHOUT_PROTOCOL_MATCH_BEGIN`
            let before = if m.start == 0 {
                None
            } else {
                t.at(m.start - 1)
            };
            if matches!(before, Some('-' | '_' | '.' | '/')) {
                continue;
            }
            // Only the ASCII part of the domain is a URL, and every ASCII domain
            // inside the match becomes one. Upstream re-runs the ASCII domain
            // pattern over the matched domain and pushes each hit.
            let domain_end = m.domain_start + m.domain_chars;
            let found = ascii_domains(t, m.domain_start, domain_end);
            if found.is_empty() {
                continue;
            }
            let first_new = urls.len();
            for (a, b) in found {
                urls.push(RawUrl {
                    start: a,
                    end: b,
                    url: t.slice(a, b).to_string(),
                });
            }
            if m.slash {
                // A trailing port, path and query belong to the last domain only.
                let _ = first_new;
                let last_index = urls.len() - 1;
                let last = &mut urls[last_index];
                last.url.push_str(t.slice(domain_end, m.end));
                last.end = m.end;
            }
            continue;
        }
        // `t.co` links may not carry extra path characters, and their slug is
        // capped at 40 characters.
        let mut end = m.end;
        if let Some(tco_end) = match_tco(t, m.start, m.end) {
            if tco_slug_len(t, m.start) > MAX_TCO_SLUG_LENGTH {
                continue;
            }
            end = tco_end;
        }
        urls.push(RawUrl {
            start: m.start,
            end,
            url: t.slice(m.start, end).to_string(),
        });
    }
    urls
}

/// The shape of a successful `extractUrl` match at one position.
#[derive(Debug, Clone, Copy)]
struct UrlMatch {
    start: usize,
    end: usize,
    protocol_len: usize,
    domain_start: usize,
    /// Domain length in characters.
    domain_chars: usize,
    /// Whether a `/` followed the domain (the path group matched at all).
    slash: bool,
}

/// `(https?://)? validDomain (:port)? (/validUrlPath*)? (\?query)?` at `pos`.
fn match_url_at(t: &Text, pos: usize) -> Option<UrlMatch> {
    let protocol_len = if t.starts_with_ci(pos, "https://") {
        8
    } else if t.starts_with_ci(pos, "http://") {
        7
    } else {
        0
    };
    let domain_start = pos + protocol_len;
    let domain_end = match_domain(t, domain_start)?;
    let mut k = domain_end;

    // `(?::(validPortNumber))?`
    if t.at(k) == Some(':') && t.at(k + 1).is_some_and(|c| c.is_ascii_digit()) {
        k += 1;
        while t.at(k).is_some_and(|c| c.is_ascii_digit()) {
            k += 1;
        }
    }

    // `(\/validUrlPath*)?`: the slash alone always matches, so the group is
    // taken whenever the next character is a slash.
    let mut slash = false;
    if t.at(k) == Some('/') {
        slash = true;
        k = match_path_units(t, k + 1);
    }

    // `(\?validUrlQueryChars*validUrlQueryEndingChars)?`
    if t.at(k) == Some('?') {
        if let Some(end) = match_query(t, k + 1) {
            k = end;
        }
    }

    Some(UrlMatch {
        start: pos,
        end: k,
        protocol_len,
        domain_start,
        domain_chars: domain_end - domain_start,
        slash,
    })
}

/// `(subdomain*validDomainName)(gTLD|ccTLD|punycode)` at `start`.
///
/// The upstream pattern is greedy on the subdomain chain, so the longest chain
/// that leaves a valid TLD wins; shorter chains are only tried when a longer one
/// has no valid TLD. `validDomainName` (the label right before the TLD) does not
/// admit underscores, while subdomains do, which is why the label before the TLD
/// is checked separately.
fn match_domain(t: &Text, start: usize) -> Option<usize> {
    // Every label that is followed by a dot, in order: (start, dot position, has '_').
    let mut labels: Vec<(usize, usize, bool)> = Vec::new();
    let mut pos = start;
    loop {
        let mut j = pos;
        while j < t.len() && is_label_char(t.ch(j)) {
            j += 1;
        }
        if j == pos {
            break;
        }
        if matches!(t.ch(pos), '-' | '_') || matches!(t.ch(j - 1), '-' | '_') {
            break;
        }
        if t.at(j) != Some('.') {
            break;
        }
        let has_underscore = (pos..j).any(|x| t.ch(x) == '_');
        labels.push((pos, j, has_underscore));
        pos = j + 1;
        if labels.len() > 127 {
            return None;
        }
    }
    // Greedy: try the longest chain first.
    for k in (1..=labels.len()).rev() {
        let (_, dot, has_underscore) = labels[k - 1];
        // The label just before the TLD is the `validDomainName` one.
        if has_underscore {
            continue;
        }
        let tld_start = dot + 1;
        if let Some(end) = match_tld(t, tld_start, t.len()) {
            if end > tld_start {
                return Some(end);
            }
        }
    }
    None
}

/// URL path units after the `/` at `slash + 0` (the caller passes the index
/// right after the slash). Returns the end of the greedy run.
fn match_path_units(t: &Text, start: usize) -> usize {
    let mut best = start;
    let mut i = start;
    while let Some(end) = match_path_unit(t, i) {
        i = end;
        best = end;
    }
    best
}

/// One `validUrlPath`: general characters and balanced parens, ending on a
/// path-ending character; or `@general+/`.
fn match_path_unit(t: &Text, start: usize) -> Option<usize> {
    if let Some(end) = match_at_path(t, start) {
        return Some(end);
    }
    // `(?:@general+/)`
    if t.at(start) == Some('@') {
        let mut j = start + 1;
        while j < t.len() && is_path_char(t.ch(j)) {
            j += 1;
        }
        if j > start + 1 && t.at(j) == Some('/') {
            return Some(j + 1);
        }
    }
    None
}

/// `general* (balanced general*)* ending`, as the longest prefix that ends on a
/// path-ending character.
fn match_at_path(t: &Text, start: usize) -> Option<usize> {
    let mut best = None;
    let mut j = start;
    loop {
        match t.at(j) {
            Some('(') => match match_balanced(t, j) {
                Some(end) => {
                    // `validUrlPathEndingChars` includes a balanced paren group,
                    // so a unit can end right after one.
                    j = end;
                    best = Some(end);
                }
                None => break,
            },
            Some(c) if is_path_char(c) => {
                j += 1;
                if is_path_ending_char(c) {
                    best = Some(j);
                }
            }
            _ => break,
        }
    }
    best
}

/// `\( (?:general+ | general* \( general+ \) general* ) \)` at `open`.
fn match_balanced(t: &Text, open: usize) -> Option<usize> {
    debug_assert_eq!(t.at(open), Some('('));
    // First alternative: `general+` then `)`.
    let mut j = open + 1;
    while j < t.len() && is_path_char(t.ch(j)) {
        j += 1;
    }
    if j > open + 1 && t.at(j) == Some(')') {
        return Some(j + 1);
    }
    // Second alternative: `general* ( general+ ) general*` then `)`.
    let inner_open = j;
    if t.at(inner_open) != Some('(') {
        return None;
    }
    let mut inner = inner_open + 1;
    while inner < t.len() && is_path_char(t.ch(inner)) {
        inner += 1;
    }
    if inner == inner_open + 1 || t.at(inner) != Some(')') {
        return None;
    }
    let mut tail = inner + 1;
    while tail < t.len() && is_path_char(t.ch(tail)) {
        tail += 1;
    }
    if t.at(tail) == Some(')') {
        return Some(tail + 1);
    }
    None
}

/// `validUrlQueryChars*validUrlQueryEndingCharsFrom` after the `?`.
fn match_query(t: &Text, start: usize) -> Option<usize> {
    let mut j = start;
    let mut last_good = None;
    while j < t.len() && is_query_char(t.ch(j)) {
        j += 1;
        if is_query_ending_char(t.ch(j - 1)) {
            last_good = Some(j);
        }
    }
    last_good
}

/// `isValidHostAndLength`: the host must be encodable as an A-label set of at
/// most 63 characters per label, and the URL with its scheme (defaulting to
/// `https://` when the match had none) at most 4096 characters.
fn valid_host_and_length(t: &Text, m: &UrlMatch) -> bool {
    let end = m.end;
    let domain = t.slice(m.domain_start, m.domain_start + m.domain_chars);
    // A domain that claims to be an A-label must be one: a label starting with
    // `xn--` may not contain non-ASCII characters.
    if domain.starts_with("xn--")
        && !contains_ascii_domain(t, m.domain_start, m.domain_start + m.domain_chars)
    {
        return false;
    }
    let Some(ascii_len) = idna::ascii_len(domain) else {
        return false;
    };
    let url_len = utf16_units(t.slice(m.start, end));
    let url_len = url_len + ascii_len - utf16_units(domain);
    let scheme_len = if m.protocol_len == 0 { 8 } else { 0 };
    url_len + scheme_len <= MAX_URL_LENGTH
}

fn utf16_units(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `validAsciiDomain` matches inside `[start, end)`: the last one wins, as in
/// upstream's `domain.replace(validAsciiDomain, ...)`.
pub(crate) fn ascii_domains(t: &Text, start: usize, end: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = start;
    while i < end {
        if !is_ascii_domain_char(t.ch(i)) {
            i += 1;
            continue;
        }
        match ascii_domain_at(t, i, end) {
            Some(e) => {
                out.push((i, e));
                i = e;
            }
            None => i += 1,
        }
    }
    out
}

/// Whether an ASCII domain starts anywhere in `[start, end)`.
pub(crate) fn contains_ascii_domain(t: &Text, start: usize, end: usize) -> bool {
    let mut i = start;
    while i < end {
        if is_ascii_domain_char(t.ch(i)) && ascii_domain_at(t, i, end).is_some() {
            return true;
        }
        i += 1;
    }
    false
}

/// `(?:[-a-z0-9 latin]{1,}\.)+(?:gTLD|ccTLD|punycode)` at `start`, bounded by `end`.
fn ascii_domain_at(t: &Text, start: usize, end: usize) -> Option<usize> {
    // `(?:label\.)+` greedily.
    let mut dots = Vec::new();
    let mut pos = start;
    loop {
        let mut j = pos;
        while j < end && is_ascii_domain_char(t.ch(j)) {
            j += 1;
        }
        if j == pos || t.at(j) != Some('.') || j + 1 > end {
            break;
        }
        dots.push(j);
        pos = j + 1;
        if dots.len() > 127 {
            return None;
        }
    }
    for dot in dots.iter().rev() {
        if let Some(e) = match_tld(t, dot + 1, end) {
            if e <= end {
                return Some(e);
            }
        }
    }
    None
}

/// `^https?://t\.co/([a-z0-9]+)(?:\?query)?` at `start`, returning the trimmed end.
fn match_tco(t: &Text, start: usize, end: usize) -> Option<usize> {
    let slash = if t.starts_with_ci(start, "https://") {
        start + 8
    } else if t.starts_with_ci(start, "http://") {
        start + 7
    } else {
        return None;
    };
    if !t.starts_with_ci(slash, "t.co/") {
        return None;
    }
    let mut j = slash + 5;
    let slug_start = j;
    while j < end && t.ch(j).is_ascii_alphanumeric() {
        j += 1;
    }
    if j == slug_start {
        return None;
    }
    if t.at(j) == Some('?') {
        if let Some(q) = match_query(t, j + 1) {
            j = q;
        }
    }
    Some(j)
}

fn tco_slug_len(t: &Text, start: usize) -> usize {
    let slash = if t.starts_with_ci(start, "https://") {
        start + 8
    } else {
        start + 7
    };
    let mut j = slash + 5;
    let slug_start = j;
    while j < t.len() && t.ch(j).is_ascii_alphanumeric() {
        j += 1;
    }
    j - slug_start
}
