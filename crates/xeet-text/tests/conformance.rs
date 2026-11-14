//! The official twitter-text conformance suite, run in full.
//!
//! The YAML files live in `/tests/conformance` at the workspace root, unmodified
//! from <https://github.com/twitter/twitter-text> (Apache-2.0, see the README
//! there). Every case in every section runs; a section that stops being covered
//! fails the `case_counts` test rather than silently shrinking.

use std::collections::BTreeMap;
use std::path::PathBuf;

use xeet_text as tt;
use yaml_rust2::{Yaml, YamlLoader};

const EXTRACT: &str = "extract.yml";
const AUTOLINK: &str = "autolink.yml";
const VALIDATE: &str = "validate.yml";
const TLDS: &str = "tlds.yml";
const HIGHLIGHT: &str = "hit_highlighting.yml";

fn load(file: &str) -> Yaml {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/conformance")
        .join(file);
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {}", path.display(), e));
    let mut docs =
        YamlLoader::load_from_str(&text).unwrap_or_else(|e| panic!("{}: {:?}", path.display(), e));
    docs.pop().expect("empty yaml")
}

fn section(file: &str, name: &str) -> Vec<Yaml> {
    let root = load(file);
    let tests = &root["tests"];
    match &tests[name] {
        Yaml::Array(cases) => cases.clone(),
        other => panic!("{}: section {name} is {:?}, not a list", file, other),
    }
}

fn s(v: &Yaml) -> String {
    match v {
        Yaml::String(s) => s.clone(),
        Yaml::Integer(i) => i.to_string(),
        Yaml::Boolean(b) => b.to_string(),
        other => panic!("expected a string, got {other:?}"),
    }
}

fn desc(case: &Yaml) -> String {
    s(&case["description"])
}

fn strings(v: &Yaml) -> Vec<String> {
    match v {
        Yaml::Array(items) => items.iter().map(s).collect(),
        Yaml::Null => Vec::new(),
        other => panic!("expected a list of strings, got {other:?}"),
    }
}

fn indices(v: &Yaml) -> (usize, usize) {
    let items = v.as_vec().expect("indices");
    (
        items[0].as_i64().expect("index") as usize,
        items[1].as_i64().expect("index") as usize,
    )
}

/// Runs a list of cases, panicking once with every failure.
fn run_all<F: Fn(&Yaml) -> Result<(), String>>(label: &str, cases: &[Yaml], f: F) {
    let mut failures = Vec::new();
    for case in cases {
        if let Err(message) = f(case) {
            failures.push(format!(
                "[{}] {}: {}",
                desc(case),
                message,
                s(&case["text"])
            ));
        }
    }
    if !failures.is_empty() {
        panic!(
            "{}: {} of {} cases failed:\n{}",
            label,
            failures.len(),
            cases.len(),
            failures.join("\n")
        );
    }
}

// ---------------------------------------------------------------------------
// extract.yml
// ---------------------------------------------------------------------------

#[test]
fn extract_mentions() {
    let cases = section(EXTRACT, "mentions");
    run_all("extract.yml mentions", &cases, |c| {
        let got = tt::mentions(&s(&c["text"]));
        let want = strings(&c["expected"]);
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got:?}, want {want:?}"))
        }
    });
}

#[test]
fn extract_mentions_with_indices() {
    let cases = section(EXTRACT, "mentions_with_indices");
    run_all("extract.yml mentions_with_indices", &cases, |c| {
        let text = s(&c["text"]);
        let parsed = tt::parse(&text);
        let got: Vec<(String, (usize, usize))> = parsed
            .entities
            .iter()
            .filter(|e| e.kind == tt::EntityKind::Mention)
            .map(|e| {
                (
                    e.screen_name().unwrap_or_default().to_string(),
                    (e.start, e.end),
                )
            })
            .collect();
        let want: Vec<(String, (usize, usize))> = c["expected"]
            .as_vec()
            .unwrap()
            .iter()
            .map(|e| (s(&e["screen_name"]), indices(&e["indices"])))
            .collect();
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got:?}, want {want:?}"))
        }
    });
}

#[test]
fn extract_mentions_or_lists_with_indices() {
    let cases = section(EXTRACT, "mentions_or_lists_with_indices");
    run_all("extract.yml mentions_or_lists_with_indices", &cases, |c| {
        let text = s(&c["text"]);
        let parsed = tt::parse(&text);
        let got: Vec<(String, String, (usize, usize))> = parsed
            .entities
            .iter()
            .filter(|e| e.kind == tt::EntityKind::Mention)
            .map(|e| {
                (
                    e.screen_name().unwrap_or_default().to_string(),
                    e.list_slug().unwrap_or_default().to_string(),
                    (e.start, e.end),
                )
            })
            .collect();
        let want: Vec<(String, String, (usize, usize))> = c["expected"]
            .as_vec()
            .unwrap()
            .iter()
            .map(|e| {
                (
                    s(&e["screen_name"]),
                    s(&e["list_slug"]),
                    indices(&e["indices"]),
                )
            })
            .collect();
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got:?}, want {want:?}"))
        }
    });
}

#[test]
fn extract_replies() {
    let cases = section(EXTRACT, "replies");
    run_all("extract.yml replies", &cases, |c| {
        let got = tt::reply_screenname(&s(&c["text"]));
        let want = match &c["expected"] {
            Yaml::Null => None,
            v => Some(s(v)),
        };
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got:?}, want {want:?}"))
        }
    });
}

#[test]
fn extract_urls() {
    let cases = section(EXTRACT, "urls");
    run_all("extract.yml urls", &cases, |c| {
        let got = tt::urls(&s(&c["text"]));
        let want = strings(&c["expected"]);
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got:?}, want {want:?}"))
        }
    });
}

fn check_urls_with_indices(cases: &[Yaml], label: &str) {
    run_all(label, cases, |c| {
        let parsed = tt::parse(&s(&c["text"]));
        let got: Vec<(String, (usize, usize))> = parsed
            .entities
            .iter()
            .filter_map(|e| match &e.kind {
                tt::EntityKind::Url { .. } => Some((e.text.clone(), (e.start, e.end))),
                _ => None,
            })
            .collect();
        let want: Vec<(String, (usize, usize))> = c["expected"]
            .as_vec()
            .unwrap()
            .iter()
            .map(|e| (s(&e["url"]), indices(&e["indices"])))
            .collect();
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got:?}, want {want:?}"))
        }
    });
}

#[test]
fn extract_urls_with_indices() {
    check_urls_with_indices(
        &section(EXTRACT, "urls_with_indices"),
        "extract.yml urls_with_indices",
    );
}

#[test]
fn extract_urls_with_directional_markers() {
    check_urls_with_indices(
        &section(EXTRACT, "urls_with_directional_markers"),
        "extract.yml urls_with_directional_markers",
    );
}

#[test]
fn extract_tco_urls_with_params() {
    let cases = section(EXTRACT, "tco_urls_with_params");
    run_all("extract.yml tco_urls_with_params", &cases, |c| {
        let got = tt::urls(&s(&c["text"]));
        let want = strings(&c["expected"]);
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got:?}, want {want:?}"))
        }
    });
}

#[test]
fn extract_hashtags() {
    for name in ["hashtags", "hashtags_from_astral"] {
        let cases = section(EXTRACT, name);
        run_all(&format!("extract.yml {name}"), &cases, |c| {
            let got = tt::hashtags(&s(&c["text"]));
            let want = strings(&c["expected"]);
            if got == want {
                Ok(())
            } else {
                Err(format!("got {got:?}, want {want:?}"))
            }
        });
    }
}

#[test]
fn extract_hashtags_with_indices() {
    let cases = section(EXTRACT, "hashtags_with_indices");
    run_all("extract.yml hashtags_with_indices", &cases, |c| {
        let parsed = tt::parse(&s(&c["text"]));
        let got: Vec<(String, (usize, usize))> = parsed
            .entities
            .iter()
            .filter(|e| e.kind == tt::EntityKind::Hashtag)
            .map(|e| {
                (
                    e.hashtag().unwrap_or_default().to_string(),
                    (e.start, e.end),
                )
            })
            .collect();
        let want: Vec<(String, (usize, usize))> = c["expected"]
            .as_vec()
            .unwrap()
            .iter()
            .map(|e| (s(&e["hashtag"]), indices(&e["indices"])))
            .collect();
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got:?}, want {want:?}"))
        }
    });
}

#[test]
fn extract_cashtags() {
    let cases = section(EXTRACT, "cashtags");
    run_all("extract.yml cashtags", &cases, |c| {
        let got = tt::cashtags(&s(&c["text"]));
        let want = strings(&c["expected"]);
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got:?}, want {want:?}"))
        }
    });
}

#[test]
fn extract_cashtags_with_indices() {
    let cases = section(EXTRACT, "cashtags_with_indices");
    run_all("extract.yml cashtags_with_indices", &cases, |c| {
        let parsed = tt::parse(&s(&c["text"]));
        let got: Vec<(String, (usize, usize))> = parsed
            .entities
            .iter()
            .filter(|e| e.kind == tt::EntityKind::Cashtag)
            .map(|e| {
                (
                    e.cashtag().unwrap_or_default().to_string(),
                    (e.start, e.end),
                )
            })
            .collect();
        let want: Vec<(String, (usize, usize))> = c["expected"]
            .as_vec()
            .unwrap()
            .iter()
            .map(|e| (s(&e["cashtag"]), indices(&e["indices"])))
            .collect();
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got:?}, want {want:?}"))
        }
    });
}

// ---------------------------------------------------------------------------
// tlds.yml
// ---------------------------------------------------------------------------

#[test]
fn tlds() {
    for name in ["country", "generic"] {
        let cases = section(TLDS, name);
        run_all(&format!("tlds.yml {name}"), &cases, |c| {
            let got = tt::urls(&s(&c["text"]));
            let want = strings(&c["expected"]);
            if got == want {
                Ok(())
            } else {
                Err(format!("got {got:?}, want {want:?}"))
            }
        });
    }
}

// ---------------------------------------------------------------------------
// validate.yml
// ---------------------------------------------------------------------------

fn expect_bool(case: &Yaml) -> bool {
    case["expected"].as_bool().expect("expected bool")
}

/// Cases in `validate.yml:tweets` that predate the 280-character limit.
///
/// Their descriptions say "141 characters", but the texts measure 140 UTF-16
/// units and weigh 143 (a 23-weight URL replaces 20 characters), so they are
/// invalid only under the old 140 limit. twitter-text 3.1.0's own
/// `isValidTweetText` returns `true` for both (checked against the published
/// package: `twitter-text@3.1.0`, `parseTweet(...).weightedLength === 143`,
/// `valid === true`). Under configuration v3 they are valid posts, so this crate
/// reports `true` and the expectation is treated as obsolete.
const OBSOLETE_140_LIMIT_CASES: &[&str] = &[
    "Invalid Tweet: 141 characters",
    "Invalid Tweet: 141 characters (due to newline)",
];

#[test]
fn validate_tweets() {
    let cases = section(VALIDATE, "tweets");
    run_all("validate.yml tweets", &cases, |c| {
        let text = s(&c["text"]);
        let got = tt::is_valid_tweet_text(&text);
        if OBSOLETE_140_LIMIT_CASES.contains(&desc(c).as_str()) {
            // Prove the case is about the old limit and that v3 disagrees with it.
            assert!(!expect_bool(c), "{}: expectation changed", desc(c));
            assert!(
                tt::weighted_length(&text) > 140,
                "{}: under 140 weighted",
                desc(c)
            );
            assert!(got, "{}: should be valid under the 280 limit", desc(c));
            return Ok(());
        }
        let want = expect_bool(c);
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got}, want {want}"))
        }
    });
}

#[test]
fn validate_usernames() {
    let cases = section(VALIDATE, "usernames");
    run_all("validate.yml usernames", &cases, |c| {
        let got = tt::is_valid_username(&s(&c["text"]));
        let want = expect_bool(c);
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got}, want {want}"))
        }
    });
}

#[test]
fn validate_lists() {
    let cases = section(VALIDATE, "lists");
    run_all("validate.yml lists", &cases, |c| {
        let got = tt::is_valid_list(&s(&c["text"]));
        let want = expect_bool(c);
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got}, want {want}"))
        }
    });
}

#[test]
fn validate_hashtags() {
    let cases = section(VALIDATE, "hashtags");
    run_all("validate.yml hashtags", &cases, |c| {
        let got = tt::is_valid_hashtag(&s(&c["text"]));
        let want = expect_bool(c);
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got}, want {want}"))
        }
    });
}

#[test]
fn validate_urls() {
    let cases = section(VALIDATE, "urls");
    run_all("validate.yml urls", &cases, |c| {
        let got = tt::is_valid_url(&s(&c["text"]), true, true);
        let want = expect_bool(c);
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got}, want {want}"))
        }
    });
}

#[test]
fn validate_urls_without_protocol() {
    let cases = section(VALIDATE, "urls_without_protocol");
    run_all("validate.yml urls_without_protocol", &cases, |c| {
        let got = tt::is_valid_url(&s(&c["text"]), true, false);
        let want = expect_bool(c);
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got}, want {want}"))
        }
    });
}

fn expected_int(case: &Yaml, key: &str) -> usize {
    case["expected"][key]
        .as_i64()
        .unwrap_or_else(|| panic!("{} missing from {key}", desc(case))) as usize
}

fn check_weighted(name: &str, config: tt::Config) {
    let cases = section(VALIDATE, name);
    run_all(name, &cases, |c| {
        let parsed = tt::parse_with(&s(&c["text"]), config);
        let mut diffs = Vec::new();
        let want_weighted = expected_int(c, "weightedLength") as u32;
        if parsed.weighted_length != want_weighted {
            diffs.push(format!(
                "weightedLength {} != {want_weighted}",
                parsed.weighted_length
            ));
        }
        let want_valid = c["expected"]["valid"].as_bool().unwrap();
        if parsed.valid != want_valid {
            diffs.push(format!("valid {} != {want_valid}", parsed.valid));
        }
        let want_permillage = expected_int(c, "permillage") as u32;
        if parsed.permillage != want_permillage {
            diffs.push(format!(
                "permillage {} != {want_permillage}",
                parsed.permillage
            ));
        }
        // twitter-text reports an inclusive end offset; this crate reports an
        // exclusive one, so the expected value is one lower (except for empty
        // input, where twitter-text uses -1 and this crate uses 0).
        let want_display = expected_int(c, "displayRangeEnd") + 1;
        if parsed.display_end != want_display {
            diffs.push(format!(
                "displayRangeEnd {} != {}",
                parsed.display_end.saturating_sub(1),
                want_display - 1
            ));
        }
        // The start of both ranges is always the beginning of the text.
        assert_eq!(expected_int(c, "displayRangeStart"), 0, "{}", desc(c));
        assert_eq!(expected_int(c, "validRangeStart"), 0, "{}", desc(c));
        let want_valid_end = expected_int(c, "validRangeEnd") + 1;
        if parsed.valid_end != want_valid_end {
            diffs.push(format!(
                "validRangeEnd {} != {}",
                parsed.valid_end.saturating_sub(1),
                want_valid_end - 1
            ));
        }
        if diffs.is_empty() {
            Ok(())
        } else {
            Err(diffs.join(", "))
        }
    });
}

#[test]
fn weighted_tweets() {
    // This section pins configuration v2 (no emoji sequence parsing); the
    // section below pins v3. The two disagree only on emoji weights.
    check_weighted("WeightedTweetsCounterTest", tt::Config::V2);
}

#[test]
fn weighted_tweets_v3_of_same_inputs() {
    // The same inputs under v3: only the emoji cases differ, which is what makes
    // the v2 pin above a real distinction rather than a guess.
    let cases = section(VALIDATE, "WeightedTweetsCounterTest");
    let mut differing = Vec::new();
    for case in &cases {
        let text = s(&case["text"]);
        let v2 = tt::parse_with(text.as_str(), tt::Config::V2).weighted_length;
        let v3 = tt::parse_with(text.as_str(), tt::Config::V3).weighted_length;
        if v2 != v3 {
            differing.push(desc(case));
        }
    }
    assert_eq!(
        differing,
        vec![
            "Count a mix of single byte single word, and double word unicode characters".to_string(),
            "Count unicode emoji chars outside the basic multilingual plane with skin tone modifiers".to_string(),
        ]
    );
}

#[test]
fn x_and_conformance_configs_agree_on_the_suite() {
    // The suite never exercises the place where X's client and twitter-text 3.1.0
    // disagree (emoji that the 2021 table does not list), so every case passes
    // under either configuration. Pinned so that the day a case does distinguish
    // them, this fails and someone decides which answer the suite is pinning.
    for section_name in [
        "WeightedTweetsCounterTest",
        "WeightedTweetsWithDiscountedEmojiCounterTest",
        "UnicodeDirectionalMarkerCounterTest",
    ] {
        for case in section(VALIDATE, section_name) {
            let text = s(&case["text"]);
            let x = tt::parse_with(&text, tt::Config::X);
            let v3 = tt::parse_with(&text, tt::Config::V3);
            assert_eq!(
                (x.weighted_length, x.valid),
                (v3.weighted_length, v3.valid),
                "{section_name}: {}",
                desc(&case)
            );
        }
    }
}

#[test]
fn weighted_emoji_tweets() {
    check_weighted(
        "WeightedTweetsWithDiscountedEmojiCounterTest",
        tt::Config::V3,
    );
}

#[test]
fn unicode_directional_markers() {
    check_weighted("UnicodeDirectionalMarkerCounterTest", tt::Config::V3);
}

// ---------------------------------------------------------------------------
// autolink.yml
// ---------------------------------------------------------------------------

#[test]
fn autolink_sections() {
    // The suite drives one entry point per section, and they differ: only
    // `autoLink` bracket-escapes its input, and only it links every entity type.
    type Entry = (&'static str, fn(&str) -> String);
    let entry: [Entry; 6] = [
        ("usernames", tt::autolink_mentions),
        ("lists", tt::autolink_mentions),
        ("hashtags", tt::autolink_hashtags),
        ("urls", tt::autolink_urls),
        ("cashtags", tt::autolink_cashtags),
        ("all", tt::autolink),
    ];
    for (name, f) in entry {
        let cases = section(AUTOLINK, name);
        run_all(&format!("autolink.yml {name}"), &cases, |c| {
            let got = f(&s(&c["text"]));
            let want = s(&c["expected"]);
            if got == want {
                Ok(())
            } else {
                Err(format!("got {got}, want {want}"))
            }
        });
    }
}

#[test]
fn autolink_json() {
    let cases = section(AUTOLINK, "json");
    run_all("autolink.yml json", &cases, |c| {
        let api = parse_api_entities(&s(&c["json"]));
        let got = tt::autolink_with_api_entities(&s(&c["text"]), &api);
        let want = s(&c["expected"]);
        if got == want {
            Ok(())
        } else {
            Err(format!("got {got}, want {want}"))
        }
    });
}

/// The `json` cases embed an API payload; parse the subset these cases use.
fn parse_api_entities(json: &str) -> tt::ApiEntities {
    let value: serde_json::Value = serde_json::from_str(json).expect("json entity payload");
    let idx = |v: &serde_json::Value| {
        let a = v[0].as_u64().unwrap() as usize;
        let b = v[1].as_u64().unwrap() as usize;
        (a, b)
    };
    let mut out = tt::ApiEntities::default();
    for url in value["urls"].as_array().into_iter().flatten() {
        out.urls.push(tt::ApiUrl {
            url: url["url"].as_str().unwrap_or_default().to_string(),
            expanded_url: url["expanded_url"].as_str().unwrap_or_default().to_string(),
            display_url: url["display_url"].as_str().unwrap_or_default().to_string(),
            indices: idx(&url["indices"]),
        });
    }
    for tag in value["hashtags"].as_array().into_iter().flatten() {
        out.hashtags.push(tt::ApiTag {
            text: tag["text"].as_str().unwrap_or_default().to_string(),
            indices: idx(&tag["indices"]),
        });
    }
    for mention in value["user_mentions"].as_array().into_iter().flatten() {
        out.user_mentions.push(tt::ApiMention {
            screen_name: mention["screen_name"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            indices: idx(&mention["indices"]),
        });
    }
    for symbol in value["symbols"].as_array().into_iter().flatten() {
        out.symbols.push(tt::ApiTag {
            text: symbol["text"].as_str().unwrap_or_default().to_string(),
            indices: idx(&symbol["indices"]),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// hit_highlighting.yml
// ---------------------------------------------------------------------------

#[test]
fn hit_highlighting() {
    for name in ["plain_text", "with_links"] {
        let cases = section(HIGHLIGHT, name);
        run_all(&format!("hit_highlighting.yml {name}"), &cases, |c| {
            let hits: Vec<(usize, usize)> =
                c["hits"].as_vec().unwrap().iter().map(indices).collect();
            let got = tt::hit_highlight(&s(&c["text"]), &hits);
            let want = s(&c["expected"]);
            if got == want {
                Ok(())
            } else {
                Err(format!("got {got}, want {want}"))
            }
        });
    }
}

// ---------------------------------------------------------------------------
// The vendored tables must match the sources they were generated from.
// ---------------------------------------------------------------------------

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xCBF2_9CE4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01B3);
    }
    h
}

#[test]
fn generated_tables_match_their_sources() {
    // Every input the tables were generated from is hashed, so a vendored file
    // that changes without regenerating fails here instead of drifting.
    let vendor = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vendor");
    let lock = std::fs::read_to_string(vendor.join("SOURCES.lock")).expect("SOURCES.lock");
    let mut checked = 0;
    for line in lock.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let (path, hash) = line.split_once('\t').expect("path<TAB>hash");
        let hash = u64::from_str_radix(hash.trim().trim_start_matches("0x"), 16).expect("hash");
        let bytes = std::fs::read(vendor.join(path)).unwrap_or_else(|e| panic!("{path}: {e}"));
        assert_eq!(fnv1a(&bytes), hash, "vendored source changed: {path}");
        checked += 1;
    }
    assert_eq!(checked, 83, "expected 83 vendored inputs");
}

// ---------------------------------------------------------------------------
// Coverage: every case and section is accounted for, so a shrinking suite fails.
// ---------------------------------------------------------------------------

#[test]
fn case_counts() {
    let expected: BTreeMap<(&str, &str), usize> = [
        (EXTRACT, "mentions"),
        (EXTRACT, "mentions_with_indices"),
        (EXTRACT, "mentions_or_lists_with_indices"),
        (EXTRACT, "replies"),
        (EXTRACT, "urls"),
        (EXTRACT, "urls_with_indices"),
        (EXTRACT, "urls_with_directional_markers"),
        (EXTRACT, "tco_urls_with_params"),
        (EXTRACT, "hashtags"),
        (EXTRACT, "hashtags_from_astral"),
        (EXTRACT, "hashtags_with_indices"),
        (EXTRACT, "cashtags"),
        (EXTRACT, "cashtags_with_indices"),
        (TLDS, "country"),
        (TLDS, "generic"),
        (VALIDATE, "tweets"),
        (VALIDATE, "usernames"),
        (VALIDATE, "lists"),
        (VALIDATE, "hashtags"),
        (VALIDATE, "urls"),
        (VALIDATE, "urls_without_protocol"),
        (VALIDATE, "WeightedTweetsCounterTest"),
        (VALIDATE, "WeightedTweetsWithDiscountedEmojiCounterTest"),
        (VALIDATE, "UnicodeDirectionalMarkerCounterTest"),
        (AUTOLINK, "usernames"),
        (AUTOLINK, "lists"),
        (AUTOLINK, "hashtags"),
        (AUTOLINK, "urls"),
        (AUTOLINK, "cashtags"),
        (AUTOLINK, "all"),
        (AUTOLINK, "json"),
        (HIGHLIGHT, "plain_text"),
        (HIGHLIGHT, "with_links"),
    ]
    .into_iter()
    .map(|(file, name)| ((file, name), section(file, name).len()))
    .collect();

    let mut total = 0;
    let mut report = Vec::new();
    for ((file, name), n) in &expected {
        total += n;
        report.push(format!("{file}:{name} {n}"));
    }
    assert_eq!(total, 2119, "case total changed:\n{}", report.join("\n"));

    // The per-section counts are pinned so that a truncated or edited YAML file
    // is a test failure, not a quietly weaker suite.
    let pins = [
        ((EXTRACT, "mentions"), 23),
        ((EXTRACT, "mentions_with_indices"), 3),
        ((EXTRACT, "mentions_or_lists_with_indices"), 5),
        ((EXTRACT, "replies"), 13),
        ((EXTRACT, "urls"), 91),
        ((EXTRACT, "urls_with_indices"), 10),
        ((EXTRACT, "urls_with_directional_markers"), 2),
        ((EXTRACT, "tco_urls_with_params"), 5),
        ((EXTRACT, "hashtags"), 65),
        ((EXTRACT, "hashtags_from_astral"), 3),
        ((EXTRACT, "hashtags_with_indices"), 8),
        ((EXTRACT, "cashtags"), 8),
        ((EXTRACT, "cashtags_with_indices"), 2),
        ((TLDS, "country"), 315),
        ((TLDS, "generic"), 1259),
        ((VALIDATE, "tweets"), 8),
        ((VALIDATE, "usernames"), 4),
        ((VALIDATE, "lists"), 5),
        ((VALIDATE, "hashtags"), 7),
        ((VALIDATE, "urls"), 24),
        ((VALIDATE, "urls_without_protocol"), 5),
        ((VALIDATE, "WeightedTweetsCounterTest"), 20),
        (
            (VALIDATE, "WeightedTweetsWithDiscountedEmojiCounterTest"),
            22,
        ),
        ((VALIDATE, "UnicodeDirectionalMarkerCounterTest"), 2),
        ((AUTOLINK, "usernames"), 19),
        ((AUTOLINK, "lists"), 12),
        ((AUTOLINK, "hashtags"), 70),
        ((AUTOLINK, "urls"), 78),
        ((AUTOLINK, "cashtags"), 2),
        ((AUTOLINK, "all"), 10),
        ((AUTOLINK, "json"), 5),
        ((HIGHLIGHT, "plain_text"), 6),
        ((HIGHLIGHT, "with_links"), 8),
    ];
    for ((file, name), n) in pins {
        assert_eq!(
            expected[&(file, name)],
            n,
            "{file}:{name} case count changed"
        );
    }
}
