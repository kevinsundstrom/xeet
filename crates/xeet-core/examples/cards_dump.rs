//! Dumps a `cards::Block` as geometry JSON, for comparison against Chrome.
//!
//! Development tool, not part of the crate's API: `tools/oracle/cards-parity.mjs`
//! runs it next to a headless Chrome rendering of X's real markup and compares
//! the two box lists.
//!
//! Input on stdin:
//!
//! ```json
//! { "kind": "media" | "card" | "quote" | "poll",
//!   "width": 310,
//!   "post": { …model::Post… },
//!   "opts": { …model::RenderOptions… },
//!   "card": { "url": "…", "card": "summary_large_image" } }
//! ```
//!
//! Output:
//!
//! ```json
//! { "height": 191.25,
//!   "boxes": [ { "t": "fill", "x": 0, "y": 0, "w": 153, "h": 191.25,
//!                "r": 14.4, "squircle": true, "color": "#00000026" }, … ],
//!   "lines": [ { "x": 0, "y": 12, "w": 120.5 } ] }
//! ```
//!
//! `t` is one of `fill`, `stroke`, `image`, `icon`. `lines` carries each text
//! line's left edge and baseline, which the oracle compares with Chrome's
//! element top plus its floored half-leading and rounded ascent.

use std::io::Read;

use xeet_core::cards::{self, AttachmentKind};
use xeet_core::color::Rgba;
use xeet_core::display::{CornerShape, ImageRef, Item};

use xeet_core::model;

fn hex(c: Rgba) -> String {
    format!("#{:02x}{:02x}{:02x}{:02x}", c.r, c.g, c.b, c.a)
}

/// A stable name for an `ImageRef`, so the oracle can check that a box painted
/// inside a quoted post draws the *quoted* post's bytes. `Media(i)` and
/// `Quote(Media(i))` are different images even when `i` is the same number: the
/// first is the outer post's media.
fn image_ref_name(r: &ImageRef) -> String {
    match r {
        ImageRef::Avatar => "avatar".to_string(),
        ImageRef::AffiliateBadge => "affiliate".to_string(),
        ImageRef::Media(i) => format!("media:{i}"),
        ImageRef::MediaSourceAvatar(i) => format!("media-source-avatar:{i}"),
        ImageRef::Card(url) => format!("card:{url}"),
        ImageRef::Quote(inner) => format!("quote:{}", image_ref_name(inner)),
    }
}

struct Box_ {
    t: &'static str,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    r: f32,
    squircle: bool,
    color: Option<String>,
    /// `ImageRef` name for `image` items; `None` otherwise.
    image_ref: Option<String>,
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("stdin");
    let v: serde_json::Value = serde_json::from_str(&input).expect("json");
    let post: model::Post = serde_json::from_value(v["post"].clone()).expect("post");
    let opts: model::RenderOptions = match v.get("opts") {
        Some(o) => serde_json::from_value(o.clone()).expect("opts"),
        None => model::RenderOptions::default(),
    };
    let width = v["width"].as_f64().unwrap_or(310.0) as f32;
    let kind = match v["kind"].as_str().unwrap_or("media") {
        "card" => AttachmentKind::Card {
            url: v["card"]["url"].as_str().unwrap_or_default().to_string(),
            card: v["card"]["card"].as_str().unwrap_or("summary").to_string(),
        },
        "quote" => AttachmentKind::Quote,
        "poll" => AttachmentKind::Poll,
        _ => AttachmentKind::Media,
    };

    let block = cards::layout(&post, &opts, &kind, width);

    let mut boxes: Vec<Box_> = Vec::new();
    // Text lines: (baseline, leftmost start, unused). Runs that share a
    // baseline are one line, which is how the oracle groups them too.
    // (baseline, leftmost start, run count, every run's left edge)
    let mut lines: Vec<(f32, f32, u32, Vec<f32>)> = Vec::new();
    for item in &block.items {
        match item {
            Item::Fill { shape, color } => boxes.push(Box_ {
                t: "fill",
                x: shape.rect.x,
                y: shape.rect.y,
                w: shape.rect.w,
                h: shape.rect.h,
                r: shape.radii.tl,
                squircle: shape.corner == CornerShape::Squircle,
                color: Some(hex(*color)),
                image_ref: None,
            }),
            Item::Stroke { shape, color, .. } => boxes.push(Box_ {
                t: "stroke",
                x: shape.rect.x,
                y: shape.rect.y,
                w: shape.rect.w,
                h: shape.rect.h,
                r: shape.radii.tl,
                squircle: shape.corner == CornerShape::Squircle,
                color: Some(hex(*color)),
                image_ref: None,
            }),
            Item::Image { shape, image, .. } => boxes.push(Box_ {
                t: "image",
                x: shape.rect.x,
                y: shape.rect.y,
                w: shape.rect.w,
                h: shape.rect.h,
                r: shape.radii.tl,
                squircle: shape.corner == CornerShape::Squircle,
                color: None,
                image_ref: Some(image_ref_name(image)),
            }),
            Item::Placeholder { shape, .. } => boxes.push(Box_ {
                t: "image",
                x: shape.rect.x,
                y: shape.rect.y,
                w: shape.rect.w,
                h: shape.rect.h,
                r: shape.radii.tl,
                squircle: shape.corner == CornerShape::Squircle,
                color: None,
                image_ref: None,
            }),
            Item::Glyphs { x, y, glyphs, .. } => {
                // Text lines are compared per baseline: the oracle takes the
                // leftmost start of every run that shares a baseline, and this
                // side does the same. (A DOM range rectangle is not a line box:
                // inside a `-webkit-line-clamp` box Chrome shifts it by a
                // fraction of a pixel, and the display list keeps glyph
                // positions without advances, so a line's *right* edge belongs
                // to the text stream's own gate, `tools/oracle/text-parity.mjs`.)
                if let Some(first) = glyphs.first() {
                    let (baseline, left) = (*y, x + first.x);
                    // Chrome groups by the DOM range's *top*, within 1.5 px, so
                    // two runs of different sizes on one row (the ALT badge at
                    // 14 px and the attribution name at 13 px) are one line
                    // there. Mirror that tolerance here, or a single visual line
                    // would count twice.
                    match lines
                        .iter_mut()
                        .find(|(ly, _, _, _)| (ly - baseline).abs() <= 1.5)
                    {
                        Some((_, lx, runs, xs)) => {
                            *lx = lx.min(left);
                            *runs += 1;
                            xs.push(left);
                        }
                        // `runs` counts glyph runs: a line that was ellipsized has
                        // the text run plus a separate "…" run.
                        None => lines.push((baseline, left, 1, vec![left])),
                    }
                }
            }
            Item::Icon { rect, .. } => boxes.push(Box_ {
                t: "icon",
                x: rect.x,
                y: rect.y,
                w: rect.w,
                h: rect.h,
                r: 0.0,
                squircle: false,
                color: None,
                image_ref: None,
            }),
            Item::PushClip { .. } | Item::PopClip => {}
        }
    }
    // y first, then x, so both sides sort identically.
    lines.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let boxes_json: Vec<String> = boxes
        .iter()
        .map(|b| {
            format!(
                "{{\"t\":\"{}\",\"x\":{:.4},\"y\":{:.4},\"w\":{:.4},\"h\":{:.4},\"r\":{:.4},\"squircle\":{},\"color\":{},\"ref\":{}}}",
                b.t,
                b.x,
                b.y,
                b.w,
                b.h,
                b.r,
                b.squircle,
                match &b.color {
                    Some(c) => format!("\"{c}\""),
                    None => "null".to_string(),
                },
                match &b.image_ref {
                    Some(r) => format!("\"{r}\""),
                    None => "null".to_string(),
                }
            )
        })
        .collect();
    let lines_json: Vec<String> = lines
        .iter()
        .map(|(y, x, runs, xs)| {
            let xs: Vec<String> = xs.iter().map(|v| format!("{v:.4}")).collect();
            format!(
                "{{\"x\":{x:.4},\"y\":{y:.4},\"runs\":{runs},\"xs\":[{}]}}",
                xs.join(",")
            )
        })
        .collect();
    println!(
        "{{\"height\":{:.4},\"boxes\":[{}],\"lines\":[{}]}}",
        block.height,
        boxes_json.join(","),
        lines_json.join(",")
    );
}
