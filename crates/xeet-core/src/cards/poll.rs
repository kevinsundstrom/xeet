//! Polls.
//!
//! Verified against a real poll post captured logged out
//! (`assets/vendor/corpus/poll-musk.html`: two choices, closed, "Final
//! results"). The markup is one pill per choice:
//!
//! ```html
//! <div class="-m-1 overflow-hidden"><div class="p-1">
//!   <div class="flex flex-col gap-3">                    <!-- 12 px to the footer -->
//!     <div class="flex flex-col gap-2" role="list">      <!-- 8 px between pills -->
//!       <div role="listitem">
//!         <div class="text-body relative grid rounded-full min-h-9"
//!              style="--poll-choice-share:0.575">
//!           <span class="absolute inset-0 rounded-full border border-normal"></span>
//!           <span class="absolute inset-y-0 start-0 rounded-full
//!                        w-[calc(var(--poll-choice-share)*100%)] bg-brand-wash"></span>
//!           <span class="relative grid items-center px-4 py-2
//!                        grid-cols-[0fr_fit-content(calc(100%-5rem))_0rem_1fr]">
//!             <span>Yes</span>              <!-- col 2; the `::before` takes col 1 -->
//!             <span><svg/></span>           <!-- col 3 (0rem): the voted check, hidden -->
//!             <span class="justify-self-end ps-3">57.5%</span>   <!-- col 4 -->
//!           </span>
//!         </div>
//!       </div>
//!     </div>
//!     <div class="x-middot-group text-subtext2 text-secondary">
//!       <span>17,502,391 votes</span><span>Final results</span>
//!     </div>
//!   </div>
//! </div></div>
//! ```
//!
//! Consequences measured in Chrome at 320/390/600:
//!
//! * The pill is `text-body` (15/20) with `px-4 py-2`, so a one-line choice is
//!   36 px (`min-h-9`) and the label's line box starts 8 px down, left-aligned
//!   at 16 px. A label that wraps makes the pill taller; nothing is centered.
//! * The label track is `fit-content(100% - 5rem)`: the label is capped at the
//!   content width minus 80 px and never stretches.
//! * The percentage is right-aligned 16 px from the end (`justify-self-end`,
//!   `ps-3`), one decimal, bold for the leading choice.
//! * The bar is the winner's `bg-brand-wash`, every other choice's
//!   `bg-(--x-border-active)`; the `-m-1`/`p-1` pair cancels, so the poll is
//!   flush with the attachment slot.
//! * The footer is 12 px under the last pill, `text-subtext2` (13/16) in
//!   `text-secondary`, with a middot group (`·`, 4 px padding each side).
//!
//! The open (voting) view has no capture: its markup swaps the columns to
//! `[1fr_…]`, hides the percentage and keeps `min-h-9`. This module draws the
//! choices and the footer for it, without bars or percentages.
use super::{fill, outline, paragraph, push_text, shape, Ctx, Item, Rect, Shape, BODY, SUBTEXT2};
use crate::color::Rgba;
use crate::display::CornerShape;
use crate::model::Poll;
use crate::rules::spec::format_plain_count;

/// `gap-2` between pills.
const GAP: f32 = 8.0;
/// `min-h-9`.
const ROW_MIN: f32 = 36.0;
/// `px-4`, `py-2`.
const PAD_X: f32 = 16.0;
const PAD_Y: f32 = 8.0;
/// `gap-3` between the pill list and the footer.
const FOOTER_GAP: f32 = 12.0;
/// `calc(100% - 5rem)` on the label track.
const LABEL_RESERVE: f32 = 80.0;
/// `.x-middot-group > :not(:first-child)::before { content: "·"; padding-inline: 4px }`.
const DOT_PAD: f32 = 4.0;

/// A `rounded-full` pill: the token's radius, clamped to half the box.
fn pill(rect: Rect) -> Shape {
    super::rounded(rect, crate::tokens::RADIUS_FULL_RADIUS)
}

/// Lays out the poll and returns its height.
pub(crate) fn layout(cx: &Ctx, poll: &Poll, y0: f32, out: &mut Vec<Item>) -> f32 {
    if cx.ios {
        return layout_ios(cx, poll, y0, out);
    }
    let choices: Vec<&str> = poll
        .choices
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .take(4)
        .collect();
    if choices.is_empty() {
        return 0.0;
    }
    let votes = poll.votes.as_ref();
    let counts: Vec<u64> = votes
        .map(|v| {
            (0..choices.len())
                .map(|i| v.get(i).copied().unwrap_or(0))
                .collect()
        })
        .unwrap_or_default();
    let total: u64 = counts.iter().sum();
    let results = total > 0;
    let winner = if results {
        let mut best = 0;
        for (i, &n) in counts.iter().enumerate() {
            if n > counts[best] {
                best = i;
            }
        }
        Some(best)
    } else {
        None
    };

    let content_w = (cx.width - 2.0 * PAD_X).max(1.0);
    let label_cap = (content_w - LABEL_RESERVE).max(1.0);
    let mut y = 0.0;
    for (i, label) in choices.iter().enumerate() {
        let share = if results {
            counts[i] as f32 / total as f32
        } else {
            0.0
        };
        let is_winner = results && winner == Some(i) && counts[i] > 0;

        // `DIdg36-I.js` (`function p`): `let g = m || f` (`m` = voting, `f` = isWinner) —
        // in results view only the winning choice uses the bold (`700`) layer, while
        // non-winners use regular (`400`); open polls use bold (`700`) in `text-brand`.
        let weight = if !results || is_winner { 700 } else { 400 };
        let label_color = if results { cx.p.primary } else { cx.p.brand };
        let text = paragraph(cx, label, BODY, weight, label_color, label_cap, Some(2));
        let row_h = ROW_MIN.max(text.height + 2.0 * PAD_Y);
        let row = Rect::new(0.0, y0 + y, cx.width, row_h);
        let row_pill = pill(row);

        if results && counts[i] > 0 {
            let bar_w = row.w * share;
            let color = if is_winner {
                cx.p.poll_brand
            } else {
                cx.p.poll_bar
            };
            // Clip inside `row_pill`; when `bar_w < row_h` (e.g. 10% on a narrow
            // column), clip a `row_h`-wide pill to `bar_w` so the left cap
            // follows the outer pill's exact radius instead of collapsing into a
            // taller-than-wide oval.
            out.push(Item::PushClip { shape: row_pill });
            if bar_w < row_h {
                out.push(Item::PushClip {
                    shape: shape(
                        Rect::new(row.x, row.y, bar_w, row_h),
                        0.0,
                        CornerShape::Round,
                    ),
                });
                fill(out, pill(Rect::new(row.x, row.y, row_h, row_h)), color);
                out.push(Item::PopClip);
            } else {
                fill(out, pill(Rect::new(row.x, row.y, bar_w, row_h)), color);
            }
            out.push(Item::PopClip);
        }
        outline(out, row_pill, cx.p.border);

        push_text(
            out,
            &text,
            row.x + PAD_X,
            row.y + (row_h - text.height) * 0.5,
            label_cap,
        );

        if results {
            // One decimal, and no trailing `.0`: `Intl` with
            // `style: "percent", maximumFractionDigits: 1`.
            let pct = format!("{:.1}%", share * 100.0);
            let pct = if let Some(stripped) = pct.strip_suffix(".0%") {
                format!("{stripped}%")
            } else {
                pct
            };
            let w = if is_winner { 700 } else { 400 };
            let block = paragraph(cx, &pct, BODY, w, cx.p.primary, content_w * 0.5, Some(1));
            push_text(
                out,
                &block,
                row.x + cx.width - PAD_X - block.width,
                row.y + (row_h - block.height) * 0.5,
                block.width,
            );
        }
        y += row_h + GAP;
    }
    if y > 0.0 {
        y -= GAP;
    }

    draw_footer(cx, poll, total, results, y0, &mut y, out);
    y
}

/// Native iOS / classic X poll layout (`ios-timeline` & `ios-detail`),
/// matching X's `4pt`-rounded rectangular result bars (`rgba(29, 155, 240, 0.58)`
/// winner wash, `#333639` / `#cfd9de` non-winner bar, no outer row border on
/// closed results, `32pt` min-height, `4pt` row gap, vertically centered `%`).
fn layout_ios(cx: &Ctx, poll: &Poll, y0: f32, out: &mut Vec<Item>) -> f32 {
    const IOS_GAP: f32 = 4.0;
    const IOS_ROW_MIN: f32 = 32.0;
    const IOS_PAD_X: f32 = 12.0;
    const IOS_PAD_Y: f32 = 6.0;
    const IOS_RADIUS: f32 = 4.0;
    const IOS_MIN_BAR_W: f32 = 7.0;

    let choices: Vec<&str> = poll
        .choices
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .take(4)
        .collect();
    if choices.is_empty() {
        return 0.0;
    }
    let counts: Vec<u64> = poll
        .votes
        .as_ref()
        .map(|v| {
            (0..choices.len())
                .map(|i| v.get(i).copied().unwrap_or(0))
                .collect()
        })
        .unwrap_or_default();
    let total: u64 = counts.iter().sum();
    let results = total > 0;
    let winner = if total > 0 {
        let mut best = 0;
        for (i, &n) in counts.iter().enumerate() {
            if n > counts[best] {
                best = i;
            }
        }
        Some(best)
    } else {
        None
    };

    let winner_fill = Rgba::rgba(0x1d, 0x9b, 0xf0, 0x94); // rgba(29, 155, 240, 0.58)
    let other_fill = if cx.p.primary == Rgba::WHITE {
        Rgba::rgb(0x33, 0x36, 0x39)
    } else {
        Rgba::rgb(0xcf, 0xd9, 0xde)
    };

    let content_w = (cx.width - 2.0 * IOS_PAD_X).max(1.0);
    let label_cap = (content_w - 68.0).max(1.0);
    let mut y = 0.0;
    for (i, label) in choices.iter().enumerate() {
        let share = if total > 0 {
            counts[i] as f32 / total as f32
        } else {
            0.0
        };
        let is_winner = results && winner == Some(i) && counts[i] > 0;
        let weight = if !results || is_winner { 700 } else { 400 };
        let label_color = if results { cx.p.primary } else { cx.p.brand };
        let text = paragraph(cx, label, BODY, weight, label_color, label_cap, Some(2));
        let row_h = IOS_ROW_MIN.max(text.height + 2.0 * IOS_PAD_Y);
        let row = Rect::new(0.0, y0 + y, cx.width, row_h);

        if results {
            let bar_w = (row.w * share).max(IOS_MIN_BAR_W).min(row.w);
            let bar = Rect::new(row.x, row.y, bar_w, row.h);
            let color = if is_winner { winner_fill } else { other_fill };
            fill(out, shape(bar, IOS_RADIUS, CornerShape::Round), color);
            push_text(
                out,
                &text,
                row.x + IOS_PAD_X,
                row.y + (row_h - text.height) * 0.5,
                label_cap,
            );
            let pct = format!("{:.1}%", share * 100.0);
            let pct = if let Some(stripped) = pct.strip_suffix(".0%") {
                format!("{stripped}%")
            } else {
                pct
            };
            let pct_w = if is_winner { 700 } else { 400 };
            let block = paragraph(
                cx,
                &pct,
                BODY,
                pct_w,
                cx.p.primary,
                content_w * 0.5,
                Some(1),
            );
            push_text(
                out,
                &block,
                row.x + cx.width - IOS_PAD_X - block.width,
                row.y + (row_h - block.height) * 0.5,
                block.width,
            );
        } else {
            outline(out, pill(row), cx.p.brand);
            push_text(
                out,
                &text,
                row.x + (cx.width - text.width) * 0.5,
                row.y + (row_h - text.height) * 0.5,
                label_cap,
            );
        }
        y += row_h + IOS_GAP;
    }
    if y > 0.0 {
        y -= IOS_GAP;
    }

    draw_footer(cx, poll, total, results, y0, &mut y, out);
    y
}

fn draw_footer(
    cx: &Ctx,
    poll: &Poll,
    total: u64,
    results: bool,
    y0: f32,
    y: &mut f32,
    out: &mut Vec<Item>,
) {
    let footer = footer_text(poll, total, results);
    if let Some(footer) = footer {
        let ty = y0 + *y + FOOTER_GAP;
        let dot = "·";
        let mut x = 0.0;
        for (i, part) in footer.iter().enumerate() {
            let block = paragraph(cx, part, SUBTEXT2, 400, cx.p.secondary, f32::MAX, Some(1));
            if i > 0 {
                let d = paragraph(cx, dot, SUBTEXT2, 400, cx.p.secondary, f32::MAX, Some(1));
                push_text(out, &d, x + DOT_PAD, ty, d.width);
                x += 2.0 * DOT_PAD + d.width;
            }
            push_text(out, &block, x, ty, block.width);
            x += block.width;
        }
        *y += FOOTER_GAP + cx.ty(SUBTEXT2).1;
    }
}

/// The footer's two parts, or `None` when X shows no footer at all.
///
/// The strings are the client's: `{count} {count, plural, one {vote} other
/// {votes}}`, then `Final results` for a closed poll or `{count} hours left`.
fn footer_text(poll: &Poll, total: u64, results: bool) -> Option<Vec<String>> {
    let votes = format_plain_count(total);
    let count = format!("{votes} {}", if total == 1 { "vote" } else { "votes" });
    let state = if results {
        "Final results".to_string()
    } else {
        let secs = poll.seconds_left?;
        let hours = secs / 3600;
        format!("{hours} hours left")
    };
    Some(vec![count, state])
}
