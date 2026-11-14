//! URL parsing, joining and the address guard.
//!
//! A small parser instead of the `url` crate: the crawler only needs absolute
//! `http(s)` URLs, the pieces of a URL (scheme, host, port, path, query) and
//! `join` for a `location` header. That is ~200 lines, pure Rust, and it keeps
//! this crate's dependency set to `serde`/`serde_json` plus the two xeet crates
//! — the same shape `xeet-text` takes for URL validation.
//!
//! The guard is the security boundary (`docs/LINK-CARDS.md` §Safety): every hop
//! is parsed here, and its host must be a public unicast destination.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// An absolute `http`/`https` URL, split into the parts the crawler uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Url {
    pub scheme: String,
    /// Lower-case, without IPv6 brackets.
    pub host: String,
    /// `None` means the scheme's default port.
    pub port: Option<u16>,
    /// Always starts with `/`.
    pub path: String,
    /// Without the leading `?`.
    pub query: Option<String>,
}

impl Url {
    /// Parses an absolute URL. `None` for anything that is not http(s) with a
    /// host.
    pub fn parse(input: &str) -> Option<Url> {
        let trimmed = input.trim();
        let (scheme, rest) = trimmed.split_once("://")?;
        let scheme = scheme.to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return None;
        }
        // Strip the fragment; the crawler never needs it.
        let rest = rest.split('#').next().unwrap_or(rest);
        let (authority, path_and_query) = match rest.find(['/', '?']) {
            Some(index) => (&rest[..index], &rest[index..]),
            None => (rest, ""),
        };
        let (host, port) = split_authority(authority)?;
        if host.is_empty() {
            return None;
        }
        let (path, query) = match path_and_query.split_once('?') {
            Some((p, q)) => (p, Some(q.to_string())),
            None => (path_and_query, None),
        };
        let path = if path.is_empty() {
            "/".to_string()
        } else {
            path.to_string()
        };
        Some(Url {
            scheme,
            host,
            port,
            path,
            query,
        })
    }

    /// `https://host[:port]/path?query`, the form a request and a cache key use.
    pub fn href(&self) -> String {
        let mut out = String::with_capacity(64);
        out.push_str(&self.scheme);
        out.push_str("://");
        if self.host.contains(':') {
            out.push('[');
            out.push_str(&self.host);
            out.push(']');
        } else {
            out.push_str(&self.host);
        }
        if let Some(port) = self.port {
            out.push(':');
            out.push_str(&port.to_string());
        }
        out.push_str(&self.path);
        if let Some(query) = &self.query {
            out.push('?');
            out.push_str(query);
        }
        out
    }

    /// The effective port (the scheme's default when none is written).
    pub fn effective_port(&self) -> u16 {
        self.port
            .unwrap_or(if self.scheme == "https" { 443 } else { 80 })
    }

    /// `scheme://host[:port]`, for robots.txt and for "same origin" checks.
    pub fn origin(&self) -> String {
        let mut out = format!("{}://{}", self.scheme, self.host);
        if let Some(port) = self.port {
            out.push(':');
            out.push_str(&port.to_string());
        }
        out
    }

    /// `path?query`, which is what a robots.txt rule is matched against (the
    /// path only, per Google's specification).
    pub fn path_and_query(&self) -> String {
        match &self.query {
            Some(query) => format!("{}?{}", self.path, query),
            None => self.path.clone(),
        }
    }

    /// Resolves a `location` header (or a meta refresh target) against this URL.
    pub fn join(&self, target: &str) -> Option<Url> {
        let target = target.trim();
        if target.is_empty() {
            return None;
        }
        if let Some(url) = Url::parse(target) {
            return Some(url);
        }
        if target.starts_with("//") {
            return Url::parse(&format!("{}:{}", self.scheme, target));
        }
        // Everything else keeps this URL's scheme, host and port.
        let mut base = self.clone();
        base.query = None;
        if target.starts_with('/') {
            let (path, query) = split_path_query(target);
            base.path = path;
            base.query = query;
            return Some(base);
        }
        if let Some(rest) = target.strip_prefix('?') {
            base.query = Some(rest.to_string());
            return Some(base);
        }
        // A relative path: replace the last segment; `.` and `..` are resolved.
        let directory = match base.path.rfind('/') {
            Some(index) => base.path[..=index].to_string(),
            None => "/".to_string(),
        };
        let (joined_path, query) = split_path_query(&format!("{}{}", directory, target));
        base.path = normalize_dots(&joined_path);
        base.query = query;
        Some(base)
    }

    /// The lower-case host, without brackets, which is what the guard checks.
    pub fn host_lower(&self) -> String {
        self.host.clone()
    }

    /// An IP literal, when the host is one.
    pub fn host_ip(&self) -> Option<IpAddr> {
        if let Ok(ip) = self.host.parse::<Ipv4Addr>() {
            return Some(IpAddr::V4(ip));
        }
        if let Ok(ip) = self.host.parse::<Ipv6Addr>() {
            return Some(IpAddr::V6(ip));
        }
        None
    }
}

fn split_authority(authority: &str) -> Option<(String, Option<u16>)> {
    // Userinfo is not part of any URL the crawler follows, and a `@` in an
    // authority is a classic phishing trick; refuse it outright.
    if authority.contains('@') {
        return None;
    }
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(p) if !p.is_empty() => Some(p.parse::<u16>().ok()?),
            Some(_) => None,
            None if after.is_empty() => None,
            None => return None,
        };
        return Some((host.to_ascii_lowercase(), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            Some((host.to_ascii_lowercase(), Some(port.parse::<u16>().ok()?)))
        }
        _ => Some((authority.to_ascii_lowercase(), None)),
    }
}

fn split_path_query(value: &str) -> (String, Option<String>) {
    let without_fragment = value.split('#').next().unwrap_or(value);
    match without_fragment.split_once('?') {
        Some((path, query)) => (path.to_string(), Some(query.to_string())),
        None => (without_fragment.to_string(), None),
    }
}

fn normalize_dots(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "." | "" => {}
            ".." => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    let trailing_slash = path.ends_with('/') || path.ends_with("/.") || path.ends_with("/..");
    let mut result = String::from("/");
    result.push_str(&out.join("/"));
    if trailing_slash && !result.ends_with('/') {
        result.push('/');
    }
    result
}

/// True for every address that is not a public unicast destination.
///
/// IPv4: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local and the
/// cloud metadata endpoint), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24,
/// 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4.
/// IPv6: `::`, `::1`, fc00::/7, fe80::/10, ff00::/8, 2001:db8::/32,
/// `2001:0::/32` (Teredo), and any IPv4-mapped / NAT64 / 6to4 address whose
/// embedded IPv4 is private.
pub fn is_private_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => is_private_v6(v6),
    }
}

pub fn is_private_v4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
}

pub fn is_private_v6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    if let Some(v4) = embedded_v4(address) {
        return is_private_v4(v4);
    }
    let first = segments[0];
    // :: and ::1
    if address.is_unspecified() || address.is_loopback() {
        return true;
    }
    // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
    if (first & 0xfe00) == 0xfc00 {
        return true;
    }
    if (first & 0xffc0) == 0xfe80 {
        return true;
    }
    if (first & 0xff00) == 0xff00 {
        return true;
    }
    // 2001:db8::/32 documentation, 2001:0::/32 Teredo.
    if first == 0x2001 && (segments[1] == 0x0db8 || segments[1] == 0x0000) {
        return true;
    }
    false
}

/// The IPv4 address embedded in an IPv4-mapped (`::ffff:a.b.c.d`), NAT64
/// (`64:ff9b::/96`) or 6to4 (`2002::/16`) address.
fn embedded_v4(address: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(v4) = address.to_ipv4_mapped() {
        return Some(v4);
    }
    let segments = address.segments();
    if segments[0] == 0x0064
        && segments[1] == 0xff9b
        && segments[2] == 0
        && segments[3] == 0
        && segments[4] == 0
        && segments[5] == 0
    {
        return Some(Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            segments[6] as u8,
            (segments[7] >> 8) as u8,
            segments[7] as u8,
        ));
    }
    if segments[0] == 0x2002 {
        return Some(Ipv4Addr::new(
            (segments[1] >> 8) as u8,
            segments[1] as u8,
            (segments[2] >> 8) as u8,
            segments[2] as u8,
        ));
    }
    None
}

// ---------------------------------------------------------------------------
// robots.txt (Google's specification, which X's crawler implements)
// ---------------------------------------------------------------------------

/// A compiled robots.txt rule set for one origin.
#[derive(Clone, Debug, Default)]
pub struct Robots {
    rules: Vec<Rule>,
}

#[derive(Clone, Debug)]
struct Rule {
    allow: bool,
    pattern: String,
}

impl Robots {
    /// Parses a robots.txt body: the `Twitterbot` group if there is one, `*`
    /// otherwise, with Google's longest-match rule (`Allow` wins a tie).
    pub fn parse(body: &str) -> Robots {
        let mut groups: Vec<(Vec<String>, Vec<Rule>, bool)> = Vec::new();
        let mut current: Option<(Vec<String>, Vec<Rule>, bool)> = None;
        for raw in body.lines() {
            let line = raw.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let key = key.trim().to_ascii_lowercase();
            let value = value.trim();
            match key.as_str() {
                "user-agent" => {
                    let in_rules = current
                        .as_ref()
                        .map(|(_, rules, started)| !rules.is_empty() || *started)
                        .unwrap_or(false);
                    if current.is_none() || in_rules {
                        if let Some(group) = current.take() {
                            groups.push(group);
                        }
                        current = Some((Vec::new(), Vec::new(), false));
                    }
                    if let Some((agents, _, _)) = current.as_mut() {
                        agents.push(value.to_ascii_lowercase());
                    }
                }
                "disallow" | "allow" => {
                    if let Some((_, rules, started)) = current.as_mut() {
                        *started = true;
                        if value.is_empty() {
                            continue;
                        }
                        rules.push(Rule {
                            allow: key == "allow",
                            pattern: value.to_string(),
                        });
                    }
                }
                _ => {}
            }
        }
        if let Some(group) = current {
            groups.push(group);
        }
        // A group that names Twitterbot wins even when it has no rules: `t.co`'s
        // robots.txt is exactly that (`User-agent: twitterbot` then a bare
        // `Disallow:`, i.e. "everything is allowed") followed by
        // `User-agent: * / Disallow: /`. Falling through to `*` there would
        // disallow every short link on X (the live bug this test records).
        let mentions_us = groups
            .iter()
            .any(|(agents, _, _)| agents.iter().any(|agent| agent.starts_with("twitterbot")));
        let specific: Vec<&Rule> = groups
            .iter()
            .filter(|(agents, _, _)| agents.iter().any(|agent| agent.starts_with("twitterbot")))
            .flat_map(|(_, rules, _)| rules.iter())
            .collect();
        let rules: Vec<Rule> = if !mentions_us {
            groups
                .iter()
                .filter(|(agents, _, _)| agents.iter().any(|agent| agent == "*"))
                .flat_map(|(_, rules, _)| rules.iter())
                .cloned()
                .collect()
        } else {
            specific.into_iter().cloned().collect()
        };
        Robots { rules }
    }

    /// Whether `path` may be fetched. No rules means allow.
    pub fn allows(&self, path: &str) -> bool {
        let mut best: Option<(usize, bool)> = None;
        for rule in &self.rules {
            if !pattern_matches(&rule.pattern, path) {
                continue;
            }
            let length = rule
                .pattern
                .chars()
                .filter(|c| *c != '*' && *c != '$')
                .count();
            best = match best {
                Some((best_len, best_allow))
                    if best_len > length || (best_len == length && best_allow) =>
                {
                    Some((best_len, best_allow))
                }
                _ => Some((length, rule.allow)),
            };
        }
        best.map(|(_, allow)| allow).unwrap_or(true)
    }
}

fn pattern_matches(pattern: &str, path: &str) -> bool {
    let anchored = pattern.ends_with('$');
    let body = if anchored {
        &pattern[..pattern.len() - 1]
    } else {
        pattern
    };
    let parts: Vec<&str> = body.split('*').collect();
    let mut rest = path;
    for (index, part) in parts.iter().enumerate() {
        if index == 0 {
            if !rest.starts_with(part) {
                return false;
            }
            rest = &rest[part.len()..];
            continue;
        }
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    if anchored {
        // The last part must end the path: with `*`, the remainder must be empty.
        parts
            .last()
            .map(|last| rest.is_empty() || (last.is_empty() && rest.is_empty()))
            .unwrap_or(true)
            || (parts.len() > 1 && rest.is_empty())
    } else {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_absolute_urls() {
        let url = Url::parse("https://pbs.twimg.com/media/ABC.jpg").unwrap();
        assert_eq!(url.scheme, "https");
        assert_eq!(url.host, "pbs.twimg.com");
        assert_eq!(url.port, None);
        assert_eq!(url.path, "/media/ABC.jpg");
        assert_eq!(url.href(), "https://pbs.twimg.com/media/ABC.jpg");

        let url = Url::parse("http://127.0.0.1:8080/a?b=1#frag").unwrap();
        assert_eq!(url.effective_port(), 8080);
        assert_eq!(url.query.as_deref(), Some("b=1"));
        assert_eq!(url.origin(), "http://127.0.0.1:8080");

        assert!(Url::parse("ftp://example.com/").is_none());
        assert!(Url::parse("file:///etc/passwd").is_none());
        assert!(Url::parse("https://user:pass@example.com/").is_none());
        assert!(Url::parse("not a url").is_none());
    }

    #[test]
    fn joins_redirect_targets() {
        let base = Url::parse("https://t.co/jO01BMGwXr").unwrap();
        assert_eq!(
            base.join("https://vercel.com/changelog/x").unwrap().href(),
            "https://vercel.com/changelog/x"
        );
        assert_eq!(base.join("/hop").unwrap().href(), "https://t.co/hop");
        assert_eq!(
            base.join("//other.example/a").unwrap().href(),
            "https://other.example/a"
        );
        assert_eq!(
            base.join("?q=1").unwrap().href(),
            "https://t.co/jO01BMGwXr?q=1"
        );
        let base = Url::parse("https://example.com/a/b/c").unwrap();
        assert_eq!(base.join("../d").unwrap().path, "/a/d");
        assert_eq!(base.join("./d").unwrap().path, "/a/b/d");
        assert_eq!(base.join("d").unwrap().path, "/a/b/d");
    }

    #[test]
    fn refuses_private_addresses() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "172.31.0.1",
            "192.168.1.1",
            "100.64.0.1",
            "169.254.169.254",
            "198.18.0.1",
            "224.0.0.1",
            "::1",
            "fd00::1",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "64:ff9b::7f00:1",
            "2002:7f00:1::1",
        ] {
            assert!(
                is_private_address(address.parse().unwrap()),
                "{address} should be private"
            );
        }
        for address in [
            "8.8.8.8",
            "93.184.216.34",
            "172.32.0.1",
            "2606:4700::1111",
            "::ffff:8.8.8.8",
        ] {
            assert!(
                !is_private_address(address.parse().unwrap()),
                "{address} should be public"
            );
        }
    }

    #[test]
    fn robots_prefers_the_specific_group_and_longest_match() {
        let robots = Robots::parse(
            "User-agent: Twitterbot\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: *\nDisallow: /\n",
        );
        assert!(robots.allows("/"));
        assert!(!robots.allows("/private"));
        assert!(robots.allows("/private/ok"));
        let wildcard = Robots::parse("User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*\n");
        assert!(!wildcard.allows("/a.pdf"));
        assert!(wildcard.allows("/a.pdf?x=1"));
        assert!(!wildcard.allows("/tmp/x"));
        assert!(wildcard.allows("/y"));
        assert!(Robots::parse("").allows("/anything"));
        // t.co, verbatim (recorded 2026-11-10): the Twitterbot group allows
        // everything and `*` denies everything; Twitterbot gets its own group.
        let tco = Robots::parse(
            "User-agent: twitterbot\nDisallow:\n\n# Google / Bing Search Engine Robots\nUser-agent: Googlebot\nUser-agent: Bingbot\nDisallow:\n\nUser-agent: *\nDisallow: /\n",
        );
        assert!(tco.allows("/jO01BMGwXr"));
        assert!(tco.allows("/"));
        // A host with only `*` still denies.
        assert!(!Robots::parse("User-agent: *\nDisallow: /\n").allows("/x"));
    }
}
