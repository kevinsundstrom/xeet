//! `xeet-render`: the render/explain/sheet/serve binary.
//!
//! Shares `src/commands/` with `xeet`, while keeping `xeet-render serve --stdio`
//! dedicated to the JSON-lines render protocol (`xeet serve --stdio` serves
//! text-layout queries for the Chrome oracle suite).
//!
//!   xeet-render render post.json --width 390 --theme dark --dpr 3 -o post.png

#[path = "../commands/mod.rs"]
mod commands;

use std::process::ExitCode;

const COMMANDS_ONLY: &str = "xeet-render";

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(first) = argv.first() else {
        eprintln!(
            "{COMMANDS_ONLY}: expected a command: {}",
            commands::COMMANDS.join(", ")
        );
        eprintln!("{}", commands::usage_for(COMMANDS_ONLY));
        return ExitCode::from(commands::EXIT_USAGE);
    };
    match first.as_str() {
        "--help" | "-h" | "help" => {
            println!("{}", commands::usage_for(COMMANDS_ONLY));
            ExitCode::SUCCESS
        }
        "--version" | "-V" | "version" => {
            println!("{} {}", COMMANDS_ONLY, env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        name if commands::is_command(name) => commands::main_for(name, &argv[1..]),
        other => {
            eprintln!("{COMMANDS_ONLY}: unknown command `{other}`");
            eprintln!("{}", commands::usage_for(COMMANDS_ONLY));
            ExitCode::from(commands::EXIT_USAGE)
        }
    }
}
