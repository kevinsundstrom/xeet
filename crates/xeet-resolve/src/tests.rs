//! The crate's tests: an in-memory [`Fetch`] and [`Lookup`], so `cargo test`
//! never touches the network.
//!
//! The fixtures are trimmed recordings of the real pages the JS crawler was
//! verified against on 2026-11-10 (`docs/LINK-CARDS.md`, `docs/MEDIA.md`): the
//! `t.co` 301 to the Vercel changelog, that page's `twitter:card`, the
//! bellingcat page that carries `twitter:card` but only Open Graph text, an X
//! post page with a video poster, and a `robots.txt` that denies one path.
//!
//! Async tests run on a 30-line `block_on` built on `std::task::Wake` — no
//! runtime dependency, which is the point of the crate.

use std::collections::BTreeMap;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};

use crate::fetch::*;
use crate::*;

// ---------------------------------------------------------------------------
// A minimal executor: every future here is ready on the first poll
// ---------------------------------------------------------------------------

struct NoopWaker;
impl Wake for NoopWaker {
    fn wake(self: Arc<Self>) {}
}

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(NoopWaker));
    let mut context = Context::from_waker(&waker);
    let mut future = Box::pin(future);
    for _ in 0..10_000 {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::yield_now(),
        }
    }
    panic!("the future never completed");
}

// ---------------------------------------------------------------------------
// The in-memory host
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Recorder {
    routes: BTreeMap<String, Response>,
    requests: Mutex<Vec<Request>>,
}

impl Recorder {
    fn new() -> Recorder {
        Recorder::default()
    }

    fn on(
        mut self,
        url: &str,
        status: u16,
        headers: &[(&str, &str)],
        body: impl Into<Vec<u8>>,
    ) -> Recorder {
        self.routes.insert(
            url.to_string(),
            Response {
                status,
                headers: headers
                    .iter()
                    .map(|(name, value)| (name.to_ascii_lowercase(), value.to_string()))
                    .collect(),
                body: body.into(),
                truncated: false,
                final_url: None,
            },
        );
        self
    }

    fn html(self, url: &str, body: &str) -> Recorder {
        self.on(
            url,
            200,
            &[("content-type", "text/html; charset=utf-8")],
            body,
        )
    }

    fn redirect(self, url: &str, status: u16, location: &str) -> Recorder {
        self.on(url, status, &[("location", location)], Vec::new())
    }

    fn png(self, url: &str, width: u32, height: u32) -> Recorder {
        self.on(
            url,
            200,
            &[("content-type", "image/png")],
            png_bytes(width, height),
        )
    }

    fn robots(mut self, origin: &str, body: &str) -> Recorder {
        self = self.on(
            &format!("{origin}/robots.txt"),
            200,
            &[("content-type", "text/plain")],
            body.as_bytes().to_vec(),
        );
        self
    }

    fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }

    fn requested_urls(&self) -> Vec<String> {
        self.requests()
            .into_iter()
            .map(|request| request.url)
            .collect()
    }
}

impl Fetch for Recorder {
    async fn fetch(&self, request: Request) -> Result<Response, FetchError> {
        self.requests.lock().unwrap().push(request.clone());
        self.routes
            .get(&request.url)
            .cloned()
            .map(|mut response| {
                if response.body.len() > request.max_bytes {
                    response.body.truncate(request.max_bytes);
                    response.truncated = true;
                }
                response
            })
            .ok_or_else(|| FetchError::Transport(format!("no route for {}", request.url)))
    }
}

struct PublicLookup;
impl Lookup for PublicLookup {
    async fn lookup(&self, _host: &str) -> Result<Vec<IpAddr>, LookupError> {
        Ok(vec![IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))])
    }
}

struct PrivateLookup;
impl Lookup for PrivateLookup {
    async fn lookup(&self, _host: &str) -> Result<Vec<IpAddr>, LookupError> {
        Ok(vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5))])
    }
}

#[derive(Default)]
struct MemoryCache {
    entries: Mutex<BTreeMap<String, CacheEntry>>,
}

impl Cache for MemoryCache {
    async fn get(&self, key: &str) -> Option<CacheEntry> {
        self.entries.lock().unwrap().get(key).cloned()
    }
    async fn set(&self, key: &str, entry: CacheEntry) {
        self.entries.lock().unwrap().insert(key.to_string(), entry);
    }
}

struct FixedClock(u64);
impl Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        self.0
    }
}

fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend_from_slice(&13u32.to_be_bytes());
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 2, 0, 0, 0]);
    bytes
}

async fn run(input: &str, opts: Options, host: &Recorder) -> Result<Resolved, Error> {
    resolve(
        input,
        opts,
        host,
        Some(&PublicLookup),
        None::<&MemoryCache>,
        None::<&FixedClock>,
    )
    .await
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

const TCO: &str = "https://t.co/jO01BMGwXr";
const VERCEL: &str = "https://vercel.com/changelog/vercel-daemons-is-now-in-public-beta";
const VERCEL_IMAGE: &str = "https://assets.vercel.com/image/upload/daemons-OG.png";
const BELLINGCAT: &str = "https://www.bellingcat.com/follow-bellingcat-on-social-media/";
const BELLINGCAT_IMAGE: &str =
    "https://www.bellingcat.com/app/uploads/2022/04/bellingcat_HP_logo_black.jpg";
const POST_ID: &str = "2119833829389041896";
const POST_URL: &str = "https://x.com/i/status/2119833829389041896";
const POSTER_BASE: &str =
    "https://pbs.twimg.com/amplify_video_thumb/2119833138889158657/img/tBwXGqHF9Nt0cudp.jpg";
const AVATAR_BASE: &str =
    "https://pbs.twimg.com/profile_images/1321163587679784960/0ZxKlEKB_normal.jpg";

const VERCEL_PAGE: &str = r#"<!DOCTYPE html><html><head>
<meta property="og:title" content="Vercel Daemons is now in public beta - Vercel">
<meta property="og:description" content="Vercel Daemons lets you run long-running processes that pull work from queues, databases, or third-party systems without an HTTP server. Now in Public Beta.">
<meta property="og:image" content="https://assets.vercel.com/image/upload/daemons-OG.png">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Vercel Daemons is now in public beta - Vercel">
<meta name="twitter:image" content="https://assets.vercel.com/image/upload/daemons-OG.png">
</head><body></body></html>"#;

const BELLINGCAT_PAGE: &str = r#"<html><head>
<meta name="twitter:card" content="summary_large_image">
<meta property="og:type" content="article">
<meta property="og:title" content="Follow Bellingcat on Social Media - bellingcat">
<meta property="og:description" content="Join our community and keep up to date with the latest Bellingcat news and investigations.">
<meta property="og:image" content="https://www.bellingcat.com/app/uploads/2022/04/bellingcat_HP_logo_black.jpg">
</head></html>"#;

fn post_page(rest_id: &str) -> String {
    let payload = serde_json::json!({
        "__typename": "Tweet",
        "rest_id": rest_id,
        "details": {
            "full_text": "A video post https://t.co/poster",
            "created_at_ms": 1762785296789i64,
            "display_text_range": [0, 12]
        },
        "core": { "user_results": { "result": {
            "core": { "name": "NASA", "screen_name": "NASA" },
            "verification": { "verified_type": "Government" },
            "avatar": { "image_url": AVATAR_BASE },
            "identity_profile_labels_highlighted_label": { "label": {
                "description": "Government Organization",
                "badge": { "url": "https://pbs.twimg.com/profile_images/1/badge_bigger.jpg" }
            } }
        } } },
        "media_entities2": [{
            "type": "video",
            "media_url_https": POSTER_BASE,
            "original_info": { "width": 3840, "height": 2160 },
            "video_info": { "duration_millis": 86708 }
        }],
        "url_entities": [{
            "url": "https://t.co/poster",
            "display_url": "example.com/poster",
            "expanded_url": "https://example.com/poster"
        }],
        "counts": { "reply_count": 10, "retweet_count": 20, "quote_count": 2, "favorite_count": 30, "bookmark_count": 1 },
        "views": { "count": 4000 }
    });
    let escaped = serde_json::to_string(&serde_json::to_string(&payload).unwrap()).unwrap();
    format!(
        r#"<html><head><script>window.__INITIAL_STATE__ = {escaped};</script></head><body><article></article></body></html>"#
    )
}

const POSTER_MEDIUM: &str = "https://pbs.twimg.com/amplify_video_thumb/2119833138889158657/img/tBwXGqHF9Nt0cudp?format=jpg&name=medium";
const POSTER_LARGE: &str = "https://pbs.twimg.com/amplify_video_thumb/2119833138889158657/img/tBwXGqHF9Nt0cudp?format=jpg&name=large";
const AVATAR_X96: &str =
    "https://pbs.twimg.com/profile_images/1321163587679784960/0ZxKlEKB_x96.jpg";
const AVATAR_RSMALL: &str =
    "https://pbs.twimg.com/profile_images/1321163587679784960/0ZxKlEKB_reasonably_small.jpg";
const BADGE: &str = "https://pbs.twimg.com/profile_images/1/badge_bigger.jpg";

fn recording_host() -> Recorder {
    Recorder::new()
        .redirect(TCO, 301, VERCEL)
        .html(VERCEL, VERCEL_PAGE)
        .png(VERCEL_IMAGE, 2400, 1256)
        .html(BELLINGCAT, BELLINGCAT_PAGE)
        .png(BELLINGCAT_IMAGE, 1200, 630)
        .html(POST_URL, &post_page(POST_ID))
        .png(POSTER_MEDIUM, 864, 486)
        .png(POSTER_LARGE, 1440, 810)
        .png(AVATAR_X96, 96, 96)
        .png(AVATAR_RSMALL, 128, 128)
        .png(BADGE, 73, 73)
        .robots("https://t.co", "User-agent: *\nDisallow:\n")
        .robots("https://vercel.com", "User-agent: Twitterbot\nDisallow:\n")
        .robots("https://www.bellingcat.com", "User-agent: *\nDisallow:\n")
        .robots("https://x.com", "User-agent: *\nDisallow:\n")
        .robots("https://pbs.twimg.com", "User-agent: *\nDisallow:\n")
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

#[test]
fn a_t_co_link_becomes_the_card_x_shows() {
    let host = recording_host();
    let mut opts = Options::default();
    opts.media = true;
    let resolved = block_on(run(&format!("daemons: {TCO}"), opts, &host)).unwrap();
    let link = resolved.links.get(TCO).expect("the t.co URL is resolved");
    assert_eq!(link.meta.card.as_deref(), Some("summary_large_image"));
    assert_eq!(
        link.meta.title.as_deref(),
        Some("Vercel Daemons is now in public beta - Vercel")
    );
    assert_eq!(link.meta.domain.as_deref(), Some("vercel.com"));
    let image = link
        .meta
        .image
        .as_ref()
        .expect("the card carries its image");
    assert_eq!((image.width, image.height), (2400, 1256));
    assert_eq!(link.chain.len(), 2);
    assert_eq!(link.chain[0].status, 301);
    assert_eq!(link.chain[1].status, 200);
    assert_eq!(link.final_url, VERCEL);
    // The display form is the *unshortened* URL, not `t.co/…`.
    assert_eq!(
        link.meta.display.as_deref(),
        Some("vercel.com/changelog/verc…")
    );
    // And it is keyed by the URL as written, which is what `rules` looks up.
    assert!(resolved.post.links.contains_key(TCO));

    // The crawler identifies itself, and the host never follows redirects.
    let requests = host.requests();
    assert!(requests
        .iter()
        .all(|request| request.redirect == Redirect::Manual));
    let tco_request = requests.iter().find(|request| request.url == TCO).unwrap();
    assert_eq!(
        tco_request
            .headers
            .iter()
            .find(|(name, _)| name == "user-agent")
            .map(|(_, value)| value.as_str()),
        Some(CRAWLER_USER_AGENT)
    );
    assert!(tco_request.headers.iter().all(|(name, _)| name != "cookie"));
}

#[test]
fn an_og_only_page_still_makes_a_card() {
    let host = recording_host();
    let resolved = block_on(run(
        "read this: https://www.bellingcat.com/follow-bellingcat-on-social-media/",
        Options::default(),
        &host,
    ))
    .unwrap();
    let link = resolved.links.get(BELLINGCAT).unwrap();
    assert_eq!(link.meta.card.as_deref(), Some("summary_large_image"));
    // `twitter:title` is absent; the page's `og:title` is what X's card carried.
    assert_eq!(
        link.meta.title.as_deref(),
        Some("Follow Bellingcat on Social Media - bellingcat")
    );
    assert_eq!(
        link.meta.image.as_ref().map(|image| image.width),
        Some(1200)
    );
}

#[test]
fn a_link_that_lands_on_an_x_post_has_no_card() {
    let host = Recorder::new()
        .redirect(
            "https://t.co/selflink",
            301,
            "https://twitter.com/espn/status/1/video/1",
        )
        .robots("https://t.co", "")
        .robots("https://twitter.com", "");
    let resolved = block_on(run(
        "watch https://t.co/selflink",
        Options::default(),
        &host,
    ))
    .unwrap();
    let link = resolved.links.get("https://t.co/selflink").unwrap();
    assert!(link.meta.card.is_none());
    assert_eq!(link.chain.len(), 1);
    assert!(link.notes.iter().any(|note| note.contains("X post")));
    // It never fetched the X page itself.
    assert!(!host
        .requested_urls()
        .iter()
        .any(|url| url.contains("twitter.com/espn")));
}

#[test]
fn robots_txt_is_honoured() {
    let host = Recorder::new()
        .robots("https://example.com", "User-agent: Twitterbot\nDisallow: /private\n")
        .html("https://example.com/private/page", "<meta name=\"twitter:card\" content=\"summary\">")
        .html("https://example.com/open", "<meta name=\"twitter:card\" content=\"summary\"><meta name=\"twitter:title\" content=\"ok\">");
    let resolved = block_on(run(
        "a https://example.com/private/page and https://example.com/open",
        Options::default(),
        &host,
    ))
    .unwrap();
    assert!(resolved
        .links
        .get("https://example.com/private/page")
        .is_none());
    assert!(resolved
        .warnings
        .iter()
        .any(|warning| warning.contains("robots.txt") && warning.contains("/private/page")));
    assert_eq!(
        resolved
            .links
            .get("https://example.com/open")
            .unwrap()
            .meta
            .title
            .as_deref(),
        Some("ok")
    );
}

#[test]
fn private_destinations_are_refused() {
    let host = recording_host();
    // xeet-text's parser does not treat an IP literal as a URL at all, so a
    // pasted `http://169.254.169.254/…` never even reaches the fetcher: there is
    // no entity, no link, and no request. (The guard still refuses the literal
    // on any path that does ask: see `urlsafety::tests`.)
    let resolved = block_on(run(
        "http://169.254.169.254/latest/meta-data/",
        Options::default(),
        &host,
    ))
    .unwrap();
    assert!(resolved.links.is_empty());
    assert!(host
        .requests()
        .iter()
        .all(|request| !request.url.contains("169.254")));
    // A hostname whose DNS answer is private is refused when a Lookup exists.
    let host = recording_host();
    let error = block_on(resolve(
        "internal.example.com/a",
        Options::default(),
        &host,
        Some(&PrivateLookup),
        None::<&MemoryCache>,
        None::<&FixedClock>,
    ))
    .unwrap();
    assert!(error
        .warnings
        .iter()
        .any(|warning| warning.contains("not a public address")));
}

#[test]
fn a_meta_refresh_redirect_is_followed() {
    let host = Recorder::new()
        .robots("https://t.co", "")
        .html(
            "https://t.co/interstitial",
            r#"<noscript><META http-equiv="refresh" content="0;URL=https://vercel.com/changelog/x"></noscript>"#,
        )
        .html(
            "https://vercel.com/changelog/x",
            "<meta name=\"twitter:card\" content=\"summary\"><meta name=\"twitter:title\" content=\"after refresh\">",
        )
        .robots("https://vercel.com", "");
    let resolved = block_on(run(
        "x https://t.co/interstitial",
        Options::default(),
        &host,
    ))
    .unwrap();
    let link = resolved.links.get("https://t.co/interstitial").unwrap();
    assert_eq!(link.meta.title.as_deref(), Some("after refresh"));
    assert!(link.notes.iter().any(|note| note.contains("refresh")));
}

#[test]
fn a_cached_link_is_not_fetched_again() {
    let host = recording_host();
    let cache = MemoryCache::default();
    let clock = FixedClock(1_000_000);
    let opts = Options::default();
    let first = block_on(resolve(
        &format!("x {TCO}"),
        opts.clone(),
        &host,
        None::<&PublicLookup>,
        Some(&cache),
        Some(&clock),
    ))
    .unwrap();
    let first_count = host.requests().len();
    assert!(!first.links.is_empty());
    let second = block_on(resolve(
        &format!("x {TCO}"),
        opts,
        &host,
        None::<&PublicLookup>,
        Some(&cache),
        Some(&clock),
    ))
    .unwrap();
    assert_eq!(
        host.requests().len(),
        first_count,
        "the second resolve must hit the cache"
    );
    assert!(second.links.get(TCO).unwrap().cached);
}

#[test]
fn plain_text_makes_no_requests() {
    let host = recording_host();
    let resolved = block_on(run("just words, no links", Options::default(), &host)).unwrap();
    assert_eq!(resolved.post.text, "just words, no links");
    assert!(resolved.links.is_empty());
    assert!(host.requests().is_empty());
}

#[test]
fn json_posts_are_validated_and_filled() {
    let host = recording_host();
    let json = format!(r#"{{"post":{{"text":"see {TCO}"}},"options":{{"width":390}}}}"#);
    let resolved = block_on(run(&json, Options::default(), &host)).unwrap();
    assert!(resolved.post.links.contains_key(TCO));
    // Strict validation still comes from the renderer's own parser.
    let bad = block_on(run(
        r#"{"post":{"text":"hi","auther":{}}}"#,
        Options::default(),
        &host,
    ));
    assert!(bad.is_err());
}

// ---------------------------------------------------------------------------
// An X post URL
// ---------------------------------------------------------------------------

#[test]
fn an_x_post_url_becomes_a_post_with_its_poster() {
    let host = recording_host();
    let mut opts = Options::default();
    opts.media = true;
    opts.width = 600.0;
    opts.dpr = 3.0;
    let resolved = block_on(run(POST_URL, opts, &host)).unwrap();

    assert_eq!(resolved.post.text, "A video post");
    assert_eq!(resolved.post.author.handle, "NASA");
    assert_eq!(
        resolved.post.author.verified,
        xeet_core::model::Verified::Government
    );
    assert_eq!(resolved.post.counts.as_ref().unwrap().reposts, 22);
    assert_eq!(resolved.source.id.as_deref(), Some(POST_ID));
    assert_eq!(resolved.source.app_version, None);
    assert!(resolved
        .source
        .page_html
        .as_deref()
        .unwrap()
        .contains("__INITIAL_STATE__"));

    // The poster frame is `Media::data`, at the variant a 600px column needs at
    // dpr 3 (`large`, per docs/MEDIA.md).
    let media = &resolved.post.media[0];
    assert_eq!(media.kind, xeet_core::model::MediaKind::Video);
    assert_eq!(media.duration, Some(86.708));
    assert!(media.data.is_some(), "the poster must be inlined");
    assert_eq!(
        resolved
            .media
            .get(POSTER_LARGE)
            .map(|asset| asset.variant.as_str()),
        Some("large")
    );
    // The avatar is the 3x size, and the badge is the payload's own URL.
    assert!(resolved.post.author.avatar.is_some());
    assert!(resolved
        .post
        .author
        .affiliate
        .as_ref()
        .unwrap()
        .badge
        .is_some());
    assert!(resolved.media.contains_key(AVATAR_RSMALL));
    assert!(resolved.media.contains_key(BADGE));
}

#[test]
fn a_404_page_is_an_error_and_a_missing_payload_is_not_found() {
    let host = Recorder::new().robots("https://x.com", "").html(
        "https://x.com/i/status/2",
        "<html><body>no payload here</body></html>",
    );
    let error = block_on(run(
        "https://x.com/someone/status/2",
        Options::default(),
        &host,
    ))
    .unwrap_err();
    assert_eq!(error.code(), "not_found");
    assert_eq!(error.status(), 404);
}

#[test]
fn an_oversize_page_is_truncated_and_noted() {
    let host = Recorder::new()
        .robots("https://example.com", "")
        .html(
            "https://example.com/big",
            &format!(
                "<html><head><meta name=\"twitter:card\" content=\"summary\"><meta name=\"twitter:title\" content=\"big\"></head><body>{}</body></html>",
                "x".repeat(200_000)
            ),
        );
    let mut opts = Options::default();
    opts.html_bytes = 64 * 1024;
    let resolved = block_on(run("x https://example.com/big", opts, &host)).unwrap();
    let link = resolved.links.get("https://example.com/big").unwrap();
    assert_eq!(link.meta.title.as_deref(), Some("big"));
    assert!(link.notes.iter().any(|note| note.contains("larger than")));
}

#[test]
fn the_display_form_matches_xeet_text() {
    assert_eq!(
        display_url("https://vercel.com/changelog/vercel-daemons-is-now-in-public-beta"),
        "vercel.com/changelog/verc…"
    );
    assert_eq!(
        display_url("https://vercel.com/for/platforms"),
        "vercel.com/for/platforms"
    );
}

#[test]
fn base64_round_trips() {
    for bytes in [&b""[..], b"f", b"fo", b"foo", b"foobar"] {
        assert_eq!(unb64(&b64(bytes)).unwrap(), bytes);
    }
    assert!(b64(b"\x89PNG\r\n\x1a\n").starts_with("iVBORw0KGgo"));
}

// ---------------------------------------------------------------------------
// Quotes from text
// ---------------------------------------------------------------------------

const QUOTED_ID: &str = "2118152230260092940";
const QUOTED_URL: &str = "https://x.com/i/status/2118152230260092940";

fn quoted_page() -> String {
    let payload = serde_json::json!({
        "__typename": "Tweet",
        "rest_id": QUOTED_ID,
        "details": { "full_text": "the original post", "created_at_ms": 1762000000000i64, "display_text_range": [0, 17] },
        "core": { "user_results": { "result": {
            "core": { "name": "Guillermo Rauch", "screen_name": "rauchg" },
            "verification": { "is_blue_verified": true },
            "avatar": { "image_url": "https://pbs.twimg.com/profile_images/9/abc_normal.jpg" }
        } } },
        "media_entities2": [{
            "type": "photo",
            "media_url_https": "https://pbs.twimg.com/media/QUOTED.jpg",
            "original_info": { "width": 1200, "height": 800 }
        }],
        // A quoted post that itself quotes: that is `post.quote.quote` (level 2),
        // drawn by X's nested preview with a 16 px avatar and one thumbnail.
        "quoted_tweet_results": { "result": {
            "__typename": "Tweet",
            "rest_id": "1000",
            "details": { "full_text": "the inner post", "created_at_ms": 1761900000000i64 },
            "core": { "user_results": { "result": {
                "core": { "name": "Inner", "screen_name": "inner" },
                "verification": { "verified_type": "Business" },
                "avatar": { "image_url": "https://pbs.twimg.com/profile_images/77/inner_normal.jpg" },
                "identity_profile_labels_highlighted_label": { "label": {
                    "description": "Inner org",
                    "badge": { "url": "https://pbs.twimg.com/profile_images/77/badge_bigger.jpg" }
                } }
            } } },
            "media_entities2": [{
                "type": "photo",
                "media_url_https": "https://pbs.twimg.com/media/INNER.jpg",
                "original_info": { "width": 1280, "height": 720 },
                "ext_alt_text": "the inner photo"
            }]
        } },
        "counts": { "reply_count": 1, "retweet_count": 2, "quote_count": 3, "favorite_count": 4 },
        "views": { "count": 5 }
    });
    let escaped = serde_json::to_string(&serde_json::to_string(&payload).unwrap()).unwrap();
    format!(r#"<html><head><script>window.__INITIAL_STATE__ = {escaped};</script></head></html>"#)
}

const QUOTED_QUOTE_SMALL: &str = "https://pbs.twimg.com/media/INNER?format=jpg&name=small";
const QUOTED_QUOTE_AVATAR: &str = "https://pbs.twimg.com/profile_images/77/inner_normal.jpg";
const QUOTED_QUOTE_BADGE: &str = "https://pbs.twimg.com/profile_images/77/badge_bigger.jpg";
const QUOTED_AVATAR_X96: &str = "https://pbs.twimg.com/profile_images/9/abc_x96.jpg";
const QUOTED_AVATAR_NORMAL: &str = "https://pbs.twimg.com/profile_images/9/abc_normal.jpg";
const QUOTED_MEDIUM: &str = "https://pbs.twimg.com/media/QUOTED?format=jpg&name=medium";
const QUOTED_LARGE: &str = "https://pbs.twimg.com/media/QUOTED?format=jpg&name=large";

fn quote_host() -> Recorder {
    recording_host()
        .html(QUOTED_URL, &quoted_page())
        .png(QUOTED_MEDIUM, 960, 640)
        .png(QUOTED_LARGE, 1200, 800)
        .png(QUOTED_AVATAR_X96, 96, 96)
        .png(QUOTED_AVATAR_NORMAL, 48, 48)
        // The nested preview's thumbnail and avatar (a 64 px square and a 16 px
        // chip, so the `small` variant and `_normal` avatar cover every dpr).
        .png(QUOTED_QUOTE_SMALL, 680, 383)
        .png(QUOTED_QUOTE_AVATAR, 48, 48)
        .png(QUOTED_QUOTE_BADGE, 73, 73)
}

#[test]
fn a_trailing_status_url_becomes_the_quote() {
    let host = quote_host();
    let mut opts = Options::default();
    opts.media = true;
    opts.width = 600.0;
    opts.dpr = 2.0;
    let draft = format!("this is so good\n\n{QUOTED_URL}");
    let resolved = block_on(run(&draft, opts, &host)).unwrap();

    let quote = resolved
        .post
        .quote
        .as_ref()
        .expect("the trailing URL is a quote");
    assert_eq!(quote.text, "the original post");
    assert_eq!(quote.author.handle, "rauchg");
    // `Media::data` holds the quoted post's photo, at the quote's own slot size.
    assert_eq!(quote.media.len(), 1);
    assert!(
        quote.media[0].data.is_some(),
        "the quoted photo must be inlined"
    );
    assert_eq!(
        resolved
            .media
            .get(QUOTED_MEDIUM)
            .map(|asset| asset.role.as_str()),
        Some("quoted media:0")
    );
    assert!(quote.author.avatar.is_some());

    // Two levels: `post.quote.quote` is the quoted post's own quote (X's nested
    // preview), and a third would be dropped.
    let nested = quote
        .quote
        .as_ref()
        .expect("the quoted post's own quote is level 2");
    assert_eq!(nested.text, "the inner post");
    assert_eq!(nested.author.handle, "inner");
    assert_eq!(nested.author.verified, xeet_core::model::Verified::Business);
    assert_eq!(
        nested.author.affiliate.as_ref().map(|a| a.name.as_str()),
        Some("Inner org")
    );
    assert_eq!(nested.media.len(), 1);
    assert_eq!(nested.media[0].alt.as_deref(), Some("the inner photo"));
    assert!(
        nested.media[0].data.is_some(),
        "the nested quote's first media item is inlined"
    );
    assert!(
        nested.author.avatar.is_some(),
        "the 16 px avatar is inlined"
    );
    assert!(
        nested.author.affiliate.as_ref().unwrap().badge.is_some(),
        "the nested author's badge is inlined"
    );
    // Roles name the slot, so the oracle can serve Chrome the same bytes.
    assert_eq!(
        resolved
            .media
            .get(QUOTED_QUOTE_SMALL)
            .map(|asset| asset.role.as_str()),
        Some("quoted quoted media:0")
    );
    assert_eq!(
        resolved
            .media
            .get(QUOTED_QUOTE_SMALL)
            .map(|asset| asset.variant.as_str()),
        Some("small")
    );
    assert_eq!(
        resolved
            .media
            .get(QUOTED_QUOTE_AVATAR)
            .map(|asset| asset.role.as_str()),
        Some("quoted quoted avatar")
    );
    assert_eq!(
        resolved
            .media
            .get(QUOTED_QUOTE_BADGE)
            .map(|asset| asset.role.as_str()),
        Some("quoted quoted badge")
    );
    assert!(
        nested.quote.is_none(),
        "a third level is dropped, as X's preview stops at two"
    );
    // The URL is still a known link (rules hides it once the handle matches).
    assert!(resolved.post.links.contains_key(QUOTED_URL));
    assert_eq!(resolved.post.links[QUOTED_URL].card, None);
}

#[test]
fn a_status_url_mid_sentence_is_not_a_quote() {
    let host = quote_host();
    let draft = format!("{QUOTED_URL} is a link, not a quote");
    let resolved = block_on(run(&draft, Options::default(), &host)).unwrap();
    assert!(resolved.post.quote.is_none());
    assert!(!host
        .requested_urls()
        .iter()
        .any(|url| url.contains(QUOTED_ID)));
}

#[test]
fn share_sheet_suffixes_still_quote() {
    let host = Recorder::new()
        .robots("https://x.com", "")
        .html(QUOTED_URL, &quoted_page());
    for variant in [
        "https://twitter.com/rauchg/status/2118152230260092940?s=20&t=abc",
        "https://mobile.twitter.com/rauchg/status/2118152230260092940?s=20",
        "https://x.com/i/web/status/2118152230260092940",
        "https://www.x.com/rauchg/statuses/2118152230260092940",
    ] {
        let resolved = block_on(run(
            &format!("look at this\n\n{variant}"),
            Options::default(),
            &host,
        ))
        .unwrap();
        assert!(
            resolved.post.quote.is_some(),
            "{variant} should be the quote"
        );
    }
}

// ---------------------------------------------------------------------------
// Two levels of quotes, on a post URL
// ---------------------------------------------------------------------------

/// The shape of `elonmusk.html:2119812607117062451`: the root quotes a post that
/// quotes another, and the second level arrives twice — a six-key stub in
/// `quoted_tweet_results`, the real post in `nested_quoted_tweet_results`. The
/// real copy has a *video* (so `Media::data` must be its poster) and a third
/// level, which has to be dropped.
const NESTED_ROOT_ID: &str = "2119812607117062451";
const NESTED_ROOT_URL: &str = "https://x.com/i/status/2119812607117062451";
const QUOTER_ID: &str = "2119805979583828413";
const INNER_POST_ID: &str = "2119802588841316632";
const DEEPEST_ID: &str = "2119000000000000001";
const QUOTER_PHOTO_SMALL: &str = "https://pbs.twimg.com/media/QUOTER?format=jpg&name=small";
const QUOTER_AVATAR_X96: &str = "https://pbs.twimg.com/profile_images/42/quoter_x96.jpg";
const INNER_POSTER_SMALL: &str =
    "https://pbs.twimg.com/amplify_video_thumb/9/inner?format=jpg&name=small";
const INNER_AVATAR_NORMAL: &str = "https://pbs.twimg.com/profile_images/24/inner_normal.jpg";
const INNER_BADGE_BIGGER: &str = "https://pbs.twimg.com/profile_images/24/badge_bigger.jpg";

fn nested_root_page() -> String {
    let inner_stub = serde_json::json!({
        "__typename": "Tweet",
        "rest_id": INNER_POST_ID,
        "id": INNER_POST_ID
    });
    let inner_rich = serde_json::json!({
        "__typename": "Tweet",
        "rest_id": INNER_POST_ID,
        "details": {
            "full_text": "Tesla has started the Earthworks for Project X",
            "created_at_ms": 1762700000000i64
        },
        "core": { "user_results": { "result": {
            "core": { "name": "SERobinsonJr", "screen_name": "SERobinsonJr" },
            "verification": { "is_blue_verified": true },
            "avatar": { "image_url": INNER_AVATAR_NORMAL },
            "identity_profile_labels_highlighted_label": { "label": {
                "description": "Tesla",
                "badge": { "url": INNER_BADGE_BIGGER }
            } }
        } } },
        "media_entities2": [{
            "type": "video",
            "media_url_https": "https://pbs.twimg.com/amplify_video_thumb/9/inner.jpg",
            "original_info": { "width": 2560, "height": 1440 },
            "video_info": { "duration_millis": 42500 }
        }],
        // A third level: present in the payload, dropped by the resolver.
        "quoted_tweet_results": { "result": {
            "__typename": "Tweet",
            "rest_id": DEEPEST_ID,
            "details": { "full_text": "the deepest post" },
            "core": { "user_results": { "result": { "core": { "name": "Deep", "screen_name": "deep" } } } }
        } }
    });
    let quoter = serde_json::json!({
        "__typename": "Tweet",
        "rest_id": QUOTER_ID,
        "details": { "full_text": "Tesla has officially started construction", "created_at_ms": 1762750000000i64 },
        "core": { "user_results": { "result": {
            "core": { "name": "Sawyer Merritt", "screen_name": "SawyerMerritt" },
            "avatar": { "image_url": "https://pbs.twimg.com/profile_images/42/quoter_normal.jpg" }
        } } },
        "media_entities2": [{
            "type": "photo",
            "media_url_https": "https://pbs.twimg.com/media/QUOTER.jpg",
            "original_info": { "width": 1600, "height": 900 }
        }],
        // X's two slots at depth 2: a stub, and the real post.
        "quoted_tweet_results": { "result": inner_stub },
        "nested_quoted_tweet_results": { "result": inner_rich }
    });
    let root = serde_json::json!({
        "__typename": "Tweet",
        "rest_id": NESTED_ROOT_ID,
        "details": { "full_text": "Wow https://t.co/nested", "created_at_ms": 1762785296789i64 },
        "core": { "user_results": { "result": {
            "core": { "name": "Elon Musk", "screen_name": "elonmusk" },
            "verification": { "is_blue_verified": true }
        } } },
        "quoted_tweet_results": { "result": quoter },
        "url_entities": [{ "url": "https://t.co/nested", "display_url": "x.com/someone/status…" }]
    });
    let escaped = serde_json::to_string(&serde_json::to_string(&root).unwrap()).unwrap();
    format!(r#"<html><head><script>window.__INITIAL_STATE__ = {escaped};</script></head></html>"#)
}

fn nested_host() -> Recorder {
    Recorder::new()
        .robots("https://x.com", "")
        .robots("https://t.co", "")
        .robots("https://pbs.twimg.com", "")
        .html(NESTED_ROOT_URL, &nested_root_page())
        .png(QUOTER_PHOTO_SMALL, 680, 383)
        .png(QUOTER_AVATAR_X96, 96, 96)
        .png(INNER_POSTER_SMALL, 680, 383)
        .png(INNER_AVATAR_NORMAL, 48, 48)
        .png(INNER_BADGE_BIGGER, 73, 73)
}

#[test]
fn a_post_url_reads_the_rich_nested_payload_not_the_stub() {
    let host = nested_host();
    let mut opts = Options::default();
    opts.media = true;
    opts.width = 390.0;
    opts.dpr = 2.0;
    let resolved = block_on(run(NESTED_ROOT_URL, opts, &host)).unwrap();

    let quoter = resolved.post.quote.as_ref().expect("level 1");
    assert_eq!(quoter.author.handle, "SawyerMerritt");
    assert_eq!(quoter.text, "Tesla has officially started construction");
    assert_eq!(quoter.media.len(), 1);
    assert!(quoter.media[0].data.is_some(), "the quoting post's photo");

    let inner = quoter.quote.as_ref().expect("level 2");
    assert_eq!(inner.author.handle, "SERobinsonJr");
    // The stub has no text: taking it would have produced an empty quote.
    assert_eq!(inner.text, "Tesla has started the Earthworks for Project X");
    assert_eq!(
        inner.created_at.as_deref(),
        Some("2025-11-09T14:53:20.000Z")
    );
    assert_eq!(inner.media.len(), 1);
    assert_eq!(inner.media[0].kind, xeet_core::model::MediaKind::Video);
    assert_eq!(inner.media[0].duration, Some(42.5));
    assert!(inner.media[0].data.is_some(), "a video's poster frame");
    assert!(inner.author.avatar.is_some());
    assert_eq!(
        inner.author.affiliate.as_ref().map(|a| a.name.as_str()),
        Some("Tesla")
    );
    assert!(inner.author.affiliate.as_ref().unwrap().badge.is_some());
    assert!(inner.quote.is_none(), "a third level is dropped");

    // Neither the stub nor the deepest post was fetched or modeled.
    let requested = host.requested_urls();
    assert!(!requested.iter().any(|url| url.contains(DEEPEST_ID)));

    // Roles: level 1 under `quoted `, level 2 under `quoted quoted `.
    assert_eq!(
        resolved
            .media
            .get(QUOTER_PHOTO_SMALL)
            .map(|asset| asset.role.as_str()),
        Some("quoted media:0")
    );
    assert_eq!(
        resolved
            .media
            .get(INNER_POSTER_SMALL)
            .map(|asset| asset.role.as_str()),
        Some("quoted quoted media:0")
    );
    assert_eq!(
        resolved
            .media
            .get(INNER_AVATAR_NORMAL)
            .map(|asset| asset.role.as_str()),
        Some("quoted quoted avatar")
    );
    assert_eq!(
        resolved
            .media
            .get(INNER_BADGE_BIGGER)
            .map(|asset| asset.role.as_str()),
        Some("quoted quoted badge")
    );
    // X's nested row is 64 px wide: `small` and the 48 px avatar are the right
    // sizes at dpr 2, not `medium`/`large`.
    assert_eq!(
        resolved
            .media
            .get(INNER_POSTER_SMALL)
            .map(|asset| asset.variant.as_str()),
        Some("small")
    );
    assert_eq!(
        resolved
            .media
            .get(INNER_AVATAR_NORMAL)
            .map(|asset| asset.variant.as_str()),
        Some("_normal")
    );
}

#[test]
fn post_json_keeps_its_nested_quote_and_its_bytes() {
    let host = recording_host();
    // A post JSON is already a model: the resolver fills links, and must not
    // flatten a quote of a quote (or touch bytes the caller supplied).
    let json = serde_json::json!({
        "post": {
            "text": "look at this",
            "quote": {
                "text": "the quoted post",
                "author": { "name": "Quoter", "handle": "quoter" },
                "quote": {
                    "text": "the quoted post's own quote",
                    "createdAt": "2026-11-09T14:53:20.000Z",
                    "author": { "name": "Inner", "handle": "inner" },
                    "media": [{ "kind": "image", "width": 64, "height": 64, "data": "AAAA" }]
                }
            }
        }
    })
    .to_string();
    let resolved = block_on(run(&json, Options::default(), &host)).unwrap();
    let level2 = resolved
        .post
        .quote
        .as_ref()
        .and_then(|quote| quote.quote.as_ref())
        .expect("post.quote.quote survives");
    assert_eq!(level2.text, "the quoted post's own quote");
    assert_eq!(level2.author.handle, "inner");
    assert_eq!(level2.media[0].data.as_deref(), Some("AAAA"));
    assert!(level2.quote.is_none());
    assert!(host.requests().is_empty());

    // Three levels is the renderer's own error (`Limits::max_quote_depth`), and
    // the resolver reports it rather than quietly cutting the tree.
    let too_deep = serde_json::json!({
        "post": {
            "text": "look at this",
            "quote": { "text": "one", "quote": { "text": "two", "quote": { "text": "three" } } }
        }
    })
    .to_string();
    let error = block_on(run(&too_deep, Options::default(), &host)).unwrap_err();
    assert!(matches!(error, Error::Invalid(_)), "got {error:?}");
    assert!(
        error.message().contains("quote depth 3"),
        "the message names the level: {}",
        error.message()
    );
}

// ---------------------------------------------------------------------------
// One post, several SSR copies
// ---------------------------------------------------------------------------

/// `x.com/cursor_ai/status/2118458629091426304` (captured 2026-11-10): X's detail
/// page ships the post **three** times. The first and third copies carry the
/// full author (`profile_image_shape: "Square"`, the affiliation label with its
/// badge); the second is the client-extension fragment — identical `full_text`
/// and `media_entities2`, but a `user_results` with no shape and no label.
///
/// The old rule ("the later copy wins on a tie") replaced the real copy with the
/// fragment, so the playground drew a round avatar and no gold badge for a
/// square, affiliated account.
const CURSOR_ID: &str = "2118458629091426304";
const CURSOR_URL: &str = "https://x.com/i/status/2118458629091426304";
const CURSOR_TEXT: &str =
    "Meet Cursor 2.0: our new agent-centric model, built to work on real projects with you.";
const CURSOR_AVATAR: &str =
    "https://pbs.twimg.com/profile_images/2014362901854085120/4V5n0JpK_x96.jpg";
const CURSOR_BADGE: &str =
    "https://pbs.twimg.com/profile_images/1952577914431614976/7oa09r3Y_bigger.jpg";
const CURSOR_PHOTO_MEDIUM: &str = "https://pbs.twimg.com/media/CURSOR?format=jpg&name=medium";
const CURSOR_PHOTO_LARGE: &str = "https://pbs.twimg.com/media/CURSOR?format=jpg&name=large";

fn cursor_copy(rich: bool) -> serde_json::Value {
    let user = if rich {
        serde_json::json!({
            "__typename": "User",
            "id": "VXNlcjox",
            "rest_id": "1",
            "core": { "name": "Cursor", "screen_name": "cursor_ai" },
            "avatar": { "image_url": "https://pbs.twimg.com/profile_images/2014362901854085120/4V5n0JpK_normal.jpg" },
            "verification": { "verified_type": "Business", "is_blue_verified": true },
            "profile_image_shape": "Square",
            "identity_profile_labels_highlighted_label": { "label": {
                "description": "Cursor",
                "badge": { "url": CURSOR_BADGE }
            } }
        })
    } else {
        // The client-extension fragment: same identity, none of the drawing data.
        serde_json::json!({
            "__typename": "User",
            "id": "VXNlcjox",
            "rest_id": "1",
            "core": { "name": "Cursor", "screen_name": "cursor_ai" },
            "avatar": { "image_url": "https://pbs.twimg.com/profile_images/2014362901854085120/4V5n0JpK_normal.jpg" },
            "verification": { "is_blue_verified": true }
        })
    };
    serde_json::json!({
        "__typename": "Tweet",
        "rest_id": CURSOR_ID,
        "details": {
            // Identical text: this is what made the score a tie.
            "full_text": CURSOR_TEXT,
            "created_at_ms": 1762380000000i64,
            "display_text_range": [0, CURSOR_TEXT.chars().count()]
        },
        "core": { "user_results": { "result": user } },
        "media_entities2": [{
            "type": "photo",
            "media_url_https": "https://pbs.twimg.com/media/CURSOR.jpg",
            "original_info": { "width": 2048, "height": 1152 }
        }],
        "counts": { "reply_count": 210, "retweet_count": 480, "quote_count": 90, "favorite_count": 5200 },
        "views": { "count": 400000 }
    })
}

/// The page: rich copy, slim fragment, rich copy — in that order, each in its own
/// escaped JSON chunk, as the server render ships them.
fn cursor_page() -> String {
    let chunks: Vec<String> = [true, false, true]
        .iter()
        .map(|rich| {
            let escaped =
                serde_json::to_string(&serde_json::to_string(&cursor_copy(*rich)).unwrap())
                    .unwrap();
            format!(r#"<script>__CHUNK__ = {escaped};</script>"#)
        })
        .collect();
    format!("<html><head>{}</head><body></body></html>", chunks.join(""))
}

#[test]
fn a_slim_ssr_copy_does_not_wipe_the_author_metadata() {
    let host = recording_host()
        .robots("https://pbs.twimg.com", "")
        .html(CURSOR_URL, &cursor_page())
        .png(CURSOR_AVATAR, 96, 96)
        .png(CURSOR_BADGE, 73, 73)
        // One media slot at 600 px / dpr 2 is a 908 px box: `medium` (1200w).
        .png(CURSOR_PHOTO_MEDIUM, 1200, 675)
        .png(CURSOR_PHOTO_LARGE, 2048, 1152);

    // The three copies collapse to one payload.
    let payloads = post::extract_payloads(&cursor_page());
    assert_eq!(payloads.len(), 1, "one post, three chunks → one payload");
    assert_eq!(
        payloads[0]
            .pointer("/core/user_results/result/profile_image_shape")
            .and_then(serde_json::Value::as_str),
        Some("Square"),
        "the kept payload has the author metadata"
    );

    let mut opts = Options::default();
    opts.media = true;
    opts.width = 600.0;
    opts.dpr = 2.0;
    let resolved = block_on(run(CURSOR_URL, opts, &host)).unwrap();
    let author = &resolved.post.author;
    assert_eq!(author.handle, "cursor_ai");
    assert_eq!(author.name, "Cursor");
    assert!(
        author.square_avatar,
        "the square avatar survives the slim copy"
    );
    let affiliate = author
        .affiliate
        .as_ref()
        .expect("the affiliation label survives the slim copy");
    assert_eq!(affiliate.name, "Cursor");
    assert!(affiliate.badge.is_some(), "the badge image is inlined");
    assert!(
        resolved.media.contains_key(CURSOR_BADGE),
        "and it is in source.media for the page's own requests"
    );
    // The text and the media are the post's, not a fragment's leftovers.
    assert_eq!(resolved.post.text, CURSOR_TEXT);
    assert_eq!(resolved.post.media.len(), 1);
    assert!(resolved.post.media[0].data.is_some());
}

// ---------------------------------------------------------------------------
// "Post video" / "Post photo" and direct twimg URLs
// ---------------------------------------------------------------------------

const ATTACH_ID: &str = "2118458629091426304";
const ATTACH_URL: &str = "https://x.com/i/status/2118458629091426304";
const ATTACH_POSTER: &str = "https://pbs.twimg.com/amplify_video_thumb/1/img/POSTER.jpg";
const ATTACH_POSTER_MEDIUM: &str =
    "https://pbs.twimg.com/amplify_video_thumb/1/img/POSTER?format=jpg&name=medium";
const ATTACH_AVATAR: &str = "https://pbs.twimg.com/profile_images/1/abc_normal.jpg";

/// A post with one video, by `cursor_ai` — what a `/video/1` link points at.
fn attach_page(handle: &str, source: Option<&str>) -> String {
    let mut media = serde_json::json!({
        "type": "video",
        "media_url_https": ATTACH_POSTER,
        "original_info": { "width": 1280, "height": 720 },
        "video_info": { "duration_millis": 42000 },
        "ext_alt_text": "a terminal full of code"
    });
    if let Some(source_handle) = source {
        media["source_user_results"] = serde_json::json!({
            "result": {
                "__typename": "User",
                "rest_id": "4242",
                "core": { "name": "NFL", "screen_name": source_handle },
                "avatar": { "image_url": "https://pbs.twimg.com/profile_images/9/nfl_normal.jpg" },
                "verification": { "verified_type": "Business", "is_blue_verified": true },
                "profile_image_shape": "Square"
            }
        });
    }
    let payload = serde_json::json!({
        "__typename": "Tweet",
        "rest_id": ATTACH_ID,
        "details": { "full_text": "the original post", "created_at_ms": 1762380000000i64 },
        "core": { "user_results": { "result": {
            "core": { "name": "Cursor", "screen_name": handle },
            "avatar": { "image_url": ATTACH_AVATAR },
            "verification": { "is_blue_verified": true }
        } } },
        "media_entities2": [media],
        "counts": { "reply_count": 1, "retweet_count": 2, "quote_count": 3, "favorite_count": 4 }
    });
    let escaped = serde_json::to_string(&serde_json::to_string(&payload).unwrap()).unwrap();
    format!(r#"<html><head><script>window.__STATE__ = {escaped};</script></head></html>"#)
}

fn attach_host(handle: &str, source: Option<&str>) -> Recorder {
    Recorder::new()
        .robots("https://x.com", "")
        .html(ATTACH_URL, &attach_page(handle, source))
        .png(ATTACH_POSTER_MEDIUM, 1280, 720)
        .png(ATTACH_AVATAR, 48, 48)
        .png(
            "https://pbs.twimg.com/profile_images/9/nfl_normal.jpg",
            48,
            48,
        )
}

fn attach_options() -> Options {
    let mut opts = Options::default();
    opts.media = true;
    opts.width = 600.0;
    opts.dpr = 2.0;
    opts
}

#[test]
fn a_status_video_url_becomes_post_media_not_a_quote() {
    let host = attach_host("cursor_ai", None);
    let input = format!("look at this https://x.com/cursor_ai/status/{ATTACH_ID}/video/1");
    let resolved = block_on(run(&input, attach_options(), &host)).unwrap();

    assert!(
        resolved.post.quote.is_none(),
        "Post video is not a Quote Tweet"
    );
    assert_eq!(resolved.post.media.len(), 1, "the item becomes post media");
    let media = &resolved.post.media[0];
    assert_eq!(media.kind, xeet_core::model::MediaKind::Video);
    assert_eq!((media.width, media.height), (1280, 720));
    assert_eq!(media.duration, Some(42.0));
    assert_eq!(media.alt.as_deref(), Some("a terminal full of code"));
    assert!(media.data.is_some(), "the poster frame is inlined");
    // The original author is credited, with their picture at the 16 px size.
    let source = media.source_author.as_ref().expect("source_author is set");
    assert_eq!(source.handle, "cursor_ai");
    assert!(
        source.avatar.is_some(),
        "the source author's avatar is inlined"
    );
    let source_avatar = resolved
        .media
        .values()
        .find(|asset| asset.role == "media:0 source avatar")
        .expect("role media:0 source avatar");
    assert_eq!(source_avatar.variant, "_normal");
    // The poster is the outer post's slot, and the URL is a link with no card.
    assert!(resolved.media.values().any(|asset| asset.role == "media:0"));
    let link = resolved
        .post
        .links
        .get(&input["look at this ".len()..])
        .expect("the URL is in post.links");
    assert_eq!(link.card, None);
}

#[test]
fn the_same_status_url_without_the_suffix_is_still_a_quote() {
    let host = attach_host("cursor_ai", None);
    let input = format!("look at this\n\nhttps://x.com/cursor_ai/status/{ATTACH_ID}");
    let resolved = block_on(run(&input, attach_options(), &host)).unwrap();
    assert!(
        resolved.post.quote.is_some(),
        "a plain status URL is a Quote Tweet"
    );
    assert!(resolved.post.media.is_empty(), "and it carries no media");
}

#[test]
fn payload_media_credits_the_post_it_came_from() {
    let host = attach_host("espn", Some("NFL"));
    let resolved = block_on(run(ATTACH_URL, attach_options(), &host)).unwrap();
    let media = &resolved.post.media[0];
    let source = media
        .source_author
        .as_ref()
        .expect("source_user_results is read");
    assert_eq!(source.handle, "NFL");
    assert_eq!(source.name, "NFL");
    assert_eq!(source.verified, xeet_core::model::Verified::Business);
    assert!(source.square_avatar);
    assert!(source.avatar.is_some(), "the source avatar is inlined");
    assert_eq!(
        resolved
            .media
            .values()
            .find(|asset| asset.role == "media:0 source avatar")
            .map(|asset| asset.variant.as_str()),
        Some("_normal")
    );
}

#[test]
fn direct_twimg_urls_are_attached_without_fetching_the_video() {
    // A video file: the size comes from the path, and nothing is downloaded.
    let host = attach_host("cursor_ai", None);
    let video = "https://video.twimg.com/amplify_video/123/vid/avc1/864x1080/clip.mp4";
    let resolved = block_on(run(&format!("watch {video}"), attach_options(), &host)).unwrap();
    assert_eq!(resolved.post.media.len(), 1);
    let media = &resolved.post.media[0];
    assert_eq!(media.kind, xeet_core::model::MediaKind::Video);
    assert_eq!((media.width, media.height), (864, 1080));
    assert!(
        media.data.is_none(),
        "a video URL carries no poster of its own"
    );
    assert!(
        !host.requested_urls().iter().any(|url| url.contains(".mp4")),
        "the stream is never fetched: {:?}",
        host.requested_urls()
    );

    // A photo: inlined at the outer slot's variant.
    let photo = "https://pbs.twimg.com/media/ABC.jpg";
    let host = attach_host("cursor_ai", None).png(
        "https://pbs.twimg.com/media/ABC?format=jpg&name=medium",
        1600,
        900,
    );
    let resolved = block_on(run(&format!("look {photo}"), attach_options(), &host)).unwrap();
    assert_eq!(resolved.post.media.len(), 1);
    let media = &resolved.post.media[0];
    assert_eq!(media.kind, xeet_core::model::MediaKind::Image);
    assert_eq!((media.width, media.height), (1600, 900));
    assert!(media.data.is_some(), "the photo's bytes are inlined");

    // A video URL plus a `pbs` image is one item: the image is the poster.
    let host = attach_host("cursor_ai", None).png(
        "https://pbs.twimg.com/media/POSTER?format=jpg&name=medium",
        864,
        486,
    );
    let resolved = block_on(run(
        &format!("watch {video} https://pbs.twimg.com/media/POSTER.jpg"),
        attach_options(),
        &host,
    ))
    .unwrap();
    assert_eq!(
        resolved.post.media.len(),
        1,
        "the poster is not a second item"
    );
    assert_eq!(
        (resolved.post.media[0].width, resolved.post.media[0].height),
        (864, 1080)
    );
    assert!(
        resolved.post.media[0].data.is_some(),
        "the poster is inlined"
    );
}

#[test]
fn a_zero_link_limit_fetches_nothing() {
    // `--offline` and `--no-links` set the limit to zero: nothing is selected, so
    // nothing reaches the network. The check used to run after the first URL was
    // already in, so one link per post still went out.
    let host = Recorder::default();
    let opts = Options {
        max_links: 0,
        ..Options::default()
    };
    let resolved = block_on(run("read https://vercel.com/a today", opts, &host)).unwrap();
    assert!(
        host.requested_urls().is_empty(),
        "fetched: {:?}",
        host.requested_urls()
    );
    assert!(resolved.post.links.is_empty());
}
