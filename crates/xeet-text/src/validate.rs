//! Validation: `isValidTweetText`, `isValidUsername`, `isValidHashtag`,
//! `isValidList` and `isValidUrl`.
//!
//! The URL validator is twitter-text's `isValidUrl`: a deliberately syntactic
//! check (RFC 3986-shaped, no DNS), not a fetch.

use crate::chars::is_cyrillic;
use crate::entities::parse;

/// `isValidTweetText`: a non-empty post of at most 280 weighted characters with
/// no invalid characters.
pub fn is_valid_tweet_text(text: &str) -> bool {
    parse(text).valid
}

/// `isValidUsername`: the whole string is one `@username`.
pub fn is_valid_username(text: &str) -> bool {
    let Some(rest) = text.strip_prefix(['@', '\u{FF20}']) else {
        return false;
    };
    match crate::mentions(text).as_slice() {
        [one] => one == rest,
        _ => false,
    }
}

/// `isValidHashtag`: the whole string is one `#hashtag`.
pub fn is_valid_hashtag(text: &str) -> bool {
    let Some(rest) = text.strip_prefix(['#', '\u{FF03}']) else {
        return false;
    };
    match crate::hashtags(text).as_slice() {
        [one] => one == rest,
        _ => false,
    }
}

/// `isValidList`: the whole string is `@username/list`.
pub fn is_valid_list(text: &str) -> bool {
    let mut t = text.chars().peekable();
    if !matches!(t.next(), Some('@' | '\u{FF20}')) {
        return false;
    }
    let mut name = 0;
    while let Some(c) = t.peek() {
        if c.is_ascii_alphanumeric() || *c == '_' {
            name += 1;
            t.next();
        } else {
            break;
        }
    }
    if name == 0 || name > 20 {
        return false;
    }
    if t.next() != Some('/') {
        return false;
    }
    match t.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for (slug, c) in t.enumerate() {
        if slug >= 24 || !(c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return false;
        }
    }
    true
}

/// `isValidUrl(url, unicodeDomains, requireProtocol)`.
pub fn is_valid_url(url: &str, unicode_domains: bool, require_protocol: bool) -> bool {
    if url.is_empty() {
        return false;
    }
    // `^([^:/?#]+):// ? ([^/?#]*) ([^?#]*) (?:\?([^#]*))? (?:#(.*))?$`
    let mut rest = url;
    let mut scheme = None;
    if let Some(i) = url.find("://") {
        let candidate = &url[..i];
        if !candidate.is_empty() && !candidate.contains([':', '/', '?', '#']) {
            scheme = Some(candidate);
            rest = &url[i + 3..];
        }
    }
    if require_protocol {
        let Some(scheme) = scheme else {
            return false;
        };
        if !is_scheme(scheme)
            || !(scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"))
        {
            return false;
        }
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let after = &rest[authority_end..];
    let path_end = after.find(['?', '#']).unwrap_or(after.len());
    let path = &after[..path_end];
    let after_path = &after[path_end..];
    let (query, fragment) = match after_path.strip_prefix('?') {
        Some(q) => match q.find('#') {
            Some(i) => (Some(&q[..i]), Some(&q[i + 1..])),
            None => (Some(q), None),
        },
        None => (None, after_path.strip_prefix('#')),
    };

    if !is_path(path) {
        return false;
    }
    if let Some(q) = query {
        if !is_query_or_fragment(q) {
            return false;
        }
    }
    if let Some(f) = fragment {
        if !is_query_or_fragment(f) {
            return false;
        }
    }
    is_authority(authority, unicode_domains)
}

fn is_scheme(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

fn is_unreserved(c: char) -> bool {
    c.is_ascii_alphanumeric() || is_cyrillic(c) || matches!(c, '-' | '.' | '_' | '~')
}

fn is_sub_delim(c: char) -> bool {
    matches!(
        c,
        '!' | '$' | '&' | '\'' | '(' | ')' | '*' | '+' | ',' | ';' | '='
    )
}

/// Consume one character of a `pchar` production, or one percent-encoded
/// triplet, returning the new index.
fn pchar(s: &[char], i: usize) -> Option<usize> {
    let c = *s.get(i)?;
    if c == '%' {
        let a = *s.get(i + 1)?;
        let b = *s.get(i + 2)?;
        if a.is_ascii_hexdigit() && b.is_ascii_hexdigit() {
            return Some(i + 3);
        }
        return None;
    }
    if is_unreserved(c) || is_sub_delim(c) || matches!(c, ':' | '|' | '@') {
        return Some(i + 1);
    }
    None
}

fn pchar_run(s: &[char], mut i: usize) -> usize {
    while let Some(next) = pchar(s, i) {
        i = next;
    }
    i
}

/// `(\/pchar*)*`
fn is_path(path: &str) -> bool {
    let s: Vec<char> = path.chars().collect();
    let mut i = 0;
    while i < s.len() {
        if s[i] != '/' {
            return false;
        }
        i = pchar_run(&s, i + 1);
    }
    true
}

/// `(pchar|\/|\?)*`
fn is_query_or_fragment(part: &str) -> bool {
    let s: Vec<char> = part.chars().collect();
    let mut i = 0;
    while i < s.len() {
        if s[i] == '/' || s[i] == '?' {
            i += 1;
            continue;
        }
        match pchar(&s, i) {
            Some(next) => i = next,
            None => return false,
        }
    }
    true
}

fn is_authority(authority: &str, unicode_domains: bool) -> bool {
    let s: Vec<char> = authority.chars().collect();
    let (userinfo, host_port) = match s.iter().position(|&c| c == '@') {
        Some(at) => (&s[..at], &s[at + 1..]),
        None => (&s[..0], &s[..]),
    };
    // `(unreserved|pct|subdelims|:)*`
    let mut i = 0;
    while i < userinfo.len() {
        let c = userinfo[i];
        if c == ':' {
            i += 1;
            continue;
        }
        if is_unreserved(c) || is_sub_delim(c) {
            i += 1;
            continue;
        }
        match pchar(userinfo, i) {
            Some(next) => i = next,
            None => return false,
        }
    }
    // `(host)(?::(port))?`
    let (host, port) = if host_port.first() == Some(&'[') {
        match host_port.iter().position(|&c| c == ']') {
            Some(end) => {
                let rest = &host_port[end + 1..];
                match rest.split_first() {
                    Some((':', tail)) => (&host_port[..=end], Some(tail)),
                    Some(_) => return false,
                    None => (&host_port[..=end], None),
                }
            }
            None => return false,
        }
    } else {
        match host_port.iter().position(|&c| c == ':') {
            Some(i) => (&host_port[..i], Some(&host_port[i + 1..])),
            None => (host_port, None),
        }
    };
    if let Some(port) = port {
        if port.is_empty() || port.len() > 5 || !port.iter().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }
    is_host(host, unicode_domains)
}

fn is_host(host: &[char], unicode_domains: bool) -> bool {
    if is_ipv4(host) {
        return true;
    }
    if host.first() == Some(&'[') && host.last() == Some(&']') {
        // `\[[a-f0-9:.]+\]` (deliberately loose)
        let inner = &host[1..host.len() - 1];
        return !inner.is_empty()
            && inner
                .iter()
                .all(|c| c.is_ascii_hexdigit() || *c == ':' || *c == '.');
    }
    is_domain(host, unicode_domains)
}

fn is_ipv4(host: &[char]) -> bool {
    let s: String = host.iter().collect();
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|p| {
        if p.is_empty() || p.len() > 3 || !p.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
        if p.len() > 1 && p.starts_with('0') {
            return false;
        }
        p.parse::<u32>().map(|n| n <= 255).unwrap_or(false)
    })
}

/// `(subdomain '.')* domain '.' tld`, syntactically. No TLD list is consulted:
/// `example.invalidtld` is a valid URL shape, it just has no card.
fn is_domain(host: &[char], unicode_domains: bool) -> bool {
    let s: String = host.iter().collect();
    let labels: Vec<&str> = s.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let last = labels.len() - 1;
    for (i, label) in labels.iter().enumerate() {
        let ok = if i == last {
            domain_tld(label, unicode_domains)
        } else if i + 1 == last {
            segment(label, unicode_domains, &[])
        } else {
            segment(label, unicode_domains, &['_'])
        };
        if !ok {
            return false;
        }
    }
    true
}

/// `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?` (plus `_` for subdomains), where the
/// unicode variant also accepts any non-ASCII character.
fn segment(label: &str, unicode: bool, extra: &[char]) -> bool {
    let chars: Vec<char> = label.chars().collect();
    let Some(&first) = chars.first() else {
        return false;
    };
    let alnum = |c: char| c.is_ascii_alphanumeric() || (unicode && !c.is_ascii());
    if !alnum(first) {
        return false;
    }
    if chars.len() == 1 {
        return true;
    }
    if !alnum(chars[chars.len() - 1]) {
        return false;
    }
    chars
        .iter()
        .all(|&c| alnum(c) || c == '-' || extra.contains(&c))
}

/// `[a-z](?:[a-z0-9-]*[a-z0-9])?`.
fn domain_tld(label: &str, unicode: bool) -> bool {
    let chars: Vec<char> = label.chars().collect();
    let Some(&first) = chars.first() else {
        return false;
    };
    let alpha = |c: char| c.is_ascii_alphabetic() || (unicode && !c.is_ascii());
    let alnum = |c: char| c.is_ascii_alphanumeric() || (unicode && !c.is_ascii());
    if !alpha(first) {
        return false;
    }
    if chars.len() == 1 {
        return true;
    }
    if !alnum(chars[chars.len() - 1]) {
        return false;
    }
    chars.iter().all(|&c| alnum(c) || c == '-')
}
