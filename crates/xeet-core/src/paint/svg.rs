//! An SVG rendering of a display list.
//!
//! This is for inspection and for people who want a vector artifact (a slide,
//! an email). It is an approximation: images become grey placeholders because
//! `DisplayList` carries no bytes, and anything the rasterizer does with
//! coverage (hinting choices, emoji layer compositing) is expressed with plain
//! fills. Text is drawn as glyph outlines in the exact positions layout
//! produced, so line breaks and spacing are the same.

use crate::display::{DisplayList, Item, Shape};
use crate::fonts::{db, FaceKind};
use std::fmt::Write;

pub fn to_svg(list: &DisplayList) -> String {
    let mut s = String::with_capacity(4096);
    let _ = write!(
        s,
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{}" height="{}" viewBox="0 0 {} {}">"#,
        round(list.width),
        round(list.height),
        round(list.width),
        round(list.height)
    );
    let _ = writeln!(s);
    let bg = list.background;
    if bg.a > 0 {
        let _ = writeln!(
            s,
            r#"<rect width="{}" height="{}" fill="{}"/>"#,
            round(list.width),
            round(list.height),
            css(bg)
        );
    }
    let mut clip_id = 0usize;
    let mut clips: Vec<usize> = Vec::new();
    for item in &list.items {
        match item {
            Item::Fill { shape, color } => {
                if let Some(d) = shape_d(shape) {
                    let _ = writeln!(s, r#"<path d="{}" fill="{}"/>"#, d, css(*color));
                }
            }
            Item::Stroke {
                shape,
                color,
                width,
            } => {
                if let Some(d) = shape_d(shape) {
                    let _ = writeln!(
                        s,
                        r#"<path d="{}" fill="none" stroke="{}" stroke-width="{}"/>"#,
                        d,
                        css(*color),
                        round(*width)
                    );
                }
            }
            Item::Glyphs {
                x,
                y,
                face,
                size,
                color,
                glyphs,
            } => {
                let fonts = db();
                let Some(f) = fonts.faces.get(*face as usize) else {
                    continue;
                };
                if f.kind == FaceKind::Emoji {
                    continue; // color glyphs are drawn from the raster path
                }
                let _ = writeln!(s, r#"<g fill="{}">"#, css(*color));
                for g in glyphs {
                    let Some(path) = crate::paint::glyph_path(f, g.id, *size) else {
                        continue;
                    };
                    let Some(d) = path_d(&path) else { continue };
                    let _ = writeln!(
                        s,
                        r#"<path transform="translate({} {})" d="{}"/>"#,
                        round(x + g.x),
                        round(y + g.y),
                        d
                    );
                }
                let _ = writeln!(s, "</g>");
            }
            Item::Icon { name, rect, color } => {
                if let Some(body) = crate::paint::icon_body(name) {
                    let scale = rect.w.min(rect.h) / 24.0;
                    let _ = writeln!(
                        s,
                        r#"<g transform="translate({} {}) scale({})" fill="{}" color="{}">{}</g>"#,
                        round(rect.x),
                        round(rect.y),
                        round(scale),
                        css(*color),
                        css(*color),
                        body
                    );
                }
            }
            Item::Image { shape, .. } => {
                if let Some(d) = shape_d(shape) {
                    let _ = writeln!(s, r##"<path d="{}" fill="#CFD9DE"/>"##, d);
                }
            }
            Item::Placeholder { shape, label } => {
                if let Some(d) = shape_d(shape) {
                    let _ = writeln!(s, r##"<path d="{}" fill="#CFD9DE"/>"##, d);
                    let cx = shape.rect.x + shape.rect.w / 2.0;
                    let cy = shape.rect.y + shape.rect.h / 2.0;
                    let _ = writeln!(
                        s,
                        r##"<text x="{}" y="{}" fill="#536471" font-family="TwitterChirp, sans-serif" font-size="13" text-anchor="middle">{}</text>"##,
                        round(cx),
                        round(cy + 4.5),
                        escape(label)
                    );
                }
            }
            Item::PushClip { shape } => {
                clip_id += 1;
                let d = shape_d(shape).unwrap_or_default();
                let _ = writeln!(
                    s,
                    r#"<clipPath id="c{clip_id}"><path d="{d}"/></clipPath><g clip-path="url(#c{clip_id})">"#
                );
                clips.push(clip_id);
            }
            Item::PopClip => {
                if clips.pop().is_some() {
                    let _ = writeln!(s, "</g>");
                }
            }
        }
    }
    while clips.pop().is_some() {
        let _ = writeln!(s, "</g>");
    }
    let _ = writeln!(s, "</svg>");
    s
}

fn shape_d(shape: &Shape) -> Option<String> {
    let p = crate::paint::shape_path(shape, 1.0)?;
    path_d(&p)
}

fn path_d(p: &tiny_skia::Path) -> Option<String> {
    let mut d = String::new();
    for seg in p.segments() {
        match seg {
            tiny_skia::PathSegment::MoveTo(pt) => {
                let _ = write!(d, "M{} {}", round(pt.x), round(pt.y));
            }
            tiny_skia::PathSegment::LineTo(pt) => {
                let _ = write!(d, "L{} {}", round(pt.x), round(pt.y));
            }
            tiny_skia::PathSegment::QuadTo(c, pt) => {
                let _ = write!(
                    d,
                    "Q{} {} {} {}",
                    round(c.x),
                    round(c.y),
                    round(pt.x),
                    round(pt.y)
                );
            }
            tiny_skia::PathSegment::CubicTo(c0, c1, pt) => {
                let _ = write!(
                    d,
                    "C{} {} {} {} {} {}",
                    round(c0.x),
                    round(c0.y),
                    round(c1.x),
                    round(c1.y),
                    round(pt.x),
                    round(pt.y)
                );
            }
            tiny_skia::PathSegment::Close => d.push('Z'),
        }
    }
    if d.is_empty() {
        None
    } else {
        Some(d)
    }
}

fn css(c: crate::color::Rgba) -> String {
    if c.a == 255 {
        format!("#{:02x}{:02x}{:02x}", c.r, c.g, c.b)
    } else {
        format!(
            "rgba({},{},{},{})",
            c.r,
            c.g,
            c.b,
            (c.a as f32 / 255.0 * 1000.0).round() / 1000.0
        )
    }
}

fn round(v: f32) -> String {
    let r = (v * 100.0).round() / 100.0;
    if r == r.trunc() {
        format!("{}", r as i64)
    } else {
        format!("{r}")
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
