# Performance: measured against the product budgets

`node tools/ship/bench.mjs` is the harness; `bench-budgets.json` is where the
budgets are written down. `node tools/ship/bench.mjs --stages` adds a
breakdown of where a row's time goes, which is what this page is mostly for: the
budgets are a product promise, but the attribution is what makes them fixable.

Last run: 2026-11-10, macOS 27.2 arm64 (M-series), `--release` (fat LTO, strip),
`ship_bench` example plus the real binary for cold start. The machine was shared
with other builds, so p50s move by 30–50% between runs; the stage rows are the
stable part of the picture.

| Row | Measured p50 | Budget | Status |
|---|---|---|---|
| `explain`, 280-character post | 343 µs | 100 µs | 3.4× over — all in `frame::layout` |
| `explain`, 25,000-character post | 3.1 ms | 2 ms | 1.6× over — all in `frame::layout` |
| PNG of a text post, 390 wide at 3× | 2.8 ms | 5 ms | ok |
| PNG with four placeholder media | 4.5 ms | 5 ms | ok (89% of budget) |
| PNG with four real 800×600 photos decoded and scaled | 62 ms | 30 ms | 2.1× over — paint's image path |
| The same at 1600×900 (stress case, own budget) | 131 ms | 120 ms | 1.1× over |
| `explain` of a post with four real images | 85 µs | 2 ms | **ok (23× margin)** |
| Cold start (process spawn to first PNG) | 5.7 ms | 10 ms | **ok** |
| Binary size, release (core: Chirp + Arial) | 7.0 MB | 50 MB | ok |

The 7.0 MB release binary is the core build (`XEET_FONT_PACKS=core`, measured
2026-11-12). The emoji, CJK, math, Latin and Arabic/Hebrew packs are 39.16 MB
beside it and load on demand; a local build without that variable embeds every
face (~49 MB). The WebAssembly module uses the same split: 6.44 MB raw / 2.85 MB
gzipped for the core, with the packs fetched separately. `packs.json` carries a
SHA-256 per pack and the build serves the whole set from a content-hashed
directory with immutable caching.

## Where `explain`'s time goes

`--stages` on the 280-character post, at 390 wide:

| Stage | p50 |
|---|---|
| `limits::validate` | 0.1 µs |
| `rules::decide` (twitter-text parse, attachment precedence) | 8.7 µs |
| `frame::layout` | 242 µs |
| → of which `inline::layout` of the 280-character body alone | 147 µs |
| → the rest: header, badges, action row, divider, attachment slot | ~95 µs |
| `explain` (the three together) | 251 µs |
| `budget_for` | 0.0 µs |

So `explain` is 96% layout, and 61% of that is shaping and breaking the body
text. The pipeline adds nothing measurable. To reach the 100 µs budget, the body
block needs to cost ~50 µs: that is a text-engine question (shaping ~280 glyphs
at ~0.5 µs each is slow for HarfBuzz-derived code; per-glyph allocation or a
per-character font-fallback scan are the usual causes), plus whatever the frame
does with ~95 µs of chrome around it. Nothing in `render.rs` can move these
numbers.

Cold start, measured from a shell (25 runs, median):

| Case | Median |
|---|---|
| spawn only (`--version`) | 4.5 ms |
| `explain` a fixture | 5.7 ms |
| `render` at dpr 1 | 9.0 ms |
| `render` at dpr 3 | 22.6 ms |

Two thirds of the dpr-1 cold start is process creation; the renderer's own share
is 4.5 ms, which is the font table plus one layout and one small raster.

## What was mine, and is fixed

`explain` used to spend 290 ms on a post with four 1600×900 images. It was not
decoding them — the report only needs dimensions — it was validating their
base64, in two full passes, with an `ALPHABET.contains(byte)` scan (64
comparisons per input byte). Three changes took that to 173 µs:

1. a 256-entry lookup table instead of the linear alphabet scan,
2. one pass instead of `base64_len` plus `check_base64`,
3. bounded validation: length arithmetic is exact and O(1), and only the first
   4 KB of a payload is checked against the alphabet. The decoder is the real
   check, and a payload that fails there becomes a placeholder plus a warning.

The image rows are paint's: decoding, mip construction and resampling. Two
numbers worth reading together: four 800×600 PNGs cost 62 ms and four 1600×900
PNGs cost 131 ms, so 4× the pixels buys only 2.2× the time, and paint's own
measurement (73–87 ms at 1600×900, decode ≈50 ms as the floor with `zune-jpeg`)
agrees on the shape. That flatness says the cost is not raw decode but a large
per-image constant — the mip chain or the resample setup — which is where a fix
would pay off. The 10–30 ms budget for four real images is therefore **not** met
today at either size; the 800×600 row exists to keep that budget honest instead
of letting a single 1600×900 stress case define it.

One caveat on all image numbers: they depend on how compressible the test images
are. `ship_bench` generates photo-like PNGs (smooth gradients with ±2 of
dither), because random noise makes inflate — and therefore decode — several
times more expensive than any photograph. Earlier numbers in this project were
taken with noise, which is why one measured 687 ms for four 1600×900 images.

The placeholder row (5.5 ms) is raster plus PNG encoding of a 390-px column at
2×, also paint's: about 0.55 M device pixels and a PNG encode.

## How to re-measure

```sh
CARGO_TARGET_DIR=target/ship-bench node tools/ship/bench.mjs
node tools/ship/bench.mjs --stages              # the attribution table above
node tools/ship/bench.mjs --rows explain_280    # one row
node tools/ship/bench.mjs --save-baseline       # record this machine
```

The relative check (`--max-regression`, default 1.25×) only applies when
`bench-baseline.json` was recorded on the same machine label
(`XEET_BENCH_MACHINE`), because a laptop and a CI runner are not comparable.
