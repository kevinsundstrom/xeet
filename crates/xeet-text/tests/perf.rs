//! Performance smoke tests.
//!
//! The numbers that matter: `explain` on a normal post has a 100 µs budget
//! (PLAN §12), and this crate is one step of it, so a 280-character post must
//! parse in single-digit microseconds, and a 25,000-character post in well under
//! a millisecond so long posts stay cheap too.
//!
//! These run in whatever profile the test binary was built for (debug builds are
//! roughly an order of magnitude slower), so the assertions are loose and the
//! measurements are printed. Run `cargo test --release -p xeet-text --test perf
//! -- --nocapture` for the numbers to quote.

use std::time::Instant;

use xeet_text as tt;

fn post() -> String {
    "We just shipped the thing.\n\nRead more: https://vercel.com/blog/the-thing-and-more \
     #launch @vercel $VRS 100% 🚀 http://example.com/a/b?c=1&d=2"
        .to_string()
}

fn long_post() -> String {
    // 25,000 characters, half CJK and half Latin, with links and hashtags.
    let unit =
        "the quick brown fox 東京で新しいAPIを公開しました #launch https://example.com/a/b/c?d=1 ";
    let mut s = String::with_capacity(26_000);
    while s.chars().count() < 25_000 {
        s.push_str(unit);
    }
    s
}

/// Iterations for a timing loop: debug builds are slow enough that the same
/// count would dominate the test run.
fn iters(n: usize) -> usize {
    if cfg!(debug_assertions) {
        (n / 20).max(5)
    } else {
        n
    }
}

fn best_of<F: FnMut()>(n: usize, mut f: F) -> f64 {
    let mut best = f64::MAX;
    for _ in 0..n {
        let start = Instant::now();
        f();
        best = best.min(start.elapsed().as_secs_f64());
    }
    best
}

#[test]
fn parse_cost() {
    let short = post();
    let long = long_post();

    // Warm up: the first call allocates nothing global, but the timing loop
    // wants a warm allocator.
    tt::parse(&short);
    tt::parse(&long);

    let short_secs = best_of(iters(2000), || {
        std::hint::black_box(tt::parse(std::hint::black_box(&short)));
    });
    let long_secs = best_of(iters(50), || {
        std::hint::black_box(tt::parse(std::hint::black_box(&long)));
    });
    let entities_secs = best_of(iters(2000), || {
        std::hint::black_box(tt::entities(std::hint::black_box(&short)));
    });
    let length_secs = best_of(iters(2000), || {
        std::hint::black_box(tt::weighted_length(std::hint::black_box(&short)));
    });
    let display_secs = best_of(iters(20000), || {
        std::hint::black_box(tt::display_url(
            "https://vercel.com/blog/a-long-post-title-here",
        ));
    });

    println!(
        "entities: {:.2} µs; weighted_length: {:.2} µs",
        entities_secs * 1e6,
        length_secs * 1e6
    );
    let long_entities = best_of(iters(20), || {
        std::hint::black_box(tt::entities(std::hint::black_box(&long)));
    });
    let long_length = best_of(iters(20), || {
        std::hint::black_box(tt::weighted_length(std::hint::black_box(&long)));
    });
    println!(
        "25k entities: {:.2} µs; 25k weighted_length: {:.2} µs",
        long_entities * 1e6,
        long_length * 1e6
    );
    println!(
        "parse 280-char post: {:.2} µs; parse 25k-char post: {:.2} µs; display_url: {:.3} µs",
        short_secs * 1e6,
        long_secs * 1e6,
        display_secs * 1e6
    );

    // Loose bounds: debug builds are roughly an order of magnitude slower than
    // the release numbers quoted in the docs.
    let (short_bound, long_bound) = if cfg!(debug_assertions) {
        (500e-6, 40e-3)
    } else {
        (100e-6, 5e-3)
    };
    assert!(
        short_secs < short_bound,
        "280-char parse took {short_secs:.6}s"
    );
    assert!(
        long_secs < long_bound,
        "25k-char parse took {long_secs:.6}s"
    );
}

#[test]
fn scales_linearly() {
    // Guards against an accidental quadratic scan in the extractors.
    let make = |n: usize| "a https://example.com/x #tag @user ".repeat(n);
    let small = make(10);
    let big = make(if cfg!(debug_assertions) { 200 } else { 1000 });
    tt::parse(&small);
    tt::parse(&big);
    let small_secs = best_of(50, || {
        std::hint::black_box(tt::parse(std::hint::black_box(&small)));
    })
    .max(1e-9);
    let big_secs = best_of(20, || {
        std::hint::black_box(tt::parse(std::hint::black_box(&big)));
    });
    let ratio = big_secs / small_secs;
    let scale = if cfg!(debug_assertions) { 20.0 } else { 100.0 };
    println!("scaling: {ratio:.1}x for {scale:.0}x the text");
    assert!(ratio < 4.0 * scale, "scaling looks quadratic: {ratio:.1}x");
}
