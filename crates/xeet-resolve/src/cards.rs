//! Card tags, read the way X's crawler reads them.
//!
//! The rules and their evidence are in `docs/LINK-CARDS.md` (X's archived
//! markup reference plus live observations from 2026-11-10); this module is the
//! port of `api/_lib/links.mjs`'s parser. In one paragraph: `twitter:card` names
//! the type (`summary`, `summary_large_image`, `app`, `player`) and the last tag
//! wins; `twitter:title`/`description`/`image`/`image:alt` fall back to their
//! `og:` counterparts; with no `twitter:card` but `og:type`+`og:title`+
//! `og:description`, a `summary` card may be rendered; a link that lands on
//! `x.com` never cards; `player` needs `twitter:player`, `app` needs
//! `twitter:app:name:*`; titles are capped at 70 characters, descriptions at
//! 200, alt text at 420.

use std::collections::BTreeMap;

/// X's documented maxima, and the image minimums from the same page.
pub const TITLE_CHARS: usize = 70;
pub const DESCRIPTION_CHARS: usize = 200;
pub const ALT_CHARS: usize = 420;
pub const IMAGE_MIN_SIZE: u32 = 144;

/// What the page (or a payload) said, plus what the library made of it.
#[derive(Clone, Debug, Default)]
pub struct Card {
    /// `None` means: no card. Otherwise one of the four X card types.
    pub card: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    /// The final host, verbatim (`www.` included), as X's payloads keep it.
    pub domain: Option<String>,
    /// The card image, absolute. Dimensions are filled in after it is fetched.
    pub image_url: Option<String>,
    pub image_width: u32,
    pub image_height: u32,
    /// X's display form of the final URL.
    pub display: Option<String>,
    /// The tags that produced the decision, for the API's `tags` map.
    pub tags: BTreeMap<String, String>,
    /// Why the decision went the way it did.
    pub notes: Vec<String>,
}

impl Card {
    /// The card image as a URL, when the card draws one.
    pub fn has_image(&self) -> bool {
        self.image_url.is_some()
    }
}

/// Every `<meta>` tag in the document: `name|property|itemprop → content`, last
/// occurrence winning, values entity-decoded.
pub fn collect_meta(html: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for tag in meta_tags(html) {
        let attrs = parse_attributes(&tag);
        let key = attrs
            .get("name")
            .or_else(|| attrs.get("property"))
            .or_else(|| attrs.get("itemprop"))
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        let Some(content) = attrs.get("content") else {
            continue;
        };
        if key.is_empty() {
            continue;
        }
        map.insert(key, decode_entities(content));
    }
    map
}

/// The `<meta …>` tags, as raw attribute strings.
fn meta_tags(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = html.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut index = 0;
    while let Some(found) = lower[index..].find("<meta") {
        let start = index + found;
        // `<metadata>` is not a `<meta>` tag.
        let after = start + 5;
        let is_tag = bytes
            .get(after)
            .map(|b| b.is_ascii_whitespace() || *b == b'>' || *b == b'/')
            .unwrap_or(false);
        if !is_tag {
            index = after;
            continue;
        }
        match lower[after..].find('>') {
            Some(end) => {
                out.push(html[after..after + end].to_string());
                index = after + end + 1;
            }
            None => break,
        }
    }
    out
}

/// Parses `key="value"`, `key='value'` and `key=value` attributes.
pub fn parse_attributes(text: &str) -> BTreeMap<String, String> {
    let mut attrs = BTreeMap::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        while index < bytes.len() && (bytes[index].is_ascii_whitespace() || bytes[index] == b'/') {
            index += 1;
        }
        let name_start = index;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'-' | b'_' | b':'))
        {
            index += 1;
        }
        if name_start == index {
            index += 1;
            continue;
        }
        let name = text[name_start..index].to_ascii_lowercase();
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] != b'=' {
            attrs.insert(name, String::new());
            continue;
        }
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        let value = if bytes[index] == b'"' || bytes[index] == b'\'' {
            let quote = bytes[index];
            index += 1;
            let start = index;
            while index < bytes.len() && bytes[index] != quote {
                index += 1;
            }
            let value = text[start..index.min(text.len())].to_string();
            index += 1;
            value
        } else {
            let start = index;
            while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'>'
            {
                index += 1;
            }
            text[start..index].to_string()
        };
        attrs.insert(name, value);
    }
    attrs
}

/// `&amp;` and friends, decoded: an image URL in markup is not a URL with `&amp;`
/// in it.
pub fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find('&') {
        out.push_str(&rest[..index]);
        let tail = &rest[index..];
        let Some(semicolon) = tail.find(';').filter(|end| *end <= 10) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..semicolon];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some('\u{a0}'),
            _ => {
                if let Some(hex) = entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                {
                    u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                } else if let Some(dec) = entity.strip_prefix('#') {
                    dec.parse::<u32>().ok().and_then(char::from_u32)
                } else {
                    None
                }
            }
        };
        match decoded {
            Some(ch) => {
                out.push(ch);
                rest = &tail[semicolon + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Reads the tags and decides the card, exactly as `docs/LINK-CARDS.md` records.
///
/// `final_url` is where the chain ended: the domain X shows and the base for a
/// relative image URL both come from it.
pub fn decide(html: &str, final_url: &crate::urlsafety::Url) -> Card {
    let tags = collect_meta(html);
    let get = |key: &str| tags.get(key).map(String::as_str).filter(|v| !v.is_empty());
    let pick = |keys: &[&str]| keys.iter().find_map(|key| get(key));

    let raw_card = pick(&["twitter:card"]).map(|value| value.trim().to_ascii_lowercase());
    let mut notes = Vec::new();
    let mut card = match raw_card.as_deref() {
        Some(value @ ("summary" | "summary_large_image" | "app" | "player")) => {
            Some(value.to_string())
        }
        Some(other) => {
            notes.push(format!(
                "twitter:card {other:?} is not a card type; X shows nothing for it"
            ));
            None
        }
        None => {
            if pick(&["og:type"]).is_some()
                && pick(&["og:title"]).is_some()
                && pick(&["og:description"]).is_some()
            {
                notes.push(
                    "no twitter:card; X may render a summary card from og:type/og:title/og:description"
                        .to_string(),
                );
                Some("summary".to_string())
            } else {
                None
            }
        }
    };

    if card.is_some() && is_x_host(&final_url.host) {
        notes.push("the link resolves to an X post; X shows no card for it".to_string());
        card = None;
    }
    if card.as_deref() == Some("player") && pick(&["twitter:player"]).is_none() {
        notes.push("a player card with no twitter:player; X shows nothing for it".to_string());
        card = None;
    }
    if card.as_deref() == Some("app")
        && !tags.keys().any(|key| key.starts_with("twitter:app:name:"))
    {
        notes.push("an app card with no twitter:app:name:*; X shows nothing for it".to_string());
        card = None;
    }

    let title = clamp(
        pick(&["twitter:title", "og:title"]),
        TITLE_CHARS,
        &mut notes,
        "title",
    );
    let description = clamp(
        pick(&["twitter:description", "og:description"]),
        DESCRIPTION_CHARS,
        &mut notes,
        "description",
    );
    let _alt = clamp(
        pick(&["twitter:image:alt", "og:image:alt"]),
        ALT_CHARS,
        &mut notes,
        "image alt",
    );
    let mut image_url = None;
    if card.is_some() {
        if let Some(raw) = pick(&[
            "twitter:image",
            "twitter:image:src",
            "og:image",
            "og:image:url",
        ]) {
            if let Some(url) = final_url.join(raw) {
                image_url = Some(url.href());
            } else {
                notes.push("the card image is not an absolute http(s) URL; dropped".to_string());
            }
        }
    }

    Card {
        card,
        title,
        description,
        domain: Some(final_url.host.clone()),
        image_url,
        image_width: 0,
        image_height: 0,
        display: Some(crate::display_url(&final_url.href())),
        tags,
        notes,
    }
}

/// `<meta http-equiv="refresh" content="0; url=…">`, which `t.co` serves a
/// browser user agent instead of a redirect.
pub fn meta_refresh_target(
    html: &str,
    base: &crate::urlsafety::Url,
) -> Option<crate::urlsafety::Url> {
    let head: String = html.chars().take(16 * 1024).collect();
    for tag in meta_tags(&head) {
        let attrs = parse_attributes(&tag);
        let is_refresh = attrs
            .get("http-equiv")
            .map(|value| value.eq_ignore_ascii_case("refresh"))
            .unwrap_or(false);
        if !is_refresh {
            continue;
        }
        let content = attrs.get("content")?;
        let lower = content.to_ascii_lowercase();
        let index = lower.find("url")?;
        let rest = content[index + 3..].trim_start();
        let rest = rest.strip_prefix('=').unwrap_or(rest).trim_start();
        let rest = rest.trim_start_matches(['"', '\'']);
        let end = rest.find(['"', '\'', ';']).unwrap_or(rest.len());
        return base.join(rest[..end].trim());
    }
    None
}

/// X's own hosts: a link that lands on one has no card.
pub fn is_x_host(host: &str) -> bool {
    matches!(
        host,
        "x.com"
            | "www.x.com"
            | "mobile.x.com"
            | "twitter.com"
            | "www.twitter.com"
            | "mobile.twitter.com"
    )
}

fn clamp(value: Option<&str>, max: usize, notes: &mut Vec<String>, what: &str) -> Option<String> {
    let text = value
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|value| !value.is_empty())?;
    if text.chars().count() <= max {
        return Some(text);
    }
    notes.push(format!(
        "the card {what} is {} characters; X's documented maximum is {max}",
        text.chars().count()
    ));
    Some(text.chars().take(max).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::urlsafety::Url;

    fn decide_at(html: &str, url: &str) -> Card {
        decide(html, &Url::parse(url).unwrap())
    }

    #[test]
    fn twitter_tags_win_and_og_fills_the_rest() {
        let card = decide_at(
            r#"<meta property="og:title" content="OG title">
               <meta name="twitter:title" content="Twitter title">
               <meta property="og:description" content="OG description">
               <meta name="twitter:image" content="/img.png">
               <meta name="twitter:card" content="summary_large_image">"#,
            "https://example.com/a/b",
        );
        assert_eq!(card.card.as_deref(), Some("summary_large_image"));
        assert_eq!(card.title.as_deref(), Some("Twitter title"));
        assert_eq!(card.description.as_deref(), Some("OG description"));
        assert_eq!(
            card.image_url.as_deref(),
            Some("https://example.com/img.png")
        );
        assert_eq!(card.domain.as_deref(), Some("example.com"));
        assert_eq!(card.display.as_deref(), Some("example.com/a/b"));
    }

    #[test]
    fn og_only_is_a_summary_card() {
        let card = decide_at(
            r#"<meta property="og:type" content="website"><meta property="og:title" content="T"><meta property="og:description" content="D">"#,
            "https://e.com/x",
        );
        assert_eq!(card.card.as_deref(), Some("summary"));
        assert!(card
            .notes
            .iter()
            .any(|note| note.contains("no twitter:card")));
        let without_type = decide_at(
            r#"<meta property="og:title" content="T"><meta property="og:description" content="D">"#,
            "https://e.com/x",
        );
        assert!(without_type.card.is_none());
    }

    #[test]
    fn unknown_and_incomplete_cards_are_no_card() {
        assert!(decide_at(
            r#"<meta name="twitter:card" content="gallery">"#,
            "https://e.com/x"
        )
        .card
        .is_none());
        assert!(decide_at(
            r#"<meta name="twitter:card" content="player"><meta name="twitter:image" content="https://e.com/i.png">"#,
            "https://e.com/x"
        )
        .card
        .is_none());
    }

    #[test]
    fn x_links_never_card() {
        let card = decide_at(
            r#"<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="https://e.com/i.png">"#,
            "https://x.com/someone/status/1",
        );
        assert!(card.card.is_none());
        assert!(card.notes.iter().any(|note| note.contains("X post")));
    }

    #[test]
    fn decodes_entities_and_caps_lengths() {
        let card = decide_at(
            r#"<meta name="twitter:card" content="summary"><meta name="twitter:title" content="A &amp; B &quot;q&quot;">"#,
            "https://e.com/x",
        );
        assert_eq!(card.title.as_deref(), Some("A & B \"q\""));
        let long = format!(
            r#"<meta name="twitter:card" content="summary"><meta name="twitter:title" content="{}">"#,
            "x".repeat(90)
        );
        let card = decide_at(&long, "https://e.com/x");
        assert_eq!(card.title.unwrap().chars().count(), TITLE_CHARS);
        assert!(card.notes.iter().any(|note| note.contains("maximum is 70")));
    }

    #[test]
    fn meta_refresh_is_found() {
        let base = Url::parse("https://t.co/abc").unwrap();
        let target = meta_refresh_target(
            r#"<noscript><META http-equiv="refresh" content="0;URL=https://vercel.com/changelog/x"></noscript>"#,
            &base,
        )
        .unwrap();
        assert_eq!(target.href(), "https://vercel.com/changelog/x");
        assert!(meta_refresh_target("<html><head></head></html>", &base).is_none());
    }

    #[test]
    fn attributes_parse_in_any_order() {
        let attrs = parse_attributes(r#" content="x" property='og:title' data-x=y"#);
        assert_eq!(attrs.get("content").map(String::as_str), Some("x"));
        assert_eq!(attrs.get("property").map(String::as_str), Some("og:title"));
        assert_eq!(attrs.get("data-x").map(String::as_str), Some("y"));
    }
}
