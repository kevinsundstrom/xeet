//! `xeet explain <post.json>`: the JSON report only, no pixels (PLAN.md §6).

use super::*;

pub const KNOWN: &[&str] = &[
    "surface",
    "width",
    "theme",
    "dpr",
    "font-scale",
    "fontScale",
    "expanded",
    "compact",
    "quiet",
    "out",
    "o",
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
            eprintln!("xeet explain: {e}");
            return EXIT_USAGE;
        }
    };
    if let Some(unknown) = args.unknown(KNOWN).first() {
        eprintln!("xeet explain: unknown flag `{unknown}`");
        return EXIT_USAGE;
    }
    let opts = match render_options(&args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("xeet explain: {e}");
            return EXIT_USAGE;
        }
    };
    let limits = match limits(&args) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("xeet explain: {e}");
            return EXIT_USAGE;
        }
    };
    let (json, source) = match read_input(&args) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("xeet explain: {e}");
            return EXIT_USAGE;
        }
    };

    let post = match xr::load_post(&json, &opts, &limits) {
        Ok(v) => v,
        Err(e) => return report_error(&source, &e),
    };
    if let Err(e) = ensure_fonts_for_post(&post, &opts) {
        eprintln!("xeet explain: {e}");
        return EXIT_IO;
    }
    let report = match xr::explain_with(&post, &opts, &limits) {
        Ok(r) => r,
        Err(e) => return report_error(&source, &e),
    };
    let quiet = args.has("quiet");
    if !quiet {
        warn_report(&report.warnings);
    }
    let text = if args.has("compact") {
        serde_json::to_string(&report)
    } else {
        serde_json::to_string_pretty(&report)
    };
    let text = match text {
        Ok(t) => t,
        Err(e) => {
            eprintln!("xeet explain: could not serialize the report: {e}");
            return EXIT_RENDER;
        }
    };
    let out = args.value("out").or_else(|| args.value("o"));
    match out {
        Some(p) => {
            if let Err(e) = write_output(Some(p), text.as_bytes()) {
                eprintln!("xeet explain: {e}");
                return EXIT_IO;
            }
            if p == "-" && !text.ends_with('\n') {
                println!();
            }
        }
        None => println!("{text}"),
    }
    EXIT_OK
}
