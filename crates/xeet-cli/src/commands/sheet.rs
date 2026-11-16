//! `xeet sheet <post.json> --widths 320,390,600 --themes light,dark -o sheet.png`
//!
//! Several viewports and themes in one labeled image: the artifact a marketing
//! review wants (PLAN.md §6).

use super::*;
use xeet_core::model::Theme;

pub const KNOWN: &[&str] = &[
    "widths",
    "themes",
    "dpr",
    "surface",
    "width",
    "theme",
    "font-scale",
    "out",
    "o",
    "time",
    "limits",
    "help",
    "h",
];

pub fn run(argv: &[String]) -> u8 {
    if argv.is_empty() || argv.iter().any(|a| a == "--help" || a == "-h") {
        println!("{}", usage_for("xeet"));
        return EXIT_OK;
    }
    let args = match Args::parse(argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("xeet sheet: {e}");
            return EXIT_USAGE;
        }
    };
    if let Some(unknown) = args.unknown(KNOWN).first() {
        eprintln!("xeet sheet: unknown flag `{unknown}`");
        return EXIT_USAGE;
    }
    let limits = match limits(&args) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("xeet sheet: {e}");
            return EXIT_USAGE;
        }
    };

    let widths = match parse_widths(args.value("widths")) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("xeet sheet: {e}");
            return EXIT_USAGE;
        }
    };
    let themes = match parse_themes(args.value("themes")) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("xeet sheet: {e}");
            return EXIT_USAGE;
        }
    };
    let mut dpr = 2.0f32;
    if let Some(d) = args.value("dpr") {
        match d.parse::<f32>() {
            Ok(v) if v > 0.0 && v <= 4.0 => dpr = v,
            _ => {
                eprintln!("xeet sheet: --dpr needs a number in 1..4, got `{d}`");
                return EXIT_USAGE;
            }
        }
    }
    // `--surface` changes the type scale inside every cell; it is validated by
    // the core, but an unknown value is a usage error, not a render error.
    if let Some(s) = args.value("surface") {
        if !matches!(s, "web-timeline" | "timeline" | "web-detail" | "detail") {
            eprintln!("xeet sheet: unknown surface `{s}`; expected web-timeline or web-detail");
            return EXIT_USAGE;
        }
    }

    let (json, source) = match read_input(&args) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("xeet sheet: {e}");
            return EXIT_USAGE;
        }
    };
    let mut opts = match render_options(&args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("xeet sheet: {e}");
            return EXIT_USAGE;
        }
    };
    opts.width = widths.first().copied().unwrap_or(opts.width);

    let started = std::time::Instant::now();
    let post = match xr::load_post(&json, &opts, &limits) {
        Ok(v) => v,
        Err(e) => return report_error(&source, &e),
    };
    if let Err(e) = ensure_fonts_for_post(&post, &opts) {
        eprintln!("xeet sheet: {e}");
        return EXIT_IO;
    }
    let png = match xr::sheet_with(&post, &widths, &themes, dpr, &limits) {
        Ok(p) => p,
        Err(e) => return report_error(&source, &e),
    };
    let elapsed = started.elapsed();

    let out = args.value("out").or_else(|| args.value("o"));
    if let Err(e) = write_output(out, &png) {
        eprintln!("xeet sheet: {e}");
        return EXIT_IO;
    }
    if args.has("time") {
        eprintln!(
            "xeet sheet: {} cells at dpr {} in {:.2} ms, {} bytes",
            widths.len() * themes.len(),
            dpr,
            elapsed.as_secs_f64() * 1000.0,
            png.len()
        );
    }
    EXIT_OK
}

/// `320,390,600` → three widths. Also accepts spaces, for `--widths "320, 390"`.
pub fn parse_widths(spec: Option<&str>) -> Result<Vec<f32>, String> {
    let spec = spec.unwrap_or("390");
    let mut out = Vec::new();
    for part in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let w: f32 = part
            .parse()
            .map_err(|_| format!("--widths needs comma-separated numbers, got `{part}`"))?;
        if !(w.is_finite() && w > 0.0) {
            return Err(format!("--widths entry `{part}` is not a positive width"));
        }
        out.push(w);
    }
    if out.is_empty() {
        return Err("--widths is empty".to_string());
    }
    Ok(out)
}

/// `light,dark`, or `both` for the pair. Order is preserved: rows follow the
/// order the user asked for, so `dark,light` flips them.
pub fn parse_themes(spec: Option<&str>) -> Result<Vec<Theme>, String> {
    let spec = spec.unwrap_or("light,dark");
    let mut out = Vec::new();
    for part in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        match part {
            "both" => {
                for t in [Theme::Light, Theme::Dark] {
                    if !out.contains(&t) {
                        out.push(t);
                    }
                }
            }
            other => {
                let t = parse_theme(other)?;
                if !out.contains(&t) {
                    out.push(t);
                }
            }
        }
    }
    if out.is_empty() {
        return Err("--themes is empty".to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widths_and_themes_parse() {
        assert_eq!(
            parse_widths(Some("320,390,600")).unwrap(),
            vec![320.0, 390.0, 600.0]
        );
        assert_eq!(parse_widths(None).unwrap(), vec![390.0]);
        assert!(parse_widths(Some("320,abc")).is_err());
        assert!(parse_widths(Some("320,0")).is_err());
        assert_eq!(
            parse_themes(Some("both")).unwrap(),
            vec![Theme::Light, Theme::Dark]
        );
        assert_eq!(
            parse_themes(Some("dark,light")).unwrap(),
            vec![Theme::Dark, Theme::Light]
        );
        assert_eq!(parse_themes(Some("dark,dark")).unwrap(), vec![Theme::Dark]);
        assert!(parse_themes(Some("dim")).is_err());
    }
}
