//! Which image variant X's client would fetch, and the URLs for it.
//!
//! The evidence is `docs/MEDIA.md`: X's server render carries a `srcset` with
//! `name=small 680w`, `name=medium 1200w`, `name=large 2048w` and lets the
//! browser pick against the slot's CSS width × the device pixel ratio; avatars
//! use a 48px `_normal 1x, _x96 2x, _reasonably_small 3x` set; video posters are
//! the same CDN under `amplify_video_thumb/…/img/…`. Never the original: a
//! payload's `original_info` can be 8192×5464, which would break `limits.rs` and
//! cost megabytes per resolve.

/// X publishes these three widths for post media, in device pixels.
pub const VARIANTS: [(&str, u32); 3] = [("small", 680), ("medium", 1200), ("large", 2048)];

/// The avatar size X's 48px `<img>` srcset picks per dpr.
pub const AVATAR_VARIANTS: [&str; 3] = ["_normal", "_x96", "_reasonably_small"];

/// What those three variants are, in pixels: X's own srcset steps.
pub const AVATAR_WIDTHS: [u32; 3] = [48, 96, 128];

/// A quoted post's avatar in X's *compact* form: `size-4`, 16 px
/// (`cards/quote.rs` `AVATAR_COMPACT`; `nested-quote-preview-SIs_tkfq` draws the
/// same class one level in).
pub const AVATAR_COMPACT_CSS: f32 = 16.0;

/// The frame draws avatars at 40 CSS px (`ImageRef::Avatar` in xeet-core).
pub const AVATAR_CSS: f32 = 40.0;

/// How the media sits in the cell: the grid (post media) or a quote's card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    Grid,
    Quote,
}

/// The rendered slot width of one media cell, in CSS pixels.
///
/// Reproduces the `sizes` attributes X's markup carries for the layouts that
/// matter: one item fills the cell's content column, two and four share it
/// across the 4px gap (`cards/media.rs` `GAP`), three keep a wide left tile, and
/// a quote's media sits in the quote card at ~80% of the column.
pub fn slot_width(count: usize, content_width: f32, layout: Layout) -> f32 {
    match layout {
        Layout::Quote => content_width * 0.8,
        Layout::Grid => match count {
            0 | 1 => content_width,
            3 => (content_width - 4.0) * 0.6,
            _ => (content_width - 4.0) / 2.0,
        },
    }
}

/// The variant name covering `slot_css × dpr`: the smallest one that fits, else
/// the largest X publishes.
pub fn variant_for(slot_css: f32, dpr: f32) -> &'static str {
    let needed = slot_css * dpr;
    for (name, width) in VARIANTS {
        if needed <= width as f32 {
            return name;
        }
    }
    VARIANTS[VARIANTS.len() - 1].0
}

/// `…/media/ID.jpg` + `small` → `…/media/ID?format=jpg&name=small`.
///
/// Only for `pbs.twimg.com`: another host's URL is left exactly as written (a
/// fixture, a card image X already sized).
pub fn variant_url(base: &str, variant: &str) -> Option<String> {
    let url = crate::urlsafety::Url::parse(base)?;
    if url.host != "pbs.twimg.com" {
        return Some(base.to_string());
    }
    let path = url.path.trim_end_matches([',', ' ']);
    let path = path
        .strip_suffix(".jpg")
        .or_else(|| path.strip_suffix(".jpeg"))
        .or_else(|| path.strip_suffix(".png"))
        .or_else(|| path.strip_suffix(".webp"))
        .unwrap_or(path);
    let mut query: Vec<String> = url
        .query
        .as_deref()
        .map(|query| {
            query
                .split('&')
                .filter(|pair| !pair.is_empty())
                .filter(|pair| !pair.starts_with("format=") && !pair.starts_with("name="))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    query.push("format=jpg".to_string());
    query.push(format!("name={variant}"));
    Some(format!(
        "{}://{}{}?{}",
        url.scheme,
        if url.host.contains(':') {
            format!("[{}]", url.host)
        } else {
            url.host.clone()
        },
        path,
        query.join("&")
    ))
}

/// The avatar URL for a dpr, from `…/profile_images/<id>/<hash>_normal.jpg`.
pub fn avatar_url(base: &str, dpr: f32) -> Option<String> {
    avatar_url_for(base, avatar_variant_for(AVATAR_CSS, dpr))
}

/// The variant covering `css_px × dpr`, from X's own steps: 48 px (`_normal`),
/// 96 (`_x96`), 128 (`_reasonably_small`).
///
/// A 40 px cell avatar lands on `_normal`/`_x96`/`_reasonably_small` at dpr
/// 1/2/3 — exactly `avatar_url`'s old table — and a 16 px nested-quote avatar
/// stays `_normal` all the way to dpr 3 (16 × 3 = 48).
pub fn avatar_variant_for(css_px: f32, dpr: f32) -> &'static str {
    let needed = css_px * dpr.clamp(1.0, 3.0);
    for (index, width) in AVATAR_WIDTHS.iter().enumerate() {
        if needed <= *width as f32 {
            return AVATAR_VARIANTS[index];
        }
    }
    AVATAR_VARIANTS[AVATAR_VARIANTS.len() - 1]
}

/// `avatar_url` for a variant that is already chosen.
pub fn avatar_url_for(base: &str, variant: &str) -> Option<String> {
    let suffixes = [
        "_normal",
        "_bigger",
        "_mini",
        "_x96",
        "_reasonably_small",
        "_200x200",
        "_400x400",
    ];
    let extensions = [".jpg", ".jpeg", ".png", ".webp"];
    for suffix in suffixes {
        for extension in extensions {
            let needle = format!("{suffix}{extension}");
            if let Some(stem) = base.strip_suffix(&needle) {
                return Some(format!("{stem}{variant}{extension}"));
            }
        }
    }
    // A profile image with no size suffix: ask the CDN for one.
    let url = crate::urlsafety::Url::parse(base)?;
    if url.host != "pbs.twimg.com" {
        return Some(base.to_string());
    }
    let size = match variant {
        "_reasonably_small" => "128x128",
        "_x96" => "96x96",
        _ => "48x48",
    };
    Some(format!("{}?name={size}", url.href()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTENT_600: f32 = 568.0;
    const CONTENT_382: f32 = 350.0;

    #[test]
    fn slots_follow_xs_sizes() {
        assert_eq!(slot_width(1, CONTENT_600, Layout::Grid), 568.0);
        assert_eq!(slot_width(2, CONTENT_600, Layout::Grid), 282.0);
        assert_eq!(slot_width(4, CONTENT_600, Layout::Grid), 282.0);
        assert!((slot_width(3, CONTENT_600, Layout::Grid) - 338.4).abs() < 0.01);
        assert!((slot_width(1, CONTENT_600, Layout::Quote) - 454.4).abs() < 0.01);
    }

    #[test]
    fn variants_cover_the_duo_presets() {
        // 382 closed at 3x, and the 600 column at 3x, are the demanding ones.
        assert_eq!(
            variant_for(slot_width(1, CONTENT_382, Layout::Grid), 3.0),
            "medium"
        );
        assert_eq!(
            variant_for(slot_width(1, CONTENT_600, Layout::Grid), 3.0),
            "large"
        );
        assert_eq!(
            variant_for(slot_width(4, CONTENT_600, Layout::Grid), 3.0),
            "medium"
        );
        assert_eq!(
            variant_for(slot_width(4, CONTENT_382, Layout::Grid), 3.0),
            "small"
        );
        assert_eq!(
            variant_for(slot_width(1, CONTENT_600, Layout::Grid), 1.0),
            "small"
        );
        assert_eq!(
            variant_for(slot_width(1, CONTENT_600, Layout::Grid), 2.0),
            "medium"
        );
    }

    #[test]
    fn variant_urls() {
        assert_eq!(
            variant_url("https://pbs.twimg.com/media/HWncStCWYAEG1pS.jpg", "medium").unwrap(),
            "https://pbs.twimg.com/media/HWncStCWYAEG1pS?format=jpg&name=medium"
        );
        assert_eq!(
            variant_url(
                "https://pbs.twimg.com/amplify_video_thumb/1/img/x.jpg",
                "large"
            )
            .unwrap(),
            "https://pbs.twimg.com/amplify_video_thumb/1/img/x?format=jpg&name=large"
        );
        assert_eq!(
            variant_url(
                "https://pbs.twimg.com/card_img/1/x?format=jpg&name=800x419",
                "small"
            )
            .unwrap(),
            "https://pbs.twimg.com/card_img/1/x?format=jpg&name=small"
        );
        assert_eq!(
            variant_url("https://example.com/a.jpg", "small").unwrap(),
            "https://example.com/a.jpg"
        );
    }

    #[test]
    fn avatars_follow_xs_srcset() {
        let base = "https://pbs.twimg.com/profile_images/1321163587679784960/0ZxKlEKB_normal.jpg";
        assert!(avatar_url(base, 1.0).unwrap().ends_with("_normal.jpg"));
        assert!(avatar_url(base, 2.0).unwrap().ends_with("_x96.jpg"));
        assert!(avatar_url(base, 3.0)
            .unwrap()
            .ends_with("_reasonably_small.jpg"));
        assert!(avatar_url(base, 4.0)
            .unwrap()
            .ends_with("_reasonably_small.jpg"));
        assert!(
            avatar_url("https://pbs.twimg.com/profile_images/1/x.jpg", 3.0)
                .unwrap()
                .contains("128x128")
        );
    }

    #[test]
    fn display_matches_xeet_text() {
        // The display rule lives in xeet-text; this is the crawler using it.
        assert_eq!(
            crate::display_url("https://vercel.com/changelog/vercel-daemons-is-now-in-public-beta"),
            "vercel.com/changelog/verc…"
        );
    }
}
