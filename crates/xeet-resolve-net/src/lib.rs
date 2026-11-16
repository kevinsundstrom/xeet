//! The native default host for [`xeet_resolve`]: `ureq` for HTTP, the system
//! resolver for DNS.
//!
//! This is the only crate in the workspace that opens a socket for resolution.
//! It is deliberately separate from `xeet-resolve` so that crate stays pure
//! (and builds for `wasm32-unknown-unknown` with no network deps at all).
//!
//! ```no_run
//! use xeet_resolve::Options;
//! let host = xeet_resolve_net::Host::new();
//! let resolved = xeet_resolve_net::block_on(xeet_resolve::resolve(
//!     "https://t.co/jO01BMGwXr",
//!     Options::default(),
//!     &host,
//!     Some(&host),
//!     None::<&xeet_resolve_net::NoCache>,
//!     Some(&host),
//! ))
//! .unwrap();
//! println!("{}", resolved.unwrap().post.text);
//! ```
//!
//! # Redirects, again
//!
//! `ureq` is configured with `redirects(0)`, so a 3xx comes back as a response
//! with its `location` header and the library follows it. That is not an
//! optimisation: it is what makes the address guard run on every hop.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use xeet_resolve::fetch::{
    Cache, CacheEntry, Clock, Fetch, FetchError, Lookup, LookupError, Method, Request, Response,
};

/// The default host: one `ureq` agent (connection reuse is off anyway — the
/// resolver sends `connection: close` — but the agent carries the TLS config).
///
/// The addresses [`Lookup::lookup`] returned for a host are the ones the agent
/// connects to for that host: `lookup` records them and the agent's resolver
/// reads them back, so the address the library validated as public is the
/// address the socket opens to. Without that, a host whose DNS answers
/// differently on the second query (rebinding) passed validation and then
/// connected somewhere private.
pub struct Host {
    agent: ureq::Agent,
    pinned: Arc<Mutex<HashMap<String, Vec<IpAddr>>>>,
}

/// `ureq`'s resolver: the pinned addresses for a host the library has looked
/// up, else the system resolver (a fetch the library did not validate first).
struct Pinned(Arc<Mutex<HashMap<String, Vec<IpAddr>>>>);

impl ureq::Resolver for Pinned {
    fn resolve(&self, netloc: &str) -> std::io::Result<Vec<SocketAddr>> {
        let (host, port) = match netloc.rsplit_once(':') {
            Some((h, p)) => (
                h.trim_start_matches('[').trim_end_matches(']'),
                p.parse::<u16>().map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        format!("bad port in {netloc:?}"),
                    )
                })?,
            ),
            None => (netloc, 443),
        };
        // A poisoned lock means a thread panicked while holding it; the map is
        // still the map, so read it rather than fall back to an unpinned lookup.
        let pinned = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&host.to_ascii_lowercase())
            .cloned();
        if let Some(addresses) = pinned {
            return Ok(addresses
                .into_iter()
                .map(|ip| SocketAddr::new(ip, port))
                .collect());
        }
        Ok(netloc.to_socket_addrs()?.collect())
    }
}

impl Default for Host {
    fn default() -> Host {
        Host::new()
    }
}

impl Host {
    pub fn new() -> Host {
        let pinned: Arc<Mutex<HashMap<String, Vec<IpAddr>>>> = Arc::default();
        let agent = ureq::AgentBuilder::new()
            // The library owns the chain; see the module docs.
            .redirects(0)
            .resolver(Pinned(Arc::clone(&pinned)))
            // A per-request timeout is set from the request's own budget; this
            // is the backstop for a host that ignores it.
            .timeout(Duration::from_secs(30))
            .user_agent("xeet-resolve")
            .build();
        Host { agent, pinned }
    }
}

impl Fetch for Host {
    /// Blocking, and the returned future is already resolved. `ureq`'s error
    /// type folds non-2xx statuses into `Err`, so those are lifted back out: the
    /// library needs the 3xx response, not an error.
    async fn fetch(&self, request: Request) -> Result<Response, FetchError> {
        debug_assert_eq!(request.method, Method::Get);
        let mut builder = self.agent.get(&request.url);
        for (name, value) in &request.headers {
            builder = builder.set(name, value);
        }
        let result = builder.timeout(request.timeout).call();
        let response = match result {
            Ok(response) => response,
            Err(ureq::Error::Status(_status, response)) => response,
            Err(ureq::Error::Transport(transport)) => {
                let message = transport.to_string();
                return Err(if message.to_ascii_lowercase().contains("timed out") {
                    FetchError::Timeout
                } else {
                    FetchError::Transport(message)
                });
            }
        };

        let status = response.status();
        let mut headers: Vec<(String, String)> = Vec::new();
        for name in response.headers_names() {
            if let Some(value) = response.header(&name) {
                headers.push((name.to_ascii_lowercase(), value.to_string()));
            }
        }
        // Read at most `max_bytes`, plus one byte to notice that there was more.
        let limit = request.max_bytes.max(1) as u64;
        let mut body = Vec::new();
        let mut reader = response.into_reader().take(limit + 1);
        reader
            .read_to_end(&mut body)
            .map_err(|error| FetchError::Transport(error.to_string()))?;
        let truncated = body.len() as u64 > limit;
        if truncated {
            body.truncate(limit as usize);
        }
        Ok(Response {
            status,
            headers,
            body,
            truncated,
            final_url: None,
        })
    }
}

impl Lookup for Host {
    /// The system resolver (`getaddrinfo`), which is what a browser would use.
    /// Blocking, like the fetch above, and for the same reason.
    async fn lookup(&self, host: &str) -> Result<Vec<IpAddr>, LookupError> {
        let addresses = (host, 443u16)
            .to_socket_addrs()
            .map_err(|_| LookupError::NoSuchHost(host.to_string()))?;
        let mut out: Vec<IpAddr> = Vec::new();
        for address in addresses {
            if !out.contains(&address.ip()) {
                out.push(address.ip());
            }
        }
        if out.is_empty() {
            return Err(LookupError::NoSuchHost(host.to_string()));
        }
        // What the library validates is what the agent will connect to. The pin
        // is recorded before the library's address check runs; a host that fails
        // it is never fetched, and with this blocking host the lookup and the
        // fetch for one URL run in sequence, so the entry cannot be overtaken.
        self.pinned
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(host.to_ascii_lowercase(), out.clone());
        Ok(out)
    }
}

impl Clock for Host {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0)
    }
}

/// A cache that stores nothing, for a one-shot CLI run.
pub struct NoCache;

impl Cache for NoCache {
    async fn get(&self, _key: &str) -> Option<CacheEntry> {
        None
    }
    async fn set(&self, _key: &str, _entry: CacheEntry) {}
}

/// A cache in a directory: one JSON file per key, hashed, with the same
/// `<sha256>.json` shape the playground's Node cache uses so the two can share a
/// directory if anyone wants to.
pub struct DirCache {
    dir: std::path::PathBuf,
}

impl DirCache {
    pub fn new(dir: impl Into<std::path::PathBuf>) -> DirCache {
        DirCache { dir: dir.into() }
    }

    fn path(&self, key: &str) -> std::path::PathBuf {
        let digest = sha256_hex(key.as_bytes());
        self.dir.join(format!("{digest}.json"))
    }
}

impl Cache for DirCache {
    async fn get(&self, key: &str) -> Option<CacheEntry> {
        let text = std::fs::read_to_string(self.path(key)).ok()?;
        let value: serde_json::Value = serde_json::from_str(&text).ok()?;
        Some(CacheEntry {
            value: value.get("value")?.as_str()?.to_string(),
            stored_at_ms: value.get("storedAt")?.as_u64()?,
        })
    }

    async fn set(&self, key: &str, entry: CacheEntry) {
        let _ = std::fs::create_dir_all(&self.dir);
        let body =
            serde_json::json!({ "key": key, "value": entry.value, "storedAt": entry.stored_at_ms });
        let _ = std::fs::write(self.path(key), body.to_string());
    }
}

/// SHA-256, hex. A cache filename does not need a dependency.
pub fn sha256_hex(input: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut message = input.to_vec();
    let bit_len = (input.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in message.chunks(64) {
        let mut w = [0u32; 64];
        for index in 0..16 {
            w[index] = u32::from_be_bytes([
                chunk[index * 4],
                chunk[index * 4 + 1],
                chunk[index * 4 + 2],
                chunk[index * 4 + 3],
            ]);
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7)
                ^ w[index - 15].rotate_right(18)
                ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17)
                ^ w[index - 2].rotate_right(19)
                ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }
        let mut a = state;
        for index in 0..64 {
            let s1 = a[4].rotate_right(6) ^ a[4].rotate_right(11) ^ a[4].rotate_right(25);
            let ch = (a[4] & a[5]) ^ (!a[4] & a[6]);
            let temp1 = a[7]
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(w[index]);
            let s0 = a[0].rotate_right(2) ^ a[0].rotate_right(13) ^ a[0].rotate_right(22);
            let maj = (a[0] & a[1]) ^ (a[0] & a[2]) ^ (a[1] & a[2]);
            let temp2 = s0.wrapping_add(maj);
            a[7] = a[6];
            a[6] = a[5];
            a[5] = a[4];
            a[4] = a[3].wrapping_add(temp1);
            a[3] = a[2];
            a[2] = a[1];
            a[1] = a[0];
            a[0] = temp1.wrapping_add(temp2);
        }
        for index in 0..8 {
            state[index] = state[index].wrapping_add(a[index]);
        }
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}

// ---------------------------------------------------------------------------
// A blocking driver
// ---------------------------------------------------------------------------

/// Drives a future that never yields on the calling thread.
///
/// Every `fetch` in this crate does its I/O inside the poll and returns a ready
/// future, so `resolve` completes on the first poll. The loop is here so that a
/// future which *does* yield (a test's, or a host built on another crate) is
/// reported as a bug rather than hanging or being silently mis-driven.
pub fn block_on<F: std::future::Future>(future: F) -> Result<F::Output, BlockingHostError> {
    use std::task::{Context, Poll, Wake, Waker};
    struct Noop;
    impl Wake for Noop {
        fn wake(self: std::sync::Arc<Self>) {}
    }
    let waker = Waker::from(std::sync::Arc::new(Noop));
    let mut context = Context::from_waker(&waker);
    let mut future = Box::pin(future);
    let started = Instant::now();
    for _ in 0..100_000 {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return Ok(value),
            Poll::Pending => {
                if started.elapsed() > Duration::from_secs(120) {
                    return Err(BlockingHostError::Stuck);
                }
                std::thread::yield_now();
            }
        }
    }
    Err(BlockingHostError::Stuck)
}

#[derive(Debug)]
pub enum BlockingHostError {
    /// The future yielded: this host does not implement an executor.
    Stuck,
}

impl std::fmt::Display for BlockingHostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the resolution did not complete without an executor")
    }
}

impl std::error::Error for BlockingHostError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_the_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"The quick brown fox jumps over the lazy dog"),
            "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
        );
    }

    #[test]
    fn the_agent_connects_to_the_addresses_lookup_returned() {
        // A listener on the loopback address stands in for the public address
        // `lookup` validated. The name does not resolve anywhere (`.test` is
        // reserved), so the only way the agent reaches the listener is through
        // the addresses `lookup` recorded.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                let mut request = [0u8; 1024];
                let _ = socket.read(&mut request);
                let _ = std::io::Write::write_all(
                    &mut socket,
                    b"HTTP/1.1 204 No Content\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
                );
            }
        });
        let host = Host::new();
        // `lookup` on a name the system resolves records what it returned.
        let looked_up = block_on(host.lookup("localhost")).unwrap().unwrap();
        assert_eq!(
            host.pinned
                .lock()
                .unwrap()
                .get("localhost")
                .map(Vec::as_slice),
            Some(looked_up.as_slice()),
            "lookup records its addresses for the agent"
        );
        let resolver = Pinned(Arc::clone(&host.pinned));
        let got = ureq::Resolver::resolve(&resolver, "localhost:80").unwrap();
        assert_eq!(
            got,
            looked_up
                .iter()
                .map(|ip| SocketAddr::new(*ip, 80))
                .collect::<Vec<_>>()
        );
        // The agent itself honours the pin: an unresolvable name with a pinned
        // loopback address reaches the listener.
        host.pinned
            .lock()
            .unwrap()
            .insert("pinned.test".into(), vec!["127.0.0.1".parse().unwrap()]);
        let response = host
            .agent
            .get(&format!("http://pinned.test:{port}/"))
            .call()
            .unwrap();
        assert_eq!(response.status(), 204);
        // A bad port is an error, not a silent 443.
        assert!(ureq::Resolver::resolve(&resolver, "localhost:port").is_err());
    }

    #[test]
    fn a_ready_future_completes() {
        let value = block_on(async { 41 + 1 }).unwrap();
        assert_eq!(value, 42);
    }
}
