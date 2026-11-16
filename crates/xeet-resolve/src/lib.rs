//! `xeet-resolve`: post text or an X post URL → a complete `model::Post`.
//!
//! The renderer is a pure function; everything a preview needs from the network
//! has to arrive as input (PLAN.md §6). This crate is that step, and it is the
//! same step for every target — the playground, the HTTP function, the CLI, the
//! browser — because the *rules* live here and only the I/O is injected.
//!
//! ```text
//!   text ──┐                     ┌─→ links: {url: LinkMeta}   (cards, display)
//!   x.com ─┼─→ resolve(…, F, L, C) ─→ media: {url: MediaAsset}  (bytes + variant)
//!   JSON ──┘                     └─→ warnings, source
//! ```
//!
//! # The interface
//!
//! ```no_run
//! # async fn demo(host: impl xeet_resolve::Fetch) {
//! use xeet_resolve::{resolve, Options};
//! let resolved = resolve(
//!     "daemons: https://t.co/jO01BMGwXr",
//!     Options::default(),
//!     &host,                       // impl Fetch
//!     None::<&NoLookup>,           // optional impl Lookup
//!     None::<&NoCache>,            // optional impl Cache
//!     None::<&NoClock>,            // optional impl Clock
//! )
//! .await;
//! # }
//! # struct NoLookup; impl xeet_resolve::Lookup for NoLookup {
//! #   async fn lookup(&self, _host: &str) -> Result<Vec<std::net::IpAddr>, xeet_resolve::LookupError> { Ok(vec![]) }
//! # }
//! # struct NoCache; impl xeet_resolve::Cache for NoCache {
//! #   async fn get(&self, _key: &str) -> Option<xeet_resolve::CacheEntry> { None }
//! #   async fn set(&self, _key: &str, _entry: xeet_resolve::CacheEntry) {}
//! # }
//! # struct NoClock; impl xeet_resolve::Clock for NoClock { fn now_ms(&self) -> u64 { 0 } }
//! ```
//!
//! Nothing here depends on a runtime: the futures are plain `core::future`
//! futures the host drives (an `await` in Node, `wasm_bindgen_futures::spawn_local`
//! in a browser, or a `futures` executor in the CLI). Nothing here opens a socket:
//! see [`Fetch`], [`Lookup`] and [`Cache`].
//!
//! # What it does, and where the rules come from
//!
//! Every rule below was derived from live evidence and lives in the docs, which
//! are the reference for this port:
//!
//! - `docs/LINK-CARDS.md` — the crawler: `Twitterbot/1.0` (which is what makes
//!   `t.co` answer 301 rather than an interstitial), ≤10 hops plus
//!   `<meta http-equiv=refresh>`, `robots.txt` for the Twitterbot group, the
//!   `twitter:*` → `og:*` fallbacks, OG-only → `summary`, an X self-link having
//!   no card, X's text maxima, image type/size limits, and the display form.
//! - `docs/MEDIA.md` — the pixels: X's `srcset` variants (`small` 680, `medium`
//!   1200, `large` 2048 device px) chosen by slot × dpr, avatar sizes
//!   (`_normal`/`_x96`/`_reasonably_small`), video/GIF posters as `Media::data`,
//!   and never the original.
//! - `docs/E2E.md` — an X post page: the payloads the server render embeds are
//!   the source of truth (no API, no session), and `longPostBody`, `appVersion`,
//!   `reposts = retweets + quotes`, reply-ness and `Pin` are server state.
//!
//! # Safety
//!
//! This runs server-side on user input (a paste), so:
//!
//! - `http`/`https` only, and **default ports only**;
//! - every hop's host is checked: an IP literal is classified here, and when a
//!   [`Lookup`] is provided every address it resolves to must be public
//!   (loopback, private, CGNAT, link-local — including `169.254.169.254` —,
//!   multicast, reserved, unique-local and the IPv4-mapped/6to4/NAT64 forms of
//!   those are refused). Without a `Lookup` — a browser has no DNS — the
//!   literal check still applies, and the host's `fetch` is responsible for the
//!   rest (see [`Lookup`]);
//! - redirects are followed by this library, never by the host, so the guard runs
//!   on every hop;
//! - 5 s per URL, 10 hops, 1 MB of HTML, 5 MB per image, content-type checked
//!   before a body is parsed;
//! - no cookies, no credentials, no request bodies.
//!
//! # Errors
//!
//! [`Error`] carries a stable `code`, a message and — for a rejected post — the
//! `fields` an editor underlines, the same shape the renderer's errors have.

#![forbid(unsafe_code)]

mod attach;
pub mod cards;
pub mod fetch;
pub mod image;
pub mod media;
pub mod post;
pub mod urlsafety;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use xeet_core::limits::Limits;
use xeet_core::model::{LinkMeta, Post};

pub use fetch::{
    Cache, CacheEntry, Clock, Fetch, FetchError, Lookup, LookupError, Method, Redirect, Request,
    Response,
};
pub use media::{avatar_url, slot_width, variant_for, variant_url, Layout, AVATAR_CSS};
pub use post::{canonical_url, status_id, status_ref, StatusRef};
pub use urlsafety::Url;

// The image slots the resolver fills, and how X draws each one. Written as a
// plan per slot so the inliner reads as data rather than as branches.
//
// The sizes are the renderer's (`crates/xeet-core/src/cards/quote.rs`): a quoted
// post's avatar is 24 px full-width or 16 px in the compact form, its thumbnail
// 96 px; X's nested quote preview — one level further in, the part the renderer
// does not draw itself — is a 16 px avatar and a single 64×64 square
// (`nested-quote-preview-SIs_tkfq`). Nothing here picks an original: the variant
// is chosen from X's own `srcset` widths.

/// Which post of the resolved tree a set of images belongs to.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Slot {
    /// The post's own media, laid out in the cell's grid.
    Post,
    /// The quoted post: full-width when the cell has no media of its own, a
    /// 96 px thumbnail beside the text when it does.
    Quote,
    /// The quoted post's own quote: one thumbnail, one small avatar.
    QuoteQuote,
}

/// How one slot is fetched.
///
/// `Copy` because the plans are handed around by value (`POST_PLAN`, …) and a
/// batch of payloads keeps them in a list while it plans its fetches.
#[derive(Clone, Copy)]
pub(crate) struct MediaPlan {
    slot: Slot,
    layout: Layout,
    /// `""`, `"quoted "` or `"quoted quoted "`: the role prefix `source.media`
    /// keys carry (`quoted quoted media:0`, `quoted quoted avatar`, …).
    prefix: &'static str,
    /// A nested quote draws its first media item only.
    only_first: bool,
    /// A nested quote's thumbnail is 64×64, so `small` (680w) covers dpr 1–3;
    /// `None` means derive the variant from the slot width (the grid and quote
    /// tables).
    variant: Option<&'static str>,
    /// The avatar's CSS size, which picks X's `srcset` step.
    avatar_css: f32,
}

/// The post's own images: the full-width cell.
pub(crate) const POST_PLAN: MediaPlan = MediaPlan {
    slot: Slot::Post,
    layout: Layout::Grid,
    prefix: "",
    only_first: false,
    variant: None,
    avatar_css: media::AVATAR_CSS,
};

/// The quoted post: `Layout::Quote` reproduces the quote card's own `sizes`.
pub(crate) const QUOTE_PLAN: MediaPlan = MediaPlan {
    slot: Slot::Quote,
    layout: Layout::Quote,
    prefix: "quoted ",
    only_first: false,
    variant: None,
    avatar_css: media::AVATAR_CSS,
};

/// The quoted post's quote, as X's nested preview draws it: a 16 px avatar and
/// at most one thumbnail. Small on purpose — it is never bigger than 64 px.
pub(crate) const NESTED_PLAN: MediaPlan = MediaPlan {
    slot: Slot::QuoteQuote,
    layout: Layout::Quote,
    prefix: "quoted quoted ",
    only_first: true,
    variant: Some("small"),
    avatar_css: media::AVATAR_COMPACT_CSS,
};

// ---------------------------------------------------------------------------
// Options and the result
// ---------------------------------------------------------------------------

/// How the caller wants the post resolved.
///
/// `Serialize`/`Deserialize` are here for the wrappers: the wasm export takes
/// this struct as JSON, and a recorded test can replay the options it used.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// Inline image bytes (`Media::data`, `Author::avatar`, card images). Off
    /// means the post still gets the *descriptions* (sizes, cards, display) but
    /// no pixels: that is the cheap path a typist needs.
    pub media: bool,
    /// The viewport the post will be rendered at, which picks the image variant
    /// exactly as X's `srcset` would.
    pub width: f32,
    pub dpr: f32,
    /// `web-timeline` or `web-detail`. The variant table does not use it today;
    /// it is here because the render options are the honest input.
    pub surface: String,
    /// How many of the post's URLs to resolve (X cards one; four is a draft).
    pub max_links: usize,
    /// The render limits (image bytes, per-image pixels). Defaults to
    /// `Limits::standard()`; not part of the wire form (a caller that wants
    /// other limits passes them to the renderer, which owns validation).
    #[serde(skip)]
    pub limits: Limits,
    /// The reference time for relative timestamps, as ISO 8601. The crate has no
    /// clock; a caller that wants "3h" passes it.
    pub now: Option<String>,
    /// Wall-clock milliseconds, used to stamp cache entries when no [`Clock`] is
    /// given.
    pub now_ms: u64,
    /// Seconds of network budget per URL.
    pub timeout_ms: u64,
    /// `usr`-level overrides, for tests and for a host with its own policy.
    pub hops: usize,
    pub html_bytes: usize,
    pub image_bytes: usize,
    pub cache_ttl_ms: u64,
    pub error_ttl_ms: u64,
    /// Origins exempt from the address guard (the offline fixtures). Never set
    /// by the shipped wrappers.
    pub allow_hosts: Vec<String>,
    /// Ignore the cache and fetch everything again (`?refresh=1`).
    pub refresh: bool,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            media: false,
            width: 600.0,
            dpr: 2.0,
            surface: "web-timeline".to_string(),
            max_links: 4,
            limits: Limits::standard(),
            now: None,
            now_ms: 0,
            timeout_ms: 5000,
            hops: 10,
            html_bytes: 1024 * 1024,
            image_bytes: 5 * 1024 * 1024,
            cache_ttl_ms: 60 * 60 * 1000,
            error_ttl_ms: 10 * 60 * 1000,
            allow_hosts: Vec::new(),
            refresh: false,
        }
    }
}

/// One resolved link: the renderer's `LinkMeta` plus what it took to get there.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    pub meta: LinkMeta,
    /// `[{url, status}]`, in order. The last entry is the page that was parsed.
    pub chain: Vec<Hop>,
    pub final_url: String,
    /// The card-relevant `<meta>` tags, as the page wrote them.
    pub tags: BTreeMap<String, String>,
    /// The card image URL, before any bytes were fetched.
    pub image_url: Option<String>,
    /// The card image itself, when `Options::media` was on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<MediaAsset>,
    pub notes: Vec<String>,
    pub cached: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hop {
    pub url: String,
    pub status: u16,
}

/// One inlined asset. Bytes are base64 in the JSON the wrappers return; the
/// `bytes` field here is the encoded length, so a caller can budget without
/// decoding.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    /// `small`/`medium`/`large` for post media, `_normal`/`_x96`/
    /// `_reasonably_small` for an avatar, `bigger` for a badge, `card` for a
    /// card image, `original` for the payload URL.
    pub variant: String,
    pub bytes: usize,
    pub width: u32,
    pub height: u32,
    /// Which slot it fills: `media:0`, `avatar`, `badge`, `card`,
    /// `quoted media:0`, `quoted avatar`, …
    pub role: String,
    /// The bytes, base64. `None` when `Options::media` was false.
    pub data: Option<String>,
}

/// Where a URL-resolved post came from.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub url: Option<String>,
    pub id: Option<String>,
    pub app_version: Option<String>,
    /// The page the payload came from. The host decides whether to keep it (the
    /// playground writes it for Chrome's page mode).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_html: Option<String>,
    pub pinned: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub post: Post,
    /// Keyed by the URL **as written in the text**, which is what `rules` looks
    /// up; the payload's own `display` wins when there is one.
    pub links: BTreeMap<String, ResolvedLink>,
    /// Keyed by the URL that was fetched (the variant, for post media).
    pub media: BTreeMap<String, MediaAsset>,
    pub source: Source,
    pub warnings: Vec<String>,
}

/// A failure with the code the wrappers surface.
#[derive(Clone, Debug)]
pub enum Error {
    /// The input is not a post (bad JSON, wrong shape).
    Input(String),
    /// The input is a post but the renderer's limits reject it: `(path, message)`.
    Invalid(Vec<(String, String)>),
    /// The URL could not be resolved (blocked, 404, no payload, …).
    Unresolved { code: &'static str, message: String },
    /// The host refused the destination (its own policy, CORS, DNS).
    Blocked(String),
    /// The address guard refused it: a private or reserved address, a
    /// non-default port, or a name that resolves to one of those.
    Address(String),
    /// The host's fetch failed.
    Transport(String),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::Input(_) => "invalid_json",
            Error::Invalid(_) => "invalid_post",
            Error::Unresolved { code, .. } => code,
            Error::Blocked(_) => "blocked",
            Error::Address(_) => "private_address",
            Error::Transport(_) => "network_error",
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            Error::Input(_) | Error::Invalid(_) => 400,
            Error::Unresolved { code, .. } if *code == "not_found" => 404,
            Error::Blocked(_) | Error::Address(_) => 400,
            Error::Unresolved { .. } => 502,
            Error::Transport(_) => 502,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Error::Input(message)
            | Error::Blocked(message)
            | Error::Address(message)
            | Error::Transport(message) => message.clone(),
            Error::Invalid(problems) => problems
                .iter()
                .map(|(path, message)| format!("{path}: {message}"))
                .collect::<Vec<_>>()
                .join("; "),
            Error::Unresolved { message, .. } => message.clone(),
        }
    }

    /// `{code, status, message, fields?}`, the wrappers' error body.
    pub fn to_json(&self) -> serde_json::Value {
        let mut value = serde_json::json!({
            "code": self.code(),
            "status": self.status(),
            "message": self.message(),
        });
        if let Error::Invalid(problems) = self {
            value["fields"] = problems
                .iter()
                .map(|(path, message)| serde_json::json!({ "path": path, "message": message }))
                .collect();
        }
        value
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for Error {}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

/// Resolves **one link** the way X's crawler would: robots.txt, redirects,
/// card tags, the display form, and (with `Options::media`) the card image.
///
/// This is the entry the HTTP function's `POST /resolve-links` uses: a caller
/// with URLs of its own does not need a post.
pub async fn resolve_link<F, L, C, K>(
    url: &str,
    opts: Options,
    fetch: &F,
    lookup: Option<&L>,
    cache: Option<&C>,
    clock: Option<&K>,
) -> Result<ResolvedLink, Error>
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let ctx = Ctx {
        opts,
        fetch,
        lookup,
        cache,
        clock,
        robots: RefCell::new(BTreeMap::new()),
    };
    run_link(&ctx, url).await
}

/// Resolves `input` (draft text, an X post URL, or post JSON) into a
/// [`Resolved`]. See the module docs for the injection points.
pub async fn resolve<F, L, C, K>(
    input: &str,
    opts: Options,
    fetch: &F,
    lookup: Option<&L>,
    cache: Option<&C>,
    clock: Option<&K>,
) -> Result<Resolved, Error>
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let ctx = Ctx {
        opts,
        fetch,
        lookup,
        cache,
        clock,
        robots: RefCell::new(BTreeMap::new()),
    };
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(Error::Input("the input is empty".to_string()));
    }
    if trimmed.starts_with('{') {
        return resolve_json(&ctx, trimmed).await;
    }
    if let Some(id) = status_id(trimmed) {
        return resolve_post_url(&ctx, trimmed, &id).await;
    }
    let post = Post {
        text: input.to_string(),
        now: ctx.opts.now.clone(),
        ..Post::default()
    };
    let mut resolved = Resolved {
        post,
        links: BTreeMap::new(),
        media: BTreeMap::new(),
        source: Source::default(),
        warnings: Vec::new(),
    };
    fill_links(&ctx, &mut resolved).await;
    // "Post video"/"Post photo" and direct `twimg` URLs become the post's media;
    // then a draft ending with a plain status URL is a quote (see
    // `attach_quote_from_text`).
    attach::attach_from_text(&ctx, &mut resolved).await;
    // X's composer carries one attachment: a draft that just got an embedded
    // item does not also become a quote, even if it ends with a post link.
    if resolved.post.media.is_empty() {
        attach_quote_from_text(&ctx, &mut resolved).await;
    }
    Ok(resolved)
}

struct Ctx<'a, F, L, C, K> {
    opts: Options,
    fetch: &'a F,
    lookup: Option<&'a L>,
    cache: Option<&'a C>,
    clock: Option<&'a K>,
    /// The compiled `robots.txt` of every origin reached, so the second hop (or
    /// the second link) does not ask for it again. `RefCell` because the futures
    /// share `&Ctx` and the resolver is single-threaded by construction (see
    /// `join_all`). (DNS is *not* memoized here: `Lookup` promises a fresh
    /// answer on every hop.)
    robots: RefCell<BTreeMap<String, urlsafety::Robots>>,
}

impl<'a, F, L, C, K> Ctx<'a, F, L, C, K>
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    fn now_ms(&self) -> u64 {
        match self.clock {
            Some(clock) => clock.now_ms(),
            None => self.opts.now_ms,
        }
    }

    fn allow_private(&self, url: &Url) -> bool {
        self.opts.allow_hosts.iter().any(|host| {
            host.eq_ignore_ascii_case(&url.host)
                || host.eq_ignore_ascii_case(&format!("{}:{}", url.host, url.effective_port()))
        })
    }
}

async fn resolve_json<F, L, C, K>(ctx: &Ctx<'_, F, L, C, K>, text: &str) -> Result<Resolved, Error>
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|error| Error::Input(format!("the JSON does not parse: {error}")))?;
    if !value.is_object() {
        return Err(Error::Input("expected a post object".to_string()));
    }
    // `{post, options}` is the shape the MCP tools and the fixtures use.
    let (post_value, options_value) = match value.get("post").filter(|post| post.is_object()) {
        Some(post) => (post.clone(), value.get("options").cloned()),
        None => (value, None),
    };
    let opts = match options_value {
        Some(options) if !options.is_null() => xeet_core::limits::options_from_value(options)
            .map_err(|error| Error::Input(error.to_string()))?,
        _ => xeet_core::model::RenderOptions::default(),
    };
    // `post_from_value` is the renderer's own strict parser: a typo comes back
    // with the path it is about (`auther` → `did you mean author`), which the
    // editor underlines.
    let post = xeet_core::limits::post_from_value(post_value)
        .map_err(|error| Error::Invalid(vec![(error.what.to_string(), error.message.clone())]))?;
    // The renderer's own validation, so a caller learns about every problem at
    // once (and a resolved post is always renderable).
    if let Err(problems) = xeet_core::limits::validate(&post, &opts, &ctx.opts.limits) {
        return Err(Error::Invalid(
            problems
                .iter()
                .map(|problem| (problem.path.clone(), problem.message.clone()))
                .collect(),
        ));
    }
    let mut resolved = Resolved {
        post,
        links: BTreeMap::new(),
        media: BTreeMap::new(),
        source: Source::default(),
        warnings: Vec::new(),
    };
    fill_links(ctx, &mut resolved).await;
    attach_quote_from_text(ctx, &mut resolved).await;
    Ok(resolved)
}

const PAGE_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
/// X's crawler identifies itself; this is what makes `t.co` redirect
/// (docs/LINK-CARDS.md §"What X's crawler does").
pub const CRAWLER_USER_AGENT: &str = "Twitterbot/1.0";

/// The post a page's payload carries, plus what the page said about it.
struct PagePost {
    tweet: serde_json::Value,
    post: Post,
    html: String,
    app_version: Option<String>,
    pinned: bool,
}

/// Fetches `https://x.com/i/status/<id>` and turns its payload into a post.
///
/// This is the one path an X URL takes, whether it was pasted (`resolve`) or is
/// the trailing link of a draft (a quote, `attach_quote_from_text`).
async fn post_from_page<F, L, C, K>(
    ctx: &Ctx<'_, F, L, C, K>,
    id: &str,
    handle: Option<&str>,
    budget: usize,
) -> Result<PagePost, Error>
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let canonical = canonical_url(id);
    // `/i/status/<id>` answers 307 to `/<handle>/status/<id>` (and a logged-out
    // visitor can be sent to `mobile.x.com` first). A browser follows those, and
    // so does the crawler — through the same address guard, on every hop.
    //
    // When the link already names the handle, ask for that page directly: it
    // saves the 307's round trip (~200 ms). If it does not answer 2xx (a renamed
    // account, say), the canonical form is fetched exactly as before.
    let fetch_page = |url: String| async move {
        fetch_following(
            ctx,
            &url,
            PAGE_USER_AGENT,
            ctx.opts.html_bytes,
            "text/html,application/xhtml+xml",
        )
        .await
        .map(|page| (url, page))
    };
    let direct = match handle {
        Some(handle) => match fetch_page(format!("https://x.com/{handle}/status/{id}")).await {
            Ok((url, page)) if (200..300).contains(&page.status) => Some((url, page)),
            _ => None,
        },
        None => None,
    };
    let (url, page) = match direct {
        Some(found) => found,
        None => fetch_page(canonical).await?,
    };
    if !(200..300).contains(&page.status) {
        return Err(Error::Unresolved {
            code: "http_status",
            message: format!("{url} answered {}", page.status),
        });
    }
    let html = page.text();
    let payloads = post::extract_payloads(&html);
    let Some(tweet) = payloads
        .iter()
        .find(|tweet| tweet.get("rest_id").and_then(serde_json::Value::as_str) == Some(id))
        .cloned()
    else {
        return Err(Error::Unresolved {
            code: "not_found",
            message: format!(
                "the page for post {id} has no payload for it (deleted, protected, or not server-rendered)"
            ),
        });
    };
    let app_version = post::app_version(&html);
    let post = post::payload_to_post_with(
        &tweet,
        ctx.opts.now.as_deref(),
        app_version.as_deref(),
        budget,
    );
    let pinned = post::pinned_ids(&html).iter().any(|pinned| pinned == id);
    Ok(PagePost {
        tweet,
        post,
        html,
        app_version,
        pinned,
    })
}

async fn resolve_post_url<F, L, C, K>(
    ctx: &Ctx<'_, F, L, C, K>,
    input: &str,
    id: &str,
) -> Result<Resolved, Error>
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let PagePost {
        tweet,
        mut post,
        html,
        app_version,
        pinned,
    } = post_from_page(
        ctx,
        id,
        post::status_handle(input).as_deref(),
        ctx.opts.limits.max_quote_depth,
    )
    .await?;
    if pinned {
        post.social_context = Some(xeet_core::model::SocialContext::Pinned);
    }
    let mut resolved = Resolved {
        post,
        links: BTreeMap::new(),
        media: BTreeMap::new(),
        source: Source {
            url: Some(input.to_string()),
            id: Some(id.to_string()),
            app_version,
            page_html: Some(html),
            pinned,
        },
        warnings: Vec::new(),
    };
    if ctx.opts.media {
        // The post, its quote and the quote's own quote, as one wave: their
        // images are independent, and the order keeps the roles deterministic.
        let mut payloads: Vec<(&serde_json::Value, MediaPlan)> = vec![(&tweet, POST_PLAN)];
        if let Some(quoted) = quoted_payload(&tweet) {
            payloads.push((quoted, QUOTE_PLAN));
            // X's nested preview draws the quoted post's own quote as a compact
            // row: a 16 px avatar and one 64×64 thumbnail.
            if let Some(nested) = quoted_payload(quoted) {
                payloads.push((nested, NESTED_PLAN));
            }
        }
        inline_media(ctx, &mut resolved, &payloads).await;
    }
    fill_links(ctx, &mut resolved).await;
    Ok(resolved)
}

/// The composer's quote: a **trailing** status URL in a draft.
///
/// X's composer does not ask whether a link looks like a post: when a draft ends
/// with an `x.com`/`twitter.com` status URL, it attaches that post as the quote
/// and `rules` hides the URL — it claims it only when the quoted post's handle
/// matches the link's (`rules::trailing_attachment_entities`). The resolver's
/// job is the other half: fetch the post and put it in `post.quote`, so the cell
/// draws a quote card instead of a stray link.
///
/// Which URL, exactly:
///
/// - the **last** status URL in the text — a quote is what a draft ends with;
/// - only when nothing but whitespace follows it: a link mid-sentence is a link,
///   not a quote (this is also what makes the rule idempotent for a pasted post);
/// - `x.com`, `twitter.com`, `www.` and `mobile.` forms; `/<name>/status/<id>`,
///   `/<name>/statuses/<id>`, `/i/status/<id>`, `/i/web/status/<id>`; with the
///   `?s=20&t=…`, `/photo/1` or `/video/1` suffix a share sheet adds;
/// - never the post being written (there is no such post yet).
///
/// One level only: a quoted post's own quote is dropped, because X's quote card
/// shows one card. In a captured page that inner quote is a
/// `nested_quoted_tweet_results`, and the client draws its text as a link.
async fn attach_quote_from_text<F, L, C, K>(ctx: &Ctx<'_, F, L, C, K>, resolved: &mut Resolved)
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    if resolved.post.quote.is_some() {
        return;
    }
    let text = resolved.post.text.clone();
    let parsed = xeet_text::parse(&text);
    let chars: Vec<char> = text.chars().collect();
    let mut trailing: Option<(String, Option<String>)> = None;
    for entity in parsed.entities.iter().rev() {
        let xeet_text::EntityKind::Url { expanded, .. } = &entity.kind else {
            continue;
        };
        // Only whitespace may follow the link.
        if chars[entity.end.min(chars.len())..]
            .iter()
            .any(|c| !c.is_whitespace())
        {
            break;
        }
        // `/status/<id>/video/1` and `/status/<id>/photo/1` are "Post video" /
        // "Post photo" — an attachment, not a quote — so a draft that ends with
        // one has no quote at all.
        if attach::is_media_url(expanded) {
            return;
        }
        if let Some(id) = status_id(expanded) {
            trailing = Some((id, post::status_handle(expanded)));
            break;
        }
    }
    let Some((id, handle)) = trailing else {
        return;
    };
    // The fetched post becomes `post.quote`, i.e. level 1, so it may only carry
    // one level of its own: that is `post.quote.quote`.
    let budget = ctx.opts.limits.max_quote_depth.saturating_sub(1);
    match post_from_page(ctx, &id, handle.as_deref(), budget).await {
        Ok(PagePost {
            tweet, mut post, ..
        }) => {
            // Two levels: the fetched post already carries its own quote (it came
            // through `payload_to_post`, which stops at `QUOTE_DEPTH`), so it is
            // kept rather than cleared — that is `post.quote.quote`. Its own
            // `quote` is `None` by construction, so a third level cannot appear.
            post.social_context = None;
            resolved.post.quote = Some(Box::new(post));
            if ctx.opts.media {
                // The quote and the quote's own quote, fetched as one wave.
                let mut payloads: Vec<(&serde_json::Value, MediaPlan)> = vec![(&tweet, QUOTE_PLAN)];
                if let Some(nested) = quoted_payload(&tweet) {
                    payloads.push((nested, NESTED_PLAN));
                }
                inline_media(ctx, resolved, &payloads).await;
            }
        }
        Err(error) => resolved.warnings.push(format!(
            "the quoted post {id} could not be resolved: {}",
            error.message()
        )),
    }
}

fn quoted_payload(tweet: &serde_json::Value) -> Option<&serde_json::Value> {
    post::quote_payload(tweet)
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/// Where one fetched image goes.
#[derive(Clone, Copy)]
enum JobSlot {
    /// Post media at this index.
    Media(usize),
    /// The post's own author picture.
    Avatar,
    /// The attribution chip of the media at this index ("Post video"/"Post
    /// photo").
    Source(usize),
    /// The affiliation badge.
    Badge,
}

/// One image a payload needs: the variant URL, the payload URL it came from,
/// and the slot it fills.
struct Job {
    slot: JobSlot,
    url: String,
    variant: &'static str,
    role: String,
    /// The payload's own URL, when the variant URL differs: the last resort when
    /// the variant (and the smaller names after it) have no bytes.
    fallback: Option<String>,
}

/// The post one slot's images belong to, when it is there to fill.
fn slot_post(post: &Post, slot: Slot) -> Option<&Post> {
    match slot {
        Slot::Post => Some(post),
        Slot::Quote => post.quote.as_deref(),
        Slot::QuoteQuote => post
            .quote
            .as_deref()
            .and_then(|quote| quote.quote.as_deref()),
    }
}

/// Every image `tweet` fills for `plan`, in the order their roles are applied.
///
/// Pure — it reads the payload, the plan and whether the target draws an
/// affiliation badge — so the post, its quote and the quote's own quote can all
/// be planned before any of their bytes are fetched.
fn media_jobs(
    tweet: &serde_json::Value,
    plan: MediaPlan,
    dpr: f32,
    content_width: f32,
    affiliate: bool,
) -> Vec<Job> {
    let mut entries: Vec<&serde_json::Value> = tweet
        .get("media_entities2")
        .and_then(serde_json::Value::as_array)
        .map(|media| {
            media
                .iter()
                .filter(|entry| {
                    entry
                        .pointer("/original_info/width")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0)
                        > 0
                        && entry
                            .pointer("/original_info/height")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0)
                            > 0
                })
                .collect()
        })
        .unwrap_or_default();
    if plan.only_first {
        entries.truncate(1);
    }
    let count = entries.len();
    let variant = plan.variant.unwrap_or_else(|| {
        media::variant_for(media::slot_width(count, content_width, plan.layout), dpr)
    });

    let mut jobs: Vec<Job> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let Some(base) = entry
            .get("media_url_https")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let Some(url) = media::variant_url(base, variant) else {
            continue;
        };
        jobs.push(Job {
            slot: JobSlot::Media(index),
            fallback: (url != base).then(|| base.to_string()),
            url,
            variant,
            role: format!("{}media:{index}", plan.prefix),
        });
    }
    // Avatar, at the size X's own srcset picks for this slot and dpr.
    if let Some(base) = tweet
        .pointer("/core/user_results/result/avatar/image_url")
        .and_then(serde_json::Value::as_str)
    {
        let avatar_variant = media::avatar_variant_for(plan.avatar_css, dpr);
        if let Some(url) = media::avatar_url_for(base, avatar_variant) {
            jobs.push(Job {
                slot: JobSlot::Avatar,
                url,
                variant: avatar_variant,
                role: format!("{}avatar", plan.prefix),
                fallback: None,
            });
        }
    }
    // "Post video"/"Post photo": the author of the media's original post, at the
    // 16 px attribution-chip size (`ESPN.html` credits `@NFL`).
    let source_variant = media::avatar_variant_for(media::AVATAR_COMPACT_CSS, dpr);
    if let Some(media_entries) = tweet
        .get("media_entities2")
        .and_then(serde_json::Value::as_array)
    {
        for (index, entry) in media_entries.iter().enumerate() {
            let Some(avatar) = entry
                .pointer("/source_user_results/result/avatar/image_url")
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            let Some(href) = media::avatar_url_for(avatar, source_variant) else {
                continue;
            };
            jobs.push(Job {
                slot: JobSlot::Source(index),
                url: href,
                variant: source_variant,
                role: format!("{}media:{index} source avatar", plan.prefix),
                fallback: None,
            });
        }
    }
    // The affiliation badge is the payload's own URL, as X draws it.
    if affiliate {
        if let Some(base) = tweet
            .pointer(
                "/core/user_results/result/identity_profile_labels_highlighted_label/label/badge/url",
            )
            .and_then(serde_json::Value::as_str)
        {
            jobs.push(Job {
                slot: JobSlot::Badge,
                url: base.to_string(),
                variant: "bigger",
                role: format!("{}badge", plan.prefix),
                fallback: None,
            });
        }
    }
    jobs
}

/// Fills every image slot the payloads name.
///
/// `payloads` is the post followed by its quote and the quote's own quote, in
/// the order their roles are applied. Their jobs are planned first and fetched
/// as one wave — the payloads are independent — and the results are then applied
/// in that same order, so `source.media` keys and warnings read exactly as they
/// would one payload at a time. Four photos, an avatar and a badge cost one
/// round trip; so do a post, its quote and that quote's quote.
async fn inline_media<F, L, C, K>(
    ctx: &Ctx<'_, F, L, C, K>,
    resolved: &mut Resolved,
    payloads: &[(&serde_json::Value, MediaPlan)],
) where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let content_width = (ctx.opts.width.clamp(100.0, 600.0) - 32.0).max(1.0);
    let dpr = if ctx.opts.dpr.is_finite() && ctx.opts.dpr > 0.0 {
        ctx.opts.dpr
    } else {
        2.0
    };
    // Planning reads the post only to learn which slots are there to fill: a
    // quote the payload did not turn out to have fetches nothing, which is what
    // the per-payload call did by returning early.
    let mut batches: Vec<(MediaPlan, Vec<Job>)> = Vec::with_capacity(payloads.len());
    for &(tweet, plan) in payloads {
        let jobs = match slot_post(&resolved.post, plan.slot) {
            Some(post) => media_jobs(
                tweet,
                plan,
                dpr,
                content_width,
                post.author.affiliate.is_some(),
            ),
            None => Vec::new(),
        };
        batches.push((plan, jobs));
    }

    let fetches: Vec<BoxedFetch<'_>> = batches
        .iter()
        .flat_map(|(_, jobs)| jobs.iter())
        .map(|job| {
            let fut: BoxedFetch<'_> = Box::pin(async move {
                let mut warnings = Vec::new();
                let (asset, url) = match &job.fallback {
                    Some(base) => {
                        fetch_image_fallback(
                            ctx,
                            base,
                            &job.url,
                            job.variant,
                            &job.role,
                            &mut warnings,
                        )
                        .await
                    }
                    None => (
                        fetch_image(ctx, &job.url, job.variant, &job.role, &mut warnings).await,
                        job.url.clone(),
                    ),
                };
                (asset, url, warnings)
            });
            fut
        })
        .collect();
    let results = join_all(fetches).await;
    let mut results = results.into_iter();

    let mut warnings: Vec<String> = Vec::new();
    for (plan, jobs) in &batches {
        for (job, (asset, url, job_warnings)) in jobs.iter().zip(results.by_ref()) {
            warnings.extend(job_warnings);
            let Some(asset) = asset else {
                if let JobSlot::Media(_) = job.slot {
                    warnings.push(format!(
                        "{}: no bytes, the renderer draws its placeholder",
                        job.role
                    ));
                }
                continue;
            };
            let target = match plan.slot {
                Slot::Post => &mut resolved.post,
                Slot::Quote => match resolved.post.quote.as_mut() {
                    Some(quote) => quote,
                    None => continue,
                },
                Slot::QuoteQuote => match resolved
                    .post
                    .quote
                    .as_mut()
                    .and_then(|quote| quote.quote.as_mut())
                {
                    Some(nested) => nested,
                    None => continue,
                },
            };
            match job.slot {
                JobSlot::Media(index) => {
                    if let Some(item) = target.media.get_mut(index) {
                        // For a video or an animated GIF this is the poster
                        // frame, which is what `Media::data` means
                        // (`docs/MEDIA.md`).
                        item.data = asset.data.clone();
                    }
                    // Keyed by the variant URL, as before, even when the bytes
                    // came from the original.
                    if ctx.opts.media {
                        resolved.media.insert(job.url.clone(), asset);
                    }
                    continue;
                }
                JobSlot::Avatar => target.author.avatar = asset.data.clone(),
                JobSlot::Source(index) => {
                    if let Some(author) = target
                        .media
                        .get_mut(index)
                        .and_then(|item| item.source_author.as_mut())
                    {
                        author.avatar = asset.data.clone();
                    }
                }
                JobSlot::Badge => {
                    if let Some(affiliate) = target.author.affiliate.as_mut() {
                        affiliate.badge = asset.data.clone();
                    }
                }
            }
            if ctx.opts.media {
                resolved.media.insert(url, asset);
            }
        }
        resolved.warnings.append(&mut warnings);
    }
}

/// One image fetch in flight: the asset (if any), the URL its bytes came from,
/// and the warnings it produced.
type BoxedFetch<'a> = Pin<Box<dyn Future<Output = (Option<MediaAsset>, String, Vec<String>)> + 'a>>;

/// Drives every future to completion together and returns their outputs in
/// order. The resolver has no runtime of its own, so this is the whole of its
/// concurrency: one poll per wake-up over the futures still pending. With a
/// host whose fetch is truly asynchronous (a browser, Node) the requests are in
/// flight at once; with a blocking host each completes on its first poll, which
/// is exactly the sequential behavior.
async fn join_all<'a, T>(futures: Vec<Pin<Box<dyn Future<Output = T> + 'a>>>) -> Vec<T> {
    let mut pending: Vec<Option<Pin<Box<dyn Future<Output = T> + 'a>>>> =
        futures.into_iter().map(Some).collect();
    let mut done: Vec<Option<T>> = pending.iter().map(|_| None).collect();
    core::future::poll_fn(move |cx| {
        let mut waiting = false;
        for (slot, out) in pending.iter_mut().zip(done.iter_mut()) {
            if let Some(future) = slot {
                match future.as_mut().poll(cx) {
                    core::task::Poll::Ready(value) => {
                        *out = Some(value);
                        *slot = None;
                    }
                    core::task::Poll::Pending => waiting = true,
                }
            }
        }
        if waiting {
            core::task::Poll::Pending
        } else {
            core::task::Poll::Ready(
                done.iter_mut()
                    .map(|v| v.take().expect("every future finished"))
                    .collect(),
            )
        }
    })
    .await
}

async fn fetch_image<F, L, C, K>(
    ctx: &Ctx<'_, F, L, C, K>,
    url: &str,
    variant: &str,
    role: &str,
    warnings: &mut Vec<String>,
) -> Option<MediaAsset>
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let key = format!("img:{url}");
    let cached = cache_get(ctx, &key, ctx.opts.cache_ttl_ms)
        .await
        .and_then(|value| decode_cached_image(&value));
    if let Some((bytes, _content_type)) = cached {
        return Some(MediaAsset {
            variant: variant.to_string(),
            bytes: bytes.len(),
            width: image::dimensions(&bytes).map(|dims| dims.0).unwrap_or(0),
            height: image::dimensions(&bytes).map(|dims| dims.1).unwrap_or(0),
            role: role.to_string(),
            data: ctx.opts.media.then(|| b64(&bytes)),
        });
    }
    let response = match fetch_bytes(
        ctx,
        url,
        CRAWLER_USER_AGENT,
        ctx.opts.image_bytes,
        "image/*",
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            warnings.push(format!("could not load {role}: {}", error.message()));
            return None;
        }
    };
    if !(200..300).contains(&response.status) {
        warnings.push(format!(
            "could not load {role}: {url} answered {}",
            response.status
        ));
        return None;
    }
    let content_type = response
        .header("content-type")
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if image::extension_for(&content_type).is_none() {
        warnings.push(format!(
            "could not load {role}: {} is {content_type}, not JPG/PNG/WEBP/GIF",
            url
        ));
        return None;
    }
    if response.truncated || response.body.len() > ctx.opts.image_bytes {
        warnings.push(format!(
            "could not load {role}: {url} is over {} bytes",
            ctx.opts.image_bytes
        ));
        return None;
    }
    let Some((width, height)) = image::dimensions(&response.body) else {
        warnings.push(format!(
            "could not load {role}: {url} is not a readable image"
        ));
        return None;
    };
    // X's 144×144 minimum is a *card* rule (docs/LINK-CARDS.md); avatars are
    // 128px at 3x by X's own srcset, so the floor applies only to card images.
    if role == "card" && (width < cards::IMAGE_MIN_SIZE || height < cards::IMAGE_MIN_SIZE) {
        warnings.push(format!(
            "the card image is {width}×{height}; X needs 144×144, so it is dropped"
        ));
        return None;
    }
    // One encoding for both readers: the cache entry carries the same base64
    // `MediaAsset::data` hands the caller, so the bytes are encoded once.
    let encoded = b64(&response.body);
    cache_set(ctx, &key, &encode_cached_image(&encoded, &content_type)).await;
    Some(MediaAsset {
        variant: variant.to_string(),
        bytes: response.body.len(),
        width,
        height,
        role: role.to_string(),
        data: ctx.opts.media.then_some(encoded),
    })
}

/// The named variants a failed `pbs.twimg.com` fetch is retried at, largest
/// first.
///
/// X's CDN often has `medium`/`small` for a picture whose `large` answers 404
/// or 403, and a smaller picture is worth much more to the cell than the
/// unbounded original (which `docs/MEDIA.md` refuses to draw: a payload's
/// `original_info` can be 8192×5464). Another host has no named variants, so
/// the list is empty.
fn smaller_variants(base: &str, variant: &str) -> Vec<&'static str> {
    let Some(url) = Url::parse(base) else {
        return Vec::new();
    };
    if url.host != "pbs.twimg.com" {
        return Vec::new();
    }
    let Some(index) = media::VARIANTS
        .iter()
        .position(|(name, _)| *name == variant)
    else {
        return Vec::new();
    };
    media::VARIANTS
        .iter()
        .take(index)
        .rev()
        .map(|(name, _)| *name)
        .collect()
}

/// One image fetch, with the CDN's own degradation: the variant X's `srcset`
/// would pick, then the smaller names of the same picture, then the payload's
/// own URL.
///
/// Returns the asset and the URL its bytes came from. `base` and `url` are the
/// same string for a host that has no variants, which is what keeps a card
/// image on someone else's CDN a single request.
pub(crate) async fn fetch_image_fallback<F, L, C, K>(
    ctx: &Ctx<'_, F, L, C, K>,
    base: &str,
    url: &str,
    variant: &str,
    role: &str,
    warnings: &mut Vec<String>,
) -> (Option<MediaAsset>, String)
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    if let Some(asset) = fetch_image(ctx, url, variant, role, warnings).await {
        return (Some(asset), url.to_string());
    }
    if url != base {
        for smaller in smaller_variants(base, variant) {
            let Some(candidate) = media::variant_url(base, smaller) else {
                continue;
            };
            if candidate == url {
                continue;
            }
            if let Some(asset) = fetch_image(ctx, &candidate, smaller, role, warnings).await {
                return (Some(asset), candidate);
            }
        }
        if let Some(asset) = fetch_image(ctx, base, "original", role, warnings).await {
            return (Some(asset), base.to_string());
        }
    }
    (None, url.to_string())
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/// How many of a post's URLs are crawled at once. X cards one link and a draft
/// four, so this is one wave for a normal post; a wider `max_links` takes a few
/// waves rather than opening a hundred sockets.
const LINK_CONCURRENCY: usize = 4;

/// One link crawl in flight: the outcome the apply loop folds in, in order.
type BoxedLink<'a> = Pin<Box<dyn Future<Output = Result<ResolvedLink, Error>> + 'a>>;

async fn fill_links<F, L, C, K>(ctx: &Ctx<'_, F, L, C, K>, resolved: &mut Resolved)
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let text = resolved.post.text.clone();
    // A page's payload comes with X's own entity list (`post.links`); a token the
    // payload did not list is one the server appended (a media or quote `t.co`),
    // which the cell never draws as a link.
    let from_page = resolved.source.id.is_some();
    // `written` is the token the text contains — that is the key `rules` looks
    // up; `expanded` is the same URL with a scheme, which is what a fetch needs
    // (a pasted `example.com/a` has no scheme in the text).
    let mut urls: Vec<(String, String)> = Vec::new();
    // `--offline` and `--no-links` set the limit to zero: nothing is selected,
    // so nothing reaches the network. The check below runs after a URL is
    // already in, so on its own it let one link per post through.
    if ctx.opts.max_links == 0 {
        return;
    }
    for entity in xeet_text::parse(&text).entities {
        if let xeet_text::EntityKind::Url { expanded, .. } = &entity.kind {
            if from_page && !resolved.post.links.contains_key(&entity.text) {
                continue;
            }
            // A URL X attaches as media ("Post video"/"Post photo", a direct
            // `twimg` URL) is not a link: no card is crawled and nothing is
            // fetched for it here — `attach::attach_from_text` owns it.
            if attach::is_media_url(expanded) {
                continue;
            }
            // A link written as an X post still gets a `LinkMeta` (its display
            // form, no card — X's own rule) so `rules` has the entry it looks up.
            if plausible_link(expanded) && !urls.iter().any(|(written, _)| *written == entity.text)
            {
                urls.push((entity.text.clone(), expanded.clone()));
            }
            if urls.len() >= ctx.opts.max_links {
                break;
            }
        }
    }
    if urls.is_empty() {
        return;
    }
    // Up to four pages at a time: the links in one post are independent, so
    // their robots.txt reads, redirect chains and card images go out together
    // instead of one after another.
    let mut results: Vec<Result<ResolvedLink, Error>> = Vec::with_capacity(urls.len());
    for chunk in urls.chunks(LINK_CONCURRENCY) {
        let fetches: Vec<BoxedLink<'_>> = chunk
            .iter()
            .map(|(_, expanded)| {
                let fetches: BoxedLink<'_> = Box::pin(run_link(ctx, expanded));
                fetches
            })
            .collect();
        results.extend(join_all(fetches).await);
    }
    // Applied in the text's order, so `post.links`, `links` and the warnings
    // read exactly as the serial crawl wrote them.
    for ((written, expanded), result) in urls.into_iter().zip(results) {
        match result {
            Ok(link) => {
                // A payload's own display form always wins: a bit.ly link still
                // reads `bit.ly/4esrsTj` while the card comes from the article
                // (docs/LINK-CARDS.md §Display).
                let existing_display = resolved
                    .post
                    .links
                    .get(&written)
                    .and_then(|meta| meta.display.clone());
                let mut meta = link.meta.clone();
                if let Some(display) = existing_display {
                    meta.display = Some(display);
                }
                if ctx.opts.media {
                    if let (Some(img_meta), Some(asset)) =
                        (meta.image.as_mut(), link.image.as_ref())
                    {
                        img_meta.data = asset.data.clone();
                    }
                }
                resolved.post.links.insert(written, meta);
                resolved.links.insert(expanded, link);
            }
            Err(error) => {
                resolved
                    .warnings
                    .push(format!("link {written}: {}", error.message()));
            }
        }
    }
}

fn plausible_link(text: &str) -> bool {
    let Some(url) = Url::parse(text) else {
        return false;
    };
    if !url.host.contains('.') && url.host != "localhost" {
        return false;
    }
    if url.host == "t.co" && url.path.trim_start_matches('/').len() < 2 {
        return false;
    }
    true
}

async fn run_link<F, L, C, K>(
    ctx: &Ctx<'_, F, L, C, K>,
    written: &str,
) -> Result<ResolvedLink, Error>
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let url = Url::parse(written).ok_or_else(|| Error::Unresolved {
        code: "invalid_url",
        message: format!("{written:?} is not an http(s) URL"),
    })?;
    let key = format!("link:{}", url.href());
    if let Some(entry) = cache_get(ctx, &key, ctx.opts.cache_ttl_ms).await {
        if let Ok(cached) = serde_json::from_str::<CachedLink>(&entry) {
            if let Some(error) = cached.error {
                return Err(Error::Unresolved {
                    code: "cached_error",
                    message: error,
                });
            }
            let mut link = cached.into_link(true);
            if ctx.opts.media {
                if let Some(img_url) = link.image_url.clone() {
                    let mut notes = Vec::new();
                    if let Some(asset) =
                        fetch_image(ctx, &img_url, "card", "card", &mut notes).await
                    {
                        if let Some(im) = link.meta.image.as_mut() {
                            if im.width == 0 {
                                im.width = asset.width;
                                im.height = asset.height;
                            }
                        }
                        link.image = Some(asset);
                    }
                }
            }
            return Ok(link);
        }
    }
    let link = crawl(ctx, &url).await?;
    let cached = CachedLink {
        final_url: link.final_url.clone(),
        chain: link.chain.clone(),
        tags: link.tags.clone(),
        meta: link.meta.clone(),
        image_url: link.image_url.clone(),
        notes: link.notes.clone(),
        error: None,
    };
    if let Ok(json) = serde_json::to_string(&cached) {
        cache_set(ctx, &key, &json).await;
    }
    Ok(link)
}

async fn crawl<F, L, C, K>(ctx: &Ctx<'_, F, L, C, K>, url: &Url) -> Result<ResolvedLink, Error>
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let mut notes = Vec::new();
    // A link to an X post has no card, and X does not crawl its own pages.
    if cards::is_x_host(&url.host) {
        let meta = LinkMeta {
            domain: Some(url.host.clone()),
            display: Some(display_url(&url.href())),
            ..LinkMeta::default()
        };
        return Ok(ResolvedLink {
            meta,
            chain: Vec::new(),
            final_url: url.href(),
            tags: BTreeMap::new(),
            image_url: None,
            image: None,
            notes: vec!["a link to an X post has no card".to_string()],
            cached: false,
        });
    }
    let mut current = url.clone();
    let mut chain: Vec<Hop> = Vec::new();
    let mut page: Option<String> = None;
    for hop in 0..=ctx.opts.hops {
        let response = fetch_page(ctx, &current, &mut notes).await?;
        chain.push(Hop {
            url: current.href(),
            status: response.status,
        });
        if matches!(response.status, 301 | 302 | 303 | 307 | 308) {
            let Some(location) = response.header("location") else {
                return Err(Error::Unresolved {
                    code: "bad_redirect",
                    message: format!(
                        "{} answered {} with no Location",
                        current.href(),
                        response.status
                    ),
                });
            };
            let Some(next) = current.join(location) else {
                return Err(Error::Unresolved {
                    code: "bad_redirect",
                    message: format!("{} redirects to {location:?}", current.href()),
                });
            };
            if next.href() == current.href() {
                return Err(Error::Unresolved {
                    code: "redirect_loop",
                    message: format!("{} redirects to itself", current.href()),
                });
            }
            current = next;
            if cards::is_x_host(&current.host) {
                let meta = LinkMeta {
                    domain: Some(current.host.clone()),
                    display: Some(display_url(&current.href())),
                    ..LinkMeta::default()
                };
                return Ok(ResolvedLink {
                    meta,
                    final_url: current.href(),
                    chain,
                    tags: BTreeMap::new(),
                    image_url: None,
                    image: None,
                    notes: vec![
                        "the link resolves to an X post; X shows no card for it".to_string()
                    ],
                    cached: false,
                });
            }
            if hop == ctx.opts.hops {
                break;
            }
            continue;
        }
        if response.status == 404 {
            return Err(Error::Unresolved {
                code: "not_found",
                message: format!("{} answered 404", current.href()),
            });
        }
        if matches!(response.status, 401 | 403 | 429) {
            return Err(Error::Unresolved {
                code: "blocked",
                message: format!("{} answered {}", current.href(), response.status),
            });
        }
        if !(200..300).contains(&response.status) {
            return Err(Error::Unresolved {
                code: "http_status",
                message: format!("{} answered {}", current.href(), response.status),
            });
        }
        let content_type = response
            .header("content-type")
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if content_type != "text/html" && content_type != "application/xhtml+xml" {
            return Err(Error::Unresolved {
                code: "not_html",
                message: format!(
                    "{} returned {content_type}, which is not a page",
                    current.href()
                ),
            });
        }
        if response.truncated {
            notes.push(format!(
                "the page is larger than {} bytes; its beginning was parsed",
                ctx.opts.html_bytes
            ));
        }
        let html = response.text();
        if let Some(target) = cards::meta_refresh_target(&html, &current) {
            if target.href() != current.href() && hop < ctx.opts.hops {
                notes.push("followed a <meta http-equiv=refresh> redirect".to_string());
                current = target;
                continue;
            }
        }
        page = Some(html);
        break;
    }
    let Some(html) = page else {
        return Err(Error::Unresolved {
            code: "too_many_redirects",
            message: format!(
                "{} did not settle within {} redirects",
                url.href(),
                ctx.opts.hops
            ),
        });
    };
    let card = cards::decide(&html, &current);
    notes.extend(card.notes.clone());
    let mut image_url = card.image_url.clone();
    let mut image = None;
    let mut width = 0;
    let mut height = 0;
    if card.card.is_some() {
        if let Some(url) = &card.image_url {
            if let Some(asset) = fetch_image(ctx, url, "card", "card", &mut notes).await {
                width = asset.width;
                height = asset.height;
                image = Some(asset);
            } else {
                image_url = None;
            }
        }
    }
    let meta = LinkMeta {
        card: card.card.clone(),
        title: card.title.clone(),
        description: card.description.clone(),
        domain: card.domain.clone(),
        image: if image_url.is_some() {
            Some(xeet_core::model::ImageMeta {
                width,
                height,
                data: None,
            })
        } else {
            None
        },
        display: Some(display_url(&current.href())),
    };
    Ok(ResolvedLink {
        meta,
        final_url: current.href(),
        chain,
        tags: card.tags,
        image_url: image_url.clone(),
        image,
        notes,
        cached: false,
    })
}

async fn fetch_page<F, L, C, K>(
    ctx: &Ctx<'_, F, L, C, K>,
    url: &Url,
    notes: &mut Vec<String>,
) -> Result<Response, Error>
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let robots = robots_for(ctx, url).await;
    if !robots.allows(&url.path) {
        return Err(Error::Unresolved {
            code: "robots",
            message: format!(
                "robots.txt for {} disallows {} for Twitterbot",
                url.origin(),
                url.path
            ),
        });
    }
    let _ = notes;
    fetch_bytes(
        ctx,
        &url.href(),
        CRAWLER_USER_AGENT,
        ctx.opts.html_bytes,
        "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    )
    .await
}

async fn robots_for<F, L, C, K>(ctx: &Ctx<'_, F, L, C, K>, url: &Url) -> urlsafety::Robots
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let origin = url.origin();
    // robots.txt is per origin and cannot change inside one resolve: a redirect
    // chain, or four links on one host, read it once. (The disk cache below is
    // the cross-resolve one; this is the per-resolve one.)
    if let Some(robots) = ctx.robots.borrow().get(&origin).cloned() {
        return robots;
    }
    let key = format!("robots:{origin}");
    let robots = if let Some(entry) = cache_get(ctx, &key, ctx.opts.cache_ttl_ms).await {
        urlsafety::Robots::parse(&entry)
    } else {
        let robots_url = format!("{origin}/robots.txt");
        let body = match fetch_bytes(
            ctx,
            &robots_url,
            CRAWLER_USER_AGENT,
            64 * 1024,
            "text/plain,*/*",
        )
        .await
        {
            Ok(response) if (200..300).contains(&response.status) => response.text(),
            Ok(response) if response.status == 401 || response.status == 403 => {
                // Google's spec: an unauthorised robots.txt means "stay out".
                "User-agent: *\nDisallow: /\n".to_string()
            }
            // Unreachable robots.txt means allow (Google's rule for 4xx).
            _ => String::new(),
        };
        cache_set(ctx, &key, &body).await;
        urlsafety::Robots::parse(&body)
    };
    ctx.robots.borrow_mut().insert(origin, robots.clone());
    robots
}

// ---------------------------------------------------------------------------
// The fetch plumbing shared by pages and images
// ---------------------------------------------------------------------------

/// Fetches a page the way a browser would: follows 3xx and
/// `<meta http-equiv=refresh>` up to `opts.hops`, with the address guard on
/// every hop (the caller asked for a *page*, not for the crawler's card rules).
async fn fetch_following<F, L, C, K>(
    ctx: &Ctx<'_, F, L, C, K>,
    url: &str,
    user_agent: &str,
    max_bytes: usize,
    accept: &str,
) -> Result<Response, Error>
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let mut current =
        Url::parse(url).ok_or_else(|| Error::Blocked(format!("{url} is not an http(s) URL")))?;
    for hop in 0..=ctx.opts.hops {
        let response = fetch_bytes(ctx, &current.href(), user_agent, max_bytes, accept).await?;
        if matches!(response.status, 301 | 302 | 303 | 307 | 308) {
            let Some(location) = response.header("location") else {
                return Err(Error::Unresolved {
                    code: "bad_redirect",
                    message: format!(
                        "{} answered {} with no Location",
                        current.href(),
                        response.status
                    ),
                });
            };
            let Some(next) = current.join(location) else {
                return Err(Error::Unresolved {
                    code: "bad_redirect",
                    message: format!("{} redirects to {location:?}", current.href()),
                });
            };
            if next.href() == current.href() {
                return Err(Error::Unresolved {
                    code: "redirect_loop",
                    message: format!("{} redirects to itself", current.href()),
                });
            }
            current = next;
            if hop == ctx.opts.hops {
                break;
            }
            continue;
        }
        if (200..300).contains(&response.status) {
            let html = response.text();
            if let Some(target) = cards::meta_refresh_target(&html, &current) {
                if target.href() != current.href() && hop < ctx.opts.hops {
                    current = target;
                    continue;
                }
            }
        }
        return Ok(response);
    }
    Err(Error::Unresolved {
        code: "too_many_redirects",
        message: format!("{url} did not settle within {} redirects", ctx.opts.hops),
    })
}

async fn fetch_bytes<F, L, C, K>(
    ctx: &Ctx<'_, F, L, C, K>,
    url: &str,
    user_agent: &str,
    max_bytes: usize,
    accept: &str,
) -> Result<Response, Error>
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let parsed =
        Url::parse(url).ok_or_else(|| Error::Blocked(format!("{url} is not an http(s) URL")))?;
    assert_fetchable(ctx, &parsed).await?;
    let timeout = Duration::from_millis(ctx.opts.timeout_ms);
    let request = Request {
        url: parsed.href(),
        method: Method::Get,
        headers: vec![
            ("user-agent".to_string(), user_agent.to_string()),
            ("accept".to_string(), accept.to_string()),
            ("accept-language".to_string(), "en-US,en;q=0.9".to_string()),
            ("connection".to_string(), "close".to_string()),
        ],
        redirect: Redirect::Manual,
        max_bytes,
        timeout,
        allow_private: ctx.allow_private(&parsed),
    };
    // Connection-level failures are worth one retry (CDNs reset pooled sockets;
    // docs/LINK-CARDS.md).
    let mut last_error = None;
    for _attempt in 0..3 {
        match ctx.fetch.fetch(request.clone()).await {
            Ok(response) => return Ok(response),
            Err(FetchError::Timeout) => {
                last_error = Some(Error::Unresolved {
                    code: "timeout",
                    message: format!("{} did not answer in time", parsed.href()),
                })
            }
            Err(FetchError::Blocked(reason)) => return Err(Error::Blocked(reason)),
            Err(FetchError::Transport(reason)) => last_error = Some(Error::Transport(reason)),
        }
    }
    Err(last_error.unwrap_or_else(|| Error::Transport("fetch failed".to_string())))
}

async fn assert_fetchable<F, L, C, K>(ctx: &Ctx<'_, F, L, C, K>, url: &Url) -> Result<(), Error>
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    if ctx.allow_private(url) {
        return Ok(());
    }
    let port = url.effective_port();
    let explicit = url.port.is_some();
    if explicit && port != 80 && port != 443 {
        return Err(Error::Address(format!(
            "{}:{} is not a default port",
            url.host, port
        )));
    }
    if let Some(ip) = url.host_ip() {
        if urlsafety::is_private_address(ip) {
            return Err(Error::Address(format!(
                "{} is a private or reserved address",
                url.host
            )));
        }
        return Ok(());
    }
    if let Some(lookup) = ctx.lookup {
        // Deliberately *not* memoized, unlike robots.txt below: `Lookup`'s
        // contract (fetch.rs) is that a host is re-resolved on every hop, so a
        // rebinding answer cannot survive a redirect. The system resolver
        // already caches, so the repeat costs a warm `getaddrinfo`.
        let addresses = lookup
            .lookup(&url.host)
            .await
            .map_err(|_| Error::Blocked(format!("{} does not resolve", url.host)))?;
        if addresses.is_empty() {
            return Err(Error::Blocked(format!("{} has no addresses", url.host)));
        }
        for address in addresses {
            if urlsafety::is_private_address(address) {
                return Err(Error::Address(format!(
                    "{} resolves to {address}, which is not a public address",
                    url.host
                )));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Cache helpers, base64 and the display form
// ---------------------------------------------------------------------------

async fn cache_get<F, L, C, K>(ctx: &Ctx<'_, F, L, C, K>, key: &str, ttl_ms: u64) -> Option<String>
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let cache = ctx.cache?;
    if ctx.opts.refresh {
        return None;
    }
    let entry = cache.get(key).await?;
    let now = ctx.now_ms();
    if ttl_ms > 0 && now > 0 {
        let age = now.saturating_sub(entry.stored_at_ms);
        if age > ttl_ms {
            return None;
        }
    }
    Some(entry.value)
}

async fn cache_set<F, L, C, K>(ctx: &Ctx<'_, F, L, C, K>, key: &str, value: &str)
where
    F: Fetch,
    L: Lookup,
    C: Cache,
    K: Clock,
{
    let Some(cache) = ctx.cache else {
        return;
    };
    cache
        .set(
            key,
            CacheEntry {
                value: value.to_string(),
                stored_at_ms: ctx.now_ms(),
            },
        )
        .await;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CachedLink {
    final_url: String,
    chain: Vec<Hop>,
    tags: BTreeMap<String, String>,
    meta: LinkMeta,
    image_url: Option<String>,
    notes: Vec<String>,
    #[serde(default)]
    error: Option<String>,
}

impl CachedLink {
    fn into_link(self, cached: bool) -> ResolvedLink {
        ResolvedLink {
            meta: self.meta,
            chain: self.chain,
            final_url: self.final_url,
            tags: self.tags,
            image_url: self.image_url,
            image: None,
            notes: self.notes,
            cached,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CachedImage {
    content_type: String,
    /// Base64, so one cache entry carries the bytes.
    data: String,
}

fn encode_cached_image(encoded: &str, content_type: &str) -> String {
    serde_json::to_string(&CachedImage {
        content_type: content_type.to_string(),
        data: encoded.to_string(),
    })
    .unwrap_or_default()
}

fn decode_cached_image(value: &str) -> Option<(Vec<u8>, String)> {
    let cached: CachedImage = serde_json::from_str(value).ok()?;
    Some((unb64(&cached.data)?, cached.content_type))
}

/// X's display form: `xeet-text`'s rule, on the URL that was actually reached.
pub fn display_url(href: &str) -> String {
    xeet_text::display_url(href)
}

/// Standard base64, padded. Nine lines of arithmetic instead of a dependency.
pub fn b64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Base64 decode, for the cache and for a test's own bytes.
pub fn unb64(text: &str) -> Option<Vec<u8>> {
    const REVERSE: [i8; 128] = {
        let mut table = [-1i8; 128];
        let mut index = 0;
        while index < 64 {
            let byte = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[index];
            table[byte as usize] = index as i8;
            index += 1;
        }
        table
    };
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for &byte in bytes {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let value = *REVERSE.get(byte as usize)?;
        if value < 0 {
            return None;
        }
        acc = (acc << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests;
