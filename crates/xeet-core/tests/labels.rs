// Entity labels and display forms are bounded: one oversized label on many
// mentions must not multiply into gigabytes.
use xeet_core::limits::{validate, Limits, MAX_LABEL_CHARS};
use xeet_core::model::{Post, RenderOptions};
use xeet_core::rules::SpanKind;

fn post(json: &str) -> Post {
    serde_json::from_str(json).unwrap()
}

#[test]
fn an_oversized_entity_label_is_refused() {
    let big = "x".repeat(MAX_LABEL_CHARS + 1);
    let p = post(&format!(
        r#"{{"text":"@a @a @a","entityLabels":{{"@a":"{big}"}}}}"#
    ));
    let err = validate(&p, &RenderOptions::default(), &Limits::standard()).unwrap_err();
    assert!(
        err.iter()
            .any(|e| e.path.contains("entityLabels") && e.message.contains("280")),
        "{err:?}"
    );
}

#[test]
fn a_normal_label_passes_and_a_long_display_form_is_refused() {
    let ok = post(r#"{"text":"@Bot said hi","entityLabels":{"@Bot":"@bot"}}"#);
    assert!(validate(&ok, &RenderOptions::default(), &Limits::standard()).is_ok());
    let big = "d".repeat(MAX_LABEL_CHARS + 1);
    let bad = post(&format!(
        r#"{{"text":"https://vercel.com/a","links":{{"https://vercel.com/a":{{"display":"{big}"}}}}}}"#
    ));
    let err = validate(&bad, &RenderOptions::default(), &Limits::standard()).unwrap_err();
    assert!(err.iter().any(|e| e.path.ends_with(".display")), "{err:?}");
}

#[test]
fn an_unvalidated_oversized_label_falls_back_to_the_written_token() {
    // `explain` validates first; the rules layer underneath holds the line on
    // its own, keeping the written token when a label is past the bound.
    let big = "x".repeat(MAX_LABEL_CHARS + 1);
    let p = post(&format!(
        r#"{{"text":"@a","entityLabels":{{"@a":"{big}"}}}}"#
    ));
    let d = xeet_core::rules::decide(&p, &RenderOptions::default());
    let mention = d
        .body
        .iter()
        .find(|s| s.kind == SpanKind::Mention)
        .expect("the mention is a body span");
    assert_eq!(mention.text, "@a");
}

#[test]
fn too_many_entity_labels_are_refused() {
    let limits = Limits::standard();
    let labels: Vec<String> = (0..=limits.max_entity_labels)
        .map(|i| format!(r#""@a{i}":"@a{i}""#))
        .collect();
    let p = post(&format!(
        r#"{{"text":"@a0","entityLabels":{{{}}}}}"#,
        labels.join(",")
    ));
    let err = validate(&p, &RenderOptions::default(), &limits).unwrap_err();
    assert!(
        err.iter()
            .any(|e| e.path.ends_with("entityLabels") && e.message.contains("entries")),
        "{err:?}"
    );
}

#[test]
fn unlimited_lifts_the_label_bounds() {
    let big = "x".repeat(MAX_LABEL_CHARS + 1);
    let p = post(&format!(
        r#"{{"text":"@a","entityLabels":{{"@a":"{big}"}}}}"#
    ));
    assert!(validate(&p, &RenderOptions::default(), &Limits::unlimited()).is_ok());
}
