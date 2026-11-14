//! Compares two PNGs and reports the difference, optionally ignoring regions.
//!
//! ```sh
//! cargo run --release --example ship_pixel_diff -- --actual ours.png --expect chrome.png \
//!     --dpr 2 --mask masks.json --max-diff 0.001
//! ```
//!
//! Used by `tools/ship/e2e.mjs` to compare a xeet render against Chrome's
//! screenshot of the same post. It prints JSON:
//!
//! ```json
//! {"sameSize":true,"width":1200,"height":668,"total":801600,"counted":640000,
//!  "differing":211,"ratio":0.00033,"maxDelta":9,"bbox":{"x":..,"y":..,"w":..,"h":..}}
//! ```
//!
//! Two knobs borrow paint's e2e oracle (`docs/e2e-raster.md`):
//!
//! - `--slack N` counts a pixel as matching when any pixel within N pixels of it
//!   matches within tolerance. A half-pixel baseline difference turns into a
//!   whole pixel of ink difference, and two rasterizers cannot agree to ±2/255
//!   on every glyph edge; slack absorbs that without letting a missing or
//!   misplaced component through (those are far wider than a pixel).
//! - `--shift-actual-y K` moves the actual image by K device pixels, so a caller
//!   can ask "does a one-pixel vertical shift explain this difference?".
//!
//! `--ink-box x,y,w,h` (CSS pixels) reports each image's ink: the number of
//! pixels that differ from that image's most common colour, and the first row
//! that has any. It is how a blank or clipped Chrome capture is caught (less
//! than half our ink) and how a text offset is measured directly.
//!
//! `--mask` takes JSON rects in **CSS pixels** (`[{"x":16,"y":12,"w":40,"h":40}]`,
//! or `{"dpr":2,"rects":[...]}`); pixels inside them are not counted. That is
//! how an image region is excluded: the two sides fill images differently on
//! purpose (Chrome gets a 1×1 transparent stub from the oracle, xeet draws its
//! labelled placeholder), and comparing them would measure the stub, not the
//! layout.
//!
//! Exit status: 0 when the difference is within `--max-diff`, 1 otherwise, 2 on
//! a usage or decode problem.

use std::fs;

use serde::Deserialize;

#[derive(Deserialize, Default)]
struct MaskFile {
    #[serde(default)]
    dpr: f32,
    #[serde(default)]
    rects: Vec<Rect>,
}

#[derive(Deserialize, Clone, Copy)]
struct Rect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| -> Option<String> {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1).cloned())
    };
    let tolerance: u8 = flag("--tolerance")
        .and_then(|v| v.parse().ok())
        .unwrap_or(2);
    let max_diff: f64 = flag("--max-diff")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.001);
    let slack: i32 = flag("--slack").and_then(|v| v.parse().ok()).unwrap_or(0);
    let shift_y: i32 = flag("--shift-actual-y")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let ink_box: Option<(f32, f32, f32, f32)> = flag("--ink-box").and_then(|v| {
        let p: Vec<f32> = v.split(',').filter_map(|x| x.trim().parse().ok()).collect();
        (p.len() == 4).then(|| (p[0], p[1], p[2], p[3]))
    });
    let verbose = args.iter().any(|a| a == "--verbose");

    // `--crop-actual x,y,w,h` in CSS pixels: the render is the whole cell
    // (including X's 16/12 padding) while a Chrome element screenshot is the
    // content box, so one side has to be cropped before they can be compared.
    let crop: Option<(f32, f32, f32, f32)> = flag("--crop-actual").and_then(|v| {
        let parts: Vec<f32> = v.split(',').filter_map(|p| p.trim().parse().ok()).collect();
        (parts.len() == 4).then(|| (parts[0], parts[1], parts[2], parts[3]))
    });

    let (Some(actual_path), Some(expect_path)) = (flag("--actual"), flag("--expect")) else {
        eprintln!("usage: ship_pixel_diff --actual a.png --expect e.png [--mask masks.json] [--dpr 2] [--max-diff 0.001] [--tolerance 2]");
        std::process::exit(2);
    };
    let (mut aw, mut ah, mut a) = match decode(&actual_path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("pixel-diff: {actual_path}: {e}");
            std::process::exit(2);
        }
    };
    let (ew, eh, e) = match decode(&expect_path) {
        Ok(v) => v,
        Err(err) => {
            eprintln!("pixel-diff: {expect_path}: {err}");
            std::process::exit(2);
        }
    };
    let dpr_early = flag("--dpr")
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(1.0);
    if let Some((cx, cy, cw, ch)) = crop {
        let (x0, y0) = (
            (cx * dpr_early).round() as u32,
            (cy * dpr_early).round() as u32,
        );
        let (w, h) = (
            (cw * dpr_early).round() as u32,
            (ch * dpr_early).round() as u32,
        );
        if x0 + w > aw || y0 + h > ah {
            eprintln!("pixel-diff: the crop {cx},{cy},{cw},{ch} at dpr {dpr_early} does not fit {aw}×{ah}");
            std::process::exit(2);
        }
        let mut cropped = Vec::with_capacity((w * h * 4) as usize);
        for y in y0..y0 + h {
            let start = ((y * aw + x0) * 4) as usize;
            cropped.extend_from_slice(&a[start..start + (w * 4) as usize]);
        }
        a = cropped;
        aw = w;
        ah = h;
    }

    if shift_y != 0 {
        // Move the actual image vertically, filling with transparency.
        let row = (aw * 4) as usize;
        let mut moved = vec![0u8; a.len()];
        for y in 0..ah {
            let sy = y as i32 + shift_y;
            if sy < 0 || sy as u32 >= ah {
                continue;
            }
            let src = (sy as u32 * aw * 4) as usize;
            let dst = (y * aw * 4) as usize;
            moved[dst..dst + row].copy_from_slice(&a[src..src + row]);
        }
        a = moved;
    }

    let same_size = (aw, ah) == (ew, eh);
    let (w, h) = (aw.min(ew), ah.min(eh));

    let mask = match flag("--mask") {
        Some(path) => match fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str::<MaskFile>(&t).map_err(|e| e.to_string()))
        {
            Ok(mut m) => {
                if m.dpr <= 0.0 {
                    m.dpr = flag("--dpr").and_then(|v| v.parse().ok()).unwrap_or(1.0);
                }
                m.rects
            }
            Err(err) => {
                eprintln!("pixel-diff: {path}: {err}");
                std::process::exit(2);
            }
        },
        None => Vec::new(),
    };
    // Masks are CSS pixels; the images are device pixels.
    let dpr = flag("--dpr")
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(1.0);
    let device: Vec<(f32, f32, f32, f32)> = mask
        .iter()
        .map(|r| (r.x * dpr, r.y * dpr, (r.x + r.w) * dpr, (r.y + r.h) * dpr))
        .collect();
    let masked = |x: u32, y: u32| -> bool {
        let (xf, yf) = (x as f32, y as f32);
        device
            .iter()
            .any(|&(x0, y0, x1, y1)| xf >= x0 && xf < x1 && yf >= y0 && yf < y1)
    };

    let mut total = 0u64;
    let mut counted = 0u64;
    let mut differing = 0u64;
    let mut max_delta = 0u8;
    let (mut bx0, mut by0, mut bx1, mut by1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for y in 0..h {
        for x in 0..w {
            total += 1;
            if masked(x, y) {
                continue;
            }
            counted += 1;
            let i = ((y * w + x) * 4) as usize;
            let mut worst = 0u8;
            for k in 0..4 {
                worst = worst.max(a[i + k].abs_diff(e[i + k]));
            }
            // One-pixel neighbourhood: the pixel matches if any neighbour in
            // the expected image is within tolerance of it.
            let mut inside = if slack > 0 { false } else { worst <= tolerance };
            if slack > 0 && !inside {
                'search: for dy in -slack..=slack {
                    for dx in -slack..=slack {
                        let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                        if nx < 0 || ny < 0 || nx as u32 >= w || ny as u32 >= h {
                            continue;
                        }
                        let j = ((ny as u32 * w + nx as u32) * 4) as usize;
                        if (0..4).all(|k| a[i + k].abs_diff(e[j + k]) <= tolerance) {
                            inside = true;
                            break 'search;
                        }
                    }
                }
            }
            if !inside {
                differing += 1;
                max_delta = max_delta.max(worst);
                bx0 = bx0.min(x);
                by0 = by0.min(y);
                bx1 = bx1.max(x);
                by1 = by1.max(y);
            }
        }
    }
    let ratio = if counted == 0 {
        1.0
    } else {
        differing as f64 / counted as f64
    };
    let bbox = if differing == 0 {
        serde_json::Value::Null
    } else {
        serde_json::json!({ "x": bx0, "y": by0, "w": bx1 - bx0 + 1, "h": by1 - by0 + 1 })
    };
    let ink = ink_box.map(|(bx, by, bw, bh)| {
        let box_of = |img: &[u8]| {
            // Masked pixels are excluded: a media stub is transparent on
            // Chrome's side and a labelled placeholder on ours, so counting
            // them would make every media-heavy post look blank.
            let (x0, y0) = (
                (bx * dpr).round().max(0.0) as u32,
                (by * dpr).round().max(0.0) as u32,
            );
            let (bw_, bh_) = (
                (bw * dpr).round().max(1.0) as u32,
                (bh * dpr).round().max(1.0) as u32,
            );
            // The background is the box's most common colour, which is what the
            // post sits on; ink is everything else.
            let mut counts: std::collections::HashMap<[u8; 4], u32> =
                std::collections::HashMap::new();
            for y in y0..(y0 + bh_).min(h) {
                for x in x0..(x0 + bw_).min(w) {
                    if masked(x, y) {
                        continue;
                    }
                    let i = ((y * w + x) * 4) as usize;
                    let key = [img[i], img[i + 1], img[i + 2], img[i + 3]];
                    *counts.entry(key).or_insert(0) += 1;
                }
            }
            let bg = counts
                .iter()
                .max_by_key(|(_, n)| **n)
                .map(|(c, _)| *c)
                .unwrap_or([255, 255, 255, 255]);
            let mut ink = 0u64;
            let mut first_row: Option<u32> = None;
            for y in y0..(y0 + bh_).min(h) {
                let mut row_ink = false;
                for x in x0..(x0 + bw_).min(w) {
                    if masked(x, y) {
                        continue;
                    }
                    let i = ((y * w + x) * 4) as usize;
                    if (0..4).any(|k| img[i + k].abs_diff(bg[k]) > tolerance) {
                        ink += 1;
                        row_ink = true;
                    }
                }
                if row_ink && first_row.is_none() {
                    first_row = Some(y.saturating_sub(y0));
                }
            }
            serde_json::json!({ "ink": ink, "firstRow": first_row, "background": bg })
        };
        serde_json::json!({ "ours": box_of(&a), "chrome": box_of(&e) })
    });

    println!(
        "{}",
        serde_json::json!({
            "sameSize": same_size,
            "actual": { "width": aw, "height": ah },
            "expect": { "width": ew, "height": eh },
            "width": w,
            "height": h,
            "total": total,
            "counted": counted,
            "masked": total.saturating_sub(counted),
            "differing": differing,
            "ratio": ratio,
            "maxDelta": max_delta,
            "bbox": bbox,
            "tolerance": tolerance,
            "slack": slack,
            "shiftY": shift_y,
            "ink": ink,
        })
    );
    if verbose && differing > 0 {
        eprintln!(
            "pixel-diff: {:.4}% of counted pixels differ by more than ±{tolerance}",
            ratio * 100.0
        );
    }
    if !same_size || ratio > max_diff {
        std::process::exit(1);
    }
}

/// Decodes a PNG into `(width, height, RGBA)`.
fn decode(path: &str) -> Result<(u32, u32, Vec<u8>), String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| "no decodable image".to_string())?;
    let mut buf = vec![0; size];
    let info = reader.next_frame(&mut buf[..]).map_err(|e| e.to_string())?;
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
        other => return Err(format!("unsupported color type {other:?}")),
    };
    Ok((info.width, info.height, rgba))
}
