//! Measures every row of PLAN.md §12 and prints JSON.
//!
//! ```sh
//! cargo run --release --example ship_bench            # all rows
//! cargo run --release --example ship_bench -- --rows explain_280,png_text
//! ```
//!
//! `tools/ship/bench.mjs` runs this, compares the numbers against the budgets
//! in `bench-budgets.json`, and measures the two things an example cannot: the
//! cold start of the real binary and the size of the stripped binary.
//!
//! Numbers are machine-specific. The budgets are absolute because §12 gives
//! targets, and the runner also prints a ratio against the last recorded run
//! (`bench-baseline.json`) so a regression is visible even when a slow CI box
//! is still under the absolute budget.

use std::hint::black_box;
use std::time::Instant;

use xeet_core::color::Rgba;
use xeet_core::limits::{self, Limits};
use xeet_core::model::{Author, Media, Post, RenderOptions, Surface, Theme};
use xeet_core::paint::Pixmap;
use xeet_core::render;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let stages = args.iter().any(|a| a == "--stages");
    let only = args
        .iter()
        .position(|a| a == "--rows")
        .and_then(|i| args.get(i + 1).cloned())
        .map(|s| s.split(',').map(str::to_string).collect::<Vec<_>>());

    let mut rows: Vec<(String, Row)> = Vec::new();
    let mut run = |name: &str, f: &mut dyn FnMut() -> usize| {
        if let Some(only) = &only {
            if !only.iter().any(|r| r == name) {
                return;
            }
        }
        let row = measure(name, f);
        println!(
            "# {name}: p50 {:.0} µs  p90 {:.0} µs  min {:.0} µs",
            row.p50_us, row.p90_us, row.min_us
        );
        rows.push((name.to_string(), row));
    };

    // --- PLAN.md §12: explain, 280 characters.
    let short = post(&lorem(280));
    let o390x3 = opts(390.0, 3.0);
    let o390x2 = opts(390.0, 2.0);
    run("explain_280", &mut || {
        let r = render::explain(&short, &o390x3).expect("explain");
        r.size.height as usize
    });

    // --- explain, 25,000 characters (a long post).
    let long = post(&lorem(25_000));
    run("explain_25000", &mut || {
        let r = render::explain(&long, &o390x3).expect("explain long");
        r.size.height as usize
    });

    // --- PNG of a text post, 390 wide at 3×.
    run("png_text_390_3x", &mut || {
        render::render(&short, &o390x3).expect("render").0.len()
    });

    // --- PNG with four placeholder media (dimensions only, no bytes).
    let mut placeholders = post("Four images, no bytes.");
    placeholders.media = vec![
        Media {
            width: 1600,
            height: 900,
            ..Media::default()
        },
        Media {
            width: 900,
            height: 1600,
            ..Media::default()
        },
        Media {
            width: 1200,
            height: 1200,
            ..Media::default()
        },
        Media {
            width: 4000,
            height: 3000,
            ..Media::default()
        },
    ];
    run("png_4_placeholders", &mut || {
        render::render(&placeholders, &o390x2)
            .expect("render")
            .0
            .len()
    });

    // --- PNG with four real photos, decoded and scaled: the decode-dominated
    // case PLAN.md §12 budgets at 10–30 ms. 800×600 is the size that budget
    // assumes (see docs/PERF.md); the images are photo-like (smooth gradients,
    // mild dither), not noise, because PNG decode cost tracks entropy.
    let mut photos = post("Four photos, decoded and cropped.");
    photos.media = (0..4)
        .map(|i| Media {
            width: 800,
            height: 600,
            data: Some(base64(&photo(800, 600, i as u8 + 1))),
            ..Media::default()
        })
        .collect();
    run("png_4_photos_800", &mut || {
        render::render(&photos, &o390x2).expect("render").0.len()
    });

    // --- The same at 1600×900: the stress case, ~4× the pixels of §12's
    // assumption. Budgeted separately, and generously, so a regression still
    // shows up without pretending the §12 number applies at any size.
    let mut large = post("Four large photos.");
    large.media = (0..4)
        .map(|i| Media {
            width: 1600,
            height: 900,
            data: Some(base64(&photo(1600, 900, i as u8 + 1))),
            ..Media::default()
        })
        .collect();
    run("png_4_photos_1600", &mut || {
        render::render(&large, &o390x2).expect("render").0.len()
    });

    // --- explain with four real images: it must not decode anything, so its
    // cost must not depend on the size of the payload at all.
    run("explain_4_real_images", &mut || {
        render::explain(&large, &o390x2)
            .expect("explain")
            .size
            .height as usize
    });

    // --- Cold start, from this process's point of view: parsing the embedded
    // fonts and building the face table is the only global initialization.
    let cold = {
        let t = Instant::now();
        let db = xeet_core::fonts::db();
        let n = db.faces.len();
        println!(
            "# font db first call: {:.0} µs for {n} faces",
            t.elapsed().as_secs_f64() * 1e6
        );
        t.elapsed().as_secs_f64() * 1e6
    };

    // --- Stage breakdown, for finding where a row's time goes.
    if stages {
        let p = post(&lorem(280));
        let l = Limits::standard();
        let mut run_stage = |name: &str, f: &mut dyn FnMut() -> usize| {
            let row = measure(name, f);
            println!("# stage {name}: p50 {:.1} µs", row.p50_us);
            rows.push((format!("stage_{name}"), row));
        };
        run_stage("validate", &mut || {
            limits::validate(&p, &o390x3, &l).map(|_| 1).unwrap_or(0)
        });
        run_stage("rules_decide", &mut || {
            let d = xeet_core::rules::decide(&p, &o390x3);
            d.body.len()
        });
        let decisions = xeet_core::rules::decide(&p, &o390x3);
        run_stage("frame_layout", &mut || {
            let (list, _r) = xeet_core::frame::layout(&p, &o390x3, &decisions);
            list.items.len()
        });
        run_stage("explain", &mut || {
            render::explain(&p, &o390x3).expect("explain").size.height as usize
        });
        run_stage("budget_for", &mut || {
            l.budget_for(&p, &o390x3, 412.0).granted() as usize
        });
        // One level into frame::layout: the body text block on its own, at the
        // 310px text column a 390px viewport gives (390 - 80).
        let body = lorem(280);
        let st = xeet_core::inline::BlockStyle {
            size: 15.0,
            line_height: 20.0,
            weight: 400,
            width: 310.0,
            max_lines: None,
            wrap: xeet_core::inline::Wrap::Anywhere,
            preserve: true,
            dir: xeet_core::inline::Dir::Auto,
            tab_size: 4.0,
        };
        run_stage("inline_body_280", &mut || {
            let block = xeet_core::inline::layout(
                &[xeet_core::inline::Span::new(
                    body.as_str(),
                    Rgba::BLACK,
                    400,
                )],
                &st,
            );
            block.lines.len()
        });
        // The attachment path: four placeholders, layout only and with pixels.
        let mut four = post("Four images, no bytes.");
        four.media = vec![
            Media {
                width: 1600,
                height: 900,
                ..Media::default()
            },
            Media {
                width: 900,
                height: 1600,
                ..Media::default()
            },
            Media {
                width: 1200,
                height: 1200,
                ..Media::default()
            },
            Media {
                width: 4000,
                height: 3000,
                ..Media::default()
            },
        ];
        run_stage("media_four_explain", &mut || {
            render::explain(&four, &o390x2)
                .expect("explain")
                .size
                .height as usize
        });
        run_stage("media_four_render", &mut || {
            render::render(&four, &o390x2).expect("render").0.len()
        });
    }

    let json_rows: Vec<String> = rows
        .iter()
        .map(|(name, r)| {
            format!(
                "    {:?}: {{ \"p50_us\": {:.1}, \"p90_us\": {:.1}, \"min_us\": {:.1}, \"iterations\": {} }}",
                name, r.p50_us, r.p90_us, r.min_us, r.iterations
            )
        })
        .collect();
    println!(
        "{{\n  \"rows\": {{\n{}\n  }},\n  \"cold_start_font_db_us\": {:.1},\n  \"meta\": {{ \"profile\": \"release\", \"target\": {:?}, \"cpus\": {} }}\n}}",
        json_rows.join(",\n"),
        cold,
        format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        std::thread::available_parallelism().map_or(0, |n| n.get()),
    );
}

struct Row {
    p50_us: f64,
    p90_us: f64,
    min_us: f64,
    iterations: usize,
}

/// Warms up, then times `f` until it has used at least ~200 ms of wall time,
/// bounded to 5..2000 iterations. The result is a percentile, not a mean,
/// because one unlucky scheduler slice should not fail a budget.
fn measure(_name: &str, f: &mut dyn FnMut() -> usize) -> Row {
    for _ in 0..3 {
        black_box(f());
    }
    let mut samples: Vec<f64> = Vec::new();
    let budget = std::time::Duration::from_millis(200);
    let started = Instant::now();
    while samples.len() < 2000 && (started.elapsed() < budget || samples.len() < 5) {
        let t = Instant::now();
        black_box(f());
        samples.push(t.elapsed().as_secs_f64() * 1e6);
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let at = |q: f64| samples[((samples.len() - 1) as f64 * q).round() as usize];
    Row {
        p50_us: at(0.5),
        p90_us: at(0.9),
        min_us: samples[0],
        iterations: samples.len(),
    }
}

fn opts(width: f32, dpr: f32) -> RenderOptions {
    RenderOptions {
        surface: Surface::WebTimeline,
        width,
        theme: Theme::Light,
        dpr,
        font_scale: 1.0,
        expanded: false,
    }
}

fn post(text: &str) -> Post {
    Post {
        text: text.to_string(),
        author: Author {
            name: "Vercel".into(),
            handle: "vercel".into(),
            ..Author::default()
        },
        ..Post::default()
    }
}

/// Deterministic filler text of about `n` characters, in the shape of real
/// marketing copy: words, punctuation, an occasional URL.
fn lorem(n: usize) -> String {
    const WORDS: &[&str] = &[
        "we",
        "shipped",
        "the",
        "thing",
        "today,",
        "and",
        "it",
        "is",
        "fast.",
        "Previews",
        "render",
        "in",
        "milliseconds",
        "so",
        "agents",
        "can",
        "draft",
        "against",
        "them.",
        "Read",
        "more:",
        "https://vercel.com/blog/the-thing",
        "or",
        "ask",
        "us",
        "anything",
        "about",
        "the",
        "layout",
        "engine.",
        "\n\n",
    ];
    let mut out = String::with_capacity(n + 16);
    let mut i = 0;
    while out.chars().count() < n {
        out.push_str(WORDS[i % WORDS.len()]);
        if i % 11 == 10 {
            out.push('\n');
        } else {
            out.push(' ');
        }
        i += 1;
    }
    out.truncate(out.char_indices().nth(n).map_or(out.len(), |(i, _)| i));
    out
}

/// A deterministic, photo-like PNG of the given size: smooth gradients with a
/// little dither, which is roughly the entropy of a photograph and nothing like
/// random noise (noise makes inflate, and therefore decode, several times more
/// expensive than any real photo). No fixture binary needed.
fn photo(width: u32, height: u32, seed: u8) -> Vec<u8> {
    let mut pm = Pixmap::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let i = ((y * width + x) * 4) as usize;
            // A gradient plus a hash: a real decoder pays for the filtering and
            // the inflate, which is what this benchmark is about.
            let n = ((x.wrapping_mul(2654435761) ^ y.wrapping_mul(40503) ^ (u32::from(seed) * 97))
                >> 8) as u8;
            pm.rgba[i] = (x * 255 / width.max(1)) as u8;
            pm.rgba[i + 1] = (y * 255 / height.max(1)) as u8;
            pm.rgba[i + 2] = n;
            pm.rgba[i + 3] = 255;
        }
    }
    let _ = Rgba::BLACK;
    xeet_core::paint::encode_png(&pm)
}

fn base64(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
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
