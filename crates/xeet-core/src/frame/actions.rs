//! The engagement row under a post.
//!
//! Two surfaces, two shapes, both from the captured markup:
//!
//! - **Timeline**: reply, repost, like, views as four equal columns that share
//!   the leftover width (`div.min-w-0.flex-1`), then bookmark and share packed
//!   to the right. Pills are 36px tall (`h-9`), padded 10px (`px-2.5`), with an
//!   18.75px icon (`size-[18.75px]`). Only reply, repost, like and views carry
//!   a number.
//! - **Post detail**: reply, repost, like as three equal columns, then
//!   bookmark (which *does* carry a number here) and share. Pills are 40px
//!   tall (`h-10`), padded 12px (`px-3`), 20px icons (`size-5`). There is no
//!   views column: the view count lives on the timestamp line.
//!
//! The row's own box is 20px tall (`h-5`) while the pills are 36 or 40, so the
//! pills overflow 8px above and below it; `overflow-visible` is explicit in
//! the markup. The row is also 8px wider than the content column
//! (`-mx-2`, `w-[calc(100%+16px)]`), which puts the first pill's padding flush
//! with the text column.
//!
//! At narrow widths the bookmark button disappears: the markup wraps it in
//! `@max-[290px]:hidden` under the `post-actions` container query, and the
//! container is the post itself, so the button is gone when the article is
//! 290px wide or less (measured on the replica at width 320: article 288 →
//! hidden; at 390: article 358 → shown).
//!
//! Numbers are `text-subtext2` (13/16) with `tabular-nums` inheriting
//! `text-secondary`, 4px after the icon (`ps-1`). X omits a number entirely
//! when it is zero, so a fresh post shows bare icons.

use crate::color::Rgba;
use crate::display::{Item, Rect};
use crate::inline::{self, BlockStyle, Dir, Span, TextBlock, Wrap};
use crate::model::Counts;
use crate::tokens;
use std::collections::BTreeMap;

use super::Ctx;

/// What one pill holds.
struct Pill {
    icon: &'static str,
    count: Option<u64>,
}

/// A laid-out action row.
pub struct Actions {
    pub items: Vec<Item>,
    pub height: f32,
    /// Pill boxes, icon boxes and count boxes by component name (`reply`,
    /// `retweet`, `like`, `views`, `bookmark`, `share`), for the parity harness
    /// and the report.
    pub pills: BTreeMap<&'static str, Rect>,
    pub icons: BTreeMap<&'static str, Rect>,
    pub counts: BTreeMap<&'static str, Rect>,
}

/// Lays out the action row whose left edge is `x` and vertical center is the
/// row's 20px box at `y`.
///
/// `article_width` decides whether the bookmark fits (see the module docs).
pub(crate) fn layout(ctx: &Ctx, x: f32, y: f32, row_w: f32, _article_width: f32) -> Actions {
    let detail = ctx.opts.surface.is_detail();
    let ios = ctx.opts.surface.is_ios();
    let counts = ctx.post.counts.as_ref();
    let (pill_h, pad_x, icon_size) = match (ios, detail) {
        (true, true) => (tokens::PILL_HEIGHT_DETAIL, 0.0, 18.0),
        (true, false) => (tokens::PILL_HEIGHT_TIMELINE, 0.0, 16.0),
        (false, true) => (
            tokens::PILL_HEIGHT_DETAIL,
            tokens::PILL_PADDING_X_DETAIL,
            tokens::PILL_ICON_SIZE_DETAIL,
        ),
        (false, false) => (
            tokens::PILL_HEIGHT_TIMELINE,
            tokens::PILL_PADDING_X_TIMELINE,
            tokens::PILL_ICON_SIZE_TIMELINE,
        ),
    };
    let pill_y = y + (tokens::ACTION_ROW_HEIGHT - pill_h) / 2.0;
    let icon_y = pill_y + (pill_h - icon_size) / 2.0;

    // A count of zero shows nothing, as X does.
    let of = |f: fn(&Counts) -> u64| counts.map(f).filter(|&n| n > 0);
    let mut leading = vec![
        (
            "reply",
            Pill {
                icon: "icon-reply",
                count: of(|c| c.replies),
            },
        ),
        (
            "retweet",
            Pill {
                icon: "icon-repost",
                count: of(|c| c.reposts),
            },
        ),
        (
            "like",
            Pill {
                icon: "icon-heart",
                count: of(|c| c.likes),
            },
        ),
    ];
    if !detail {
        leading.push((
            "views",
            Pill {
                icon: "icon-bar-chart",
                count: of(|c| c.views),
            },
        ));
    }
    let bookmark = Pill {
        icon: "icon-bookmark",
        count: if detail { of(|c| c.bookmarks) } else { None },
    };
    let share = Pill {
        icon: "icon-share-ios",
        count: None,
    };
    // `@max-[290px]:hidden` is evaluated against the action row's own
    // `@container` (`w-[calc(100%+16px)]` = `vw − 64`), shown iff `row_w >= 290`.
    // On iOS, all six icons sit in an equal-spacing row down to narrow widths.
    let show_bookmark = if ios {
        detail || row_w >= 220.0
    } else {
        detail || row_w >= tokens::BOOKMARK_HIDDEN_BELOW_ARTICLE_WIDTH
    };

    let count_style = ctx.subtext2_style();
    struct MeasuredPill {
        name: &'static str,
        icon: &'static str,
        w: f32,
        text: Option<(f32, TextBlock)>,
    }
    let measure = |name: &'static str, pill: &Pill| -> MeasuredPill {
        let mut w = 2.0 * pad_x + icon_size;
        let mut text = None;
        if let Some(n) = pill.count {
            let label = super::numbers::compact(n);
            // Tabular figures: `font-variant-numeric: tabular-nums` on X's
            // counts makes digits wider than the proportional default.
            let block = count_block(&label, count_style, ctx.colors.fg_secondary, f32::MAX / 4.0);
            let text_w = super::header::ceil64(block.width);
            w += tokens::COUNT_PADDING_START + text_w;
            text = Some((text_w, block));
        }
        MeasuredPill {
            name,
            icon: pill.icon,
            w,
            text,
        }
    };

    let mut out = Actions {
        items: Vec::new(),
        height: tokens::ACTION_ROW_HEIGHT,
        pills: BTreeMap::new(),
        icons: BTreeMap::new(),
        counts: BTreeMap::new(),
    };

    // Draws one already-measured pill at `px`, recording its boxes.
    let draw = |out: &mut Actions, pill: MeasuredPill, px: f32| {
        let pill_rect = Rect::new(px, pill_y, pill.w, pill_h);
        let icon = Rect::new(px + pad_x, icon_y, icon_size, icon_size);
        out.pills.insert(pill.name, pill_rect);
        out.icons.insert(pill.name, icon);
        out.items.push(Item::Icon {
            name: pill.icon.to_string(),
            rect: icon,
            color: ctx.colors.fg_secondary,
        });
        if let Some((text_w, block)) = pill.text {
            // The number's line box is centered in the pill, and the glyph box
            // inside it starts after the exact half-leading (1.5px for 13/16).
            let line_box_top = pill_y + (pill_h - count_style.line_height) / 2.0;
            let text_x = icon.x + icon.w + tokens::COUNT_PADDING_START;
            // The count element is an `inline-flex` whose own box is one em
            // tall (its inner span sets `line-height: 1em`), centered in the
            // pill; the glyph box inside it is the font's.
            let count_rect = Rect::new(
                icon.x + icon.w,
                pill_y + (pill_h - count_style.size) / 2.0,
                tokens::COUNT_PADDING_START + text_w,
                count_style.size,
            );
            out.counts.insert(pill.name, count_rect);
            out.items
                .extend(super::header::glyph_items(&block, text_x, line_box_top));
        }
    };

    if ios {
        let mut all: Vec<MeasuredPill> = leading.iter().map(|(n, p)| measure(n, p)).collect();
        if show_bookmark {
            all.push(measure("bookmark", &bookmark));
        }
        all.push(measure("share", &share));
        let used: f32 = all.iter().map(|p| p.w).sum();
        let gaps = all.len().saturating_sub(1).max(1) as f32;
        let gap = ((row_w - used) / gaps).max(4.0);
        let mut cx = x;
        for pill in all {
            let w = pill.w;
            draw(&mut out, pill, cx);
            cx += w + gap;
        }
        return out;
    }

    let measured_bookmark = show_bookmark.then(|| measure("bookmark", &bookmark));
    let measured_share = measure("share", &share);
    let right_w = measured_bookmark.as_ref().map_or(0.0, |p| p.w) + measured_share.w;
    let columns = leading.len() as f32;
    let col_w = ((row_w - right_w) / columns).max(0.0);
    for (i, (name, pill)) in leading.iter().enumerate() {
        draw(&mut out, measure(name, pill), x + i as f32 * col_w);
    }
    let mut right_x = x + col_w * columns;
    if let Some(bm) = measured_bookmark {
        let w = bm.w;
        draw(&mut out, bm, right_x);
        right_x += w;
    }
    draw(&mut out, measured_share, right_x);
    out
}

/// An engagement count ("1.2K"), laid out with tabular figures.
///
/// X puts `font-variant-numeric: tabular-nums` on counts, and tabular digits
/// are wider than proportional ones (28.25px against 25.17px for "1.2K" at
/// 13px), which is the width the captured markup has. `inline::Span::tnum`
/// carries the feature through the shared engine.
///
/// One adjustment after layout: Chrome centers the count's line box in the
/// pill and starts the glyph box at the *exact* half-leading, while `inline`
/// floors it (identical at 15/20, 0.5px off at 13/16).
fn count_block(label: &str, style: tokens::TypeStyle, color: Rgba, width: f32) -> TextBlock {
    let weight = tokens::WEIGHT_NORMAL;
    let mut block = inline::layout(
        &[Span {
            text: label.to_string(),
            color,
            weight,
            ss01: false,
            tnum: true,
            atomic: false,
            role: "count",
        }],
        &BlockStyle {
            size: style.size,
            line_height: style.line_height,
            weight,
            width: width.max(1.0),
            max_lines: Some(1),
            wrap: Wrap::Normal,
            preserve: false,
            dir: Dir::Ltr,
            tab_size: 4.0,
        },
    );
    let (ascent, descent) = crate::fonts::db()
        .primary(weight)
        .rounded_metrics(style.size);
    let leading = style.line_height - (ascent + descent);
    let exact_half = leading / 2.0;
    let floored = (leading / 2.0).floor();
    if let Some(line) = block.lines.first_mut() {
        line.top += exact_half - floored;
    }
    block
}
