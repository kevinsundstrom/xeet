//! The pipeline as a caller sees it: fixtures in, PNG and report out.
//!
//! These tests are deliberately end to end and fixture-driven: they exercise
//! whatever `rules`, `frame`, `cards` and `paint` currently are, so they keep
//! passing (or start failing) when a stage lands or changes, without knowing
//! its internals.

use std::path::PathBuf;

use xeet_core::limits::{self, Limits};
use xeet_core::model::{Media, RenderOptions, Surface, Theme};
use xeet_core::render;

fn fixture(name: &str) -> xeet_core::model::Post {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/posts")
        .join(name);
    let json = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    limits::parse_post(&json).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn fixture_names() -> Vec<String> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/posts");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("the fixtures directory")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    assert!(!names.is_empty(), "no fixtures in {}", dir.display());
    names
}

fn options(width: f32, theme: Theme, dpr: f32) -> RenderOptions {
    RenderOptions {
        surface: Surface::WebTimeline,
        width,
        theme,
        dpr,
        font_scale: 1.0,
        expanded: false,
    }
}

/// An avatar slot is never a placeholder: x.com always draws a picture there,
/// and the renderer falls back to X's own default profile image when the post
/// carries no avatar bytes. This guards the display list (frame, quote card) and
/// the image source together — a placeholder label here is a visible e2e failure.
#[test]
fn an_avatar_slot_is_an_image_even_without_bytes() {
    let mut post: xeet_core::model::Post = serde_json::from_str(
        &std::fs::read_to_string("../../tests/fixtures/posts/text-simple.json").unwrap(),
    )
    .unwrap();
    post.author.avatar = None;
    let opts = xeet_core::model::RenderOptions::default();
    let (list, _) = xeet_core::render::display_list(&post, &opts).unwrap();
    let avatar = xeet_core::tokens::AVATAR_SIZE;
    let mut seen_avatar_image = false;
    for item in &list.items {
        if let xeet_core::display::Item::Placeholder { shape, label } = item {
            assert!(
                !(shape.rect.w == avatar && shape.rect.h == avatar),
                "an avatar-sized placeholder is a bug: label {label:?}"
            );
        }
        if let xeet_core::display::Item::Image { image, shape, .. } = item {
            if *image == xeet_core::display::ImageRef::Avatar {
                seen_avatar_image = true;
                assert_eq!((shape.rect.w, shape.rect.h), (avatar, avatar));
            }
        }
    }
    assert!(seen_avatar_image, "the avatar slot must be an image item");
}

#[test]
fn every_fixture_explains_and_renders() {
    for name in fixture_names() {
        let post = fixture(&name);
        for opts in [
            options(390.0, Theme::Dark, 3.0),
            options(600.0, Theme::Light, 2.0),
        ] {
            let report =
                render::explain(&post, &opts).unwrap_or_else(|e| panic!("{name}: explain: {e}"));
            assert!(
                report.size.width > 0.0 && report.size.height > 0.0,
                "{name}: empty size"
            );
            assert_eq!(
                report.size.width,
                opts.width.min(600.0),
                "{name}: the column is min(width, 600)"
            );
            assert!(
                report.ruleset.starts_with("x-web@"),
                "{name}: ruleset {:?}",
                report.ruleset
            );
            assert!(report.length.limit > 0, "{name}: no length limit");
            assert!(
                !report.verified_for.is_empty(),
                "{name}: no verified surfaces"
            );

            let (png, rendered) =
                render::render(&post, &opts).unwrap_or_else(|e| panic!("{name}: render: {e}"));
            assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "{name}: not a PNG");
            assert_eq!(
                (rendered.size.width, rendered.size.height),
                (report.size.width, report.size.height),
                "{name}: render and explain disagree about the size"
            );
            // The raster is the report's size at the device pixel ratio.
            let expected_w = (report.size.width * opts.dpr).ceil() as u32;
            let expected_h = (report.size.height * opts.dpr).ceil() as u32;
            let (w, h) = png_dimensions(&png);
            assert_eq!(
                (w, h),
                (expected_w, expected_h),
                "{name}: PNG is {w}×{h}, the report says {expected_w}×{expected_h}"
            );
        }
    }
}

#[test]
fn the_same_input_gives_the_same_bytes() {
    for name in fixture_names() {
        let post = fixture(&name);
        let opts = options(390.0, Theme::Light, 2.0);
        let a = render::render(&post, &opts).unwrap().0;
        let b = render::render(&post, &opts).unwrap().0;
        assert_eq!(a, b, "{name}: two renders of the same input differ");
    }
}

#[test]
fn a_sheet_holds_every_cell() {
    let post = fixture("text-simple.json");
    let png = render::sheet(
        &post,
        &[320.0, 390.0, 600.0],
        &[Theme::Light, Theme::Dark],
        1.0,
    )
    .unwrap();
    let (w, h) = png_dimensions(&png);
    // Three columns plus gaps and margins: wider than the widest cell, and two
    // rows plus labels: taller than one cell.
    assert!(w > 600, "sheet is {w} wide");
    assert!(h > 100, "sheet is {h} tall");
}

#[test]
fn the_reports_json_round_trips() {
    let post = fixture("links-card.json");
    let report = render::explain(&post, &options(390.0, Theme::Dark, 2.0)).unwrap();
    let json = serde_json::to_string(&report).unwrap();
    let back: xeet_core::model::Report = serde_json::from_str(&json).unwrap();
    assert_eq!(back.size.height, report.size.height);
    assert_eq!(back.ruleset, report.ruleset);
}

#[test]
fn limits_refuse_hostile_input_without_panicking() {
    let post = fixture("text-simple.json");
    let limits = Limits::standard();

    // Too many attachments.
    let mut many = post.clone();
    many.media = (0..21)
        .map(|_| Media {
            width: 10,
            height: 10,
            ..Media::default()
        })
        .collect();
    let err = render::explain(&many, &options(390.0, Theme::Light, 2.0)).unwrap_err();
    assert_eq!(err.http_status(), 400);
    assert!(err.to_json()["fields"]
        .as_array()
        .is_some_and(|f| !f.is_empty()));

    // Too much text.
    let mut huge = post.clone();
    huge.text = "a".repeat(limits.max_text_chars + 1);
    assert!(!render::explain(&huge, &options(390.0, Theme::Light, 2.0)).is_ok());

    // An absurd output size.
    assert!(
        !render::render(&post, &options(1200.0, Theme::Light, 4.0)).is_ok()
            || limits.check_output(1200.0, 1.0, 4.0).is_ok()
    );

    // A sheet over the cell cap.
    let widths: Vec<f32> = (0..20).map(|i| 300.0 + i as f32).collect();
    assert!(render::sheet(&post, &widths, &[Theme::Light], 1.0).is_err());

    // An unparseable option value.
    assert!(limits::parse_options("{\"width\": \"wide\"}").is_err());
}

#[test]
fn placeholder_and_real_media_both_render() {
    let mut post = fixture("media-four.json");
    let opts = options(390.0, Theme::Light, 2.0);
    let placeholders = render::render(&post, &opts).unwrap();
    assert!(placeholders.0.len() > 200);

    // The same post with real bytes: a 4×4 PNG, repeated, must decode and not
    // change the geometry (`media-four.json` declares larger dimensions; the
    // decoder's own size wins for the crop, so the height may move, but it
    // must not fail).
    let pixel = tiny_png();
    let b64 = base64(&pixel);
    for (i, m) in post.media.iter_mut().enumerate() {
        if i < 2 {
            m.width = 4;
            m.height = 4;
            m.data = Some(b64.clone());
        }
    }
    let with_bytes = render::render(&post, &opts).unwrap();
    assert!(with_bytes.0.len() > 200);
}

fn png_dimensions(png: &[u8]) -> (u32, u32) {
    // IHDR: width and height are big-endian u32 at offsets 16 and 20.
    assert!(png.len() > 24, "PNG is too short");
    let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let h = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    (w, h)
}

/// A 4×4 opaque red PNG, built here so the test needs no binary fixture.
fn tiny_png() -> Vec<u8> {
    let mut pixmap = xeet_core::paint::Pixmap::new(4, 4);
    for i in (0..pixmap.rgba.len()).step_by(4) {
        pixmap.rgba[i..i + 4].copy_from_slice(&[255, 0, 0, 255]);
    }
    xeet_core::paint::encode_png(&pixmap)
}

fn base64(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                s.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}
