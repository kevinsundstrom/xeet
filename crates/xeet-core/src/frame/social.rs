//! The row X draws above a cell's post: `Pinned` (and, in other contexts,
//! `@someone reposted`).
//!
//! Only `Pinned` appears in the captures, so only that is modelled; the shape
//! below is what the markup gives and what the replica measures.
//!
//! Captured markup (`F1.html`, a profile timeline, 2026-11-09), as the
//! `<article>`'s **first** child — the article is `flex flex-col gap-1`, so the
//! row is one `gap-1` (4px) above the avatar/header row:
//!
//! ```html
//! <article class="group/post flex flex-col gap-1">
//!   <div class="max-w-full text-subtext2 font-bold text-secondary flex items-center gap-2">
//!     <span class="flex w-10 shrink-0 justify-end">
//!       <svg data-icon="icon-pin-fill" class="size-4">…</svg>
//!     </span>
//!     <span>Pinned</span>
//!   </div>
//!   <div class="flex gap-2">…avatar + header…</div>
//! ```
//!
//! Geometry measured in Chrome at a 600px cell (all of it falls out of the
//! classes, which is why there are no magic numbers here):
//!
//! ```text
//! row        16 .. 584   h 16   text-subtext2 13/16, bold, text-secondary, gap-2
//! icon       40 .. 56    h 16   size-4, right-aligned in the 40px avatar column
//! "Pinned"   64 ..       h 16   starts exactly at the text column
//! main row   32 ..              row height 16 + the article's 4px gap
//! ```
//!
//! So the row is `max(16, subtext2 line-height)` tall (the icon never scales,
//! the text does), the icon's right edge is the avatar column's right edge, and
//! the label starts at the text column.

use crate::display::{Item, Rect};
use crate::inline::Wrap;
use crate::tokens;

use super::Ctx;

/// Icon size: `size-4`.
const ICON: f32 = 16.0;

/// A laid-out context row.
pub struct ContextRow {
    pub items: Vec<Item>,
    pub height: f32,
    pub row: Rect,
    pub icon: Rect,
    pub label: Rect,
}

/// The context row for `ctx.post.social_context`, or `None` when the cell has
/// none. `content_x` is the left edge of the content column (the avatar
/// column starts at the cell padding), `width` the content width.
pub(crate) fn context_row(ctx: &Ctx, content_x: f32, y: f32, width: f32) -> Option<ContextRow> {
    let context = ctx.post.social_context?;
    let style = tokens::SUBTEXT2.scaled(ctx.scale);
    let height = style.line_height.max(ICON);
    let icon_size = ICON.min(height);
    let icon = Rect::new(
        content_x - tokens::AVATAR_GAP - icon_size,
        y + (height - icon_size) / 2.0,
        icon_size,
        icon_size,
    );
    let label_text = context.label();
    let block = super::header::one_line(
        label_text,
        ctx.colors.fg_secondary,
        tokens::WEIGHT_BOLD,
        style,
        Wrap::Normal,
        false,
        f32::MAX / 4.0,
    );
    let mut items = vec![
        Item::Icon {
            name: context.icon().to_string(),
            rect: icon,
            color: ctx.colors.fg_secondary,
        },
        Item::PushClip {
            shape: crate::display::Shape::rect(Rect::new(content_x, y, width, height)),
        },
    ];
    items.extend(super::header::glyph_items(&block, content_x, y));
    items.push(Item::PopClip);
    let label = Rect::new(content_x, y, super::header::ceil64(block.width), height);
    Some(ContextRow {
        items,
        height,
        // The row spans the whole article width, starting at the cell padding
        // (its own children are the icon column and the label).
        row: Rect::new(
            content_x - tokens::AVATAR_SIZE - tokens::AVATAR_GAP,
            y,
            width + tokens::AVATAR_SIZE + tokens::AVATAR_GAP,
            height,
        ),
        icon,
        label,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Post, RenderOptions, SocialContext, Surface, Theme};

    fn ctx_for(context: Option<SocialContext>) -> (Post, RenderOptions) {
        let post = Post {
            text: "hi".to_string(),
            social_context: context,
            ..Post::default()
        };
        let opts = RenderOptions {
            surface: Surface::WebTimeline,
            width: 600.0,
            theme: Theme::Light,
            dpr: 1.0,
            font_scale: 1.0,
            expanded: false,
        };
        (post, opts)
    }

    #[test]
    fn pinned_row_geometry_matches_the_capture() {
        let (post, opts) = ctx_for(Some(SocialContext::Pinned));
        let ctx = Ctx {
            post: &post,
            opts: &opts,
            colors: tokens::LIGHT,
            scale: 1.0,
        };
        let row = context_row(&ctx, 64.0, 12.0, 520.0).expect("row");
        assert_eq!(row.height, 16.0);
        assert_eq!(
            row.icon.x, 40.0,
            "icon right-aligns in the 40px avatar column"
        );
        assert_eq!(row.icon.w, 16.0, "size-4");
        assert_eq!(row.label.x, 64.0, "label starts at the text column");
        assert!(
            row.label.w > 30.0 && row.label.w < 50.0,
            "\"Pinned\" at 13px bold"
        );
    }

    #[test]
    fn no_context_no_row() {
        let (post, opts) = ctx_for(None);
        let ctx = Ctx {
            post: &post,
            opts: &opts,
            colors: tokens::LIGHT,
            scale: 1.0,
        };
        assert!(context_row(&ctx, 64.0, 12.0, 520.0).is_none());
    }
}
