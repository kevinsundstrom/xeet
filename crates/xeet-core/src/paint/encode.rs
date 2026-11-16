//! PNG encoding.
//!
//! Encoding is most of the cost of a text render (PLAN §12: a 390-wide post at
//! 3× must produce a PNG in under 5 ms), so the default is the fast path:
//! `fdeflate` compression with a `Sub` row filter, which is both quick and
//! good on flat UI content. [`encode_png_best`] trades time for size with the
//! upstream balanced deflate, for artifacts people archive.
//!
//! Measurements on this machine (1170×1236, text post at 3×):
//!
//! | mode | time | bytes |
//! |---|---|---|
//! | `Fast` + `Sub` | see `examples/paint_bench.rs` | — |
//! | `Balanced` + `Adaptive` | — | — |

use crate::paint::Pixmap;

/// Encodes a pixmap as an 8-bit RGBA PNG, tuned for speed.
///
/// Returns an empty vector only if the encoder itself fails, which would mean
/// a bug in the `png` crate rather than bad input.
pub fn encode_png(p: &Pixmap) -> Vec<u8> {
    encode(p, png::Compression::Fast, png::Filter::Sub)
}

/// Encodes a pixmap as an 8-bit RGBA PNG, tuned for size.
pub fn encode_png_best(p: &Pixmap) -> Vec<u8> {
    encode(p, png::Compression::High, png::Filter::Adaptive)
}

fn encode(p: &Pixmap, compression: png::Compression, filter: png::Filter) -> Vec<u8> {
    let mut out = Vec::with_capacity(1024 + p.rgba.len() / 8);
    {
        let mut enc = png::Encoder::new(&mut out, p.width, p.height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(compression);
        enc.set_filter(filter);
        // Screenshots are not photographs: no need for the extra chunk.
        let Ok(mut w) = enc.write_header() else {
            return Vec::new();
        };
        if w.write_image_data(&p.rgba).is_err() {
            return Vec::new();
        }
    }
    out
}
