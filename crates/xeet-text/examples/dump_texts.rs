//! Emits the differential corpus for `tools/x-client`: one JSON object per line
//! with the text and the URL spans this crate extracts, so X's own counter can
//! be fed the same inputs (it has no URL extractor of its own in the extracted
//! module; the spans are the ones this crate already produces identically).
//!
//! ```sh
//! CARGO_TARGET_DIR=target/agent-text cargo run -q -p xeet-text --example dump_texts -- corpus.jsonl > texts.jsonl
//! ```
//!
//! With no arguments it reads every conformance YAML and every captured post page
//! in `assets/vendor/corpus`, so the corpus is the suite plus real posts.
use std::io::Write;

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut sources: Vec<std::path::PathBuf> = files.iter().map(std::path::PathBuf::from).collect();
    if sources.is_empty() {
        for dir in [
            root.join("../../tests/conformance"),
            root.join("../../assets/vendor/corpus"),
        ] {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                    if matches!(ext, "html" | "yml" | "jsonl") {
                        sources.push(path);
                    }
                }
            }
        }
    }

    let mut texts: Vec<String> = Vec::new();
    for path in sources {
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        match path.extension().and_then(|e| e.to_str()) {
            Some("yml") => texts.extend(from_yaml(&raw)),
            Some("jsonl") => {
                for line in raw.lines() {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(t) = v["t"].as_str().or_else(|| v["text"].as_str()) {
                            texts.push(t.to_string());
                        }
                    }
                }
            }
            Some("html") => texts.extend(from_capture(&raw)),
            _ => {}
        }
    }
    texts.sort();
    texts.dedup();

    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    for text in texts {
        let urls: Vec<[usize; 2]> = xeet_text::parse(&text)
            .entities
            .iter()
            .filter(|e| matches!(e.kind, xeet_text::EntityKind::Url { .. }))
            .map(|e| [e.start, e.end])
            .collect();
        writeln!(out, "{}", serde_json::json!({ "t": text, "urls": urls })).unwrap();
    }
}

/// Every `text:` value in a conformance YAML file, unescaped.
fn from_yaml(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("text: \"") {
            if let Some(body) = rest.strip_suffix('"') {
                out.push(unescape_yaml(body));
            }
        }
    }
    out
}

/// Every `full_text` in a captured post page's embedded payloads.
fn from_capture(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for chunk in raw.split("full_text").skip(1) {
        let Some(start) = chunk.find(":\\\"") else {
            continue;
        };
        let tail = &chunk[start + 2..];
        let Some(len) = tail.find("\\\",\\\"") else {
            continue;
        };
        let encoded = format!("\"{}\"", &tail[..len]);
        if let Ok(decoded) = serde_json::from_str::<String>(&encoded) {
            out.push(decoded);
        }
    }
    out
}

/// YAML double-quoted escapes, enough for the conformance files.
fn unescape_yaml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                if let Some(c) = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    out.push(c);
                }
            }
            Some('U') => {
                let hex: String = chars.by_ref().take(8).collect();
                if let Some(c) = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    out.push(c);
                }
            }
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}
