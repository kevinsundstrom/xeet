//! The injection boundary: what the library asks a host to do.
//
// The resolver does no I/O of its own. Everything that touches the network is
// one trait: [`Fetch`]. A host implements it with whatever it has — Node's
// `fetch`, a browser's `fetch` behind a CORS proxy, `ureq` in a CLI, an
// in-memory table in a test — and the library keeps the crawler's *rules*
// (user agent, hop limit, meta refresh, robots.txt, address checks) exactly the
// same everywhere.
//!
//! Redirects are deliberately **not** delegated: the library sends
//! `redirect: Manual` in every [`Request`] and follows the chain itself, because
//! the per-hop rules are the part that has to be identical on every platform.
//! A host that follows redirects on its own would hand the library the final
//! page with no chain, and the playground's diff would lose the evidence.

use std::future::Future;
use std::net::IpAddr;
use std::time::Duration;

/// One HTTP request, as the library wants it made.
#[derive(Clone, Debug)]
pub struct Request {
    pub url: String,
    pub method: Method,
    /// `user-agent`, `accept`, `accept-language`. No cookies, ever.
    pub headers: Vec<(String, String)>,
    /// Always [`Redirect::Manual`]. See the module docs.
    pub redirect: Redirect,
    /// Read at most this many bytes of the body; the rest may be dropped (the
    /// response is then marked `truncated`). Card tags live in the `<head>`.
    pub max_bytes: usize,
    /// The remaining budget for this URL. A host should abort at this point.
    pub timeout: Duration,
    /// True only for the offline smoke fixtures: a host may then skip its own
    /// private-address enforcement. The library has already checked (see
    /// [`crate::Lookup`]) or been told to allow the host.
    pub allow_private: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Redirect {
    /// Never follow; return the 3xx with its `location`.
    Manual,
}

/// What a [`Fetch`] returns. `body` may be shorter than the response (see
/// [`Request::max_bytes`]); `truncated` says so, and the library reports it.
#[derive(Clone, Debug)]
pub struct Response {
    pub status: u16,
    /// Lower-case header names. Repeated headers keep their first value.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub truncated: bool,
    /// The URL actually reached, when the host followed a redirect of its own
    /// (a host *should not*; the library records it as a note).
    pub final_url: Option<String>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        let wanted = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(k, _)| *k == wanted)
            .map(|(_, v)| v.as_str())
    }

    /// The `charset` from `content-type`, if any.
    pub fn charset(&self) -> Option<String> {
        let content_type = self.header("content-type")?;
        for part in content_type.split(';').skip(1) {
            let part = part.trim();
            if let Some(value) = part.strip_prefix("charset=") {
                return Some(value.trim_matches('"').trim().to_ascii_lowercase());
            }
        }
        None
    }

    /// The body as text, honouring a UTF-8-compatible charset declaration.
    pub fn text(&self) -> String {
        // Only UTF-8 is decoded here: the pages the crawler reads are UTF-8 in
        // practice, and a wrong guess is worse than replacement characters. A
        // host that needs another charset can decode and hand over a Response
        // whose body is already UTF-8.
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// A failure the library can report, with the code the API surfaces.
#[derive(Clone, Debug)]
pub enum FetchError {
    /// DNS, TLS, connection reset, HTTP/2 stream error: worth retrying once.
    Transport(String),
    /// The host gave up on the budget.
    Timeout,
    /// The host refuses this destination (its own policy or a browser's CORS).
    Blocked(String),
}

/// The one thing a host must provide.
pub trait Fetch {
    fn fetch(&self, request: Request) -> impl Future<Output = Result<Response, FetchError>>;
}

#[derive(Clone, Debug)]
pub enum LookupError {
    NoSuchHost(String),
}

/// An optional DNS resolver, for the address guard.
///
/// When a host provides it, every address a hostname resolves to must be public
/// (no loopback, private, CGNAT, link-local, multicast or reserved ranges) and
/// the host is re-resolved on every hop, so a rebinding answer does not survive
/// a redirect.
///
/// When it does not — a browser has no DNS — the library still refuses
/// `http://127.0.0.1`, `169.254.169.254`, `[::1]` and other private **literals**
/// itself, and documents that the host's `fetch` must enforce the rest (a
/// worker on a private network, a CORS proxy, a browser's own same-origin
/// policy).
pub trait Lookup {
    fn lookup(&self, host: &str) -> impl Future<Output = Result<Vec<IpAddr>, LookupError>>;
}

/// One cached value, with the wall-clock time (ms since the epoch) it was
/// stored. The library owns the TTL policy; the host owns the storage.
#[derive(Clone, Debug)]
pub struct CacheEntry {
    pub value: String,
    pub stored_at_ms: u64,
}

/// Optional storage for resolved links and fetched image bytes.
///
/// Keys are stable strings the library chooses (`len:<url>`, `img:<url>`,
/// `robots:<origin>`); a host that wants LRU eviction, a directory or a browser
/// `Cache` store keys them however it likes, and may ignore `set` entirely.
pub trait Cache {
    fn get(&self, key: &str) -> impl Future<Output = Option<CacheEntry>>;
    fn set(&self, key: &str, entry: CacheEntry) -> impl Future<Output = ()>;
}

/// Optional clock. Without one, TTLs are not enforced (every cache entry is
/// treated as fresh) and timestamps come from [`crate::Options::now_ms`].
pub trait Clock {
    fn now_ms(&self) -> u64;
}
