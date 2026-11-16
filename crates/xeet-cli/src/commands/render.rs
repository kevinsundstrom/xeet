//! `xeet render <post.json> -o post.png` (PLAN.md §6).

use super::*;

pub const KNOWN: &[&str] = &[
    "surface",
    "width",
    "theme",
    "dpr",
    "font-scale",
    "fontScale",
    "expanded",
    "out",
    "o",
    "report",
    "svg",
    "geometry",
    "time",
    "limits",
    "help",
    "h",
];

/// The display list as JSON: every box the painter would draw, in CSS pixels.
///
/// This is the machine-readable seam for the geometry oracle (`tools/ship/e2e.mjs`
/// compares it against Chrome's boxes for the same post) and for anyone
/// debugging a frame: it is `render::display_list`, nothing derived.
pub fn geometry_json(
    post: &xeet_core::model::Post,
    opts: &xeet_core::model::RenderOptions,
) -> Result<String, Error> {
    let (list, report) = xr::display_list(post, opts)?;
    // The frame's own line boxes, so a consumer never has to re-lay the report's
    // text (that would be a different layout: the report's `visible` carries the
    // affordance as text, the frame places it as its own box).
    let lines = xr::frame_lines(post, opts);
    let items: Vec<serde_json::Value> = list
        .items
        .iter()
        .map(|item| {
            let rect = |r: xeet_core::display::Rect| {
                serde_json::json!({ "x": r.x, "y": r.y, "w": r.w, "h": r.h })
            };
            let color = |c: xeet_core::color::Rgba| {
                serde_json::json!([c.r, c.g, c.b, c.a])
            };
            match item {
                xeet_core::display::Item::Fill { shape, color: c } => {
                    serde_json::json!({ "kind": "fill", "rect": rect(shape.rect), "color": color(*c) })
                }
                xeet_core::display::Item::Stroke { shape, color: c, width } => serde_json::json!({
                    "kind": "stroke", "rect": rect(shape.rect), "color": color(*c), "width": width
                }),
                xeet_core::display::Item::Glyphs { x, y, size, color: c, glyphs, face } => serde_json::json!({
                    "kind": "glyphs",
                    // The origin is the baseline of the first run; every glyph
                    // position is relative to it. No text: the list has been
                    // shaped, not kept.
                    "x": x, "y": y, "size": size, "face": face,
                    "color": color(*c),
                    "count": glyphs.len(),
                    "extent": glyphs.last().map(|g| g.x),
                }),
                xeet_core::display::Item::Icon { name, rect: r, color: c } => {
                    serde_json::json!({ "kind": "icon", "name": name, "rect": rect(*r), "color": color(*c) })
                }
                xeet_core::display::Item::Image { shape, image, .. } => {
                    serde_json::json!({ "kind": "image", "rect": rect(shape.rect), "image": format!("{image:?}") })
                }
                xeet_core::display::Item::Placeholder { shape, label } => serde_json::json!({
                    "kind": "placeholder", "rect": rect(shape.rect), "label": label
                }),
                xeet_core::display::Item::PushClip { shape } => {
                    serde_json::json!({ "kind": "clip", "rect": rect(shape.rect) })
                }
                xeet_core::display::Item::PopClip => serde_json::json!({ "kind": "pop-clip" }),
            }
        })
        .collect();
    let doc = serde_json::json!({
        "width": list.width,
        "height": list.height,
        "background": [list.background.r, list.background.g, list.background.b, list.background.a],
        "size": { "width": report.size.width, "height": report.size.height },
        "lines": lines,
        "items": items,
    });
    serde_json::to_string(&doc)
        .map_err(|e| Error::Stage(format!("could not serialize the geometry: {e}")))
}

pub fn run(argv: &[String]) -> u8 {
    if argv.is_empty() || argv.iter().any(|a| a == "--help" || a == "-h") {
        println!("{}", usage_for("xeet"));
        println!("\nlimits: {}", limits_line(&Limits::standard()));
        return EXIT_OK;
    }
    let args = match Args::parse(argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("xeet render: {e}");
            return EXIT_USAGE;
        }
    };
    if let Some(unknown) = args.unknown(KNOWN).first() {
        eprintln!("xeet render: unknown flag `{unknown}`");
        return EXIT_USAGE;
    }
    let opts = match render_options(&args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("xeet render: {e}");
            return EXIT_USAGE;
        }
    };
    let limits = match limits(&args) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("xeet render: {e}");
            return EXIT_USAGE;
        }
    };
    let (json, source) = match read_input(&args) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("xeet render: {e}");
            return EXIT_USAGE;
        }
    };

    let started = std::time::Instant::now();
    let post = match xr::load_post(&json, &opts, &limits) {
        Ok(v) => v,
        Err(e) => return report_error(&source, &e),
    };
    if let Err(e) = ensure_fonts_for_post(&post, &opts) {
        eprintln!("xeet render: {e}");
        return EXIT_IO;
    }
    let (png, report) = match xr::render_with(&post, &opts, &limits) {
        Ok(v) => v,
        Err(e) => return report_error(&source, &e),
    };
    let elapsed = started.elapsed();

    let out = args.value("out").or_else(|| args.value("o"));
    if let Err(e) = write_output(out, &png) {
        eprintln!("xeet render: {e}");
        return EXIT_IO;
    }
    if let Some(path) = args.value("geometry") {
        match geometry_json(&post, &opts) {
            Ok(json) => {
                if let Err(e) = write_output(Some(path), json.as_bytes()) {
                    eprintln!("xeet render: {e}");
                    return EXIT_IO;
                }
            }
            Err(e) => return report_error("--geometry", &e),
        }
    }
    if let Some(path) = args.value("report") {
        match serde_json::to_string_pretty(&report) {
            Ok(text) => {
                if let Err(e) = write_text(path, &text) {
                    eprintln!("xeet render: {e}");
                    return EXIT_IO;
                }
            }
            Err(e) => {
                eprintln!("xeet render: could not serialize the report: {e}");
                return EXIT_RENDER;
            }
        }
    }
    if let Some(path) = args.value("svg") {
        match svg_for(&post, &opts) {
            Ok(svg) => {
                if let Err(e) = write_output(Some(path), svg.as_bytes()) {
                    eprintln!("xeet render: {e}");
                    return EXIT_IO;
                }
            }
            Err(e) => return report_error("--svg", &e),
        }
    }
    warn_report(&report.warnings);
    if args.has("time") {
        eprintln!(
            "xeet render: {}×{} at dpr {} in {:.2} ms, {} bytes",
            report.size.width,
            report.size.height,
            opts.dpr,
            elapsed.as_secs_f64() * 1000.0,
            png.len()
        );
    }
    EXIT_OK
}
