//! The URL display form: how X shortens a link for display.
//!
//! # The rule, and the evidence for it
//!
//! X does not show the URL you typed. For every link in a post the server
//! includes three forms in the payload: `url` (a `t.co` redirect),
//! `expanded_url` (where it goes) and `display_url` (what the UI prints). The
//! display form is derived from `expanded_url` like this:
//!
//! 1. Strip a leading `http://` or `https://`.
//! 2. Strip a leading `www.`.
//! 3. Split at the first `/`, `?` or `#`: that is the host, and everything after
//!    it is the tail.
//! 4. If the tail is longer than 15 characters, keep the host, the first 15
//!    characters of the tail, and an ellipsis (`…`). Otherwise keep it all.
//!
//! A trailing slash survives (`hackertube.org/`), the host keeps its case
//! (`GamesIndustry.biz`), and only the front of the tail is ever cut, never the
//! middle: X never hides the host, because that is the part people use to judge
//! a link.
//!
//! ## Where that came from
//!
//! The captures in `assets/vendor/corpus/` embed the tweets' payloads, and every
//! `display_url`/`expanded_url` pair in them was harvested (122 distinct pairs
//! across 35 accounts, fetched logged out on 2026-11-10). Every truncated pair
//! keeps exactly 15 characters after the host plus `…`; no pair with a tail of
//! 14 characters or fewer is truncated. Examples:
//!
//! | `expanded_url` | `display_url` | tail kept |
//! |---|---|---|
//! | `https://x.com/i/broadcasts/2KoXmRNZMNJONX` | `x.com/i/broadcasts/2…` | 15 |
//! | `https://www.nasa.gov/general/max-power-nasas-…` | `nasa.gov/general/max-po…` | 15 |
//! | `https://docs.github.com/copilot/concepts/models/…` | `docs.github.com/copilot/concep…` | 15 |
//! | `https://simonwillison.net/2026/Nov/9/mysterious-beeps/` | `simonwillison.net/2026/Nov/9/mys…` | 15 |
//! | `https://vercel.com/for/platforms` | `vercel.com/for/platforms` | 14, whole |
//! | `https://karpathy.ai/tristan-tube/` | `karpathy.ai/tristan-tube/` | 14, whole |
//! | `https://hackertube.org/` | `hackertube.org/` | 1, whole |
//!
//! ## What is not verified
//!
//! - A tail of exactly 15 characters: no capture has one. The rule above leaves
//!   it alone, which is the only reading where the cut is a cut.
//! - Hosts longer than 17 characters. `twitter-text`'s own renderer documents a
//!   leading ellipsis for those (`…nname.com/foo` for
//!   `http://longdomainname.com/foo`), which would mean X cuts the *front* of the
//!   host too. No current payload shows it: in 122 pairs the longest host is 17
//!   characters and no display form starts with an ellipsis. This crate keeps the
//!   host whole and truncates only the tail; if a long-host capture ever shows a
//!   leading ellipsis, that is the branch to add.
//! - Non-ASCII hosts: no capture has one, so punycode hosts are left as written.

/// How many characters of the tail X keeps before the ellipsis.
const TAIL_CHARS: usize = 15;

/// The display form of a URL, as X shows it.
///
/// Idempotent, and safe on anything: input that is not a URL comes back
/// unchanged.
pub fn display_url(url: &str) -> String {
    let mut rest = url;
    for scheme in ["https://", "http://"] {
        if starts_with_ci(rest, scheme) {
            rest = &rest[scheme.len()..];
            break;
        }
    }
    if starts_with_ci(rest, "www.") {
        rest = &rest[4..];
    }
    if rest.is_empty() {
        return rest.to_string();
    }
    let host_len = rest
        .find(['/', '?', '#'])
        .map(|i| rest[..i].chars().count())
        .unwrap_or_else(|| rest.chars().count());
    let chars: Vec<char> = rest.chars().collect();
    if chars.len() <= host_len + TAIL_CHARS {
        return rest.to_string();
    }
    let mut out: String = chars[..host_len + TAIL_CHARS].iter().collect();
    out.push('…');
    out
}

/// `s` starts with `prefix`, ignoring ASCII case, on a character boundary.
fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observed_pairs() {
        // Every row is a real `(expanded_url, display_url)` pair from the
        // corpus captures; see the module documentation.
        let cases = [
            ("https://x.com/i/broadcasts/2KoXmRNZMNJONX", "x.com/i/broadcasts/2…"),
            (
                "https://www.nasa.gov/general/max-power-nasas-inaugural-aerospace-expo-ignites-americas-future/",
                "nasa.gov/general/max-po…",
            ),
            (
                "https://docs.github.com/copilot/concepts/models/copilot-fusion?utm_source=universe-2026-x&utm_medium=social&utm_campaign=universe-2026",
                "docs.github.com/copilot/concep…",
            ),
            (
                "https://github.blog/ai-and-ml/github-copilot/how-to-continue-a-github-copilot-app-session-in-vs-code/?utm_source=x-promoting-app-session-vs-code-article&utm_medium=social&utm_campaign=copilot-app-session-vscode-nov-2026",
                "github.blog/ai-and-ml/gith…",
            ),
            (
                "https://simonwillison.net/2026/Nov/9/mysterious-beeps/",
                "simonwillison.net/2026/Nov/9/mys…",
            ),
            (
                "https://www.theverge.com/tech/1030084/apple-intelligence-usage-packs-ai-features-creator-studio-logic-pro",
                "theverge.com/tech/1030084/a…",
            ),
            ("https://theatlantic.com/culture/2026/11/saturday-night-live-james-talarico-cold-open/689344/?taid=6af29a47d0eea10001e9a8f5", "theatlantic.com/culture/2026/1…"),
            ("https://iom.int/news/misery-thousands-gaza-tents-flood-iom-warns-further-hardship-winter-deepens", "iom.int/news/misery-th…"),
            ("https://un.org/en/observances/world-science-day", "un.org/en/observances…"),
            ("https://x.com/i/article/2077522774332153856", "x.com/i/article/2077…"),
            // Not truncated.
            ("http://github.com", "github.com"),
            ("https://developer.x.com", "developer.x.com"),
            ("https://nyti.ms/4kIWji9", "nyti.ms/4kIWji9"),
            ("https://go.nasa.gov/3UBpcCs", "go.nasa.gov/3UBpcCs"),
            ("https://hackertube.org/", "hackertube.org/"),
            ("https://karpathy.ai/tristan-tube/", "karpathy.ai/tristan-tube/"),
            ("https://vercel.com/for/platforms", "vercel.com/for/platforms"),
            ("https://luma.com/llamalounge28", "luma.com/llamalounge28"),
            ("https://GamesIndustry.biz", "GamesIndustry.biz"),
        ];
        for (expanded, display) in cases {
            assert_eq!(display_url(expanded), display, "{expanded}");
        }
    }

    #[test]
    fn scheme_less_and_odd_input() {
        assert_eq!(
            display_url("example.com/a/b/c/d/e/f/g/h/i/j/k"),
            "example.com/a/b/c/d/e/f/g/…"
        );
        assert_eq!(display_url(""), "");
        assert_eq!(display_url("not a url"), "not a url");
        assert_eq!(display_url("https://example.com"), "example.com");
        assert_eq!(display_url("https://example.com/"), "example.com/");
        assert_eq!(display_url("https://example.com?q=1"), "example.com?q=1");
    }

    #[test]
    fn tail_boundary() {
        // 14 tail characters stay whole; 16 are cut to 15.
        assert_eq!(
            display_url("https://example.com/abcdefghijklmn"),
            "example.com/abcdefghijklmn"
        );
        assert_eq!(
            display_url("https://example.com/abcdefghijklmnop"),
            "example.com/abcdefghijklmn…"
        );
    }
}
