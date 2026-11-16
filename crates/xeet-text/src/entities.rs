//! Entities and the `parse` entry point.

use crate::extract;
use crate::length::{self, Weighted};
use crate::text::Text;
use crate::url;

/// What kind of entity a span is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntityKind {
    /// A URL. `display` is the form X shows (scheme and `www.` stripped, long
    /// paths cut with an ellipsis, see [`crate::display_url`]); `expanded` is
    /// the URL with a scheme, as written in the text (this crate never resolves
    /// redirects, so for a `t.co` link `expanded` is still the `t.co` link).
    Url { display: String, expanded: String },
    /// A `@mention` or a `@mention/list`. `text` covers the `@` and the slug.
    Mention,
    /// A `#hashtag`. `text` covers the `#`.
    Hashtag,
    /// A `$cashtag`. `text` covers the `$`.
    Cashtag,
}

/// One entity in a text.
///
/// `start` and `end` are offsets in UTF-16 code units, the unit X's payloads
/// use, and `text` is the exact source span. Use [`crate::utf16_to_byte`] to
/// slice the original string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entity {
    pub kind: EntityKind,
    pub start: usize,
    pub end: usize,
    pub text: String,
}

impl Entity {
    /// For a mention, the screen name without the `@` and without `/<list>`.
    pub fn screen_name(&self) -> Option<&str> {
        match self.kind {
            EntityKind::Mention => {
                let name = self.text.trim_start_matches(['@', '\u{FF20}']);
                Some(match name.find('/') {
                    Some(i) => &name[..i],
                    None => name,
                })
            }
            _ => None,
        }
    }

    /// For a mention of a list, the `/<slug>` part, including the slash.
    pub fn list_slug(&self) -> Option<&str> {
        match self.kind {
            EntityKind::Mention => {
                let name = self.text.trim_start_matches(['@', '\u{FF20}']);
                let offset = self.text.len() - name.len();
                Some(&self.text[offset + name.find('/')?..])
            }
            _ => None,
        }
    }

    /// For a hashtag, the tag without the `#`.
    pub fn hashtag(&self) -> Option<&str> {
        match self.kind {
            EntityKind::Hashtag => Some(self.text.trim_start_matches(['#', '\u{FF03}'])),
            _ => None,
        }
    }

    /// For a cashtag, the symbol without the `$`.
    pub fn cashtag(&self) -> Option<&str> {
        match self.kind {
            EntityKind::Cashtag => Some(self.text.trim_start_matches('$')),
            _ => None,
        }
    }
}

/// The result of [`parse`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    /// Entities sorted by start offset, with overlaps removed the way
    /// twitter-text removes them (a URL swallows a hashtag or mention inside
    /// it).
    pub entities: Vec<Entity>,
    /// Weighted length under configuration v3: 280 is the limit, a URL counts
    /// 23, an emoji sequence 2, CJK and other wide characters 2.
    pub weighted_length: u32,
    /// Whether the text is a postable post: non-empty, within 280 weighted,
    /// and free of invalid characters.
    pub valid: bool,
    /// `weighted_length / 280 * 1000`, as X's composer reports it.
    pub permillage: u32,
    /// Exclusive end of the displayed text, in UTF-16 code units of the input.
    /// twitter-text reports the same number as an inclusive `display_text_range`
    /// end, one less; empty input is 0 either way.
    pub display_end: usize,
    /// Exclusive end of the valid prefix, in UTF-16 code units of the input.
    pub valid_end: usize,
}

/// Parse a text: entities, weighted length and validity, as X's client does.
pub fn parse(text: &str) -> Parsed {
    parse_with(text, length::Config::X)
}

/// Parse a text under a specific weighted-length configuration.
///
/// [`parse`] is [`Config::X`], X's own client. `Config::V3` and `Config::V2` are
/// twitter-text's configurations, which the conformance suite pins; they differ
/// from X on how emoji are segmented.
pub fn parse_with(text: &str, config: length::Config) -> Parsed {
    let t = Text::new(text);
    let normalized = length::normalize(text);
    // Reuse the character tables when the text needed no normalization, which is
    // the common case.
    let urls = url::extract(&t, true);
    let measured = match normalized {
        std::borrow::Cow::Borrowed(_) => length::measure(&t, crate::utf16_len(text), config, &urls),
        std::borrow::Cow::Owned(normalized) => {
            let normalized_text = Text::new(&normalized);
            let normalized_urls = url::extract(&normalized_text, true);
            length::measure(
                &normalized_text,
                crate::utf16_len(text),
                config,
                &normalized_urls,
            )
        }
    };
    let Weighted {
        weighted_length,
        valid,
        permillage,
        display_end,
        valid_end,
    } = measured;
    Parsed {
        entities: entities_from(&t, &urls),
        weighted_length,
        valid,
        permillage,
        display_end,
        valid_end,
    }
}

/// Extract every entity, without measuring the text.
pub fn entities(text: &str) -> Vec<Entity> {
    let t = Text::new(text);
    let urls = url::extract(&t, true);
    entities_from(&t, &urls)
}

/// [`entities`] over an already-built character table and URL scan.
fn entities_from(t: &Text, urls: &[url::RawUrl]) -> Vec<Entity> {
    enum Raw {
        Url(usize, usize, String),
        Mention(usize, usize),
        Hashtag(usize, usize),
        Cashtag(usize, usize),
    }

    let mut raw = Vec::new();
    // The order matters only for exact ties, which the grammar cannot produce,
    // but it matches twitter-text's own order.
    for u in urls {
        raw.push(Raw::Url(u.start, u.end, u.url.clone()));
    }
    for h in extract::extract_hashtags(t) {
        raw.push(Raw::Hashtag(h.start, h.end));
    }
    for m in extract::extract_mentions(t) {
        raw.push(Raw::Mention(m.start, m.end));
    }
    for c in extract::extract_cashtags(t) {
        raw.push(Raw::Cashtag(c.start, c.end));
    }

    // `removeOverlappingEntities`: stable sort by start, then drop anything that
    // starts before the previous kept entity ends.
    let mut spans: Vec<(usize, usize, usize)> = raw
        .iter()
        .enumerate()
        .map(|(idx, r)| {
            let (start, end) = match r {
                Raw::Url(a, b, _)
                | Raw::Mention(a, b)
                | Raw::Hashtag(a, b)
                | Raw::Cashtag(a, b) => (*a, *b),
            };
            (start, end, idx)
        })
        .collect();
    spans.sort_by_key(|&(start, _, idx)| (start, idx));

    let mut out = Vec::with_capacity(spans.len());
    let mut prev_end: Option<usize> = None;
    for (start, end, idx) in spans {
        if let Some(pe) = prev_end {
            if pe > start {
                continue;
            }
        }
        prev_end = Some(end);
        let text = t.slice(start, end).to_string();
        let kind = match &raw[idx] {
            Raw::Url(_, _, url) => EntityKind::Url {
                display: crate::display_url(url),
                expanded: with_scheme(url),
            },
            Raw::Mention(..) => EntityKind::Mention,
            Raw::Hashtag(..) => EntityKind::Hashtag,
            Raw::Cashtag(..) => EntityKind::Cashtag,
        };
        out.push(Entity {
            kind,
            start: t.utf16(start),
            end: t.utf16(end),
            text,
        });
    }
    out
}

/// Add `http://` to a URL that has no scheme, as twitter-text does when it
/// builds a link target.
fn with_scheme(url: &str) -> String {
    let is_absolute = url
        .get(..8)
        .is_some_and(|h| h.eq_ignore_ascii_case("https://"))
        || url
            .get(..7)
            .is_some_and(|h| h.eq_ignore_ascii_case("http://"));
    if is_absolute {
        url.to_string()
    } else {
        format!("http://{url}")
    }
}

/// Extract the usernames a reply is addressed to (twitter-text's
/// `extractReplyScreenname`), or `None` when the text does not start with one.
pub fn reply_screenname(text: &str) -> Option<String> {
    let t = Text::new(text);
    let mut i = 0;
    while i < t.len() && crate::chars::is_space(t.ch(i)) {
        i += 1;
    }
    if !crate::chars::is_at_sign(t.at(i)?) {
        return None;
    }
    let start = i + 1;
    let mut j = start;
    while j < t.len() && j - start < 20 && (t.ch(j).is_ascii_alphanumeric() || t.ch(j) == '_') {
        j += 1;
    }
    if j == start {
        return None;
    }
    // `INVALID_MENTION_MATCH_END` also applies to replies.
    if let Some(c) = t.at(j) {
        if crate::chars::is_end_mention_char(c) || t.starts_with_ci(j, "://") {
            return None;
        }
    }
    Some(t.slice(start, j).to_string())
}

/// Extract URLs (twitter-text's `extractURLs`), as written in the text.
pub fn urls(text: &str) -> Vec<String> {
    let t = Text::new(text);
    url::extract(&t, true).into_iter().map(|u| u.url).collect()
}

/// Extract hashtags without the `#`, in order.
///
/// A hashtag inside a URL is not a hashtag, so this drops any tag that overlaps
/// a URL, the way `extractHashtagsWithIndices` does when `checkUrlOverlap` is on.
pub fn hashtags(text: &str) -> Vec<String> {
    let t = Text::new(text);
    let mut spans: Vec<(usize, usize, bool)> = Vec::new();
    for h in extract::extract_hashtags(&t) {
        spans.push((h.start, h.end, true));
    }
    for u in url::extract(&t, true) {
        spans.push((u.start, u.end, false));
    }
    spans.sort_by_key(|&(start, _, is_tag)| (start, !is_tag));
    let mut kept: Vec<(usize, usize)> = Vec::new();
    let mut prev_end: Option<usize> = None;
    for (start, end, is_tag) in spans {
        if let Some(pe) = prev_end {
            if pe > start {
                continue;
            }
        }
        prev_end = Some(end);
        if is_tag {
            kept.push((start, end));
        }
    }
    kept.into_iter()
        .map(|(s, e)| t.slice(s + 1, e).to_string())
        .collect()
}

/// Extract `@username` mentions without the `@`, in order.
///
/// A `@username/list` reference is a list, not a mention, and is left out:
/// twitter-text's `extractMentions` does the same.
pub fn mentions(text: &str) -> Vec<String> {
    let t = Text::new(text);
    extract::extract_mentions(&t)
        .into_iter()
        .filter(|m| !t.slice(m.start, m.end).contains('/'))
        .map(|m| t.slice(m.start + 1, m.end).to_string())
        .collect()
}

/// Extract cashtags without the `$`, in order.
pub fn cashtags(text: &str) -> Vec<String> {
    let t = Text::new(text);
    extract::extract_cashtags(&t)
        .into_iter()
        .map(|c| t.slice(c.start + 1, c.end).to_string())
        .collect()
}
