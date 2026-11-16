//! X's icon sprite: the SVG symbols in `assets/vendor/icons.json`, filled
//! into a rectangle.
//!
//! The sprite is X's own, extracted from the page (`tools/sync-upstream.mjs`).
//! Each entry is a `viewBox` plus the inner SVG of a `<symbol>`: paths, and for
//! the color badges a `linearGradient`. We parse just that subset — path data
//! (including arcs), `fill`, `fill-rule`, `circle`, `rect`, `linearGradient`
//! with `stop`s — because that is all the sprite contains. Anything else is
//! ignored rather than guessed at, so a new icon type shows up as "missing
//! icon" instead of a wrong one.
//!
//! Fill rules:
//! - no `fill` attribute, or `fill="currentColor"`: the item's color.
//! - `fill="#rrggbb"` / `url(#id)`: the sprite's own color, as X draws it
//!   (the verified badges are blue or gold regardless of theme).

use crate::color::Rgba;
use crate::display::Rect;
use crate::paint::Renderer;
use std::collections::HashMap;
use std::sync::OnceLock;
use tiny_skia::{GradientStop, LinearGradient, Path, PathBuilder, Shader, SpreadMode, Transform};

pub(crate) fn draw(r: &mut Renderer, name: &str, rect: &Rect, color: Rgba) {
    let Some(icon) = icons().get(name) else {
        return;
    };
    if !rect.w.is_finite() || !rect.h.is_finite() || !rect.x.is_finite() || !rect.y.is_finite() {
        return;
    }
    if rect.w <= 0.0 || rect.h <= 0.0 {
        return;
    }
    let dpr = r.dpr;
    // `preserveAspectRatio` defaults to xMidYMid meet: uniform scale, centered.
    let sx = rect.w * dpr / icon.vb_w;
    let sy = rect.h * dpr / icon.vb_h;
    let s = sx.min(sy);
    let ox = rect.x * dpr + (rect.w * dpr - icon.vb_w * s) / 2.0 - icon.vb_x * s;
    let oy = rect.y * dpr + (rect.h * dpr - icon.vb_h * s) / 2.0 - icon.vb_y * s;
    let ts = Transform::from_row(s, 0.0, 0.0, s, ox, oy);
    for el in &icon.els {
        let Some(path) = el.path.clone().transform(ts) else {
            continue;
        };
        let rule = if el.even_odd {
            tiny_skia::FillRule::EvenOdd
        } else {
            tiny_skia::FillRule::Winding
        };
        match &el.fill {
            Fill::Item => r.fill(&path, color, rule),
            Fill::Solid(c) => r.fill(&path, *c, rule),
            Fill::Gradient(g) => {
                if let Some(shader) = g.shader(ts, icon.vb_w, icon.vb_h) {
                    r.fill_shader(&path, shader, rule);
                }
            }
        }
    }
}

/// The icon's raw SVG body, for the SVG writer.
pub(crate) fn body(name: &str) -> Option<&'static str> {
    icons().get(name).map(|i| i.body.as_str())
}

#[derive(Clone)]
enum Fill {
    /// `currentColor`: whatever the item asked for.
    Item,
    Solid(Rgba),
    Gradient(Gradient),
}

#[derive(Clone)]
struct Gradient {
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    /// `userSpaceOnUse` when true, `objectBoundingBox` (the default) otherwise.
    user_space: bool,
    stops: Vec<(f32, Rgba)>,
}

impl Gradient {
    fn shader(&self, ts: Transform, vb_w: f32, vb_h: f32) -> Option<Shader<'_>> {
        let (x1, y1, x2, y2) = if self.user_space {
            let mut pts = [
                tiny_skia::Point::from_xy(self.x1, self.y1),
                tiny_skia::Point::from_xy(self.x2, self.y2),
            ];
            ts.map_points(&mut pts);
            (pts[0].x, pts[0].y, pts[1].x, pts[1].y)
        } else {
            // Fractions of the shape's box, in the icon's coordinate space.
            let mut pts = [
                tiny_skia::Point::from_xy(self.x1 * vb_w, self.y1 * vb_h),
                tiny_skia::Point::from_xy(self.x2 * vb_w, self.y2 * vb_h),
            ];
            ts.map_points(&mut pts);
            (pts[0].x, pts[0].y, pts[1].x, pts[1].y)
        };
        let mut stops = Vec::with_capacity(self.stops.len());
        for (offset, c) in &self.stops {
            stops.push(GradientStop::new(
                *offset,
                tiny_skia::Color::from_rgba8(c.r, c.g, c.b, c.a),
            ));
        }
        if stops.len() < 2 {
            return None;
        }
        LinearGradient::new(
            tiny_skia::Point::from_xy(x1, y1),
            tiny_skia::Point::from_xy(x2, y2),
            stops,
            SpreadMode::Pad,
            Transform::identity(),
        )
    }
}

struct Element {
    path: Path,
    fill: Fill,
    even_odd: bool,
}

struct Icon {
    body: String,
    vb_x: f32,
    vb_y: f32,
    vb_w: f32,
    vb_h: f32,
    els: Vec<Element>,
}

fn icons() -> &'static HashMap<String, Icon> {
    static ICONS: OnceLock<HashMap<String, Icon>> = OnceLock::new();
    ICONS.get_or_init(|| {
        let mut out = HashMap::new();
        let Ok(json) = serde_json::from_str::<serde_json::Value>(crate::fonts::ICONS_JSON) else {
            return out;
        };
        let Some(map) = json.as_object() else {
            return out;
        };
        for (name, v) in map {
            let Some(body) = v.get("body").and_then(|b| b.as_str()) else {
                continue;
            };
            let vb = parse_view_box(
                v.get("viewBox")
                    .and_then(|b| b.as_str())
                    .unwrap_or("0 0 24 24"),
            );
            let els = parse_body(body, vb);
            out.insert(
                name.clone(),
                Icon {
                    body: body.to_string(),
                    vb_x: vb.0,
                    vb_y: vb.1,
                    vb_w: vb.2,
                    vb_h: vb.3,
                    els,
                },
            );
        }
        out
    })
}

fn parse_view_box(s: &str) -> (f32, f32, f32, f32) {
    let mut l = Lexer::new(s);
    let x = l.number().unwrap_or(0.0);
    let y = l.number().unwrap_or(0.0);
    let w = l.number().unwrap_or(24.0);
    let h = l.number().unwrap_or(24.0);
    if w > 0.0 && h > 0.0 {
        (x, y, w, h)
    } else {
        (0.0, 0.0, 24.0, 24.0)
    }
}

/// Parses the inner SVG into a flat list of filled paths.
///
/// Two passes: gradients first (they may be defined after the paths that use
/// them), then the shapes.
fn parse_body(body: &str, _vb: (f32, f32, f32, f32)) -> Vec<Element> {
    let tags = tags(body);
    let mut gradients: HashMap<String, Gradient> = HashMap::new();
    let mut current: Option<String> = None;
    for (name, attrs) in &tags {
        match *name {
            "linearGradient" => {
                let id = attr(attrs, "id").unwrap_or_default().to_string();
                gradients.insert(id.clone(), parse_gradient(attrs));
                current = Some(id);
            }
            "stop" => {
                if let Some(g) = current.as_ref().and_then(|id| gradients.get_mut(id)) {
                    let offset = attr(attrs, "offset")
                        .and_then(|v| v.parse::<f32>().ok())
                        .unwrap_or(0.0);
                    let c = attr(attrs, "stop-color")
                        .and_then(Rgba::parse_hex)
                        .unwrap_or(Rgba::BLACK);
                    g.stops.push((offset.clamp(0.0, 1.0), c));
                }
            }
            _ => {}
        }
    }

    let mut els = Vec::new();
    let mut depth = 0usize;
    for (name, attrs) in &tags {
        match *name {
            "defs" => {
                depth += 1;
                continue;
            }
            "/defs" => {
                depth = depth.saturating_sub(1);
                continue;
            }
            _ => {}
        }
        if depth > 0 {
            continue;
        }
        let fill = parse_fill(attrs, &gradients);
        let even_odd = attr(attrs, "fill-rule") == Some("evenodd");
        let path = match *name {
            "path" => attr(attrs, "d").and_then(parse_path),
            "circle" => {
                let f = |k: &str| {
                    attr(attrs, k)
                        .and_then(|v| v.parse::<f32>().ok())
                        .unwrap_or(0.0)
                };
                let (cx, cy, rr) = (f("cx"), f("cy"), f("r"));
                if rr > 0.0 {
                    let mut pb = PathBuilder::new();
                    pb.push_circle(cx, cy, rr);
                    pb.finish()
                } else {
                    None
                }
            }
            "rect" => {
                let f = |k: &str| {
                    attr(attrs, k)
                        .and_then(|v| v.parse::<f32>().ok())
                        .unwrap_or(0.0)
                };
                let (x, y, w, h, rr) = (f("x"), f("y"), f("width"), f("height"), f("rx"));
                let mut pb = PathBuilder::new();
                if w > 0.0 && h > 0.0 {
                    if rr > 0.0 {
                        let r = rr.min(w / 2.0).min(h / 2.0);
                        let k = r * 0.552_284_8;
                        pb.move_to(x + r, y);
                        pb.line_to(x + w - r, y);
                        pb.cubic_to(x + w - r + k, y, x + w, y + r - k, x + w, y + r);
                        pb.line_to(x + w, y + h - r);
                        pb.cubic_to(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h);
                        pb.line_to(x + r, y + h);
                        pb.cubic_to(x + r - k, y + h, x, y + h - r + k, x, y + h - r);
                        pb.line_to(x, y + r);
                        pb.cubic_to(x, y + r - k, x + r - k, y, x + r, y);
                        pb.close();
                        pb.finish()
                    } else {
                        tiny_skia::Rect::from_xywh(x, y, w, h).map(PathBuilder::from_rect)
                    }
                } else {
                    None
                }
            }
            _ => None,
        };
        if let Some(path) = path {
            els.push(Element {
                path,
                fill,
                even_odd,
            });
        }
    }
    els
}

/// Every tag in the document with its raw attribute text, self-closing and
/// closing tags included (`/defs` for a close tag).
fn tags(body: &str) -> Vec<(&str, &str)> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(open) = rest.find('<') {
        rest = &rest[open + 1..];
        let Some(end) = rest.find('>') else { break };
        let tag = &rest[..end];
        rest = &rest[end + 1..];
        let tag = tag.trim();
        if tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        let inner = tag.trim_end_matches('/').trim();
        let (name, attrs) = split_tag(inner);
        out.push((name, attrs));
    }
    out
}

fn parse_gradient(attrs: &str) -> Gradient {
    let f = |k: &str, d: f32| {
        attr(attrs, k)
            .and_then(|v| v.parse::<f32>().ok())
            .unwrap_or(d)
    };
    Gradient {
        x1: f("x1", 0.0),
        y1: f("y1", 0.0),
        x2: f("x2", 1.0),
        y2: f("y2", 0.0),
        user_space: attr(attrs, "gradientUnits") == Some("userSpaceOnUse"),
        stops: Vec::new(),
    }
}

fn parse_fill(attrs: &str, gradients: &HashMap<String, Gradient>) -> Fill {
    match attr(attrs, "fill") {
        None | Some("currentColor") | Some("inherit") => Fill::Item,
        Some(v) => {
            if let Some(id) = v.strip_prefix("url(#").and_then(|s| s.strip_suffix(')')) {
                match gradients.get(id) {
                    Some(g) => Fill::Gradient(g.clone()),
                    None => Fill::Item,
                }
            } else if let Some(c) = Rgba::parse_hex(v) {
                Fill::Solid(c)
            } else {
                Fill::Item
            }
        }
    }
}

/// Splits `<tag attr="v" …>` into the tag name and the raw attribute text.
fn split_tag(s: &str) -> (&str, &str) {
    match s.find(char::is_whitespace) {
        Some(i) => (&s[..i], &s[i..]),
        None => (s, ""),
    }
}

fn attr<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    let mut hay = attrs;
    loop {
        let i = hay.find(name)?;
        // Must start an attribute: preceded by whitespace, followed by `=`.
        let before_ok = i == 0 || hay.as_bytes()[i - 1].is_ascii_whitespace();
        let after = &hay[i + name.len()..];
        if before_ok {
            if let Some(rest) = after.strip_prefix('=') {
                let rest = rest.trim_start();
                let quote = rest.chars().next()?;
                if quote == '"' || quote == '\'' {
                    let val = &rest[1..];
                    let end = val.find(quote)?;
                    return Some(&val[..end]);
                }
                let end = rest
                    .find(|c: char| c.is_whitespace() || c == '/')
                    .unwrap_or(rest.len());
                return Some(&rest[..end]);
            }
        }
        hay = &hay[i + name.len()..];
    }
}

// ---------------------------------------------------------------- path data

struct Lexer<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Lexer<'a> {
    fn new(s: &'a str) -> Lexer<'a> {
        Lexer {
            s: s.as_bytes(),
            i: 0,
        }
    }

    fn skip_sep(&mut self) {
        while self.i < self.s.len() {
            let c = self.s[self.i];
            if c == b',' || c.is_ascii_whitespace() {
                self.i += 1;
            } else {
                break;
            }
        }
    }

    fn peek_cmd(&mut self) -> Option<u8> {
        self.skip_sep();
        let c = *self.s.get(self.i)?;
        if c.is_ascii_alphabetic() {
            Some(c)
        } else {
            None
        }
    }

    fn number(&mut self) -> Option<f32> {
        self.skip_sep();
        let start = self.i;
        if self.i < self.s.len() && (self.s[self.i] == b'-' || self.s[self.i] == b'+') {
            self.i += 1;
        }
        let mut digits = false;
        while self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
            self.i += 1;
            digits = true;
        }
        if self.i < self.s.len() && self.s[self.i] == b'.' {
            self.i += 1;
            while self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
                self.i += 1;
                digits = true;
            }
        }
        if !digits {
            self.i = start;
            return None;
        }
        if self.i < self.s.len() && (self.s[self.i] == b'e' || self.s[self.i] == b'E') {
            let save = self.i;
            self.i += 1;
            if self.i < self.s.len() && (self.s[self.i] == b'-' || self.s[self.i] == b'+') {
                self.i += 1;
            }
            let mut exp_digits = false;
            while self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
                self.i += 1;
                exp_digits = true;
            }
            if !exp_digits {
                self.i = save;
            }
        }
        std::str::from_utf8(&self.s[start..self.i])
            .ok()?
            .parse()
            .ok()
    }

    fn flag(&mut self) -> Option<bool> {
        self.skip_sep();
        match self.s.get(self.i) {
            Some(b'0') => {
                self.i += 1;
                Some(false)
            }
            Some(b'1') => {
                self.i += 1;
                Some(true)
            }
            _ => None,
        }
    }
}

/// Parses SVG path data into a path. Unknown commands stop parsing; the rest
/// of the icon still draws.
pub(crate) fn parse_path(d: &str) -> Option<Path> {
    let mut l = Lexer::new(d);
    let mut pb = PathBuilder::new();
    let (mut cx, mut cy) = (0.0f32, 0.0f32);
    let (mut sx, mut sy) = (0.0f32, 0.0f32);
    let mut last_cmd = 0u8;
    let mut last_ctrl: Option<(f32, f32)> = None;
    let mut cmd: u8;
    loop {
        l.skip_sep();
        if l.i >= l.s.len() {
            break;
        }
        if let Some(c) = l.peek_cmd() {
            l.i += 1;
            cmd = c;
        } else if last_cmd != 0 {
            // Implicit repetition: M→L, m→l, others repeat.
            cmd = match last_cmd {
                b'M' => b'L',
                b'm' => b'l',
                other => other,
            };
        } else {
            return None;
        }
        let rel = cmd.is_ascii_lowercase();
        let upper = cmd.to_ascii_uppercase();
        let (ox, oy) = if rel { (cx, cy) } else { (0.0, 0.0) };
        match upper {
            b'M' => {
                let (x, y) = (l.number()?, l.number()?);
                cx = ox + x;
                cy = oy + y;
                sx = cx;
                sy = cy;
                pb.move_to(cx, cy);
                last_ctrl = None;
            }
            b'L' => {
                let (x, y) = (l.number()?, l.number()?);
                cx = ox + x;
                cy = oy + y;
                pb.line_to(cx, cy);
                last_ctrl = None;
            }
            b'H' => {
                let x = l.number()?;
                cx = ox + x;
                pb.line_to(cx, cy);
                last_ctrl = None;
            }
            b'V' => {
                let y = l.number()?;
                cy = oy + y;
                pb.line_to(cx, cy);
                last_ctrl = None;
            }
            b'C' => {
                let (x1, y1) = (ox + l.number()?, oy + l.number()?);
                let (x2, y2) = (ox + l.number()?, oy + l.number()?);
                let (x, y) = (ox + l.number()?, oy + l.number()?);
                pb.cubic_to(x1, y1, x2, y2, x, y);
                cx = x;
                cy = y;
                last_ctrl = Some((x2, y2));
            }
            b'S' => {
                let (x2, y2) = (ox + l.number()?, oy + l.number()?);
                let (x, y) = (ox + l.number()?, oy + l.number()?);
                let (x1, y1) = match last_ctrl {
                    Some((px, py)) if matches!(last_cmd.to_ascii_uppercase(), b'C' | b'S') => {
                        (2.0 * cx - px, 2.0 * cy - py)
                    }
                    _ => (cx, cy),
                };
                pb.cubic_to(x1, y1, x2, y2, x, y);
                cx = x;
                cy = y;
                last_ctrl = Some((x2, y2));
            }
            b'Q' => {
                let (x1, y1) = (ox + l.number()?, oy + l.number()?);
                let (x, y) = (ox + l.number()?, oy + l.number()?);
                pb.quad_to(x1, y1, x, y);
                cx = x;
                cy = y;
                last_ctrl = Some((x1, y1));
            }
            b'T' => {
                let (x, y) = (ox + l.number()?, oy + l.number()?);
                let (x1, y1) = match last_ctrl {
                    Some((px, py)) if matches!(last_cmd.to_ascii_uppercase(), b'Q' | b'T') => {
                        (2.0 * cx - px, 2.0 * cy - py)
                    }
                    _ => (cx, cy),
                };
                pb.quad_to(x1, y1, x, y);
                cx = x;
                cy = y;
                last_ctrl = Some((x1, y1));
            }
            b'A' => {
                let rx = l.number()?;
                let ry = l.number()?;
                let rot = l.number()?;
                let large = l.flag()?;
                let sweep = l.flag()?;
                let (x, y) = (ox + l.number()?, oy + l.number()?);
                arc_to(&mut pb, cx, cy, rx, ry, rot, large, sweep, x, y);
                cx = x;
                cy = y;
                last_ctrl = None;
            }
            b'Z' => {
                pb.close();
                cx = sx;
                cy = sy;
                last_ctrl = None;
            }
            _ => break,
        }
        last_cmd = cmd;
    }
    pb.finish()
}

/// Endpoint → center arc conversion (SVG 1.1 F.6.5), emitted as cubics.
#[allow(clippy::too_many_arguments)]
fn arc_to(
    pb: &mut PathBuilder,
    x0: f32,
    y0: f32,
    rx: f32,
    ry: f32,
    rot: f32,
    large: bool,
    sweep: bool,
    x: f32,
    y: f32,
) {
    let (mut rx, mut ry) = (rx.abs(), ry.abs());
    if rx == 0.0 || ry == 0.0 || (x0 == x && y0 == y) {
        pb.line_to(x, y);
        return;
    }
    let phi = rot.to_radians();
    let (sin_p, cos_p) = phi.sin_cos();
    let dx2 = (x0 - x) / 2.0;
    let dy2 = (y0 - y) / 2.0;
    let x1p = cos_p * dx2 + sin_p * dy2;
    let y1p = -sin_p * dx2 + cos_p * dy2;
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if lambda > 1.0 {
        let s = lambda.sqrt();
        rx *= s;
        ry *= s;
    }
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let mut coef = if den > 0.0 {
        (num / den).max(0.0).sqrt()
    } else {
        0.0
    };
    if large == sweep {
        coef = -coef;
    }
    let cxp = coef * rx * y1p / ry;
    let cyp = -coef * ry * x1p / rx;
    let cx = cos_p * cxp - sin_p * cyp + (x0 + x) / 2.0;
    let cy = sin_p * cxp + cos_p * cyp + (y0 + y) / 2.0;
    let ang = |ux: f32, uy: f32, vx: f32, vy: f32| -> f32 {
        let dot = ux * vx + uy * vy;
        let len = ((ux * ux + uy * uy) * (vx * vx + vy * vy)).sqrt();
        let mut a = if len > 0.0 {
            (dot / len).clamp(-1.0, 1.0).acos()
        } else {
            0.0
        };
        if ux * vy - uy * vx < 0.0 {
            a = -a;
        }
        a
    };
    let theta1 = ang(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let mut dtheta = ang(
        (x1p - cxp) / rx,
        (y1p - cyp) / ry,
        (-x1p - cxp) / rx,
        (-y1p - cyp) / ry,
    );
    if !sweep && dtheta > 0.0 {
        dtheta -= std::f32::consts::TAU;
    } else if sweep && dtheta < 0.0 {
        dtheta += std::f32::consts::TAU;
    }
    let segments = (dtheta.abs() / std::f32::consts::FRAC_PI_2).ceil().max(1.0) as usize;
    let delta = dtheta / segments as f32;
    let mut t = theta1;
    for _ in 0..segments {
        let (sin1, cos1) = t.sin_cos();
        let t2 = t + delta;
        let (sin2, cos2) = t2.sin_cos();
        let alpha = 4.0 / 3.0 * (delta / 4.0).tan();
        let p = |c: f32, s: f32| {
            (
                cx + rx * c * cos_p - ry * s * sin_p,
                cy + rx * c * sin_p + ry * s * cos_p,
            )
        };
        let (ax, ay) = p(cos1, sin1);
        let (bx, by) = p(cos2, sin2);
        let (dax, day) = (
            -rx * sin1 * cos_p - ry * cos1 * sin_p,
            -rx * sin1 * sin_p + ry * cos1 * cos_p,
        );
        let (dbx, dby) = (
            -rx * sin2 * cos_p - ry * cos2 * sin_p,
            -rx * sin2 * sin_p + ry * cos2 * cos_p,
        );
        pb.cubic_to(
            ax + alpha * dax,
            ay + alpha * day,
            bx - alpha * dbx,
            by - alpha * dby,
            bx,
            by,
        );
        t = t2;
    }
}
