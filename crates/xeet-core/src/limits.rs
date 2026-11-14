//! Hard limits, a deterministic work budget, and input validation (PLAN.md §13).
//!
//! The renderer takes input written by agents and runs in a privileged,
//! multi-tenant process, so the input is assumed hostile. This module is where
//! "hostile" becomes numbers:
//!
//! - **Text**: UTF-8 bytes and Unicode scalar values.
//! - **Media**: how many attachments, and their declared dimensions.
//! - **Images**: encoded bytes, decoded dimensions and decoded pixel area.
//!   `paint::decode_image` takes a `&Limits` and enforces the image caps there,
//!   before allocating, so a decompression bomb costs nothing.
//! - **Output**: pixel area of the raster, which is `width × height × dpr²`.
//!   Checked after layout, since the height is only known then.
//! - **Work**: a *deterministic* budget instead of a clock. `xeet-core` has no
//!   clock (it would make output timing-dependent and the WASM build
//!   non-hermetic), so the budget is a unit counter derived from the input.
//!   Every stage charges against it; exhausting it is an error, never a wait.
//!
//! Nothing here panics on bad input: every check returns an error that names
//! the field and what to do about it.

use crate::model::{Post, RenderOptions, Surface, Theme};
use std::collections::BTreeMap;
use std::fmt;

/// Caps on one render. [`Limits::standard`] is the policy every wrapper uses;
/// tests and the oracle may pass something looser or tighter.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// UTF-8 bytes of `Post::text` (a byte cap catches "one huge string").
    pub max_text_bytes: usize,
    /// Unicode scalar values of `Post::text`.
    pub max_text_chars: usize,
    /// Characters X allows in one long post. Over this, the report says the
    /// post is invalid rather than refusing to render it (see `explain`).
    pub long_post_chars: usize,
    /// Attachments in `Post::media`. X allows four images, or one video/GIF.
    pub max_media: usize,
    /// Encoded bytes of one image (avatar, media, card image).
    pub max_image_bytes: usize,
    /// Encoded bytes of all images in one request, summed.
    pub max_image_bytes_total: usize,
    /// Larger side of one decoded image, in pixels.
    pub max_image_dimension: u32,
    /// Decoded area of one image, in pixels. Set to the dimension cap squared
    /// so any image X serves at its maximum side decodes.
    pub max_image_pixels: u64,
    /// Decoded area of all images in one request, summed.
    pub max_image_pixels_total: u64,
    /// Quoted posts nested inside a post (`Post::quote`), which is depth 1, and
    /// inside that one (`post.quote.quote`), which is depth 2. X renders both —
    /// a quote of a quote shows as the inner post — and refuses a third, so
    /// `post.quote.quote.quote` is an `invalid_post` naming that path.
    pub max_quote_depth: usize,
    /// Cells in one `sheet`: `widths.len() * themes.len()`.
    pub max_sheet_cells: usize,
    /// CSS pixels of a sheet, per side.
    pub max_sheet_dimension: f32,
    /// Output raster width and height in device pixels.
    pub max_output_width: u32,
    pub max_output_height: u32,
    /// Output raster area in device pixels (width × height × dpr²).
    pub max_output_pixels: u64,
    /// Longest accepted card title, description and alt text.
    pub max_card_text_chars: usize,
    /// Narrowest and widest viewport we accept, in CSS pixels.
    pub min_width: f32,
    pub max_width: f32,
    /// Work units granted before any input-dependent allowance.
    pub work_base: u64,
    /// Work units granted per Unicode scalar of `Post::text`.
    pub work_per_char: u64,
    /// Work units granted per output device pixel.
    pub work_per_output_pixel: u64,
    /// The most work units a request can ever be granted.
    pub work_ceiling: u64,
}

impl Limits {
    /// The policy the CLI, the HTTP function and the WASM package share.
    ///
    /// The numbers are sized so that a legitimate request never hits a limit:
    /// the largest real post (25,000 characters) uses a quarter of the text
    /// budget, a four-image post at 3× on a 600px column uses about 1/8 of the
    /// output budget, and a 40 MP image is refused before it is decoded.
    pub const fn standard() -> Limits {
        Limits {
            max_text_bytes: 256 * 1024,
            max_text_chars: 100_000,
            long_post_chars: 25_000,
            max_media: 20,
            max_image_bytes: 8 * 1024 * 1024,
            max_image_bytes_total: 64 * 1024 * 1024,
            max_image_dimension: 8192,
            // The dimension cap squared: any image X can serve at its maximum
            // side fits, which real payloads need (a captured photo is
            // 8192×5464 = 44.7 MP). The total still bounds one request while
            // admitting 20-image carousels.
            max_image_pixels: 67_108_864,
            max_image_pixels_total: 536_870_912,
            max_quote_depth: 2,
            max_sheet_cells: 12,
            max_sheet_dimension: 8192.0,
            max_output_width: 8192,
            max_output_height: 32_768,
            max_output_pixels: 64_000_000,
            max_card_text_chars: 4096,
            min_width: 100.0,
            max_width: 1200.0,
            work_base: 2_000_000,
            work_per_char: 200,
            work_per_output_pixel: 4,
            work_ceiling: 200_000_000,
        }
    }

    /// No caps beyond the ones that keep arithmetic sane. For the oracle and
    /// for tests that deliberately want to see the failure modes.
    pub const fn unlimited() -> Limits {
        Limits {
            max_text_bytes: usize::MAX,
            max_text_chars: usize::MAX,
            long_post_chars: 25_000,
            max_media: usize::MAX,
            max_image_bytes: usize::MAX,
            max_image_bytes_total: usize::MAX,
            max_image_dimension: u32::MAX,
            max_image_pixels: u64::MAX,
            max_image_pixels_total: u64::MAX,
            max_quote_depth: usize::MAX,
            max_sheet_cells: usize::MAX,
            max_sheet_dimension: f32::MAX,
            max_output_width: u32::MAX,
            max_output_height: u32::MAX,
            max_output_pixels: u64::MAX,
            max_card_text_chars: usize::MAX,
            min_width: 1.0,
            max_width: f32::MAX,
            work_base: u64::MAX / 4,
            work_per_char: 0,
            work_per_output_pixel: 0,
            work_ceiling: u64::MAX / 2,
        }
    }

    /// Checks one decoded image's dimensions, the way `paint::decode_image`
    /// does: before decoding when the header already says too much, and after
    /// decoding as a second line of defence.
    pub fn check_image_dimensions(
        &self,
        width: u32,
        height: u32,
        what: &str,
    ) -> Result<(), LimitError> {
        if width == 0 || height == 0 {
            return Err(LimitError::new(
                "image_dimensions_invalid",
                format!("{what} has zero width or height ({width}×{height})"),
            ));
        }
        if width > self.max_image_dimension || height > self.max_image_dimension {
            return Err(LimitError::new(
                "image_too_large",
                format!(
                    "{what} is {width}×{height}; the limit is {} pixels on a side",
                    self.max_image_dimension
                ),
            ));
        }
        let pixels = u64::from(width) * u64::from(height);
        if pixels > self.max_image_pixels {
            return Err(LimitError::new(
                "image_pixels_exceeded",
                format!(
                    "{what} is {width}×{height} = {pixels} pixels; the limit is {} pixels",
                    self.max_image_pixels
                ),
            ));
        }
        Ok(())
    }

    /// Checks encoded image size before decoding.
    pub fn check_image_bytes(&self, bytes: usize, what: &str) -> Result<(), LimitError> {
        if bytes > self.max_image_bytes {
            return Err(LimitError::new(
                "image_bytes_exceeded",
                format!(
                    "{what} is {} bytes encoded; the limit is {} bytes",
                    bytes, self.max_image_bytes
                ),
            ));
        }
        Ok(())
    }

    /// Checks the raster `width × height` at `dpr`. Call after layout, when the
    /// height is known; `width` may come from the options.
    pub fn check_output(&self, width: f32, height: f32, dpr: f32) -> Result<(), LimitError> {
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return Err(LimitError::new(
                "output_invalid",
                format!("output size {width}×{height} is not a positive, finite size"),
            ));
        }
        let w = (width * dpr).ceil();
        let h = (height * dpr).ceil();
        if w > f32::from(u16::MAX) || h > f32::from(u16::MAX) {
            // Also keeps the raster inside the 16-bit limits of most encoders.
            return Err(LimitError::new(
                "output_too_large",
                format!("output would be {w}×{h} device pixels at dpr {dpr}; the limit is 65535 on a side"),
            ));
        }
        let (w, h) = (w as u64, h as u64);
        if w > u64::from(self.max_output_width) || h > u64::from(self.max_output_height) {
            return Err(LimitError::new(
                "output_too_large",
                format!(
                    "output would be {w}×{h} device pixels at dpr {dpr}; the limit is {}×{}",
                    self.max_output_width, self.max_output_height
                ),
            ));
        }
        let pixels = w * h;
        if pixels > self.max_output_pixels {
            return Err(LimitError::new(
                "output_pixels_exceeded",
                format!(
                    "output would be {w}×{h} = {pixels} device pixels; the limit is {}",
                    self.max_output_pixels
                ),
            ));
        }
        Ok(())
    }

    /// Checks a raster that already exists, in device pixels.
    pub fn check_output_pixels(&self, width: u32, height: u32) -> Result<(), LimitError> {
        if width > self.max_output_width || height > self.max_output_height {
            return Err(LimitError::new(
                "output_too_large",
                format!(
                    "output raster is {width}×{height} device pixels; the limit is {}×{}",
                    self.max_output_width, self.max_output_height
                ),
            ));
        }
        let pixels = u64::from(width) * u64::from(height);
        if pixels > self.max_output_pixels {
            return Err(LimitError::new(
                "output_pixels_exceeded",
                format!(
                    "output raster is {width}×{height} = {pixels} device pixels; the limit is {}",
                    self.max_output_pixels
                ),
            ));
        }
        Ok(())
    }

    /// The work budget for one request: a pure function of the input, so two
    /// runs of the same input get the same budget on every platform.
    pub fn budget_for(&self, post: &Post, opts: &RenderOptions, estimated_height: f32) -> Budget {
        // The whole tree is shaped and painted, so the whole tree is charged:
        // the root, its quote, and that quote's quote. Counting only the root
        // would let a 100 000-character post carry two 25 000-character quotes
        // for no budget at all.
        let mut chars = 0u64;
        let mut media = 0u64;
        let mut node = Some(post);
        while let Some(p) = node {
            chars = chars.saturating_add(p.text.chars().count() as u64);
            media = media.saturating_add(p.media.len() as u64);
            node = p.quote.as_deref();
        }
        let dpr = if opts.dpr.is_finite() && opts.dpr > 0.0 {
            opts.dpr
        } else {
            1.0
        };
        // The height is a layout result; before layout we use a generous
        // stand-in so the grant does not depend on the very work it guards.
        let h = if estimated_height.is_finite() && estimated_height > 0.0 {
            f64::from(estimated_height)
        } else {
            4000.0
        };
        let out_pixels = (f64::from(opts.width.max(0.0)) * f64::from(dpr) * h * f64::from(dpr))
            .min(6.4e7) as u64;
        let units = self
            .work_base
            .saturating_add(chars.saturating_mul(self.work_per_char))
            .saturating_add(media.saturating_mul(10_000))
            .saturating_add(out_pixels.saturating_mul(self.work_per_output_pixel))
            .min(self.work_ceiling);
        Budget {
            granted: units,
            remaining: units,
        }
    }
}

impl Default for Limits {
    fn default() -> Self {
        Limits::standard()
    }
}

/// A deterministic allowance of work, in abstract units. One unit is roughly
/// one shaped glyph position or 64 output pixels; the exact exchange rate is a
/// policy, not a contract. Overrunning it means the input asked for
/// pathological amounts of layout (deeply nested quotes, gigantic sheets) and
/// the request fails instead of pinning a CPU.
#[derive(Clone, Copy, Debug)]
pub struct Budget {
    granted: u64,
    remaining: u64,
}

impl Budget {
    pub const fn granted(&self) -> u64 {
        self.granted
    }

    pub const fn remaining(&self) -> u64 {
        self.remaining
    }

    pub const fn spent(&self) -> u64 {
        self.granted - self.remaining
    }

    /// Charges `units`, or fails if the budget is exhausted.
    pub fn charge(&mut self, units: u64, what: &str) -> Result<(), LimitError> {
        match self.remaining.checked_sub(units) {
            Some(left) => {
                self.remaining = left;
                Ok(())
            }
            None => Err(LimitError::new(
                "work_budget_exceeded",
                format!(
                    "{what} needs more work than this request may spend ({} of {} units used)",
                    self.spent(),
                    self.granted
                ),
            )),
        }
    }
}

/// One refused request. `code` is stable and machine-readable; the wrappers map
/// it to an HTTP status and a JSON body, and the CLI prints `detail`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LimitError {
    pub code: &'static str,
    pub detail: String,
}

impl LimitError {
    pub fn new(code: &'static str, detail: impl Into<String>) -> LimitError {
        LimitError {
            code,
            detail: detail.into(),
        }
    }

    /// True when the caller, not the server, is at fault (HTTP 4xx).
    pub fn is_client_error(&self) -> bool {
        !matches!(self.code, "work_budget_exceeded")
    }
}

impl fmt::Display for LimitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for LimitError {}

/// One validation complaint about the input, with the field it is about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    /// JSON-ish path, e.g. `post.media[2].width`.
    pub path: String,
    pub message: String,
}

impl Problem {
    fn new(path: impl Into<String>, message: impl Into<String>) -> Problem {
        Problem {
            path: path.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

/// Validates a post and its options against `limits`, returning every problem
/// found rather than only the first: an agent gets one round trip to fix them.
///
/// This is the "no hostile input" gate. `render` and `explain` call it, so the
/// wrappers do not have to.
pub fn validate(post: &Post, opts: &RenderOptions, limits: &Limits) -> Result<(), Vec<Problem>> {
    let mut problems = Vec::new();

    let text_chars = post.text.chars().count();
    if post.text.len() > limits.max_text_bytes {
        problems.push(Problem::new(
            "post.text",
            format!(
                "is {} bytes of UTF-8; the limit is {} bytes",
                post.text.len(),
                limits.max_text_bytes
            ),
        ));
    }
    if text_chars > limits.max_text_chars {
        problems.push(Problem::new(
            "post.text",
            format!(
                "has {text_chars} characters; the limit is {}",
                limits.max_text_chars
            ),
        ));
    }

    if !opts.width.is_finite() || opts.width < limits.min_width || opts.width > limits.max_width {
        problems.push(Problem::new(
            "options.width",
            format!(
                "is {}; the accepted range is {} to {} CSS pixels",
                opts.width, limits.min_width, limits.max_width
            ),
        ));
    }
    if !opts.dpr.is_finite() || opts.dpr <= 0.0 || opts.dpr > 4.0 {
        problems.push(Problem::new(
            "options.dpr",
            format!(
                "is {}; the accepted range is greater than 0 and at most 4",
                opts.dpr
            ),
        ));
    }
    if !opts.font_scale.is_finite() || !(0.5..=2.0).contains(&opts.font_scale) {
        problems.push(Problem::new(
            "options.fontScale",
            format!("is {}; the accepted range is 0.5 to 2.0", opts.font_scale),
        ));
    }

    let mut totals = Totals::default();
    validate_post_body(post, "post", 0, limits, &mut problems, &mut totals);
    // Both caps are per *request*, and a request is the post plus every nested
    // quote: four images in the root and four in its quote are eight images'
    // worth of work however the tree is shaped.
    if totals.encoded_bytes > limits.max_image_bytes_total {
        problems.push(Problem::new(
            "post",
            format!(
                "carries {} bytes of base64 images across the post and its quotes; the limit is {} bytes per request",
                totals.encoded_bytes, limits.max_image_bytes_total
            ),
        ));
    }
    if totals.pixels > limits.max_image_pixels_total {
        problems.push(Problem::new(
            "post",
            format!(
                "carries {} pixels of images across the post and its quotes; the limit is {} per request",
                totals.pixels, limits.max_image_pixels_total
            ),
        ));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

/// What the whole post tree costs, summed across nested quotes.
#[derive(Default)]
struct Totals {
    encoded_bytes: usize,
    pixels: u64,
}

fn validate_post_body(
    post: &Post,
    path: &str,
    depth: usize,
    limits: &Limits,
    problems: &mut Vec<Problem>,
    totals: &mut Totals,
) {
    if post.author.name.chars().count() > 256 {
        problems.push(Problem::new(
            format!("{path}.author.name"),
            format!(
                "is {} characters; the limit is 256",
                post.author.name.chars().count()
            ),
        ));
    }
    let handle = post.author.handle.trim_start_matches('@');
    if handle.len() > 64 {
        problems.push(Problem::new(
            format!("{path}.author.handle"),
            format!("is {} bytes; the limit is 64", handle.len()),
        ));
    }
    if !handle
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        problems.push(Problem::new(
            format!("{path}.author.handle"),
            "may contain only ASCII letters, digits and underscore (pass it without the @)"
                .to_string(),
        ));
    }

    if post.media.len() > limits.max_media {
        problems.push(Problem::new(
            format!("{path}.media"),
            format!(
                "has {} attachments; the limit is {} (up to 20 carousel items, or one video or GIF)",
                post.media.len(),
                limits.max_media
            ),
        ));
    }
    // No "a video excludes other media" rule, deliberately. That is a composer
    // constraint, and real payloads break it: a quote of a two-image plus
    // one-video post exists in the captured corpus, and the renderer has to
    // show what X showed rather than refuse it. The count cap above still
    // applies.
    for (i, m) in post.media.iter().enumerate() {
        let at = format!("{path}.media[{i}]");
        if m.width == 0 || m.height == 0 {
            problems.push(Problem::new(
                format!("{at}.width"),
                format!(
                    "media dimensions must be positive; got {}×{}",
                    m.width, m.height
                ),
            ));
        } else if let Err(e) =
            limits.check_image_dimensions(m.width, m.height, "the media dimensions")
        {
            problems.push(Problem::new(format!("{at}.width"), e.detail));
        }
        if let Some(alt) = &m.alt {
            if alt.chars().count() > 1000 {
                problems.push(Problem::new(
                    format!("{at}.alt"),
                    "is longer than 1000 characters (X's ALT limit is 1000)",
                ));
            }
        }
        if m.width > 0 && m.height > 0 {
            totals.pixels = totals
                .pixels
                .saturating_add(u64::from(m.width) * u64::from(m.height));
        }
        if let Some(data) = &m.data {
            let bytes = base64_len(data);
            totals.encoded_bytes = totals.encoded_bytes.saturating_add(bytes);
            if let Err(e) = limits.check_image_bytes(bytes, "the media image") {
                problems.push(Problem::new(format!("{at}.data"), e.detail));
            }
            if let Err(e) = check_base64(data) {
                problems.push(Problem::new(format!("{at}.data"), e));
            }
        }
        if let Some(d) = m.duration {
            if !d.is_finite() || d < 0.0 || d > 24.0 * 3600.0 {
                problems.push(Problem::new(
                    format!("{at}.duration"),
                    format!("is {d}; expected seconds from 0 to 86400"),
                ));
            }
        }
    }

    if let Some(avatar) = &post.author.avatar {
        let bytes = base64_len(avatar);
        totals.encoded_bytes = totals.encoded_bytes.saturating_add(bytes);
        if let Err(e) = limits.check_image_bytes(bytes, "the avatar") {
            problems.push(Problem::new(format!("{path}.author.avatar"), e.detail));
        }
        if let Err(e) = check_base64(avatar) {
            problems.push(Problem::new(format!("{path}.author.avatar"), e));
        }
    }

    for (url, meta) in &post.links {
        let at = format!("{path}.links[{url:?}]");
        if url.is_empty() {
            problems.push(Problem::new(
                format!("{path}.links"),
                "contains an empty URL key",
            ));
        }
        for (field, value) in [
            ("title", &meta.title),
            ("description", &meta.description),
            ("domain", &meta.domain),
        ] {
            if let Some(v) = value {
                if v.chars().count() > limits.max_card_text_chars {
                    problems.push(Problem::new(
                        format!("{at}.{field}"),
                        format!(
                            "is {} characters; the limit is {}",
                            v.chars().count(),
                            limits.max_card_text_chars
                        ),
                    ));
                }
            }
        }
        if let Some(img) = &meta.image {
            if let Some(data) = &img.data {
                let bytes = base64_len(data);
                totals.encoded_bytes = totals.encoded_bytes.saturating_add(bytes);
                if let Err(e) = limits.check_image_bytes(bytes, "the card image") {
                    problems.push(Problem::new(format!("{at}.image.data"), e.detail));
                }
                if let Err(e) = check_base64(data) {
                    problems.push(Problem::new(format!("{at}.image.data"), e));
                }
            }
            if img.width > 0 && img.height > 0 {
                if let Err(e) = limits.check_image_dimensions(
                    img.width,
                    img.height,
                    "the card image dimensions",
                ) {
                    problems.push(Problem::new(format!("{at}.image.width"), e.detail));
                }
            }
        }
    }

    if let Some(poll) = &post.poll {
        let at = format!("{path}.poll");
        if !(2..=4).contains(&poll.choices.len()) {
            problems.push(Problem::new(
                format!("{at}.choices"),
                format!("has {} choices; a poll has 2 to 4", poll.choices.len()),
            ));
        }
        for (i, c) in poll.choices.iter().enumerate() {
            if c.trim().is_empty() {
                problems.push(Problem::new(format!("{at}.choices[{i}]"), "is empty"));
            }
            if c.chars().count() > 25 {
                problems.push(Problem::new(
                    format!("{at}.choices[{i}]"),
                    "is longer than X's 25-character poll choice limit",
                ));
            }
        }
        if let Some(votes) = &poll.votes {
            if votes.len() != poll.choices.len() {
                problems.push(Problem::new(
                    format!("{at}.votes"),
                    format!(
                        "has {} entries for {} choices",
                        votes.len(),
                        poll.choices.len()
                    ),
                ));
            }
        }
    }

    // One walk down `quote`, to `max_quote_depth`. The depth of `post.quote` is
    // 1 and of `post.quote.quote` is 2; at the cap the *next* quote is refused,
    // and the problem names its path (`post.quote.quote.quote`).
    if let Some(quote) = &post.quote {
        let child = depth + 1;
        if child > limits.max_quote_depth {
            problems.push(Problem::new(
                format!("{path}.quote"),
                format!(
                    "is quote depth {child}; X shows at most {} level(s) of quoting",
                    limits.max_quote_depth
                ),
            ));
        } else {
            validate_post_body(
                quote,
                &format!("{path}.quote"),
                child,
                limits,
                problems,
                totals,
            );
        }
    }
}

/// A byte is a base64 digit (the standard alphabet, no URL-safe variants).
///
/// A 256-entry table rather than `ALPHABET.contains(b)`: that linear scan over
/// 64 bytes per input byte is O(64n), and on a post with four 1.8 MB images it
/// cost 280 ms of validation alone — which made `explain` look like it was
/// decoding pixels. It was not; it was scanning them twice.
const fn base64_table() -> [bool; 256] {
    let mut t = [false; 256];
    let mut i = 0;
    while i < 256 {
        let b = i as u8;
        t[i] = b.is_ascii_alphanumeric() || b == b'+' || b == b'/';
        i += 1;
    }
    t
}

static BASE64_DIGIT: [bool; 256] = base64_table();

/// How much of an image payload validation looks at.
///
/// Checking the base64 of every image in full is O(image bytes), which is time
/// spent on a decision the decoder makes anyway: `paint::decode_image` rejects
/// anything that is not really a PNG, JPEG or WebP, and the renderer turns that
/// into a placeholder plus a warning. Validation therefore checks the length
/// arithmetic (exact, O(1)) and the first few kilobytes (enough to catch a
/// truncated string, a JSON array pasted by mistake, or a `data:` URL with the
/// wrong encoding) and leaves the rest to the decoder. The result: a post with
/// four 1.8 MB images validates in microseconds instead of milliseconds.
const BASE64_VALIDATE_PREFIX: usize = 4096;

/// Strips an optional `data:...;base64,` prefix.
fn base64_payload(s: &str) -> &str {
    let s = s.trim();
    s.strip_prefix("data:")
        .and_then(|rest| rest.split_once(',').map(|(_, d)| d))
        .unwrap_or(s)
}

/// Validates the shape of a base64 string and returns the decoded length.
///
/// Checks, all in bounded time:
/// - the length is a multiple of 4 (so `length * 3 / 4` is meaningful),
/// - there are at most two `=` and only at the end,
/// - the first [`BASE64_VALIDATE_PREFIX`] bytes are in the standard alphabet.
fn scan_base64(s: &str) -> Result<usize, String> {
    let data = base64_payload(s);
    if !data.len().is_multiple_of(4) {
        return Err(format!(
            "is not valid base64: length {} is not a multiple of 4",
            data.len()
        ));
    }
    let bytes = data.as_bytes();
    let padding = bytes.iter().rev().take_while(|&&b| b == b'=').count();
    if padding > 2 {
        return Err("is not valid base64: too much padding".to_string());
    }
    let digits = &bytes[..bytes.len() - padding];
    let prefix = &digits[..digits.len().min(BASE64_VALIDATE_PREFIX)];
    if let Some(i) = prefix.iter().position(|&b| !BASE64_DIGIT[b as usize]) {
        return Err(format!(
            "is not valid base64: unexpected byte at offset {i} (expected standard base64, no data: URL prefix needed)"
        ));
    }
    Ok(digits.len() / 4 * 3 + (digits.len() % 4).saturating_sub(1))
}

/// Decoded length of a base64 string, in O(1). `0` for an unusable string;
/// `validate` reports the error separately.
fn base64_len(s: &str) -> usize {
    let data = base64_payload(s);
    if !data.len().is_multiple_of(4) {
        return 0;
    }
    let padding = data
        .bytes()
        .rev()
        .take(2)
        .take_while(|&b| b == b'=')
        .count();
    data.len() / 4 * 3 - padding
}

fn check_base64(s: &str) -> Result<(), String> {
    scan_base64(s).map(|_| ())
}

/// Checks a `sheet` request before any work is done.
pub fn validate_sheet(
    widths: &[f32],
    themes: &[Theme],
    limits: &Limits,
) -> Result<(), Vec<Problem>> {
    let mut problems = Vec::new();
    if widths.is_empty() {
        problems.push(Problem::new("widths", "is empty; pass at least one width"));
    }
    if themes.is_empty() {
        problems.push(Problem::new(
            "themes",
            "is empty; pass at least one of light, dark",
        ));
    }
    let cells = widths.len().saturating_mul(themes.len());
    if cells > limits.max_sheet_cells {
        problems.push(Problem::new(
            "widths × themes",
            format!(
                "asks for {cells} cells; the limit is {}",
                limits.max_sheet_cells
            ),
        ));
    }
    for (i, w) in widths.iter().enumerate() {
        if !w.is_finite() || *w < limits.min_width || *w > limits.max_width {
            problems.push(Problem::new(
                format!("widths[{i}]"),
                format!(
                    "is {w}; the accepted range is {} to {} CSS pixels",
                    limits.min_width, limits.max_width
                ),
            ));
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// A refused JSON document, with the position and field that caused it.
#[derive(Clone, Debug)]
pub struct InputError {
    pub what: &'static str,
    pub message: String,
}

impl fmt::Display for InputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid {}: {}", self.what, self.message)
    }
}

impl std::error::Error for InputError {}

/// Parses a `Post` from JSON.
///
/// Unknown fields are **refused**, not ignored: a typo (`"auther"`, or the
/// serde spelling `"created_at"` instead of `"createdAt"`) would otherwise
/// silently render a default author or a "now" timestamp, and a preview that
/// quietly ignores half of what the caller sent is worse than one that refuses
/// it. The error names each offending field and, when it can tell, the field it
/// meant, including the snake_case-to-camelCase case.
pub fn parse_post(json: &str) -> Result<Post, InputError> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| InputError {
        what: "post JSON",
        message: format!("{e}{}", hint_for_syntax(&e.to_string())),
    })?;
    post_from_value(value)
}

/// [`parse_post`], from an already-parsed JSON value. The WASM and Node
/// wrappers handle a whole request object, so they hand the `post` member over
/// without re-serializing it.
pub fn post_from_value(value: serde_json::Value) -> Result<Post, InputError> {
    let mut bad = Vec::new();
    unknown_fields_in(
        &value,
        &Shape {
            fields: POST_FIELDS,
            map_values: None,
            array_items: None,
        },
        "",
        &mut bad,
    );
    if !bad.is_empty() {
        return Err(InputError {
            what: "post",
            message: if bad.len() == 1 {
                format!(
                    "{} (unknown fields are refused, so a typo cannot silently change the preview)",
                    bad[0]
                )
            } else {
                format!(
                    "{} unknown fields, none of which are part of the post:\n  {}",
                    bad.len(),
                    bad.join("\n  ")
                )
            },
        });
    }
    serde_json::from_value(value).map_err(|e| InputError {
        what: "post",
        message: serde_context(&e),
    })
}

/// Parses `RenderOptions` from JSON, filling in defaults for absent fields.
/// Same strictness as [`parse_post`]: unknown option keys are refused.
pub fn parse_options(json: &str) -> Result<RenderOptions, InputError> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| InputError {
        what: "options JSON",
        message: format!("{e}{}", hint_for_syntax(&e.to_string())),
    })?;
    options_from_value(value)
}

/// [`parse_options`], from an already-parsed JSON value.
pub fn options_from_value(value: serde_json::Value) -> Result<RenderOptions, InputError> {
    let mut bad = Vec::new();
    unknown_fields_in(
        &value,
        &Shape {
            fields: OPTIONS_FIELDS,
            map_values: None,
            array_items: None,
        },
        "",
        &mut bad,
    );
    if !bad.is_empty() {
        return Err(InputError {
            what: "options",
            message: bad.join("; "),
        });
    }
    serde_json::from_value(value).map_err(|e| InputError {
        what: "options",
        message: serde_context(&e),
    })
}

/// The fields of each object in the input, camelCase as the wire format spells
/// them. Unknown keys are an error, not a note: a mistyped `created_at` used to
/// render "now" without complaint, and a preview that silently ignores half of
/// what the caller sent is worse than one that refuses it.
struct Shape {
    /// Object where every key must be one of `fields`.
    fields: &'static [&'static str],
    /// Object used as a map (URL to card metadata): its keys are data, so only
    /// the values are checked.
    map_values: Option<&'static [&'static str]>,
    /// Array of objects with these fields.
    array_items: Option<&'static [&'static str]>,
}

const POST_FIELDS: &[&str] = &[
    "text",
    "author",
    "media",
    "links",
    "entityLabels",
    "cardState",
    "quote",
    "poll",
    "createdAt",
    "now",
    "counts",
    "longPost",
    "longPostBody",
    "appVersion",
    "replyTo",
    "replyToHandle",
    "socialContext",
    "mediaTags",
];
const AUTHOR_FIELDS: &[&str] = &[
    "name",
    "handle",
    "verified",
    "avatar",
    "squareAvatar",
    "protected",
    "affiliate",
];
const AFFILIATE_FIELDS: &[&str] = &["name", "badge"];
const MEDIA_FIELDS: &[&str] = &[
    "kind",
    "width",
    "height",
    "alt",
    "data",
    "duration",
    "sourceAuthor",
];
const LINK_FIELDS: &[&str] = &["card", "title", "description", "domain", "image", "display"];
const IMAGE_FIELDS: &[&str] = &["width", "height", "data"];
const POLL_FIELDS: &[&str] = &["choices", "votes", "secondsLeft"];
const COUNTS_FIELDS: &[&str] = &["replies", "reposts", "likes", "views", "bookmarks"];
const OPTIONS_FIELDS: &[&str] = &["surface", "width", "theme", "dpr", "fontScale", "expanded"];

/// Walks the request and collects every unknown key, with a suggestion.
fn unknown_fields_in(value: &serde_json::Value, shape: &Shape, path: &str, out: &mut Vec<String>) {
    if let serde_json::Value::Object(obj) = value {
        if shape.fields.is_empty() {
            // A map: keys are data (a URL), values are objects.
            if let Some(item_fields) = shape.map_values {
                for (key, v) in obj {
                    let child = format!("{path}[{key:?}]");
                    unknown_fields_in(
                        v,
                        &Shape {
                            fields: item_fields,
                            map_values: None,
                            array_items: None,
                        },
                        &child,
                        out,
                    );
                }
            }
            return;
        }
        for (key, v) in obj {
            let child = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            if !shape.fields.contains(&key.as_str()) {
                out.push(match closest(key, shape.fields) {
                    Some(s) => format!("unknown field `{child}`; did you mean `{s}`?"),
                    None => format!(
                        "unknown field `{child}`; the accepted fields are: {}",
                        shape.fields.join(", ")
                    ),
                });
                continue;
            }
            // Descend into the fields that have a shape of their own.
            let nested = match key.as_str() {
                "author" | "sourceAuthor" => Some(&Shape {
                    fields: AUTHOR_FIELDS,
                    map_values: None,
                    array_items: None,
                }),
                "affiliate" => Some(&Shape {
                    fields: AFFILIATE_FIELDS,
                    map_values: None,
                    array_items: None,
                }),
                "counts" => Some(&Shape {
                    fields: COUNTS_FIELDS,
                    map_values: None,
                    array_items: None,
                }),
                "poll" => Some(&Shape {
                    fields: POLL_FIELDS,
                    map_values: None,
                    array_items: None,
                }),
                "links" => Some(&Shape {
                    fields: &[],
                    map_values: Some(LINK_FIELDS),
                    array_items: None,
                }),
                "image" => Some(&Shape {
                    fields: IMAGE_FIELDS,
                    map_values: None,
                    array_items: None,
                }),
                "media" => Some(&Shape {
                    fields: &[],
                    map_values: None,
                    array_items: Some(MEDIA_FIELDS),
                }),
                "quote" => Some(&Shape {
                    fields: POST_FIELDS,
                    map_values: None,
                    array_items: None,
                }),
                _ => None,
            };
            if let Some(nested) = nested {
                if let Some(items) = nested.array_items {
                    if let serde_json::Value::Array(arr) = v {
                        for (i, item) in arr.iter().enumerate() {
                            let child = format!("{child}[{i}]");
                            unknown_fields_in(
                                item,
                                &Shape {
                                    fields: items,
                                    map_values: None,
                                    array_items: None,
                                },
                                &child,
                                out,
                            );
                        }
                    }
                } else {
                    unknown_fields_in(v, nested, &child, out);
                }
            }
        }
    }
}

/// An unknown key hint that also names the camelCase spelling: the most common
/// mistake is a caller writing the Rust/serde field name (`created_at`) instead
/// of the wire name (`createdAt`).
fn closest<'a>(key: &str, known: &[&'a str]) -> Option<&'a str> {
    if let Some(camel) = snake_to_camel(key) {
        if let Some(hit) = known.iter().find(|k| **k == camel) {
            return Some(hit);
        }
    }
    let lower = key.to_ascii_lowercase();
    known
        .iter()
        .map(|k| (*k, distance(&lower, &k.to_ascii_lowercase())))
        .filter(|(k, d)| *d <= 2 && *d < k.len())
        .min_by_key(|(_, d)| *d)
        .map(|(k, _)| k)
}

/// `created_at` -> `createdAt`. `None` when the key has no underscore, since
/// there is nothing to convert.
fn snake_to_camel(key: &str) -> Option<String> {
    if !key.contains('_') {
        return None;
    }
    let mut out = String::with_capacity(key.len());
    let mut upper = false;
    for c in key.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    Some(out)
}

fn distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// Turns serde's enum errors into advice a caller can act on.
fn serde_context(e: &serde_json::Error) -> String {
    let msg = e.to_string();
    if msg.contains("unknown variant") {
        format!("{msg} (valid values are listed above; surfaces are `web-timeline` and `web-detail`, themes are `light` and `dark`)")
    } else if msg.contains("invalid type") {
        format!("{msg} (check the field named above; numbers must be JSON numbers, not strings)")
    } else {
        msg
    }
}

fn hint_for_syntax(msg: &str) -> String {
    if msg.contains("EOF") || msg.contains("end of input") {
        "; the document ends early, likely an unclosed brace, bracket or string".to_string()
    } else if msg.contains("trailing characters") {
        "; the document has more than one JSON value".to_string()
    } else {
        String::new()
    }
}

/// A short description of the limits, for `--help` and error footers.
pub fn summary(limits: &Limits) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "text {} chars / {} bytes",
        limits.max_text_chars, limits.max_text_bytes
    ));
    s.push_str(&format!(", media {}", limits.max_media));
    s.push_str(&format!(
        ", image {} bytes / {} px {}×{}",
        limits.max_image_bytes,
        limits.max_image_pixels,
        limits.max_image_dimension,
        limits.max_image_dimension
    ));
    s.push_str(&format!(", output {} px", limits.max_output_pixels));
    s
}

/// The surfaces a report may claim (PLAN.md §5). Kept here so wrappers and
/// tests agree on the list; `rules::decide` fills the actual values.
pub fn default_surfaces() -> Vec<Surface> {
    vec![Surface::WebTimeline, Surface::WebDetail]
}

/// Maps a `Surface` to the text size X uses on it, in CSS pixels: 15/20 in the
/// timeline, 17/24 on the detail page (PLAN.md §3).
pub fn surface_type(surface: Surface, font_scale: f32) -> (f32, f32) {
    let scale = if font_scale.is_finite() && font_scale > 0.0 {
        font_scale
    } else {
        1.0
    };
    match surface {
        Surface::WebTimeline => (15.0 * scale, 20.0 * scale),
        Surface::WebDetail => (17.0 * scale, 24.0 * scale),
        Surface::IosTimeline => (15.5 * scale, (62.0 / 3.0) * scale),
        Surface::IosDetail => (17.0 * scale, 23.0 * scale),
    }
}

/// Counts the fields a caller is likely to have gotten wrong, for the
/// `xeet explain` summary line. Cheap and total.
pub fn post_shape(post: &Post) -> BTreeMap<&'static str, usize> {
    let mut m = BTreeMap::new();
    m.insert("media", post.media.len());
    m.insert("links", post.links.len());
    m.insert(
        "media_with_bytes",
        post.media.iter().filter(|m| m.data.is_some()).count(),
    );
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Author, Media, MediaKind};

    fn opts(width: f32, dpr: f32) -> RenderOptions {
        RenderOptions {
            width,
            dpr,
            ..RenderOptions::default()
        }
    }

    fn text_post(n: usize) -> Post {
        Post {
            text: "a".repeat(n),
            author: Author {
                name: "Vercel".into(),
                handle: "vercel".into(),
                ..Author::default()
            },
            ..Post::default()
        }
    }

    #[test]
    fn a_normal_post_passes() {
        let p = text_post(280);
        assert!(validate(&p, &opts(390.0, 3.0), &Limits::standard()).is_ok());
    }

    #[test]
    fn long_post_over_text_limit_is_refused_non_panicking() {
        // Two limits, two error paths.
        let mut l = Limits::standard();
        l.max_text_chars = 1000;
        let err = validate(&text_post(1001), &opts(390.0, 2.0), &l).unwrap_err();
        assert!(err
            .iter()
            .any(|p| p.path == "post.text" && p.message.contains("1001")));
        let mut l = Limits::standard();
        l.max_text_bytes = 500;
        let err = validate(&text_post(501), &opts(390.0, 2.0), &l).unwrap_err();
        assert!(err.iter().any(|p| p.message.contains("bytes")));
    }

    #[test]
    fn too_many_media_is_refused() {
        let mut p = text_post(10);
        p.media = (0..21)
            .map(|_| Media {
                width: 100,
                height: 100,
                ..Media::default()
            })
            .collect();
        let err = validate(&p, &opts(390.0, 2.0), &Limits::standard()).unwrap_err();
        assert!(err
            .iter()
            .any(|e| e.path == "post.media" && e.message.contains("21")));
    }

    #[test]
    fn mixed_media_is_accepted_because_real_posts_have_it() {
        // A quoted post in the captured corpus has two images and a video; X
        // rendered it, so refusing it would make a real preview impossible.
        let mut p = text_post(10);
        p.media = vec![
            Media {
                kind: MediaKind::Image,
                width: 100,
                height: 100,
                ..Media::default()
            },
            Media {
                kind: MediaKind::Image,
                width: 100,
                height: 100,
                ..Media::default()
            },
            Media {
                kind: MediaKind::Video,
                width: 100,
                height: 100,
                ..Media::default()
            },
        ];
        let problems = validate(&p, &opts(390.0, 2.0), &Limits::standard());
        assert!(problems.is_ok(), "{problems:?}");
    }

    #[test]
    fn output_area_is_checked_with_dpr() {
        let l = Limits::standard();
        assert!(l.check_output(390.0, 400.0, 3.0).is_ok());
        // 1200 CSS px at 4× is 4800 device px wide: over the 8192-wide cap? no,
        // but 20000 tall is.
        assert_eq!(
            l.check_output(390.0, 20_000.0, 3.0).unwrap_err().code,
            "output_too_large"
        );
        let mut l = Limits::standard();
        l.max_output_pixels = 1000;
        assert_eq!(
            l.check_output(100.0, 100.0, 3.0).unwrap_err().code,
            "output_pixels_exceeded"
        );
        assert_eq!(
            l.check_output(f32::NAN, 100.0, 1.0).unwrap_err().code,
            "output_invalid"
        );
    }

    #[test]
    fn image_caps_cover_dimension_area_and_bytes() {
        let l = Limits::standard();
        assert!(l.check_image_dimensions(1200, 630, "the image").is_ok());
        assert_eq!(
            l.check_image_dimensions(0, 10, "the image")
                .unwrap_err()
                .code,
            "image_dimensions_invalid"
        );
        assert_eq!(
            l.check_image_dimensions(9000, 10, "the image")
                .unwrap_err()
                .code,
            "image_too_large"
        );
        // The pixel cap is the dimension cap squared, so at the shipped policy
        // an oversized image is caught by the dimension check; the pixel check
        // is defence in depth for a policy that raises one without the other.
        assert!(l.check_image_dimensions(8000, 8000, "the image").is_ok());
        let mut small = Limits::standard();
        small.max_image_pixels = 10_000;
        assert_eq!(
            small
                .check_image_dimensions(200, 200, "the image")
                .unwrap_err()
                .code,
            "image_pixels_exceeded"
        );
        assert_eq!(
            l.check_image_bytes(l.max_image_bytes + 1, "the image")
                .unwrap_err()
                .code,
            "image_bytes_exceeded"
        );
    }

    #[test]
    fn budget_is_deterministic_and_enforced() {
        let l = Limits::standard();
        let p = text_post(280);
        let o = opts(390.0, 3.0);
        let a = l.budget_for(&p, &o, 412.0);
        let b = l.budget_for(&p, &o, 412.0);
        assert_eq!(a.granted(), b.granted());
        assert!(a.granted() > 0);
        let mut budget = a;
        assert!(budget.charge(a.granted(), "layout").is_ok());
        assert_eq!(
            budget.charge(1, "layout").unwrap_err().code,
            "work_budget_exceeded"
        );
        // A pathological input gets no more than the ceiling.
        let mut l = Limits::standard();
        l.work_base = l.work_ceiling;
        assert_eq!(
            l.budget_for(&text_post(25_000), &o, 1e6).granted(),
            l.work_ceiling
        );
    }

    /// A media object with `data` bytes (valid base64) and the given size.
    fn media_with(width: u32, height: u32, data: Option<&str>) -> crate::model::Media {
        crate::model::Media {
            width,
            height,
            data: data.map(|d| d.to_string()),
            ..crate::model::Media::default()
        }
    }

    /// Depth 1 (`post.quote`) and depth 2 (`post.quote.quote`) render; the third
    /// level is refused, and the problem names where it sits.
    #[test]
    fn quote_depth_allows_two_levels_and_refuses_the_third() {
        let l = Limits::standard();
        let o = opts(390.0, 2.0);

        let mut one = text_post(5);
        one.quote = Some(Box::new(text_post(5)));
        assert!(
            validate(&one, &o, &l).is_ok(),
            "a quoted post is depth 1: {:?}",
            validate(&one, &o, &l).err()
        );

        let mut two = text_post(5);
        let mut inner = text_post(5);
        inner.quote = Some(Box::new(text_post(5)));
        two.quote = Some(Box::new(inner));
        assert!(
            validate(&two, &o, &l).is_ok(),
            "a quote of a quote is depth 2: {:?}",
            validate(&two, &o, &l).err()
        );

        let mut three = text_post(5);
        let mut mid = text_post(5);
        let mut leaf = text_post(5);
        leaf.quote = Some(Box::new(text_post(5)));
        mid.quote = Some(Box::new(leaf));
        three.quote = Some(Box::new(mid));
        let err = validate(&three, &o, &l).unwrap_err();
        assert_eq!(err.len(), 1, "{err:?}");
        assert_eq!(err[0].path, "post.quote.quote.quote");
        assert!(
            err[0].message.contains("depth 3"),
            "the message says which depth: {:?}",
            err[0]
        );
    }

    /// The per-request caps are for the whole tree: a quote's images count
    /// against the same budget as the post's own.
    #[test]
    fn image_totals_sum_across_nested_quotes() {
        let o = opts(390.0, 2.0);

        // Pixels: two 4×4 images are 32, one is 16.
        let mut l = Limits::standard();
        l.max_image_pixels_total = 20;
        let mut quoted = text_post(5);
        quoted.media = vec![media_with(4, 4, None)];
        let mut root = text_post(5);
        root.media = vec![media_with(4, 4, None)];
        root.quote = Some(Box::new(quoted));
        let err = validate(&root, &o, &l).unwrap_err();
        assert!(
            err.iter()
                .any(|p| p.path == "post" && p.message.contains("32 pixels")),
            "{err:?}"
        );
        let mut alone = text_post(5);
        alone.media = vec![media_with(4, 4, None)];
        assert!(validate(&alone, &o, &l).is_ok(), "16 pixels is under 20");

        // Bytes: 3 + 3 decoded bytes against a 4-byte request cap.
        let mut l = Limits::standard();
        l.max_image_bytes_total = 4;
        let mut quoted = text_post(5);
        quoted.media = vec![media_with(1, 1, Some("AAAA"))];
        let mut root = text_post(5);
        root.media = vec![media_with(1, 1, Some("AAAA"))];
        root.quote = Some(Box::new(quoted));
        let err = validate(&root, &o, &l).unwrap_err();
        assert!(
            err.iter()
                .any(|p| p.path == "post" && p.message.contains("6 bytes")),
            "{err:?}"
        );

        // And the shipped policy accepts a deep pair of real-sized photos.
        let mut quoted = text_post(5);
        quoted.media = vec![media_with(6000, 6000, None)];
        let mut root = text_post(5);
        root.media = vec![media_with(6000, 6000, None)];
        root.quote = Some(Box::new(quoted));
        assert!(
            validate(&root, &o, &Limits::standard()).is_ok(),
            "72 MP across two quotes is under the 134 MP request cap"
        );
    }

    /// The work grant covers every level of quoting: shaping a quote's text is
    /// work, and at depth 2 there are three bodies to shape.
    #[test]
    fn the_work_budget_counts_nested_quotes() {
        let o = opts(390.0, 2.0);
        let l = Limits::standard();
        let bare = text_post(10);
        let mut quoted = text_post(10);
        quoted.quote = Some(Box::new(text_post(1000)));
        let mut twice = text_post(10);
        let mut mid = text_post(10);
        mid.quote = Some(Box::new(text_post(1000)));
        twice.quote = Some(Box::new(mid));

        let a = l.budget_for(&bare, &o, 100.0).granted();
        let b = l.budget_for(&quoted, &o, 100.0).granted();
        let c = l.budget_for(&twice, &o, 100.0).granted();
        assert_eq!(b - a, 1000 * l.work_per_char, "the quote's text is charged");
        // 10 (root) + 10 (the middle post) + 1000 (its quote), against 10.
        assert_eq!(
            c - a,
            1010 * l.work_per_char,
            "both nested bodies are charged"
        );

        // Media at any depth is charged too.
        let mut with_media = text_post(10);
        let mut inner = text_post(10);
        inner.media = vec![media_with(1, 1, None)];
        with_media.quote = Some(Box::new(inner));
        // The quote's 10 characters plus one media attachment.
        assert_eq!(
            l.budget_for(&with_media, &o, 100.0).granted() - a,
            10 * l.work_per_char + 10_000
        );
    }

    #[test]
    fn bad_options_are_named() {
        let p = text_post(10);
        let e = validate(&p, &opts(5.0, 9.0), &Limits::standard()).unwrap_err();
        assert!(e.iter().any(|p| p.path == "options.width"));
        assert!(e.iter().any(|p| p.path == "options.dpr"));
    }

    #[test]
    fn parse_errors_name_the_field() {
        let e = parse_post("{\"text\": 3}").unwrap_err();
        assert!(e.message.contains("invalid type"), "{}", e.message);
        let e = parse_post("{\"text\": \"hi\"").unwrap_err();
        assert!(e.message.contains("ends early"), "{}", e.message);
        // A mistyped key is an error that names the field it meant.
        let e = parse_post(r#"{"text":"hi","auther":{}}"#).unwrap_err();
        assert!(
            e.message.contains("auther") && e.message.contains("author"),
            "{}",
            e.message
        );
        let e = parse_options("{\"theme\":\"dim\"}").unwrap_err();
        assert!(e.message.contains("light"), "{}", e.message);
    }

    #[test]
    fn unknown_fields_are_errors_with_a_suggestion() {
        // The case that motivated this: `created_at` used to silently render
        // "now", because serde ignores what it does not know.
        let e = parse_post(r#"{"text":"hi","created_at":"2026-01-01T00:00:00Z"}"#).unwrap_err();
        assert!(e.message.contains("createdAt"), "{}", e.message);
        assert!(
            e.message.contains("unknown field `created_at`"),
            "{}",
            e.message
        );

        // Nested, in every struct that has one.
        for (json, expected) in [
            (
                r#"{"text":"hi","author":{"screen_name":"x"}}"#,
                "author.screen_name",
            ),
            (
                r#"{"text":"hi","media":[{"width":1,"height":1,"alt_text":"x"}]}"#,
                "media[0].alt_text",
            ),
            (
                r#"{"text":"hi","poll":{"choices":["a","b"],"seconds_left":5}}"#,
                "poll.seconds_left",
            ),
            (
                r#"{"text":"hi","counts":{"reply_count":1}}"#,
                "counts.reply_count",
            ),
            (
                r#"{"text":"hi","links":{"https://a.b":{"card_uri":"x"}}}"#,
                "links",
            ),
            (
                r#"{"text":"hi","quote":{"text":"q","created_at":"x"}}"#,
                "quote.created_at",
            ),
            (
                r#"{"text":"hi","author":{"affiliate":{"display_name":"x"}}}"#,
                "affiliate.display_name",
            ),
        ] {
            let e = parse_post(json).unwrap_err();
            assert!(e.message.contains(expected), "{json} → {}", e.message);
        }

        // `links` is a map: URL keys are data, not field names.
        assert!(
            parse_post(r#"{"text":"hi","links":{"https://a.b/c?d=e":{"card":"summary"}}}"#).is_ok()
        );

        // Options too, including the snake_case hint.
        let e = parse_options(r#"{"font_scale":1.2}"#).unwrap_err();
        assert!(e.message.contains("fontScale"), "{}", e.message);
        assert!(parse_options(r#"{"width":390,"theme":"dark"}"#).is_ok());

        // Several mistakes at once are all reported.
        let e = parse_post(r#"{"text":"hi","auther":{},"polls":{}}"#).unwrap_err();
        assert!(e.message.contains("2 unknown fields"), "{}", e.message);

        // Every field the schema publishes is accepted: no false positives.
        let full = r#"{
            "text":"hi","author":{"name":"A","handle":"a","verified":"blue","avatar":null,
              "squareAvatar":false,"protected":false,"affiliate":{"name":"Org","badge":null}},
            "media":[{"kind":"image","width":10,"height":10,"alt":"x","data":null,"duration":null}],
            "links":{"https://a.b":{"card":"summary","title":"t","description":"d","domain":"a.b",
              "image":{"width":1,"height":1,"data":null}}},
            "cardState":"auto","quote":null,
            "poll":{"choices":["a","b"],"votes":[1,2],"secondsLeft":3},
            "createdAt":null,"now":null,
            "counts":{"replies":1,"reposts":2,"likes":3,"views":4,"bookmarks":5},
            "longPost":false,"longPostBody":null,"appVersion":null,"replyTo":null,"replyToHandle":null,
            "mediaTags":["A"],"entityLabels":{"@Bot":"@bot"},"socialContext":"pinned"
        }"#;
        parse_post(full).unwrap_or_else(|e| panic!("the full schema must parse: {e}"));
    }

    #[test]
    fn base64_length_and_validity() {
        assert_eq!(base64_len("AAAA"), 3);
        assert_eq!(base64_len("AAA="), 2);
        assert_eq!(base64_len("AA=="), 1);
        assert_eq!(base64_len("data:image/png;base64,AAAA"), 3);
        assert!(check_base64("AAA=").is_ok());
        assert!(check_base64("AA!A").is_err());
        assert!(check_base64("AAA").is_err());
    }

    #[test]
    fn social_context_round_trips_and_its_typo_is_caught() {
        let post = parse_post(r#"{"text":"hi","socialContext":"pinned"}"#).unwrap();
        assert_eq!(
            post.social_context,
            Some(crate::model::SocialContext::Pinned)
        );
        let e = parse_post(r#"{"text":"hi","social_context":"pinned"}"#).unwrap_err();
        assert!(e.message.contains("socialContext"), "{}", e.message);
    }

    #[test]
    fn snake_case_keys_map_to_their_camel_case_spelling() {
        assert_eq!(snake_to_camel("created_at").as_deref(), Some("createdAt"));
        assert_eq!(snake_to_camel("media_tags").as_deref(), Some("mediaTags"));
        assert_eq!(
            snake_to_camel("square_avatar").as_deref(),
            Some("squareAvatar")
        );
        assert_eq!(snake_to_camel("createdAt"), None);
        assert_eq!(closest("created_at", POST_FIELDS), Some("createdAt"));
        assert_eq!(closest("cratedAt", POST_FIELDS), Some("createdAt"));
        assert_eq!(closest("something_else", POST_FIELDS), None);
    }

    #[test]
    fn image_payload_validation_is_bounded_and_still_catches_garbage() {
        // 4 MB of valid base64: validation must not depend on the length, so
        // the cost here is the string's construction, not the check.
        let big = "A".repeat(4 * 1024 * 1024);
        let started = std::time::Instant::now();
        assert_eq!(base64_len(&big), 3 * 1024 * 1024);
        assert!(check_base64(&big).is_ok());
        let elapsed = started.elapsed();
        assert!(elapsed.as_millis() < 50, "validating 4 MB took {elapsed:?}");

        // A wrong length or padding is caught exactly, in O(1).
        assert!(check_base64("AAA").is_err());
        assert!(check_base64("AA===").is_err());
        assert_eq!(base64_len("AAA"), 0);
        // Garbage in the prefix is caught; garbage later is the decoder's job
        // (it becomes a placeholder with a warning, never a panic).
        assert!(check_base64("!!!=").is_err());
        let mut late = "A".repeat(8192);
        late.replace_range(8000..8001, "!");
        assert!(check_base64(&late).is_ok());
    }

    #[test]
    fn sheet_validation() {
        let l = Limits::standard();
        assert!(validate_sheet(&[390.0, 600.0], &[Theme::Light, Theme::Dark], &l).is_ok());
        assert!(validate_sheet(&[], &[Theme::Light], &l).is_err());
        let mut l = Limits::standard();
        l.max_sheet_cells = 3;
        assert!(validate_sheet(&[390.0, 600.0], &[Theme::Light, Theme::Dark], &l).is_err());
    }

    #[test]
    fn surface_type_follows_the_stylesheet() {
        assert_eq!(surface_type(Surface::WebTimeline, 1.0), (15.0, 20.0));
        assert_eq!(surface_type(Surface::WebDetail, 1.0), (17.0, 24.0));
        assert_eq!(surface_type(Surface::WebTimeline, 1.25), (18.75, 25.0));
    }

    #[test]
    fn limits_are_wide_enough_for_the_biggest_real_post() {
        let l = Limits::standard();
        // A 25,000-character post, four 1600×900 images, at 1200 wide and 3×.
        let mut p = text_post(25_000);
        p.media = (0..4)
            .map(|_| Media {
                width: 1600,
                height: 900,
                ..Media::default()
            })
            .collect();
        assert!(validate(&p, &opts(1200.0, 3.0), &l).is_ok());
        assert!(l.check_output(1200.0, 5000.0, 3.0).is_ok());
    }
}
