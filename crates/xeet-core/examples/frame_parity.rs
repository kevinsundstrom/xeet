// Frame parity: xeet's layout against Chrome's, box by box.
//
// Development tool (PLAN.md §10): the expected numbers come from
// `tools/oracle/replica.mjs` rendering X's real markup, never from xeet.
//
// ```sh
// export CARGO_TARGET_DIR=$PWD/target/agent-frame
// node tools/oracle/replica-fixtures.mjs > tmp/frame/fixtures.json
// node tools/oracle/replica.mjs --fixtures tmp/frame/fixtures.json --out tmp/frame/geometry
// cargo run -p xeet-core --example frame_parity -- \
//     --fixtures tmp/frame/fixtures.json --geometry tmp/frame/geometry
// ```
//
// Exit code 0 means every box matched within Chrome's 1/64 px layout unit and
// every frame height was identical.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

use serde_json::Value;
use xeet_core::display::{self, Rect};
use xeet_core::frame::{self, time};
use xeet_core::model::{self, Author, Counts, Post, RenderOptions, Surface, Theme, Verified};

const TOLERANCE: f32 = 1.0 / 64.0 + 1e-6;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let mut fixtures: Option<PathBuf> = None;
    let mut geometry: Option<PathBuf> = None;
    let mut verbose = false;
    let mut post_dir: Option<PathBuf> = None;
    let mut dump: Option<String> = None;
    let mut png: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--fixtures" => fixtures = args.next().map(PathBuf::from),
            "--geometry" => geometry = args.next().map(PathBuf::from),
            "--verbose" => verbose = true,
            "--dump" => dump = args.next(),
            "--png" => png = args.next().map(PathBuf::from),
            // Triage mode for tools/ship/e2e.mjs artifacts: each directory is a
            // post (`post.json`), laid out at the width of the page it came from,
            // printing our component boxes so a height delta can be attributed.
            "--post-dirs" => post_dir = args.next().map(PathBuf::from),
            other => {
                eprintln!("unknown argument {other}");
                return ExitCode::from(2);
            }
        }
    }
    if let Some(dir) = post_dir {
        return dump_posts(&dir);
    }
    let (Some(fixtures), Some(geometry)) = (fixtures, geometry) else {
        eprintln!("usage: frame_parity --fixtures <json> --geometry <dir> [--verbose]");
        return ExitCode::from(2);
    };

    let suite: Value = serde_json::from_str(&std::fs::read_to_string(&fixtures).expect("fixtures"))
        .expect("fixtures json");
    let cases = suite.as_array().expect("fixtures is an array");

    let mut failures = 0usize;
    let mut worst: f32 = 0.0;
    let mut worst_where = String::new();
    let mut checked_boxes = 0usize;
    let mut checked_lines = 0usize;
    let mut rows: Vec<String> = Vec::new();

    for case in cases {
        let name = case["name"].as_str().expect("fixture name").to_string();
        let path = geometry.join(format!("{name}.json"));
        let Ok(text) = std::fs::read_to_string(&path) else {
            rows.push(format!("{name}: MISSING replica dump {}", path.display()));
            failures += 1;
            continue;
        };
        let expected: Value = serde_json::from_str(&text).expect("replica json");
        let fx = Fixture::from_json(case);
        let mut decisions = xeet_core::rules::decide(&fx.post, &fx.opts);
        // The fixture's clamp is what Chrome rendered; the rules stage decides
        // clamps from the post's own data, so respect the fixture here.
        if let Some(clamp) = case["post"]["clamp"].as_u64() {
            decisions.clamp = Some(clamp as usize);
        }
        let (list, report, geo) = frame::layout_debug(&fx.post, &fx.opts, &decisions);

        if dump.as_deref() == Some(name.as_str()) {
            for (label, rect) in &geo.boxes {
                println!(
                    "  {label:16} {:>9.4} {:>9.4} {:>9.4} {:>9.4}",
                    rect.x, rect.y, rect.w, rect.h
                );
            }
            for l in &geo.lines {
                println!(
                    "  line {:<6} {:?} x={} y={} w={} h={}",
                    l.block, l.text, l.x, l.y, l.w, l.h
                );
            }
        }
        if let Some(dir) = &png {
            std::fs::create_dir_all(dir).expect("png dir");
            let bytes = xeet_core::paint::rasterize_png(&list, 2.0, &xeet_core::paint::NoImages);
            std::fs::write(dir.join(format!("{name}.png")), bytes).expect("write png");
        }
        let mut problems: Vec<String> = Vec::new();
        let want_w = expected["frame"]["width"].as_f64().unwrap_or(0.0) as f32;
        let want_h = expected["frame"]["height"].as_f64().unwrap_or(0.0) as f32;
        if (list.width - want_w).abs() > TOLERANCE {
            problems.push(format!("frame.width {} vs {want_w}", list.width));
        }
        if (list.height - want_h).abs() > TOLERANCE {
            problems.push(format!("frame.height {} vs {want_h}", list.height));
        }
        if (report.size.height - list.height).abs() > TOLERANCE {
            problems.push("report.size.height disagrees with the list".to_string());
        }

        // Boxes: the intersection of what both sides name.
        let boxes = expected["boxes"].as_object().expect("boxes");
        for (label, want) in boxes {
            let Some(mine) = geo.boxes.get(label) else {
                continue;
            };
            if want.is_null() {
                problems.push(format!("{label}: replica has no box, we do"));
                continue;
            }
            let want = box_of(want);
            checked_boxes += 1;
            for (axis, a, b) in [
                ("x", mine.x, want.x),
                ("y", mine.y, want.y),
                ("w", mine.w, want.w),
                ("h", mine.h, want.h),
            ] {
                let delta = (a - b).abs();
                if delta > TOLERANCE {
                    problems.push(format!("{label}.{axis}: {} vs {b} ({:+.4})", a, a - b));
                    if delta > worst {
                        worst = delta;
                        worst_where = format!("{name} {label}.{axis}");
                    }
                } else if delta > worst {
                    worst = delta;
                    worst_where = format!("{name} {label}.{axis}");
                }
            }
        }
        // Every label we emit must be one the replica also measures, otherwise
        // a rename here could silently stop checking a box.
        for label in geo.boxes.keys() {
            if !boxes.contains_key(label)
                && label != "attachment"
                && !label.ends_with("Pill")
                && label != "headerRow_count"
            {
                problems.push(format!(
                    "{label}: we measure a box the replica does not name"
                ));
            }
        }

        // The avatar's corner radius. Chrome reports `10%` for a business
        // account (`<div class="x-avatar rounded-[10%] size-10">`, 4px on the
        // 40px slot) and a huge px value for `rounded-full` (a circle), so a
        // value at or above half the box is the circle case and is skipped.
        if let (Some(style), Some(box_)) = (
            expected["styles"]["avatarShape"]["borderRadius"].as_str(),
            expected["boxes"]["avatarShape"].as_object(),
        ) {
            let w = box_.get("w").and_then(Value::as_f64).unwrap_or(0.0) as f32;
            let want = if let Some(pct) = style.strip_suffix('%') {
                pct.parse::<f32>().ok().map(|p| p / 100.0 * w)
            } else if let Some(px) = style.strip_suffix("px") {
                px.parse::<f32>().ok()
            } else {
                None
            };
            if let Some(want) = want.filter(|r| *r < w * 0.5) {
                let ours = list.items.iter().find_map(|item| match item {
                    display::Item::Image {
                        shape,
                        image: display::ImageRef::Avatar,
                        ..
                    } if shape.rect.w == w => Some(shape.radii.tl),
                    _ => None,
                });
                match ours {
                    Some(radius) if (radius - want).abs() <= TOLERANCE => {}
                    Some(radius) => problems.push(format!(
                        "avatarShape radius: {radius} vs {want} ({:+.4})",
                        radius - want
                    )),
                    None => problems.push("avatarShape: no avatar image item".to_string()),
                }
            }
        }

        // Text lines, per block.
        let lines = expected["lines"].as_object().expect("lines");
        for (block, want_lines) in lines {
            let Some(want_lines) = want_lines.as_array() else {
                continue;
            };
            let truncated_text =
                geo.lines.iter().any(|l| l.block == "text") && report.text.truncated;
            let mine: Vec<_> = geo.lines.iter().filter(|l| l.block == block).collect();
            // A clamped block reports the hidden lines too; only the first is
            // comparable.
            let clamped_block = block == "name" || block == "handle" || truncated_text;
            if !clamped_block && mine.len() != want_lines.len() {
                problems.push(format!(
                    "lines.{block}: {} lines vs {}",
                    mine.len(),
                    want_lines.len()
                ));
            }
            for (i, want) in want_lines.iter().enumerate() {
                let Some(mine) = mine.get(i) else { break };
                let want_text = want["text"].as_str().unwrap_or("");
                // A clamped block's DOM rects are Chrome's *unclamped* layout,
                // while it paints an ellipsis-truncated line: the two can
                // differ by a grapheme at the cut, so require a prefix rather
                // than equality and skip the width (see the module docs).
                let clamped = block == "name" || block == "handle" || truncated_text;
                // Chrome's rects cover trailing whitespace (a newline or the
                // hanging space at a soft break); our line text is the line's
                // content without it.
                let (mine_t, want_t) = (mine.text.trim_end(), want_text.trim_end());
                let text_ok = if clamped {
                    mine_t.starts_with(want_t) || want_t.starts_with(mine_t)
                } else {
                    mine_t == want_t
                };
                if !text_ok {
                    problems.push(format!(
                        "lines.{block}[{i}].text {:?} vs {want_text:?}",
                        mine.text
                    ));
                }
                checked_lines += 1;
                let want_rect = box_of(want);
                // A clamped line's DOM rect is Chrome's *unclamped* layout: it
                // still reports every line the clamp hides and the line box
                // before the ellipsis truncated it, so `x` and `w` are not the
                // painted box (a right-to-left line shifts by the ellipsis).
                // The painted clamp is verified in pixels instead
                // (`tools/oracle/clamp-ink.mjs`); here only `y`/`h` are exact.
                let rect_axes: &[(&str, f32, f32)] = if clamped {
                    &[("y", mine.y, want_rect.y), ("h", mine.h, want_rect.h)]
                } else {
                    &[
                        ("x", mine.x, want_rect.x),
                        ("y", mine.y, want_rect.y),
                        ("h", mine.h, want_rect.h),
                    ]
                };
                for (axis, a, b) in rect_axes.iter().copied() {
                    if (a - b).abs() > TOLERANCE {
                        problems.push(format!(
                            "lines.{block}[{i}].{axis}: {} vs {b} ({:+.4})",
                            a,
                            a - b
                        ));
                    }
                }
                // Chrome's range rects include a hanging trailing space; our
                // line width deliberately does not.
                if !clamped
                    && !mine.text.ends_with(char::is_whitespace)
                    && (mine.w - want_rect.w).abs() > TOLERANCE
                {
                    problems.push(format!(
                        "lines.{block}[{i}].w: {} vs {} ({:+.4})",
                        mine.w,
                        want_rect.w,
                        mine.w - want_rect.w
                    ));
                }
            }
        }

        // The timestamp label X's own formatter produced for this fixture.
        if let Some(want) = expected["fixture"]["derived"]["stamp"].as_str() {
            let got = time::label(
                fx.post.created_at.as_deref(),
                fx.post.now.as_deref(),
                fx.opts.surface == Surface::WebDetail,
            );
            if got != want {
                problems.push(format!("timestamp {got:?} vs {want:?}"));
            }
        }

        if problems.is_empty() {
            rows.push(format!("{name}: ok ({}x{})", list.width, list.height));
        } else {
            failures += 1;
            rows.push(format!("{name}: {} problem(s)", problems.len()));
            if verbose || problems.len() <= 6 {
                for p in &problems {
                    rows.push(format!("    {p}"));
                }
            }
        }
    }

    for row in &rows {
        println!("{row}");
    }
    println!(
        "\n{} fixtures, {failures} failing; {checked_boxes} boxes and {checked_lines} lines checked; worst delta {:.4}px at {worst_where}",
        cases.len(),
        TOLERANCE
    );
    let _ = BTreeMap::<(), ()>::new();
    if failures == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// Prints our component boxes for every `post.json` under `dir`.
fn dump_posts(dir: &std::path::Path) -> ExitCode {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("post dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect();
    entries.sort();
    for entry in entries {
        let Ok(text) = std::fs::read_to_string(entry.join("post.json")) else {
            continue;
        };
        // `post.json` is exactly `model::Post`, so deserialize it as one.
        let Ok(post) = serde_json::from_str::<Post>(&text) else {
            continue;
        };
        let opts = RenderOptions {
            surface: Surface::WebTimeline,
            width: 600.0,
            theme: Theme::Light,
            dpr: 2.0,
            font_scale: 1.0,
            expanded: false,
        };
        let decisions = xeet_core::rules::decide(&post, &opts);
        let (list, report, geo) = frame::layout_debug(&post, &opts, &decisions);
        let g = |k: &str| geo.boxes.get(k).map(|r| (r.y, r.h));
        let g_box = |k: &str| geo.boxes.get(k).map(|r| (r.x, r.y, r.w, r.h));
        let tail = |s: &str| {
            s.chars()
                .rev()
                .take(26)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        };
        println!(
            "  visible tail={:?} lines={} truncated={}",
            tail(&report.text.visible),
            report.text.lines,
            report.text.truncated
        );
        println!(
            "  showMoreBox={:?} lines={:?}",
            g_box("showMore"),
            geo.lines
                .iter()
                .filter(|l| l.block == "text")
                .map(|l| (
                    l.y,
                    l.w,
                    l.text
                        .chars()
                        .rev()
                        .take(24)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>()
                ))
                .collect::<Vec<_>>()
        );
        println!(
            "{} h={} text={:?} attachment={:?} actions={:?} showMore={:?} attach={:?}",
            entry.file_name().unwrap().to_string_lossy(),
            list.height,
            g("text"),
            g("attachment"),
            g("actionRow"),
            report.text.show_more,
            decisions.attachment,
        );
    }
    ExitCode::SUCCESS
}

fn box_of(value: &Value) -> Rect {
    let f = |k: &str| value[k].as_f64().unwrap_or(0.0) as f32;
    Rect::new(f("x"), f("y"), f("w"), f("h"))
}

/// The fixture JSON, as the replica writes it.
struct Fixture {
    post: Post,
    opts: RenderOptions,
}

impl Fixture {
    fn from_json(case: &Value) -> Fixture {
        let post = &case["post"];
        // Fixtures carry the body as spans; a `post.json` artifact carries it as
        // the plain string the model takes.
        let text: String = match &post["text"] {
            Value::Array(spans) => spans
                .iter()
                .map(|s| {
                    s["display"]
                        .as_str()
                        .or_else(|| s["text"].as_str())
                        .unwrap_or("")
                        .to_string()
                })
                .collect(),
            Value::String(s) => s.clone(),
            _ => String::new(),
        };
        let verified = match post["verified"].as_str().unwrap_or("none") {
            "blue" => Verified::Blue,
            "business" => Verified::Business,
            "government" => Verified::Government,
            _ => Verified::None,
        };
        let counts = post["counts"].as_object().map(|c| Counts {
            replies: c.get("replies").and_then(Value::as_u64).unwrap_or(0),
            reposts: c.get("reposts").and_then(Value::as_u64).unwrap_or(0),
            likes: c.get("likes").and_then(Value::as_u64).unwrap_or(0),
            views: c.get("views").and_then(Value::as_u64).unwrap_or(0),
            bookmarks: c.get("bookmarks").and_then(Value::as_u64).unwrap_or(0),
        });
        let instant = |v: &Value| -> Option<String> {
            let ms = v.as_f64()? as i64;
            Some(
                time::Instant {
                    ms,
                    offset_minutes: 0,
                }
                .to_iso8601(),
            )
        };
        let surface = match case["surface"].as_str().unwrap_or("timeline") {
            "detail" => Surface::WebDetail,
            _ => Surface::WebTimeline,
        };
        let theme = match case["theme"].as_str().unwrap_or("light") {
            "dark" => Theme::Dark,
            _ => Theme::Light,
        };
        let affiliate = post["affiliate"].as_object().map(|a| model::Affiliate {
            name: a
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Affiliate")
                .to_string(),
            badge: None,
        });
        Fixture {
            post: Post {
                text,
                author: Author {
                    name: post["name"].as_str().unwrap_or("").to_string(),
                    handle: post["handle"].as_str().unwrap_or("").to_string(),
                    verified,
                    affiliate,
                    square_avatar: post["squareAvatar"].as_bool().unwrap_or(false),
                    ..Author::default()
                },
                counts,
                social_context: post["pinned"]
                    .as_bool()
                    .unwrap_or(false)
                    .then_some(model::SocialContext::Pinned),
                long_post: post["longPost"].as_bool(),
                long_post_body: post["body"].as_str().map(str::to_string),
                created_at: instant(&post["timestamp"]),
                now: instant(&post["now"]),
                ..Post::default()
            },
            opts: RenderOptions {
                surface,
                width: case["width"].as_f64().unwrap_or(600.0) as f32,
                theme,
                dpr: case["dpr"].as_f64().unwrap_or(2.0) as f32,
                font_scale: case["fontScale"].as_f64().unwrap_or(1.0) as f32,
                expanded: false,
            },
        }
    }
}

#[allow(dead_code)]
fn unused_model() -> model::Theme {
    model::Theme::Light
}
