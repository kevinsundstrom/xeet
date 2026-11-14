//! `xeet-render serve --stdio`: the playground's long-lived render server.
//!
//! These tests speak the wire protocol to a real process, because the contract
//! is the process: one JSON line in, one JSON line out, for many requests, and
//! a bad request must not end the loop.
//!
//!   CARGO_TARGET_DIR=target/playground cargo test -p xeet-cli --test serve_stdio

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_xeet-render");

struct Serve {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Serve {
    fn start() -> Serve {
        let mut child = Command::new(BIN)
            .args(["serve", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("the xeet-render binary starts");
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = BufReader::new(child.stdout.take().expect("stdout is piped"));
        Serve {
            child,
            stdin,
            stdout,
        }
    }

    /// One request line in, one response line out.
    fn send(&mut self, line: &str) -> serde_json::Value {
        writeln!(self.stdin, "{line}").expect("the request is written");
        self.stdin.flush().expect("the request is flushed");
        let mut reply = String::new();
        let read = self
            .stdout
            .read_line(&mut reply)
            .expect("a reply line arrives");
        assert!(read > 0, "the server closed stdout on {line}");
        serde_json::from_str(&reply).unwrap_or_else(|e| panic!("reply is not JSON ({e}): {reply}"))
    }

    fn request(&mut self, request: serde_json::Value) -> serde_json::Value {
        self.send(&request.to_string())
    }
}

impl Drop for Serve {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn simple_post() -> serde_json::Value {
    let text = std::fs::read_to_string(root().join("tests/fixtures/posts/text-simple.json"))
        .expect("the fixture exists");
    serde_json::from_str(&text).expect("the fixture is JSON")
}

fn png_magic() -> &'static [u8] {
    b"\x89PNG\r\n\x1a\n"
}

/// Standard base64, decoded just enough to check the PNG magic.
fn decode_prefix(b64: &str, bytes: usize) -> Vec<u8> {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in b64.bytes() {
        let Some(v) = TABLE.iter().position(|&t| t == c) else {
            break;
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            if out.len() >= bytes {
                break;
            }
        }
    }
    out
}

#[test]
fn info_reports_the_version_and_the_ruleset() {
    let mut serve = Serve::start();
    let reply = serve.request(serde_json::json!({ "id": "boot", "op": "info" }));
    assert_eq!(reply["id"], "boot");
    let version = &reply["version"];
    let ruleset = version["ruleset"].as_str().expect("ruleset is a string");
    assert!(
        ruleset.starts_with("x-web@"),
        "ruleset id is x-web@<rev>: {ruleset}"
    );
    assert!(
        version["upstream"].as_str().is_some_and(|s| !s.is_empty()),
        "the embedded upstream app version is reported: {version}"
    );
    assert!(
        version["builtAt"].as_str().is_some_and(|s| s.len() == 24),
        "builtAt is an ISO 8601 UTC stamp: {version}"
    );
}

#[test]
fn render_returns_a_png_the_report_and_the_geometry() {
    let mut serve = Serve::start();
    let reply = serve.request(serde_json::json!({
        "id": 1,
        "op": "render",
        "post": simple_post(),
        "options": { "width": 390, "theme": "dark", "dpr": 3 },
    }));
    assert!(reply.get("error").is_none(), "no error: {reply}");
    assert_eq!(reply["id"], 1);

    let png = reply["png"].as_str().expect("png is base64");
    assert!(png.len() > 1000, "a real PNG, not an empty payload");
    assert_eq!(
        decode_prefix(png, 8),
        png_magic(),
        "the payload starts with the PNG signature"
    );

    assert_eq!(reply["width"].as_f64(), Some(390.0), "CSS width is echoed");
    assert!(reply["height"].as_f64().unwrap_or(0.0) > 0.0);
    assert_eq!(reply["dpr"].as_f64(), Some(3.0));

    let report = &reply["report"];
    assert!(
        report["length"]["weighted"].as_u64().is_some_and(|n| n > 0),
        "the report carries the weighted length: {report}"
    );

    let lines = reply["geometry"]["lines"].as_array().expect("frame lines");
    assert!(!lines.is_empty(), "the frame laid text out");
    assert!(
        lines[0]["text"].is_string(),
        "a line is text + box: {lines:?}"
    );
    let boxes = reply["geometry"]["boxes"].as_array().expect("boxes");
    // An avatar slot is an image item even when the post carries no avatar
    // bytes: the renderer substitutes X's default profile image
    // (`render::default_avatar`), so x.com's "always a picture" holds. It used
    // to be the placeholder box this assertion looked for.
    assert!(
        boxes
            .iter()
            .any(|b| b["kind"] == "image" && b["name"] == "Avatar"),
        "the avatar slot is an image box: {boxes:?}"
    );
    assert!(
        reply["ms"]["total"].as_f64().is_some_and(|ms| ms >= 0.0),
        "timing is reported"
    );
}

#[test]
fn explain_returns_the_report_without_pixels() {
    let mut serve = Serve::start();
    let reply = serve.request(serde_json::json!({
        "id": 2,
        "op": "explain",
        "post": { "text": "hello" },
        "options": { "width": 600 },
    }));
    assert!(reply.get("error").is_none(), "no error: {reply}");
    assert_eq!(reply["report"]["size"]["width"].as_f64(), Some(600.0));
    assert!(reply.get("png").is_none(), "explain draws nothing");
}

#[test]
fn a_bad_line_does_not_end_the_process() {
    let mut serve = Serve::start();
    let reply = serve.send("{not json");
    assert_eq!(reply["error"]["code"], "invalid_json");
    assert!(reply["id"].is_null(), "no id to echo");

    let reply = serve.send("[]");
    assert_eq!(reply["error"]["code"], "invalid_json");

    let reply = serve.request(serde_json::json!({ "id": 3, "op": "nope" }));
    assert_eq!(reply["error"]["code"], "unknown_op");
    assert_eq!(reply["id"], 3);

    // The same process still renders: a bad request is one bad line.
    let reply = serve.request(serde_json::json!({
        "id": 4,
        "op": "render",
        "post": { "text": "still here" },
        "geometry": false,
    }));
    assert!(
        reply.get("error").is_none(),
        "no error after bad lines: {reply}"
    );
    assert_eq!(reply["id"], 4);
}

#[test]
fn an_unknown_field_names_the_typo_and_suggests_the_right_key() {
    let mut serve = Serve::start();
    let reply = serve.request(serde_json::json!({
        "id": 5,
        "op": "render",
        "post": { "text": "hi", "auther": { "name": "a", "handle": "a" } },
    }));
    let error = &reply["error"];
    // The strict parser refuses unknown keys at parse time, which the core
    // reports as `invalid_json` with the suggestion in the message.
    assert_eq!(error["code"], "invalid_json", "strict parser: {error}");
    let message = error["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("did you mean `author`"),
        "the field error suggests the right key: {message}"
    );
}

#[test]
fn a_validation_problem_lists_its_field_path() {
    let mut serve = Serve::start();
    let reply = serve.request(serde_json::json!({
        "id": 6,
        "op": "render",
        "post": { "text": "hi" },
        "options": { "dpr": 9 },
    }));
    let error = &reply["error"];
    assert_eq!(error["code"], "invalid_post", "validation error: {error}");
    let fields = error["fields"]
        .as_array()
        .expect("fields list the problems");
    assert!(
        fields.iter().any(|f| f["path"] == "options.dpr"),
        "the problem names the field: {fields:?}"
    );
}

#[test]
fn a_request_without_a_post_is_an_error_with_the_id() {
    let mut serve = Serve::start();
    let reply = serve.request(serde_json::json!({ "id": "x", "op": "render" }));
    assert_eq!(reply["id"], "x");
    assert_eq!(reply["error"]["code"], "invalid_post");
}

/// The playground's budget is "a few ms per keystroke" (docs/PLAYGROUND.md).
/// This test is the regression alarm for that: it prints the distribution and
/// fails only far above the goal, because a shared CI machine is noisy.
#[test]
fn a_render_round_trip_costs_a_few_milliseconds() {
    let mut serve = Serve::start();
    let post = simple_post();
    let mut samples = Vec::new();
    for i in 0..20 {
        let started = std::time::Instant::now();
        let reply = serve.request(serde_json::json!({
            "id": i,
            "op": "render",
            "post": post,
            "options": { "width": 390, "dpr": 2 },
        }));
        assert!(reply.get("error").is_none(), "no error: {reply}");
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = samples[samples.len() / 2];
    eprintln!(
        "serve: round trip median {median:.2} ms, p90 {:.2} ms, max {:.2} ms",
        samples[samples.len() * 9 / 10],
        samples[samples.len() - 1]
    );
    // The budget is for the profile the playground builds (`--profile fast`); an
    // unoptimized `cargo test` is an order of magnitude slower, and the number is
    // reported there rather than asserted.
    if !cfg!(debug_assertions) {
        assert!(
            median < 100.0,
            "a render round trip should be a few ms, not {median:.1} ms"
        );
    }
}
