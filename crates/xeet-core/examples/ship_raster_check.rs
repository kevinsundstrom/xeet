//! Checks rendered PNGs against the raster goldens, with the perceptual
//! threshold from PLAN.md §4 ("at least 99.9% of pixels within a small color
//! tolerance, the rest confined to glyph edges").
//!
//! ```sh
//! cargo run --release --example ship_raster_check -- [--golden tests/golden/raster] [--max-diff 0.001]
//! ```
//!
//! A raster golden is a pair:
//!
//! - `tests/golden/raster/<case>.json`: `{ "post": {...} | "postFile": "...",
//!   "options": { width, theme, dpr, surface }, "oracle": { ... } }`
//! - `tests/golden/raster/<case>.png`: the oracle image (Chrome rendering X's
//!   real stylesheet and markup), never xeet's own output.
//!
//! Each case is rendered through the same path a caller uses
//! (`render::render`), decoded, and compared pixel by pixel. A pixel is "within
//! tolerance" when every channel is within `TOLERANCE` of the golden. The case
//! fails when more than `--max-diff` of pixels are outside it, and the report
//! names the bounding box of the differences so the fault can be located.
//!
//! When no goldens exist yet, the check passes with a notice: the raster gate
//! arrives with the first oracle capture, and pretending to check before that
//! would be worse than saying so.

use std::fs;
use std::path::{Path, PathBuf};

use xeet_core::limits;
use xeet_core::model::{Post, RenderOptions};
use xeet_core::render;

/// Per-channel tolerance in 8-bit sRGB counts.
const TOLERANCE: u8 = 2;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str, default: &str| -> String {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1).cloned())
            .unwrap_or_else(|| default.to_string())
    };
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = PathBuf::from(flag(
        "--golden",
        &root.join("tests/golden/raster").display().to_string(),
    ));
    let max_diff: f64 = flag("--max-diff", "0.001").parse().unwrap_or(0.001);
    let verbose = args.iter().any(|a| a == "--verbose");

    let cases = match collect(&dir) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("raster: {e}");
            std::process::exit(1);
        }
    };
    if cases.is_empty() {
        println!("raster: no goldens in {} yet; nothing to compare (the gate arrives with the first oracle capture)", dir.display());
        return;
    }

    let mut failures = 0;
    let mut worst: f64 = 0.0;
    for case_path in &cases {
        match check_case(case_path, max_diff, verbose) {
            Ok(diff) => {
                worst = worst.max(diff);
                println!(
                    "raster: ok   {} ({:.4}% of pixels differ)",
                    case_path.display(),
                    diff * 100.0
                );
            }
            Err(e) => {
                failures += 1;
                eprintln!("raster: FAIL {}\n  {e}", case_path.display());
            }
        }
    }
    if failures > 0 {
        eprintln!(
            "raster: {failures} of {} cases failed (worst {:.4}% of pixels)",
            cases.len(),
            worst * 100.0
        );
        std::process::exit(1);
    }
    println!(
        "raster: {} cases within {:.1}% at ±{TOLERANCE} per channel",
        cases.len(),
        max_diff * 100.0
    );
}

fn collect(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    out.sort();
    Ok(out)
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Case {
    post: Option<Post>,
    post_file: Option<String>,
    options: Options,
    oracle: Oracle,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Options {
    width: f32,
    theme: xeet_core::model::Theme,
    dpr: f32,
    surface: xeet_core::model::Surface,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            width: 600.0,
            theme: xeet_core::model::Theme::Light,
            dpr: 2.0,
            surface: xeet_core::model::Surface::WebTimeline,
        }
    }
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Oracle {
    png: Option<String>,
    chrome: Option<String>,
}

fn check_case(path: &Path, max_diff: f64, verbose: bool) -> Result<f64, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("could not read the case: {e}"))?;
    let case: Case =
        serde_json::from_str(&text).map_err(|e| format!("the case is not valid JSON: {e}"))?;
    let dir = path.parent().unwrap_or(Path::new("."));

    let post = match (&case.post, &case.post_file) {
        (Some(p), _) => p.clone(),
        (None, Some(rel)) => {
            let p = dir.join(rel);
            let json = fs::read_to_string(&p)
                .map_err(|e| format!("could not read {}: {e}", p.display()))?;
            limits::parse_post(&json).map_err(|e| e.to_string())?
        }
        (None, None) => return Err("the case has neither `post` nor `postFile`".to_string()),
    };
    let oracle_png = case
        .oracle
        .png
        .clone()
        .map(|p| dir.join(p))
        .unwrap_or_else(|| path.with_extension("png"));
    if !oracle_png.exists() {
        return Err(format!(
            "the oracle image {} does not exist",
            oracle_png.display()
        ));
    }
    let oracle_note = case.oracle.chrome.as_deref().unwrap_or("unknown Chrome");

    let opts = RenderOptions {
        surface: case.options.surface,
        width: case.options.width,
        theme: case.options.theme,
        dpr: case.options.dpr,
        font_scale: 1.0,
        expanded: false,
    };
    let (png, _report) = render::render(&post, &opts).map_err(|e| e.to_string())?;
    let ours = decode(&png)?;
    let golden = decode(
        &fs::read(&oracle_png).map_err(|e| format!("could not read the oracle image: {e}"))?,
    )?;

    if ours.0 != golden.0 || ours.1 != golden.1 {
        return Err(format!(
            "size differs: xeet {}×{}, oracle {}×{} (captured with {oracle_note})",
            ours.0, ours.1, golden.0, golden.1
        ));
    }

    let (w, h) = (ours.0, ours.1);
    let mut bad = 0u64;
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            let d = (0..4).any(|k| ours.2[i + k].abs_diff(golden.2[i + k]) > TOLERANCE);
            if d {
                bad += 1;
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    let ratio = bad as f64 / f64::from(w) / f64::from(h);
    if ratio > max_diff {
        let mut msg = format!(
            "{:.4}% of pixels differ by more than ±{TOLERANCE} (allowed {:.4}%); the differences span x {}..{}, y {}..{} (oracle: {oracle_note})",
            ratio * 100.0,
            max_diff * 100.0,
            x0,
            x1,
            y0,
            y1
        );
        if verbose {
            // A crop of the first differences makes the failure reviewable.
            for (name, img) in [("xeet", &ours), ("oracle", &golden)] {
                let mut crop = String::new();
                for y in y0..=y1.min(y0 + 8) {
                    for x in x0..=x1.min(x0 + 32) {
                        let i = ((y * w + x) * 4) as usize;
                        crop.push_str(&format!(
                            "{:02x}{:02x}{:02x} ",
                            img.2[i],
                            img.2[i + 1],
                            img.2[i + 2]
                        ));
                    }
                    crop.push('\n');
                }
                msg.push_str(&format!("\n  {name}:\n{crop}"));
            }
        }
        return Err(msg);
    }
    Ok(ratio)
}

/// Decodes a PNG into `(width, height, RGBA)`.
fn decode(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("the image is not a readable PNG: {e}"))?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| "the PNG header does not describe a decodable image".to_string())?;
    let mut buf = vec![0; size];
    let info = reader
        .next_frame(&mut buf[..])
        .map_err(|e| format!("could not decode the PNG: {e}"))?;
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => {
            let src = &buf[..info.buffer_size()];
            let mut out = Vec::with_capacity(src.len() / 3 * 4);
            for i in (0..src.len()).step_by(3) {
                out.extend_from_slice(&[src[i], src[i + 1], src[i + 2], 255]);
            }
            out
        }
        other => return Err(format!("unsupported oracle color type {other:?}")),
    };
    Ok((info.width, info.height, rgba))
}
