use serde::Deserialize;
use std::io::{BufRead, Read, Write};
use std::time::Instant;
use xeet_core::color::Rgba;
use xeet_core::inline::{self, BlockStyle, Dir, Run, Span, TextBlock, Wrap};

// The user-facing commands (render, explain, sheet, resolve), shared with the
// `xeet-render` binary so there is one implementation of each.
mod commands;

const DEBUG_USAGE: &str = "\
Debugging:
  xeet debug-text --width W [--size 15 --lh 20 --weight 400] < text
  xeet serve --stdio      # one JSON layout request per line
  xeet info               # embedded upstream snapshot and faces";

fn main() -> std::process::ExitCode {
    use std::process::ExitCode;
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("debug-text") => debug_text(&args[1..]),
        // `xeet serve` stays the layout server the parity tools drive;
        // `xeet-render serve` is the render server.
        Some("serve") => serve(&args[1..]),
        Some("info") => info(),
        Some("--version" | "-V" | "version") => println!("xeet {}", env!("CARGO_PKG_VERSION")),
        Some(name) if commands::is_command(name) => return commands::main_for(name, &args[1..]),
        Some("--help" | "-h" | "help") => {
            println!("{}\n{DEBUG_USAGE}", commands::usage_for("xeet"))
        }
        _ => {
            eprintln!("{}\n{DEBUG_USAGE}", commands::usage_for("xeet"));
            return ExitCode::from(commands::EXIT_USAGE);
        }
    }
    ExitCode::SUCCESS
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn num(args: &[String], name: &str, d: f32) -> f32 {
    flag(args, name).and_then(|v| v.parse().ok()).unwrap_or(d)
}

/// Lays out stdin as one pre-wrap block and prints line fragments as JSON.
/// Input is a JSON array of strings (one block each) or raw text.
fn debug_text(args: &[String]) {
    let st = BlockStyle {
        size: num(args, "--size", 15.0),
        line_height: num(args, "--lh", 20.0),
        weight: num(args, "--weight", 400.0) as u16,
        width: num(args, "--width", 420.0),
        max_lines: flag(args, "--clamp").and_then(|v| v.parse().ok()),
        wrap: match flag(args, "--wrap") {
            Some("normal") => Wrap::Normal,
            Some("break-all") => Wrap::BreakAll,
            _ => Wrap::Anywhere,
        },
        preserve: flag(args, "--ws") != Some("normal"),
        dir: match flag(args, "--dir") {
            Some("ltr") => Dir::Ltr,
            Some("rtl") => Dir::Rtl,
            _ => Dir::Auto,
        },
        tab_size: num(args, "--tab-size", 4.0),
    };
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let blocks: Vec<String> = serde_json::from_str(&input).unwrap_or_else(|_| vec![input.clone()]);
    // Shape with the same faces the post will use; a missing pack is a warning
    // here because this is a debugging command, not a render.
    let all = blocks.join("\n");
    if let Err(e) = commands::ensure_fonts_for_json(&serde_json::json!({ "text": all })) {
        eprintln!("xeet debug-text: {e}");
    }
    let mut out = Vec::new();
    for text in &blocks {
        let block = inline::layout(&[Span::new(text.as_str(), Rgba::BLACK, st.weight)], &st);
        let lines: Vec<serde_json::Value> = block
            .fragments()
            .iter()
            .map(|f| serde_json::json!({ "text": f.text, "line": f.line, "x": f.x, "y": f.y, "w": f.w, "h": f.h }))
            .collect();
        let mut entry = serde_json::json!({ "height": block.height, "width": block.width, "truncated": block.truncated, "lines": lines });
        if args.iter().any(|a| a == "--runs") {
            entry["runs"] = serde_json::Value::Array(
                block
                    .lines
                    .iter()
                    .flat_map(|l| line_runs(&block, l, true))
                    .collect(),
            );
        }
        out.push(entry);
    }
    println!("{}", serde_json::to_string(&out).unwrap());
}

// ---------------------------------------------------------------------------
// serve: a long-lived layout process for the playground and other tools.
//
// One JSON request per line on stdin, one JSON response per line on stdout.
// The font set is loaded once and every request reuses it, so a keystroke
// costs a layout rather than a process spawn.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LayoutRequest {
    id: serde_json::Value,
    text: String,
    widths: Vec<f32>,
    width: Option<f32>,
    size: f32,
    lh: f32,
    weight: u16,
    clamp: Option<usize>,
    wrap: String,
    dir: String,
    preserve: bool,
    tab_size: f32,
    runs: bool,
}

impl Default for LayoutRequest {
    fn default() -> Self {
        LayoutRequest {
            id: serde_json::Value::Null,
            text: String::new(),
            widths: Vec::new(),
            width: None,
            size: 15.0,
            lh: 20.0,
            weight: 400,
            clamp: None,
            wrap: "anywhere".to_string(),
            dir: "auto".to_string(),
            preserve: true,
            tab_size: 4.0,
            runs: true,
        }
    }
}

fn serve(args: &[String]) {
    if args.iter().any(|a| a != "--stdio") {
        eprintln!("xeet serve: unknown argument; only --stdio is supported");
        std::process::exit(2);
    }
    // Parse the font set before acknowledging any request.
    let _ = xeet_core::fonts::db();
    let stdin = std::io::stdin();
    let mut stdout = std::io::BufWriter::new(std::io::stdout());
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<LayoutRequest>(&line) {
            Ok(req) => layout_response(req),
            Err(e) => serde_json::json!({ "error": format!("bad request: {e}") }),
        };
        if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}

fn layout_response(req: LayoutRequest) -> serde_json::Value {
    if let Err(e) = commands::ensure_fonts_for_json(&serde_json::json!({ "text": &req.text })) {
        return serde_json::json!({ "error": e });
    }
    let mut widths = req.widths.clone();
    if let Some(w) = req.width {
        widths.push(w);
    }
    if widths.is_empty() {
        widths.push(420.0);
    }
    let st = BlockStyle {
        size: req.size,
        line_height: req.lh,
        weight: req.weight,
        width: 0.0,
        max_lines: req.clamp,
        wrap: match req.wrap.as_str() {
            "normal" => Wrap::Normal,
            "break-all" => Wrap::BreakAll,
            _ => Wrap::Anywhere,
        },
        preserve: req.preserve,
        dir: match req.dir.as_str() {
            "ltr" => Dir::Ltr,
            "rtl" => Dir::Rtl,
            _ => Dir::Auto,
        },
        tab_size: req.tab_size,
    };
    let mut results = Vec::with_capacity(widths.len());
    for width in widths {
        if !(width.is_finite() && width > 0.0) {
            results.push(serde_json::json!({ "error": "width must be a positive number" }));
            continue;
        }
        let style = BlockStyle { width, ..st };
        let started = Instant::now();
        let block = inline::layout(
            &[Span::new(req.text.as_str(), Rgba::BLACK, req.weight)],
            &style,
        );
        let us = started.elapsed().as_micros() as u64;
        results.push(block_json(&block, req.runs, us));
    }
    serde_json::json!({
        "id": req.id,
        "upstream": { "appVersion": xeet_core::fonts::UPSTREAM_APP_VERSION, "fetchedAt": xeet_core::fonts::UPSTREAM_FETCHED_AT },
        "results": results,
    })
}

fn block_json(block: &TextBlock, with_runs: bool, us: u64) -> serde_json::Value {
    let lines: Vec<serde_json::Value> = block
        .lines
        .iter()
        .map(|line| {
            let text = &block.text[line.start..line.end];
            let ellipsis = line
                .runs
                .iter()
                .any(|r| r.start == r.end && !r.glyphs.is_empty());
            let mut entry = serde_json::json!({
                "text": text,
                "bare": text.trim_end_matches(' '),
                "top": line.top,
                "baseline": line.top + line.baseline,
                "height": line.height,
                "width": line.width,
                "ellipsis": ellipsis,
            });
            if with_runs {
                entry["runs"] = serde_json::Value::Array(line_runs(block, line, true));
            }
            entry
        })
        .collect();
    serde_json::json!({
        "width": block.width,
        "height": block.height,
        "lines": lines,
        "truncated": block.truncated,
        "naturalLines": block.natural_lines,
        "rtl": block.rtl,
        "us": us,
    })
}

fn line_runs(block: &TextBlock, line: &inline::Line, _with_meta: bool) -> Vec<serde_json::Value> {
    let db = xeet_core::fonts::db();
    line.runs
        .iter()
        .map(|run: &Run| {
            let face = db.face(run.face);
            let text = if run.start == run.end && !run.glyphs.is_empty() {
                "…"
            } else {
                &block.text[run.start..run.end]
            };
            let (ascent, descent) = face.rounded_metrics(block.size);
            serde_json::json!({
                "text": text,
                "x": run.x,
                "w": run.width,
                "rtl": run.rtl,
                "level": run.level,
                "script": run.script,
                "ellipsis": run.start == run.end && !run.glyphs.is_empty(),
                "ascent": ascent,
                "descent": descent,
                "face": {
                    "file": face.file,
                    "family": face.family,
                    "weight": face.weight,
                    "subset": face.subset,
                    "kind": match face.kind {
                        xeet_core::fonts::FaceKind::Chirp => "chirp",
                        xeet_core::fonts::FaceKind::Fallback => "fallback",
                        xeet_core::fonts::FaceKind::Emoji => "emoji",
                    },
                },
            })
        })
        .collect()
}

fn info() {
    let _ = commands::load_all_fonts();
    let db = xeet_core::fonts::db();
    let faces: Vec<serde_json::Value> = db
        .faces
        .iter()
        .map(|f| {
            serde_json::json!({
                "file": f.file,
                "family": f.family,
                "weight": f.weight,
                "subset": f.subset,
                "kind": match f.kind {
                    xeet_core::fonts::FaceKind::Chirp => "chirp",
                    xeet_core::fonts::FaceKind::Fallback => "fallback",
                    xeet_core::fonts::FaceKind::Emoji => "emoji",
                },
            })
        })
        .collect();
    println!(
        "{}",
        serde_json::json!({
            "upstream": { "appVersion": xeet_core::fonts::UPSTREAM_APP_VERSION, "fetchedAt": xeet_core::fonts::UPSTREAM_FETCHED_AT },
            "faces": faces,
        })
    );
}
