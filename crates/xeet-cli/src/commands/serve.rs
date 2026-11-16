//! `xeet-render serve --stdio`: the render server the playground keeps warm.
//!
//! One JSON object per line on stdin, one JSON object per line on stdout, for
//! the life of the process. The font set, the ruleset and every lazily built
//! table are paid once at startup, which is what makes a keystroke cost a
//! layout rather than a process spawn.
//!
//! Request:
//!
//! ```json
//! {"id": 7, "op": "render", "post": {"text": "…"}, "options": {"width": 390}}
//! ```
//!
//! `op` is `render`, `explain` or `info`; `options` is `RenderOptions`
//! (camelCase, strict, as on the wire everywhere else) and may be absent.
//! `geometry: false` skips the display list, which is the only expensive part a
//! caller paying per keystroke can drop.
//!
//! Response, always one line, always with the request's `id` (so a client with
//! several requests in flight can match them):
//!
//! ```json
//! {"id": 7, "png": "iVBOR…", "width": 390, "height": 412, "dpr": 2,
//!  "report": {…}, "geometry": {"lines": [...], "boxes": [...]},
//!  "ms": {"total": 6.1, "parse": 0.2, "render": 4.8, "geometry": 0.9}}
//! ```
//!
//! Failures are `{"id": 7, "error": {"code", "message", "fields"?}}` and never
//! end the process: a bad request is one bad line, not a dead server. (The
//! process can still die on a panic — release builds use `panic = "abort"` — so
//! the playground restarts it and says so; that is the one failure this loop
//! cannot absorb itself.)
//!
//! `info` is also the handshake: a client sends `{"id": 0, "op": "info"}` after
//! spawning and reads the version back, so "ready" needs no extra protocol.
//!
//! ## Version
//!
//! `version.rev`/`dirty`/`builtAt` come from a sidecar meta file next to the
//! binary (`xeet-render.meta.json`), which the playground writes right after a
//! build: the binary cannot know the git state it was compiled from, and
//! `crates/xeet-core` is forbidden from reading the clock or the filesystem.
//! A meta file older than the binary is ignored (a rebuild with a stale meta
//! must not claim the old revision). Falling back: `XEET_BUILD_REV` /
//! `XEET_BUILD_DIRTY` at compile time, then the binary's own mtime for
//! `builtAt` and `null` for the revision.

use super::*;

use std::io::BufRead;

use xeet_core::model::Post;

pub const KNOWN: &[&str] = &["stdio", "limits", "help", "h"];

pub fn run(argv: &[String]) -> u8 {
    if argv.iter().any(|a| a == "--help" || a == "-h") {
        println!("{}", usage_for("xeet-render"));
        return EXIT_OK;
    }
    let args = match Args::parse(argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("xeet-render serve: {e}");
            return EXIT_USAGE;
        }
    };
    if let Some(unknown) = args.unknown(KNOWN).first() {
        eprintln!("xeet-render serve: unknown flag `{unknown}`; only --stdio is supported");
        return EXIT_USAGE;
    }
    if !args.positional.is_empty() {
        eprintln!(
            "xeet-render serve: unexpected argument `{}`; only --stdio is supported",
            args.positional[0]
        );
        return EXIT_USAGE;
    }
    let limits = match limits(&args) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("xeet-render serve: {e}");
            return EXIT_USAGE;
        }
    };

    // Pay every one-time cost before acknowledging a request: the font set,
    // the ruleset, and a tiny render (which initializes the shaper's caches).
    // A caller's first request should be as fast as its second.
    let _ = xeet_core::fonts::db();
    let warm: Post = serde_json::from_str(r#"{"text":"warm"}"#).expect("the warm-up post parses");
    let _ = xr::render_with(&warm, &RenderOptions::default(), &Limits::unlimited());

    let stdin = std::io::stdin();
    let mut stdin = stdin.lock();
    let stdout = std::io::stdout();
    let mut stdout = std::io::BufWriter::new(stdout.lock());
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            // A read error is the pipe going away; there is nobody to tell.
            Err(_) => break,
        }
        if line.trim().is_empty() {
            continue;
        }
        let reply = handle_line(line.trim_end(), &limits);
        if writeln!(stdout, "{reply}").is_err() || stdout.flush().is_err() {
            break;
        }
    }
    EXIT_OK
}

/// One request line in, one response line out. Never panics on input and never
/// reports failure by exiting.
pub fn handle_line(line: &str, limits: &Limits) -> serde_json::Value {
    let started = std::time::Instant::now();
    // Parse to a `Value` first so the reply can carry the id even when the rest
    // of the line is unusable.
    let request: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            return serde_json::json!({
                "id": serde_json::Value::Null,
                "error": {
                    "code": "invalid_json",
                    "status": 400,
                    "message": format!("the request line is not JSON: {e}"),
                }
            })
        }
    };
    if !request.is_object() {
        return serde_json::json!({
            "id": serde_json::Value::Null,
            "error": {
                "code": "invalid_json",
                "status": 400,
                "message": "the request must be a JSON object",
            }
        });
    }
    let id = request
        .get("id")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let op = request
        .get("op")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("render");

    if let Err(error) = super::ensure_fonts_for_json(&request) {
        return serde_json::json!({
            "id": id,
            "error": {
                "code": "fonts_failed",
                "status": 500,
                "message": error,
            }
        });
    }

    let body = match op {
        "render" => render(&request, limits, started),
        "explain" => explain(&request, limits, started),
        "info" => Ok(info()),
        other => Err(ReplyError::new(
            "unknown_op",
            400,
            format!("unknown op `{other}`; expected render, explain or info"),
        )),
    };

    match body {
        Ok(mut value) => {
            // `id` wins over whatever the payload says: it is the correlation
            // field, not part of the result.
            if let Some(obj) = value.as_object_mut() {
                obj.insert("id".to_string(), id);
            }
            value
        }
        Err(e) => serde_json::json!({ "id": id, "error": e.to_json() }),
    }
}

fn render(
    request: &serde_json::Value,
    limits: &Limits,
    started: std::time::Instant,
) -> Result<serde_json::Value, ReplyError> {
    let parse_started = std::time::Instant::now();
    let opts = options_of(request)?;
    let post = post_of(request, &opts, limits)?;
    let parse = parse_started.elapsed().as_secs_f64() * 1000.0;

    let render_started = std::time::Instant::now();
    let (png, report) = xr::render_with(&post, &opts, limits).map_err(ReplyError::from)?;
    let render_ms = render_started.elapsed().as_secs_f64() * 1000.0;

    let wants_geometry = request
        .get("geometry")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let geometry_started = std::time::Instant::now();
    let geometry = if wants_geometry {
        serde_json::Value::Object(geometry_of(&post, &opts, limits)?)
    } else {
        serde_json::Value::Null
    };
    let geometry_ms = geometry_started.elapsed().as_secs_f64() * 1000.0;

    let encode_started = std::time::Instant::now();
    let png64 = base64_encode(&png);
    let encode_ms = encode_started.elapsed().as_secs_f64() * 1000.0;

    let report_json = serde_json::to_value(&report).map_err(|e| {
        ReplyError::new(
            "render_failed",
            500,
            format!("could not serialize the report: {e}"),
        )
    })?;

    let mut out = serde_json::Map::new();
    out.insert("png".into(), serde_json::Value::String(png64));
    // CSS pixels, like every other size on the wire; `dpr` says how many device
    // pixels each one is worth.
    out.insert("width".into(), json_f32(report.size.width));
    out.insert("height".into(), json_f32(report.size.height));
    out.insert("dpr".into(), json_f32(opts.dpr));
    out.insert("report".into(), report_json);
    out.insert("geometry".into(), geometry);
    out.insert(
        "ms".into(),
        serde_json::json!({
            "total": round3(started.elapsed().as_secs_f64() * 1000.0),
            "parse": round3(parse),
            "render": round3(render_ms),
            "geometry": round3(geometry_ms),
            "encode": round3(encode_ms),
            "pngBytes": png.len(),
        }),
    );
    Ok(serde_json::Value::Object(out))
}

fn explain(
    request: &serde_json::Value,
    limits: &Limits,
    started: std::time::Instant,
) -> Result<serde_json::Value, ReplyError> {
    let parse_started = std::time::Instant::now();
    let opts = options_of(request)?;
    let post = post_of(request, &opts, limits)?;
    let parse = parse_started.elapsed().as_secs_f64() * 1000.0;
    let render_started = std::time::Instant::now();
    let report = xr::explain_with(&post, &opts, limits).map_err(ReplyError::from)?;
    let render_ms = render_started.elapsed().as_secs_f64() * 1000.0;
    Ok(serde_json::json!({
        "report": serde_json::to_value(&report).map_err(|e| ReplyError::new(
            "render_failed", 500, format!("could not serialize the report: {e}")))?,
        "width": json_f32(report.size.width),
        "height": json_f32(report.size.height),
        "ms": {
            "total": round3(started.elapsed().as_secs_f64() * 1000.0),
            "parse": round3(parse),
            "render": round3(render_ms),
        },
    }))
}

/// What this binary knows about itself. `ruleset` and `upstream` are compiled
/// in; the git facts come from the sidecar meta the playground writes.
pub fn info() -> serde_json::Value {
    // `info` reports the whole font set, so pull in the lazy packs when this
    // build ships them beside the binary.
    let _ = super::load_all_fonts();
    let stamp = BuildStamp::load();
    serde_json::json!({
        "version": {
            "rev": stamp.rev,
            "dirty": stamp.dirty,
            "builtAt": stamp.built_at,
            "ruleset": xr::ruleset_id(),
            "upstream": xeet_core::fonts::UPSTREAM_APP_VERSION,
            "upstreamFetchedAt": xeet_core::fonts::UPSTREAM_FETCHED_AT,
            "crate": env!("CARGO_PKG_VERSION"),
            "exe": std::env::current_exe().ok().map(|p| p.display().to_string()),
            "pid": std::process::id(),
        },
        "limits": limits_line(&Limits::standard()),
        "ops": ["render", "explain", "info"],
    })
}

// ---------------------------------------------------------------------------
// Request pieces
// ---------------------------------------------------------------------------

fn options_of(request: &serde_json::Value) -> Result<RenderOptions, ReplyError> {
    match request.get("options") {
        None | Some(serde_json::Value::Null) => Ok(RenderOptions::default()),
        Some(value) => xeet_core::limits::options_from_value(value.clone()).map_err(|e| {
            ReplyError::new("invalid_options", 400, e.to_string()).with_fields(vec![Field::new(
                "options",
                "the options object is not valid",
            )])
        }),
    }
}

fn post_of(
    request: &serde_json::Value,
    opts: &RenderOptions,
    limits: &Limits,
) -> Result<Post, ReplyError> {
    let value = request
        .get("post")
        .ok_or_else(|| ReplyError::new("invalid_post", 400, "the request has no `post`"))?;
    let post = xeet_core::limits::post_from_value(value.clone()).map_err(ReplyError::from)?;
    xeet_core::limits::validate(&post, opts, limits).map_err(ReplyError::from)?;
    Ok(post)
}

/// The frame's line boxes and every box the painter would draw, in CSS pixels.
///
/// `lines` is `render::frame_lines`, the frame's own decision, and `boxes` is
/// the display list's rectangles — the same seam `xeet-render render
/// --geometry` writes, and what the oracle compares against Chrome.
fn geometry_of(
    post: &Post,
    opts: &RenderOptions,
    limits: &Limits,
) -> Result<serde_json::Map<String, serde_json::Value>, ReplyError> {
    let (list, _report) = xr::display_list_with(post, opts, limits).map_err(ReplyError::from)?;
    let lines = xr::frame_lines(post, opts);
    let mut boxes = Vec::new();
    for item in &list.items {
        use xeet_core::display::Item;
        let entry = match item {
            Item::Fill { shape, color } => {
                let mut e = box_json("fill", shape.rect);
                e.insert("color".into(), color_json(*color));
                e
            }
            Item::Stroke {
                shape,
                color,
                width,
            } => {
                let mut e = box_json("stroke", shape.rect);
                e.insert("color".into(), color_json(*color));
                e.insert("width".into(), json_f32(*width));
                e
            }
            Item::Icon { name, rect, color } => {
                let mut e = box_json("icon", *rect);
                e.insert("name".into(), serde_json::Value::String(name.clone()));
                e.insert("color".into(), color_json(*color));
                e
            }
            Item::Image { shape, image, .. } => {
                let mut e = box_json("image", shape.rect);
                e.insert(
                    "name".into(),
                    serde_json::Value::String(format!("{image:?}")),
                );
                e
            }
            Item::Placeholder { shape, label } => {
                let mut e = box_json("placeholder", shape.rect);
                e.insert("name".into(), serde_json::Value::String(label.clone()));
                e
            }
            Item::PushClip { shape } => box_json("clip", shape.rect),
            // Glyph runs have a baseline origin and a size, not a box; the other
            // is not a rectangle at all.
            Item::Glyphs { .. } | Item::PopClip => continue,
        };
        boxes.push(serde_json::Value::Object(entry));
    }
    let mut out = serde_json::Map::new();
    out.insert("width".into(), json_f32(list.width));
    out.insert("height".into(), json_f32(list.height));
    out.insert(
        "lines".into(),
        serde_json::to_value(&lines).unwrap_or(serde_json::Value::Null),
    );
    out.insert("boxes".into(), serde_json::Value::Array(boxes));
    Ok(out)
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

fn json_f32(v: f32) -> serde_json::Value {
    // Non-finite floats have no JSON form; a size is always finite here, and a
    // null is honest if it somehow is not.
    serde_json::Number::from_f64(f64::from(v))
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}

/// A box of the display list: kind plus its rectangle, ready for an overlay.
fn box_json(
    kind: &str,
    rect: xeet_core::display::Rect,
) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    map.insert("kind".into(), serde_json::Value::String(kind.to_string()));
    map.insert("x".into(), json_f32(rect.x));
    map.insert("y".into(), json_f32(rect.y));
    map.insert("w".into(), json_f32(rect.w));
    map.insert("h".into(), json_f32(rect.h));
    map
}

fn color_json(c: xeet_core::color::Rgba) -> serde_json::Value {
    serde_json::json!([c.r, c.g, c.b, c.a])
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// A field-level problem, the shape `Error::to_json` already uses.
struct Field {
    path: String,
    message: String,
}

impl Field {
    fn new(path: &str, message: &str) -> Field {
        Field {
            path: path.to_string(),
            message: message.to_string(),
        }
    }
}

/// An error reply: the core's own JSON when it is a core error.
struct ReplyError {
    code: &'static str,
    status: u16,
    message: String,
    fields: Vec<Field>,
}

impl ReplyError {
    fn new(code: &'static str, status: u16, message: impl Into<String>) -> ReplyError {
        ReplyError {
            code,
            status,
            message: message.into(),
            fields: Vec::new(),
        }
    }

    fn with_fields(mut self, fields: Vec<Field>) -> ReplyError {
        self.fields = fields;
        self
    }

    fn to_json(&self) -> serde_json::Value {
        let mut v = serde_json::json!({
            "code": self.code,
            "status": self.status,
            "message": self.message,
        });
        if !self.fields.is_empty() {
            v["fields"] = self
                .fields
                .iter()
                .map(|f| serde_json::json!({ "path": f.path, "message": f.message }))
                .collect();
        }
        v
    }
}

impl From<Error> for ReplyError {
    fn from(e: Error) -> ReplyError {
        let json = e.to_json();
        let code = json["code"].as_str().unwrap_or("render_failed");
        // The core's codes are a small closed set, so an owned copy is cheap and
        // keeps `ReplyError` free of a lifetime parameter.
        let code: &'static str = match code {
            "invalid_post" => "invalid_post",
            "invalid_json" => "invalid_json",
            "render_failed" => "render_failed",
            other => match other {
                "text_too_long" => "text_too_long",
                "request_too_large" => "request_too_large",
                "work_budget_exceeded" => "work_budget_exceeded",
                "output_invalid" => "output_invalid",
                _ => "render_failed",
            },
        };
        let fields = json["fields"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|f| {
                        Field::new(
                            f["path"].as_str().unwrap_or("post"),
                            f["message"].as_str().unwrap_or("invalid"),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        ReplyError {
            code,
            status: e.http_status(),
            message: e.to_string(),
            fields,
        }
    }
}

impl From<xeet_core::limits::InputError> for ReplyError {
    fn from(e: xeet_core::limits::InputError) -> ReplyError {
        ReplyError::new("invalid_json", 400, e.to_string())
    }
}

impl From<Vec<xeet_core::limits::Problem>> for ReplyError {
    fn from(problems: Vec<xeet_core::limits::Problem>) -> ReplyError {
        ReplyError {
            code: "invalid_post",
            status: 400,
            message: format!("invalid post: {} problem(s)", problems.len()),
            fields: problems
                .iter()
                .map(|p| Field::new(&p.path, &p.message))
                .collect(),
        }
    }
}

/// Standard base64 (RFC 4648, padded). Twenty lines instead of a dependency for
/// a crate that ships to wasm and to three wrappers.
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Build stamp
// ---------------------------------------------------------------------------

struct BuildStamp {
    rev: serde_json::Value,
    dirty: serde_json::Value,
    built_at: serde_json::Value,
}

impl BuildStamp {
    /// Sidecar meta, then compile-time env, then the binary's mtime.
    fn load() -> BuildStamp {
        let exe = std::env::current_exe().ok();
        let exe_mtime = exe
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .and_then(|m| m.modified().ok());

        if let Some(exe) = &exe {
            if let Some(meta) = read_meta(exe, exe_mtime) {
                return meta;
            }
        }
        BuildStamp {
            rev: option_env!("XEET_BUILD_REV")
                .map(|s| serde_json::Value::String(s.to_string()))
                .unwrap_or(serde_json::Value::Null),
            dirty: match option_env!("XEET_BUILD_DIRTY") {
                Some("1") | Some("true") => serde_json::Value::Bool(true),
                Some(_) => serde_json::Value::Bool(false),
                None => serde_json::Value::Null,
            },
            built_at: exe_mtime
                .map(iso8601)
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        }
    }
}

/// `<exe dir>/<exe name>.meta.json`, written by the playground after a build.
///
/// Ignored when it is older than the binary: a rebuild that did not rewrite the
/// meta must not keep the previous revision's claim.
fn read_meta(
    exe: &std::path::Path,
    exe_mtime: Option<std::time::SystemTime>,
) -> Option<BuildStamp> {
    let file_name = exe.file_name()?.to_string_lossy().to_string();
    let path = exe.with_file_name(format!("{file_name}.meta.json"));
    let meta_mtime = std::fs::metadata(&path).ok()?.modified().ok()?;
    if let Some(built) = exe_mtime {
        // A meta file written a moment before the link would be unfair to
        // reject; two seconds of slack covers a filesystem's timestamp
        // granularity without hiding a stale meta.
        let slack = std::time::Duration::from_secs(2);
        if meta_mtime + slack < built {
            return None;
        }
    }
    let text = std::fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(BuildStamp {
        rev: value.get("rev").cloned().unwrap_or(serde_json::Value::Null),
        dirty: value
            .get("dirty")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        built_at: value
            .get("builtAt")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    })
}

/// `2026-11-10T12:34:56.789Z`, UTC. `xeet-core` may not read the clock, but the
/// CLI may, and this is the only place that needs a date. The civil-from-days
/// arithmetic is Howard Hinnant's, valid for the whole `SystemTime` range.
fn iso8601(t: std::time::SystemTime) -> String {
    let since_epoch = t
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(std::time::Duration::ZERO);
    let secs = since_epoch.as_secs() as i64;
    let millis = since_epoch.subsec_millis();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_reference_encoding() {
        for (input, want) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64_encode(input.as_bytes()), want, "input {input:?}");
        }
        let png_magic = base64_encode(b"\x89PNG\r\n\x1a\n");
        assert!(png_magic.starts_with("iVBORw0KGgo"), "got {png_magic}");
    }

    #[test]
    fn iso8601_dates_are_utc_and_zero_padded() {
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_762_785_296_789);
        assert_eq!(iso8601(t), "2025-11-10T14:34:56.789Z");
        assert_eq!(iso8601(std::time::UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn a_bad_line_is_an_error_and_not_a_panic() {
        let limits = Limits::standard();
        let reply = handle_line("not json at all", &limits);
        assert_eq!(reply["error"]["code"], "invalid_json");
        assert!(reply["id"].is_null());
        let reply = handle_line("[1,2,3]", &limits);
        assert_eq!(reply["error"]["code"], "invalid_json");
    }

    #[test]
    fn unknown_op_and_missing_post_are_errors_with_the_id() {
        let limits = Limits::standard();
        let reply = handle_line(r#"{"id":9,"op":"nope"}"#, &limits);
        assert_eq!(reply["id"], 9);
        assert_eq!(reply["error"]["code"], "unknown_op");
        let reply = handle_line(r#"{"id":"a","op":"render"}"#, &limits);
        assert_eq!(reply["id"], "a");
        assert_eq!(reply["error"]["code"], "invalid_post");
    }
}
