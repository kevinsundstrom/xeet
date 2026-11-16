//! TLD tables: lookup and the boundary rule.

use crate::chars::is_tld_boundary;
use crate::gentables::tlds::{MAX_TLD_LEN, TLDS};
use crate::text::Text;

/// The alternation order of a TLD, or `None` when the label is not a TLD.
///
/// Matching is ASCII case-insensitive, as the upstream pattern is compiled with
/// the `i` flag.
pub(crate) fn order_of(label: &str) -> Option<u16> {
    let needle = label.as_bytes();
    let mut lo = 0usize;
    let mut hi = TLDS.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        let (name, order) = TLDS[mid];
        match cmp_ci(needle, name.as_bytes()) {
            std::cmp::Ordering::Equal => return Some(order),
            std::cmp::Ordering::Less => hi = mid,
            std::cmp::Ordering::Greater => lo = mid + 1,
        }
    }
    None
}

fn cmp_ci(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
    let n = a.len().min(b.len());
    for i in 0..n {
        let x = a[i].to_ascii_lowercase();
        let y = b[i];
        if x != y {
            return x.cmp(&y);
        }
    }
    a.len().cmp(&b.len())
}

/// Match a TLD at `pos`, returning its end.
///
/// Mirrors `(?:validGTLD|validCCTLD|validPunycode)`: the gTLD and ccTLD
/// alternatives end at a boundary (`(?=[^0-9a-zA-Z@+-]|$)`), and when several
/// of them match the same label the earliest in the upstream alternation wins.
/// The punycode alternative has no boundary requirement and is tried last.
pub(crate) fn match_tld(t: &Text, pos: usize, limit: usize) -> Option<usize> {
    let max = MAX_TLD_LEN.min(limit.saturating_sub(pos));
    let mut best: Option<(u16, usize)> = None;
    for len in 1..=max {
        let end = pos + len;
        if end < limit && t.at(end).is_some_and(|c| !is_tld_boundary(c)) {
            // No longer TLD can end here either, but a shorter one already
            // recorded still stands, so keep looking for a valid end.
            continue;
        }
        if let Some(order) = order_of(t.slice(pos, end)) {
            if best.is_none_or(|(o, _)| order < o) {
                best = Some((order, end));
            }
        }
    }
    if let Some((_, end)) = best {
        return Some(end);
    }
    // `xn--[\-0-9a-z]+`: at least one character after the prefix, no boundary.
    if t.starts_with_ci(pos, "xn--") {
        let mut j = pos + 4;
        while j < limit && (t.ch(j).is_ascii_alphanumeric() || t.ch(j) == '-') {
            j += 1;
        }
        if j > pos + 4 {
            return Some(j);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_tlds() {
        assert!(order_of("com").is_some());
        assert!(order_of("COM").is_some());
        assert!(order_of("co").is_some());
        assert!(order_of("\u{d55c}\u{ad6d}").is_some());
        assert!(order_of("not-a-tld").is_none());
        assert!(order_of("").is_none());
    }
}
