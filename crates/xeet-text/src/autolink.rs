//! Autolink: twitter-text's `autoLink` and `autoLinkWithJSON`.
//!
//! The markup is the Java implementation's (`Autolink`, constructed the way its
//! conformance test constructs it: `new Autolink(false)`), which is what
//! `autolink.yml` expects:
//!
//! - `<` and `>` in the input are escaped before anything is extracted.
//! - No `rel="nofollow"` and no `data-screen-name`: X's own markup adds those at
//!   a different layer.
//! - The `@` of a mention stays outside the anchor; `#` and `$` go inside.
//! - Link text and attribute values are HTML-escaped; the rest of the text is
//!   not (it was bracket-escaped already).
//!
//! This exists because it is the most complete test of entity boundaries in the
//! conformance suite, and because the API-payload mode documents the display
//! form markup (`js-display-url` and the invisible spans that keep the full URL
//! copyable) that X itself renders.

use crate::entities::{self, Entity, EntityKind};

const HASHTAG_CLASS: &str = "tweet-url hashtag";
const CASHTAG_CLASS: &str = "tweet-url cashtag";
const LIST_CLASS: &str = "tweet-url list-slug";
const USERNAME_CLASS: &str = "tweet-url username";
const HASHTAG_URL_BASE: &str = "https://twitter.com/search?q=%23";
const CASHTAG_URL_BASE: &str = "https://twitter.com/search?q=%24";
const USERNAME_URL_BASE: &str = "https://twitter.com/";
const LIST_URL_BASE: &str = "https://twitter.com/";
const INVISIBLE_ATTRS: &str = "style='position:absolute;left:-9999px;'";

/// An entity as X's API payload describes it, for [`autolink_with_api_entities`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApiEntities {
    pub urls: Vec<ApiUrl>,
    pub hashtags: Vec<ApiTag>,
    pub user_mentions: Vec<ApiMention>,
    pub symbols: Vec<ApiTag>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiUrl {
    pub url: String,
    pub expanded_url: String,
    pub display_url: String,
    /// UTF-16 offsets into the text.
    pub indices: (usize, usize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiTag {
    pub text: String,
    pub indices: (usize, usize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiMention {
    pub screen_name: String,
    pub indices: (usize, usize),
}

/// What to render for a URL entity.
enum UrlRender {
    /// A URL found in the text: show it as written.
    Plain,
    /// A URL from an API payload: show `display`, keep `expanded` in the markup
    /// and in a `title`.
    Api { display: String, expanded: String },
}

/// `autoLink(text)`: link every entity twitter-text finds in the text.
pub fn autolink(text: &str) -> String {
    let escaped = escape_brackets(text);
    let found: Vec<Entity> = entities::entities(&escaped)
        .into_iter()
        .filter(|e| match &e.kind {
            EntityKind::Url { .. } => has_scheme(&e.text),
            _ => true,
        })
        .collect();
    render(&escaped, &found, &[])
}

/// `autoLinkUsernamesAndLists(text)`.
pub fn autolink_mentions(text: &str) -> String {
    render(
        text,
        &entities::entities(text)
            .into_iter()
            .filter(|e| matches!(e.kind, EntityKind::Mention))
            .collect::<Vec<_>>(),
        &[],
    )
}

/// `autoLinkHashtags(text)`.
pub fn autolink_hashtags(text: &str) -> String {
    render(
        text,
        &entities::entities(text)
            .into_iter()
            .filter(|e| matches!(e.kind, EntityKind::Hashtag))
            .collect::<Vec<_>>(),
        &[],
    )
}

/// `autoLinkURLs(text)`: only URLs that carry a scheme are linkable.
pub fn autolink_urls(text: &str) -> String {
    render(
        text,
        &entities::entities(text)
            .into_iter()
            .filter(|e| matches!(e.kind, EntityKind::Url { .. }) && has_scheme(&e.text))
            .collect::<Vec<_>>(),
        &[],
    )
}

/// `autoLinkCashtags(text)`.
pub fn autolink_cashtags(text: &str) -> String {
    render(
        text,
        &entities::entities(text)
            .into_iter()
            .filter(|e| matches!(e.kind, EntityKind::Cashtag))
            .collect::<Vec<_>>(),
        &[],
    )
}

/// `autoLinkWithJSON`: link the entities an API payload describes.
pub fn autolink_with_api_entities(text: &str, api: &ApiEntities) -> String {
    let escaped = escape_brackets(text);
    let mut found: Vec<Entity> = Vec::new();
    for url in &api.urls {
        found.push(Entity {
            kind: EntityKind::Url {
                display: url.display_url.clone(),
                expanded: url.expanded_url.clone(),
            },
            start: url.indices.0,
            end: url.indices.1,
            text: slice_utf16(&escaped, url.indices),
        });
    }
    for tag in &api.hashtags {
        found.push(Entity {
            kind: EntityKind::Hashtag,
            start: tag.indices.0,
            end: tag.indices.1,
            text: slice_utf16(&escaped, tag.indices),
        });
    }
    for mention in &api.user_mentions {
        found.push(Entity {
            kind: EntityKind::Mention,
            start: mention.indices.0,
            end: mention.indices.1,
            text: slice_utf16(&escaped, mention.indices),
        });
    }
    for symbol in &api.symbols {
        found.push(Entity {
            kind: EntityKind::Cashtag,
            start: symbol.indices.0,
            end: symbol.indices.1,
            text: slice_utf16(&escaped, symbol.indices),
        });
    }
    found.sort_by_key(|e| e.start);
    render(&escaped, &found, &api.urls)
}

fn slice_utf16(text: &str, indices: (usize, usize)) -> String {
    let a = crate::utf16_to_byte(text, indices.0);
    let b = crate::utf16_to_byte(text, indices.1).max(a);
    text[a..b].to_string()
}

fn has_scheme(url: &str) -> bool {
    url.get(..8)
        .is_some_and(|h| h.eq_ignore_ascii_case("https://"))
        || url
            .get(..7)
            .is_some_and(|h| h.eq_ignore_ascii_case("http://"))
}

fn render(text: &str, entities: &[Entity], api_urls: &[ApiUrl]) -> String {
    let mut out = String::new();
    let mut begin = 0usize;
    for entity in entities {
        let start = crate::utf16_to_byte(text, entity.start);
        let end = crate::utf16_to_byte(text, entity.end).max(start);
        if start > begin {
            out.push_str(&text[begin..start]);
        }
        match &entity.kind {
            EntityKind::Url { .. } => {
                let api = api_urls.iter().find(|u| u.url == entity.text);
                let render = match api {
                    Some(api) => UrlRender::Api {
                        display: api.display_url.clone(),
                        expanded: api.expanded_url.clone(),
                    },
                    None => UrlRender::Plain,
                };
                out.push_str(&link_to_url(&entity.text, render, text));
            }
            EntityKind::Hashtag => {
                let hash: String = text[start..].chars().take(1).collect();
                let tag = entity.hashtag().unwrap_or_default();
                let mut attrs = vec![
                    ("href", format!("{HASHTAG_URL_BASE}{tag}")),
                    ("title", format!("#{tag}")),
                ];
                // `rtlChars` is tested against the whole text, not the tag.
                if text.chars().any(is_rtl) {
                    attrs.push(("class", format!("{HASHTAG_CLASS} rtl")));
                } else {
                    attrs.push(("class", HASHTAG_CLASS.to_string()));
                }
                out.push_str(&link_to_text_with_symbol(&hash, tag, attrs));
            }
            EntityKind::Mention => {
                let at: String = text[start..].chars().take(1).collect();
                let name = entity.screen_name().unwrap_or_default();
                let attrs = match entity.list_slug() {
                    Some(slug) => vec![
                        ("class", LIST_CLASS.to_string()),
                        ("href", format!("{LIST_URL_BASE}{name}{slug}")),
                    ],
                    None => vec![
                        ("class", USERNAME_CLASS.to_string()),
                        ("href", format!("{USERNAME_URL_BASE}{name}")),
                    ],
                };
                let body = match entity.list_slug() {
                    Some(slug) => format!("{name}{slug}"),
                    None => name.to_string(),
                };
                out.push_str(&link_to_text_with_symbol(&at, &body, attrs));
            }
            EntityKind::Cashtag => {
                let symbol = entity.cashtag().unwrap_or_default();
                let attrs = vec![
                    ("href", format!("{CASHTAG_URL_BASE}{symbol}")),
                    ("title", format!("${symbol}")),
                    ("class", CASHTAG_CLASS.to_string()),
                ];
                out.push_str(&link_to_text_with_symbol("$", symbol, attrs));
            }
        }
        begin = end;
    }
    if begin < text.len() {
        out.push_str(&text[begin..]);
    }
    out
}

fn link_to_url(url: &str, render: UrlRender, _text: &str) -> String {
    let mut attrs = vec![("href", url.to_string())];
    let body = match render {
        UrlRender::Plain => escape(url),
        UrlRender::Api { display, expanded } => {
            attrs.push(("title", expanded.clone()));
            display_markup(&display, &expanded)
        }
    };
    link_to_text(body, attrs)
}

/// The API display form: show the shortened URL but keep the full one in the
/// markup, hidden, so copying the text yields the whole link.
fn display_markup(display: &str, expanded: &str) -> String {
    let plain = display.replace('…', "");
    let Some(index) = expanded.find(&plain) else {
        return display.to_string();
    };
    let before = &expanded[..index];
    let after = &expanded[index + plain.len()..];
    let leading = if display.starts_with('…') {
        "…"
    } else {
        ""
    };
    let trailing = if display.ends_with('…') { "…" } else { "" };
    format!(
        "<span class='tco-ellipsis'>{leading}<span {INVISIBLE_ATTRS}>&nbsp;</span></span>\
         <span {INVISIBLE_ATTRS}>{}</span>\
         <span class='js-display-url'>{}</span>\
         <span {INVISIBLE_ATTRS}>{}</span>\
         <span class='tco-ellipsis'><span {INVISIBLE_ATTRS}>&nbsp;</span>{trailing}</span>",
        escape(before),
        escape(&plain),
        escape(after),
    )
}

fn link_to_text_with_symbol(
    symbol: &str,
    text: &str,
    attrs: Vec<(&'static str, String)>,
) -> String {
    // `usernameIncludeSymbol` is off, so the `@` of a mention stays outside.
    if matches!(symbol, "@" | "\u{FF20}") {
        format!("{symbol}{}", link_to_text(escape(text), attrs))
    } else {
        let mut body = escape(symbol);
        body.push_str(&escape(text));
        link_to_text(body, attrs)
    }
}

fn link_to_text(text: String, attrs: Vec<(&'static str, String)>) -> String {
    let mut out = String::from("<a");
    for (name, value) in &attrs {
        out.push_str(&format!(" {name}=\"{}\"", escape(value)));
    }
    out.push('>');
    out.push_str(&text);
    out.push_str("</a>");
    out
}

/// `escapeBrackets`: only the two characters that could start markup.
fn escape_brackets(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '>' => out.push_str("&gt;"),
            '<' => out.push_str("&lt;"),
            c => out.push(c),
        }
    }
    out
}

/// `escapeHTML`: the five HTML-significant characters.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '>' => out.push_str("&gt;"),
            '<' => out.push_str("&lt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// `rtlChars`: Hebrew and Arabic blocks, plus presentation forms.
fn is_rtl(c: char) -> bool {
    matches!(c as u32, 0x0600..=0x06FF | 0x0750..=0x077F | 0x0590..=0x05FF | 0xFE70..=0xFEFF)
}
