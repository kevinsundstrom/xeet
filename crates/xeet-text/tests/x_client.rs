//! Differential check against X's own shipped character counter.
//!
//! X's web client computes the composer's weighted length itself, in the bundle
//! captured under `assets/vendor/upstream/js/`. `tools/x-client/extract.mjs`
//! pulls that code out of the chunk (verbatim, minus the URL-extractor import)
//! and `tools/x-client/expected.mjs` runs it in Node over a corpus. This test
//! compares the crate's default configuration against those answers.
//!
//! ```sh
//! node crates/xeet-text/tools/x-client/extract.mjs          # pulls the counter out of the chunk
//! CARGO_TARGET_DIR=target/agent-text cargo run -q -p xeet-text --example dump_texts \
//!   > /tmp/texts.jsonl                                      # conformance + captured posts
//! node crates/xeet-text/tools/x-client/expected.mjs /tmp/texts.jsonl /tmp/x-expected.jsonl
//! X_COUNTER=/tmp/x-expected.jsonl CARGO_TARGET_DIR=target/agent-text \
//!   cargo test -p xeet-text --test x_client -- --nocapture
//! ```
//!
//! It is opt-in because it needs node and a corpus, so the `x_client_fixture`
//! test below carries a committed excerpt of the same run.

use std::path::PathBuf;

use xeet_text as tt;

/// Answers captured from X's counter (`tools/x-client/expected.mjs`), one per
/// line: `(text, weighted_length, valid)`.
const FIXTURE: &[(&str, u32, bool)] = &[
    ("\u{1F44D}\u{1F3FD}", 2, true),
    ("\u{2764}\u{FE0F}", 2, true),
    (
        "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}",
        2,
        true,
    ),
    ("\u{1F1FA}\u{1F1F8}", 2, true),
    ("1\u{FE0F}\u{20E3}", 2, true),
    ("#\u{FE0F}\u{20E3}", 2, true),
    ("1\u{20E3}", 2, true),
    (
        "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
        2,
        true,
    ),
    ("\u{1F3F4}\u{E0067}\u{E0062}\u{E0075}\u{E007F}", 10, true),
    ("\u{1F426}\u{200D}\u{1F525}", 2, true),
    ("\u{1F441}\u{FE0F}\u{200D}\u{1F5E8}\u{FE0F}", 2, true),
    ("\u{1FAF1}\u{1F3FB}", 2, true),
    ("\u{1FAE9}", 2, true),
    ("\u{1F9D1}\u{1F3FF}\u{200D}\u{1F9B3}", 2, true),
    ("\u{270C}\u{1F3FF}", 2, true),
    ("\u{2614}\u{1F3FB}", 2, true),
    ("\u{2605}\u{FE0F}", 4, true),
    ("launch \u{1F680} done", 14, true),
    ("launch \u{1F680}\u{1F44D}\u{1F3FD} done", 16, true),
    ("\u{1F44D}\u{1F3FD}\u{1F44D}\u{1F3FD}", 4, true),
    ("hi\u{FEFF}", 4, false),
    ("   ", 3, true),
    ("", 0, false),
];

#[test]
fn x_client_fixture() {
    let mut cases: Vec<(String, u32, bool)> = FIXTURE
        .iter()
        .map(|&(t, w, v)| (t.to_string(), w, v))
        .collect();
    // Lengths at and over the limit, and CJK, straight from the client run.
    cases.push(("a".repeat(280), 280, true));
    cases.push(("a".repeat(281), 281, false));
    cases.push(("\u{306E}".repeat(140), 280, true));
    let mut failures = Vec::new();
    for (text, weighted, valid) in cases {
        let parsed = tt::parse(&text);
        if parsed.weighted_length != weighted || parsed.valid != valid {
            failures.push(format!(
                "{text:?}: got {} / valid {}, X's client gives {weighted} / valid {valid}",
                parsed.weighted_length, parsed.valid
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "counter disagreements:\n{}",
        failures.join("\n")
    );
}

/// Where the two configurations disagree, from the client run above. This is the
/// whole point of the split: the conformance suite is silent on these.
#[test]
fn default_differs_from_the_conformance_table_on_new_emoji() {
    let cases = [
        ("\u{270C}\u{1F3FF}", 2, 4),          // victory hand + skin tone
        ("\u{261D}\u{1F3FB}", 2, 4),          // index finger + skin tone
        ("\u{1F426}\u{200D}\u{1F525}", 2, 5), // bird + ZWJ + fire
        ("\u{1F441}\u{FE0F}\u{200D}\u{1F5E8}\u{FE0F}", 2, 5), // eye in speech bubble
        ("\u{1FAF1}\u{1F3FB}", 2, 4),         // handshake + skin tone
        ("   ", 3, 0),                        // blank text
    ];
    for (text, want_x, want_v3) in cases {
        assert_eq!(tt::parse(text).weighted_length, want_x, "X: {text:?}");
        assert_eq!(
            tt::parse_with(text, tt::Config::V3).weighted_length,
            want_v3,
            "twitter-text 3.1.0: {text:?}"
        );
    }
}

#[test]
fn x_client_corpus() {
    let Ok(path) = std::env::var("X_COUNTER") else {
        eprintln!("X_COUNTER not set: skipping the differential run (see the module docs)");
        return;
    };
    let raw = std::fs::read_to_string(PathBuf::from(path)).expect("expected jsonl");
    let mut checked = 0;
    let mut mismatches = Vec::new();
    for line in raw.lines() {
        let v: serde_json::Value = serde_json::from_str(line).expect("json");
        let text = v["t"].as_str().expect("text");
        let weighted = v["weighted"].as_u64().expect("weighted") as u32;
        let valid = v["valid"].as_bool().expect("valid");
        let parsed = tt::parse(text);
        checked += 1;
        if parsed.weighted_length != weighted || parsed.valid != valid {
            mismatches.push(format!(
                "{text:?}: {} / valid {} vs X {} / valid {}",
                parsed.weighted_length, parsed.valid, weighted, valid
            ));
        }
    }
    println!("{checked} texts, {} disagreements", mismatches.len());
    assert!(
        mismatches.is_empty(),
        "disagreements:\n{}",
        mismatches
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
