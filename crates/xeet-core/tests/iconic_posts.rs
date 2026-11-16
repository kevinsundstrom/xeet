//! Regression suite for four iconic emoji / box-drawing / kaomoji X posts:
//!
//! 1. `@NASAGoddard` (`928356699043491842`) — space field with `🌟 🌙 🛰️ ✨ 🚀 🌏 🌞 ☄️`
//! 2. `@MerriamWebster` (`908706514302570497`) — `"Whataboutism"` with `⚪️` / `🔘` radio buttons + card
//! 3. `@MerriamWebster` (`905445022878879744`) — `┻┳|` brick wall + `•.•)` / `⊂ﾉ` peeking face + card
//! 4. `@pizzahut` (`928347864471875585`) — `(•_•)` / `<)   )╯` dancing figure + 22 `🍕` slices

use std::path::PathBuf;

use xeet_core::display::Item;
use xeet_core::fonts::{self, FaceKind};
use xeet_core::limits;
use xeet_core::model::{Post, RenderOptions, Surface, Theme};
use xeet_core::render;

const ICONIC_FIXTURES: &[&str] = &[
    "iconic-nasa-goddard.json",
    "iconic-mw-whataboutism.json",
    "iconic-mw-anyways.json",
    "iconic-pizzahut.json",
];

fn load(name: &str) -> Post {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/posts")
        .join(name);
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    limits::parse_post(&raw).unwrap_or_else(|e| panic!("{name}: {e}"))
}

#[test]
fn all_four_iconic_posts_fit_within_280_weighted_characters() {
    for &name in ICONIC_FIXTURES {
        let post = load(name);
        let len = xeet_text::weighted_length(&post.text);
        assert!(
            len > 0 && len <= 280,
            "{name}: expected <= 280 weighted chars, got {len}"
        );
    }
}

#[test]
fn iconic_posts_have_zero_missing_glyphs_across_surfaces_and_widths() {
    let db = fonts::db();
    let emoji_id = db.select('🚀', 400, true);
    assert_eq!(db.face(emoji_id).kind, FaceKind::Emoji);
    assert_eq!(db.face(emoji_id).family, "Apple Color Emoji");

    for &ch in &['┻', '┳', '╯', 'ﾉ'] {
        let fid = db.select(ch, 400, false);
        assert_eq!(
            db.face(fid).family,
            "Hiragino Sans",
            "expected Hiragino Sans for U+{:04X} ({ch:?}), got {}",
            ch as u32,
            db.face(fid).family
        );
        assert!(db.face(fid).glyph(ch).is_some(), "missing glyph for {ch:?}");
    }

    for &name in ICONIC_FIXTURES {
        let post = load(name);
        for surface in [Surface::WebTimeline, Surface::WebDetail] {
            for width in [320.0, 390.0, 600.0] {
                let opts = RenderOptions {
                    surface,
                    width,
                    theme: Theme::Light,
                    dpr: 2.0,
                    font_scale: 1.0,
                    expanded: false,
                };
                let (list, report) = render::display_list(&post, &opts)
                    .unwrap_or_else(|e| panic!("{name} {surface:?} {width}: {e}"));
                let mut emoji_runs = 0usize;
                for item in &list.items {
                    if let Item::Glyphs { face, glyphs, .. } = item {
                        let f = db.face(*face);
                        if f.kind == FaceKind::Emoji {
                            emoji_runs += 1;
                        }
                        for g in glyphs {
                            assert_ne!(
                                g.id, 0,
                                "{name} ({surface:?} w={width}) emitted .notdef glyph 0 in face {} ({})",
                                f.family, f.file
                            );
                        }
                    }
                }
                if name != "iconic-mw-anyways.json" {
                    assert!(emoji_runs > 0, "{name}: expected at least one emoji run");
                }
                let (png, _) = render::render(&post, &opts)
                    .unwrap_or_else(|e| panic!("{name} render failed: {e}"));
                assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
                assert!(report.size.height > 200.0);
            }
        }
    }
}

#[test]
fn merriam_webster_cards_strip_leading_www_from_domain_credit() {
    let db = fonts::db();
    for &name in &["iconic-mw-whataboutism.json", "iconic-mw-anyways.json"] {
        let post = load(name);
        let opts = RenderOptions {
            surface: Surface::WebDetail,
            width: 390.0,
            theme: Theme::Light,
            dpr: 2.0,
            font_scale: 1.0,
            expanded: false,
        };
        let (list, _) = render::display_list(&post, &opts).unwrap();
        let w_glyph = db
            .primary(400)
            .glyph('w')
            .expect("Chirp must have lowercase 'w'");
        let mut saw_credit = false;
        for item in &list.items {
            if let Item::Glyphs { size, glyphs, .. } = item {
                if (*size - 13.0).abs() < 0.01 && glyphs.len() >= 20 {
                    let w_count = glyphs.iter().filter(|g| g.id == w_glyph).count();
                    if w_count == 1 {
                        saw_credit = true;
                    }
                    assert!(
                        w_count < 3,
                        "{name}: card credit kept leading www. (w_count={w_count})"
                    );
                }
            }
        }
        assert!(
            saw_credit,
            "{name}: expected `From merriam-webster.com` credit run"
        );
    }
}
