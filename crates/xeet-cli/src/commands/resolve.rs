//! `xeet resolve <text|url|post.json>`: the resolver, from the command line.
//!
//! This is the native target of `crates/xeet-resolve`: the same crate the WASM
//! package exports and the playground calls, driven by the default `ureq` host
//! (`crates/xeet-resolve-net`). Its job is to make the resolver observable —
//! `--media` shows the variant X's client would fetch, `--record` shows the
//! redirect chain — and to be the second implementation the parity test can
//! compare against the wasm build.
//!
//! ```text
//! $ xeet resolve "daemons: https://t.co/jO01BMGwXr" --compact
//! {"post":{…,"links":{"https://t.co/jO01BMGwXr":{…}}},"links":{…}}
//! ```

use std::io::{Read, Write};

use xeet_resolve::{Options, Resolved};

use super::*;

const KNOWN: &[&str] = &[
    "media",
    "no-media",
    "width",
    "dpr",
    "surface",
    "max-links",
    "no-links",
    "cache",
    "refresh",
    "offline",
    "compact",
    "quiet",
    "help",
    "h",
    "limits",
    "timeout",
];

pub fn run(argv: &[String]) -> u8 {
    let args = match Args::parse(argv) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("xeet resolve: {message}");
            return EXIT_USAGE;
        }
    };
    if args.has("help") || args.has("h") {
        eprintln!("{}", usage_for("xeet"));
        return EXIT_OK;
    }
    let unknown = args.unknown(KNOWN);
    if !unknown.is_empty() {
        eprintln!("xeet resolve: unknown flag {}", unknown.join(", "));
        return EXIT_USAGE;
    }
    let Some(input) = read_source(&args) else {
        return EXIT_USAGE;
    };
    let mut opts = Options::default();
    opts.media = args.has("media") && !args.has("no-media");
    opts.limits = match limits(&args) {
        Ok(limits) => limits,
        Err(message) => {
            eprintln!("xeet resolve: {message}");
            return EXIT_USAGE;
        }
    };
    if let Some(width) = args.value("width") {
        match width.parse::<f32>() {
            Ok(width) if (100.0..=600.0).contains(&width) => opts.width = width,
            _ => {
                eprintln!("xeet resolve: --width needs a number in 100..=600, got `{width}`");
                return EXIT_USAGE;
            }
        }
    }
    if let Some(dpr) = args.value("dpr") {
        match dpr.parse::<f32>() {
            Ok(dpr) if (1.0..=4.0).contains(&dpr) => opts.dpr = dpr,
            _ => {
                eprintln!("xeet resolve: --dpr needs a number in 1..=4, got `{dpr}`");
                return EXIT_USAGE;
            }
        }
    }
    if let Some(surface) = args.value("surface") {
        opts.surface = surface.to_string();
    }
    if let Some(max) = args.value("max-links") {
        opts.max_links = max.parse().unwrap_or(opts.max_links);
    }
    if args.has("no-links") {
        opts.max_links = 0;
    }
    if let Some(timeout) = args.value("timeout") {
        opts.timeout_ms = timeout.parse().unwrap_or(opts.timeout_ms);
    }
    let host = xeet_resolve_net::Host::new();
    opts.now_ms = {
        use xeet_resolve::Clock;
        host.now_ms()
    };
    if args.has("offline") {
        // Nothing to fetch: the post keeps its text and the links keep their
        // display forms. Useful for checking a payload without a network.
        opts.max_links = 0;
    }

    // `Cache` is not object-safe (its futures borrow `self`), so the choice is a
    // small enum rather than a `Box<dyn Cache>`.
    let cache = match args.value("cache") {
        Some(dir) => AnyCache::Dir(xeet_resolve_net::DirCache::new(dir)),
        None => AnyCache::None,
    };
    let started = std::time::Instant::now();
    let result = xeet_resolve_net::block_on(xeet_resolve::resolve(
        &input,
        opts,
        &host,
        Some(&host),
        Some(&cache),
        Some(&host),
    ));
    let elapsed = started.elapsed();
    match result {
        Ok(Ok(resolved)) => {
            if !args.has("quiet") {
                for warning in &resolved.warnings {
                    eprintln!("warning: {warning}");
                }
                if args.has("time") {
                    eprintln!("resolve: {} ms", elapsed.as_millis());
                }
            }
            let body = render_json(&resolved);
            let text = if args.has("compact") {
                body.to_string()
            } else {
                serde_json::to_string_pretty(&body).unwrap_or_default()
            };
            match write_stdout(&text) {
                Ok(()) => EXIT_OK,
                Err(message) => {
                    eprintln!("xeet resolve: {message}");
                    EXIT_IO
                }
            }
        }
        Ok(Err(error)) => {
            let body = error.to_json();
            eprintln!("{body}");
            if error.status() >= 500 {
                EXIT_RENDER
            } else {
                EXIT_INPUT
            }
        }
        Err(_) => {
            eprintln!("xeet resolve: the resolution did not complete (a host future yielded)");
            EXIT_RENDER
        }
    }
}

enum AnyCache {
    None,
    Dir(xeet_resolve_net::DirCache),
}

impl xeet_resolve::Cache for AnyCache {
    async fn get(&self, key: &str) -> Option<xeet_resolve::CacheEntry> {
        match self {
            AnyCache::None => None,
            AnyCache::Dir(dir) => xeet_resolve::Cache::get(dir, key).await,
        }
    }

    async fn set(&self, key: &str, entry: xeet_resolve::CacheEntry) {
        if let AnyCache::Dir(dir) = self {
            xeet_resolve::Cache::set(dir, key, entry).await;
        }
    }
}

/// The input: a positional path, `-` for stdin, or a literal string.
///
/// A path that exists is read; so is any JSON object. Everything else is the
/// text to resolve, which is what makes `xeet resolve "hi https://…"` work.
fn read_source(args: &Args) -> Option<String> {
    let Some(argument) = args.positional.first() else {
        eprintln!(
            "xeet resolve: expected text, an x.com post URL, or a post JSON path (or - for stdin)"
        );
        return None;
    };
    if argument == "-" {
        let mut text = String::new();
        if let Err(error) = std::io::stdin().read_to_string(&mut text) {
            eprintln!("xeet resolve: could not read stdin: {error}");
            return None;
        }
        return Some(text);
    }
    if std::path::Path::new(argument).is_file() {
        return match std::fs::read_to_string(argument) {
            Ok(text) => Some(text),
            Err(error) => {
                eprintln!("xeet resolve: could not read {argument}: {error}");
                None
            }
        };
    }
    Some(argument.clone())
}

fn write_stdout(text: &str) -> Result<(), String> {
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(text.as_bytes())
        .and_then(|()| stdout.write_all(b"\n"))
        .map_err(|error| format!("could not write to stdout: {error}"))
}

/// The wire shape the wrappers return, so a CLI run and an HTTP call compare.
fn render_json(resolved: &Resolved) -> serde_json::Value {
    serde_json::json!({
        "post": resolved.post,
        "links": resolved.links,
        "media": resolved.media,
        "source": resolved.source,
        "warnings": resolved.warnings,
    })
}
