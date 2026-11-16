//! Renders a block of text to a PNG, so anyone can see the rasterizer's output
//! without the rest of the pipeline.
//!
//! ```sh
//! echo 'We just shipped the thing. 🎉' \
//!   | cargo run --profile fast --example paint_text -- --width 390 --dpr 3 -o tmp/text.png
//! cargo run --profile fast --example paint_text -- --width 390 --dpr 2 --theme dark \
//!   --text 'Hello from xeet' -o tmp/dark.png
//! ```
//!
//! Everything is CSS pixels except `--dpr`, which multiplies the pixel grid.
//! Text is laid out by the real text engine (`inline::layout`), so line breaks
//! are the ones Chrome produces; this file only feeds the display list to
//! `paint::rasterize`.

use std::io::Read;
use xeet_core::color::Rgba;
use xeet_core::display::DisplayList;
use xeet_core::inline::{self, BlockStyle, Dir, Span, Wrap};
use xeet_core::paint::{self, NoImages};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| -> Option<String> {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let num = |name: &str, d: f32| flag(name).and_then(|v| v.parse().ok()).unwrap_or(d);

    let width = num("--width", 390.0);
    let dpr = num("--dpr", 3.0);
    let size = num("--size", 15.0);
    let line_height = num("--lh", 20.0);
    let weight = num("--weight", 400.0) as u16;
    let padding = num("--padding", 16.0);
    let clamp = flag("--clamp").and_then(|v| v.parse::<usize>().ok());
    let dark = flag("--theme").as_deref() == Some("dark");
    let out = flag("-o").unwrap_or_else(|| "text.png".to_string());

    let mut text = flag("--text").unwrap_or_default();
    if text.is_empty() {
        std::io::stdin().read_to_string(&mut text).expect("stdin");
        // Trailing newline from `echo` is not part of the post.
        if text.ends_with('\n') {
            text.pop();
        }
    }

    let (bg, fg) = if dark {
        (Rgba::hex(0x000000), Rgba::hex(0xE7E9EA))
    } else {
        (Rgba::hex(0xFFFFFF), Rgba::hex(0x0F1419))
    };

    let st = BlockStyle {
        size,
        line_height,
        weight,
        width: width - 2.0 * padding,
        max_lines: clamp,
        wrap: Wrap::Anywhere,
        preserve: true,
        dir: Dir::Auto,
        tab_size: 4.0,
    };
    let block = inline::layout(&[Span::new(text.as_str(), fg, weight)], &st);
    let height = block.height + 2.0 * padding;
    let mut list = DisplayList::new(width, height, bg);
    list.push_text(&block, padding, padding);

    let pixmap = paint::rasterize(&list, dpr, &NoImages);
    let png = paint::encode_png(&pixmap);
    std::fs::write(&out, &png).expect("write png");
    println!(
        "{}: {}x{} css, {}x{} px, {} lines, {} bytes png",
        out,
        width,
        height,
        pixmap.width,
        pixmap.height,
        block.lines.len(),
        png.len()
    );
}
