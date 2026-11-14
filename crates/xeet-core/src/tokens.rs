//! Typed design tokens, generated from X's stylesheet.
//!
//! `tools/extract-tokens.mjs` resolves X's utility classes into numbers and
//! colors and writes `assets/vendor/tokens.json`; `build.rs` turns that into
//! the constants included at the bottom of this file. Nothing here is a CSS
//! engine: only the declarations the post frame actually uses are extracted,
//! and the extractor fails (rather than drifting) when one goes missing.
//!
//! Two rules matter for callers:
//!
//! - Type sizes and line heights are **multiplied by X's user font-scale
//!   setting** (`RenderOptions::font_scale`), exactly as the stylesheet does
//!   (`calc(15 / 16 * 1rem * var(--x-font-scale))`). Spacing, avatar size and
//!   icon sizes do not scale.
//! - The badge is `size-[1em]` of the header text, so it scales with the text.

use crate::color::Rgba;
use crate::display::CornerShape;
use crate::model::Theme;

/// A font size and its line height, in CSS pixels at scale 1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TypeStyle {
    pub size: f32,
    pub line_height: f32,
}

impl TypeStyle {
    /// The same style at a user font-scale setting.
    pub const fn scaled(self, font_scale: f32) -> TypeStyle {
        TypeStyle {
            size: self.size * font_scale,
            line_height: self.line_height * font_scale,
        }
    }
}

/// The frame's colors for one theme.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Colors {
    pub bg_primary: Rgba,
    pub bg_secondary: Rgba,
    pub fg_primary: Rgba,
    pub fg_secondary: Rgba,
    pub fg_tertiary: Rgba,
    pub fg_brand: Rgba,
    pub border_normal: Rgba,
    pub border_divider: Rgba,
}

/// A corner radius as Chrome draws it, plus the round fallback the pre-squircle
/// rendering would use.
///
/// X sets `--x-radius-m: 1.8` inside `@supports (corner-shape: squircle)` for
/// the `rounded-*` utilities (except `rounded-2xl` and `rounded-full`), and
/// current Chrome satisfies that query, so `rounded-md` is 28.8px drawn as a
/// superellipse rather than 16px round. Both numbers are available:
/// [`RADIUS_MD`] is the effective one, [`RADIUS_MD_ROUND`] the fallback, and
/// [`RADIUS_MD_SHAPE`] the corner shape to pass to `display::Shape`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Radius {
    pub value: f32,
    pub round: f32,
    pub corner: CornerShape,
}

/// One color's channels, emitted by `build.rs`.
#[derive(Clone, Copy, Debug)]
pub struct RgbaParts(pub u8, pub u8, pub u8, pub u8);

impl RgbaParts {
    pub const fn rgba(self) -> Rgba {
        Rgba::rgba(self.0, self.1, self.2, self.3)
    }
}

// Type scale (`--text-*`).
pub const BODY: TypeStyle = TypeStyle {
    size: TYPE_BODY_SIZE,
    line_height: TYPE_BODY_LINE_HEIGHT,
};
pub const LEAD: TypeStyle = TypeStyle {
    size: TYPE_LEAD_SIZE,
    line_height: TYPE_LEAD_LINE_HEIGHT,
};
pub const SUBTEXT1: TypeStyle = TypeStyle {
    size: TYPE_SUBTEXT1_SIZE,
    line_height: TYPE_SUBTEXT1_LINE_HEIGHT,
};
pub const SUBTEXT2: TypeStyle = TypeStyle {
    size: TYPE_SUBTEXT2_SIZE,
    line_height: TYPE_SUBTEXT2_LINE_HEIGHT,
};
pub const HEADLINE1: TypeStyle = TypeStyle {
    size: TYPE_HEADLINE1_SIZE,
    line_height: TYPE_HEADLINE1_LINE_HEIGHT,
};
pub const HEADLINE2: TypeStyle = TypeStyle {
    size: TYPE_HEADLINE2_SIZE,
    line_height: TYPE_HEADLINE2_LINE_HEIGHT,
};
pub const TITLE4: TypeStyle = TypeStyle {
    size: TYPE_TITLE4_SIZE,
    line_height: TYPE_TITLE4_LINE_HEIGHT,
};

pub const LIGHT: Colors = Colors {
    bg_primary: LIGHT_BG_PRIMARY.rgba(),
    bg_secondary: LIGHT_BG_SECONDARY.rgba(),
    fg_primary: LIGHT_FG_PRIMARY.rgba(),
    fg_secondary: LIGHT_FG_SECONDARY.rgba(),
    fg_tertiary: LIGHT_FG_TERTIARY.rgba(),
    fg_brand: LIGHT_FG_BRAND.rgba(),
    border_normal: LIGHT_BORDER_NORMAL.rgba(),
    border_divider: LIGHT_BORDER_DIVIDER.rgba(),
};

pub const DARK: Colors = Colors {
    bg_primary: DARK_BG_PRIMARY.rgba(),
    bg_secondary: DARK_BG_SECONDARY.rgba(),
    fg_primary: DARK_FG_PRIMARY.rgba(),
    fg_secondary: DARK_FG_SECONDARY.rgba(),
    fg_tertiary: DARK_FG_TERTIARY.rgba(),
    fg_brand: DARK_FG_BRAND.rgba(),
    border_normal: DARK_BORDER_NORMAL.rgba(),
    border_divider: DARK_BORDER_DIVIDER.rgba(),
};

/// The palette for a theme.
pub const fn colors(theme: Theme) -> Colors {
    match theme {
        Theme::Light => LIGHT,
        Theme::Dark => DARK,
    }
}

// Spacing and sizes, in CSS pixels. These do not scale with the font setting.
pub const PADDING_X: f32 = LAYOUT_PADDING_X;
pub const PADDING_Y: f32 = LAYOUT_PADDING_Y;
pub const AVATAR_SIZE: f32 = LAYOUT_AVATAR_SIZE;
pub const AVATAR_GAP: f32 = LAYOUT_AVATAR_GAP;
pub const GAP_TIGHT: f32 = LAYOUT_GAP_TIGHT;
pub const GAP_HALF: f32 = LAYOUT_GAP_HALF;
pub const GAP_ROW: f32 = LAYOUT_GAP_ROW;
pub const GAP_BLOCK: f32 = LAYOUT_GAP_BLOCK;
pub const MORE_BUTTON_SIZE: f32 = LAYOUT_MORE_BUTTON_SIZE;
pub const MORE_ICON_SIZE: f32 = LAYOUT_MORE_ICON_SIZE;
pub const MORE_MARGIN_Y: f32 = LAYOUT_MORE_MARGIN_Y;
pub const MORE_MARGIN_END_TIMELINE: f32 = LAYOUT_MORE_MARGIN_END_TIMELINE;
pub const MORE_MARGIN_END_DETAIL: f32 = LAYOUT_MORE_MARGIN_END_DETAIL;
pub const ACTION_ROW_HEIGHT: f32 = LAYOUT_ACTION_ROW_HEIGHT;
pub const ACTION_ROW_BLEED: f32 = LAYOUT_ACTION_ROW_BLEED;
pub const PILL_HEIGHT_TIMELINE: f32 = LAYOUT_PILL_HEIGHT_TIMELINE;
pub const PILL_PADDING_X_TIMELINE: f32 = LAYOUT_PILL_PADDING_X_TIMELINE;
pub const PILL_ICON_SIZE_TIMELINE: f32 = LAYOUT_PILL_ICON_SIZE_TIMELINE;
pub const PILL_HEIGHT_DETAIL: f32 = LAYOUT_PILL_HEIGHT_DETAIL;
pub const PILL_PADDING_X_DETAIL: f32 = LAYOUT_PILL_PADDING_X_DETAIL;
pub const PILL_ICON_SIZE_DETAIL: f32 = LAYOUT_PILL_ICON_SIZE_DETAIL;
pub const COUNT_PADDING_START: f32 = LAYOUT_COUNT_PADDING_START;
/// Padding on each side of the `·` X inserts between header parts.
pub const DOT_PADDING: f32 = LAYOUT_DOT_PADDING;
/// The badge is one em of the header text, so it scales with it.
pub const BADGE_EM: f32 = LAYOUT_BADGE_SIZE / TYPE_BODY_SIZE;
/// Radii, effective (squircle where X asks for it) and round fallbacks.
pub const RADIUS_XS_RADIUS: Radius = Radius {
    value: RADIUS_XS,
    round: RADIUS_XS_ROUND,
    corner: RADIUS_XS_SHAPE,
};
pub const RADIUS_SM_RADIUS: Radius = Radius {
    value: RADIUS_SM,
    round: RADIUS_SM_ROUND,
    corner: RADIUS_SM_SHAPE,
};
pub const RADIUS_MD_RADIUS: Radius = Radius {
    value: RADIUS_MD,
    round: RADIUS_MD_ROUND,
    corner: RADIUS_MD_SHAPE,
};
pub const RADIUS_LG_RADIUS: Radius = Radius {
    value: RADIUS_LG,
    round: RADIUS_LG_ROUND,
    corner: RADIUS_LG_SHAPE,
};
pub const RADIUS_XL_RADIUS: Radius = Radius {
    value: RADIUS_XL,
    round: RADIUS_XL_ROUND,
    corner: RADIUS_XL_SHAPE,
};
pub const RADIUS_2XL_RADIUS: Radius = Radius {
    value: RADIUS_2XL,
    round: RADIUS_2XL_ROUND,
    corner: RADIUS_2XL_SHAPE,
};
pub const RADIUS_FULL_RADIUS: Radius = Radius {
    value: RADIUS_FULL,
    round: RADIUS_FULL_ROUND,
    corner: RADIUS_FULL_SHAPE,
};

/// At or below this article width the action row hides the bookmark button
/// (`@max-[290px]:hidden` under the `post-actions` container query).
pub const BOOKMARK_HIDDEN_BELOW_ARTICLE_WIDTH: f32 = LAYOUT_BOOKMARK_HIDDEN_BELOW_ARTICLE_WIDTH;

/// Escapes for the runtime checks in tests and reports.
pub mod source {
    /// SHA-256 of the stylesheet these tokens came from.
    pub const STYLESHEET_SHA256: &str = super::SOURCE_SHA256;

    /// X's `--spacing` unit, the basis of every gap and padding here.
    pub const SPACING: f32 = super::SPACING;

    /// `--x-radius-m` as declared: X's default, 1.
    pub const RADIUS_MULTIPLIER: f32 = super::RADIUS_MULTIPLIER;

    /// `--x-radius-m` inside `@supports (corner-shape: squircle)`: 1.8, the
    /// value Chrome applies.
    pub const RADIUS_MULTIPLIER_SQUIRCLE: f32 = super::RADIUS_MULTIPLIER_SQUIRCLE;

    /// `--x-root-font-size`.
    pub const ROOT_FONT_SIZE: f32 = super::ROOT_FONT_SIZE;
}

include!(concat!(env!("OUT_DIR"), "/tokens_gen.rs"));

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_scale_matches_x() {
        // PLAN.md §3: body 15/20, lead 17/24, subtext 14/16 and 13/16.
        assert_eq!(
            BODY,
            TypeStyle {
                size: 15.0,
                line_height: 20.0
            }
        );
        assert_eq!(
            LEAD,
            TypeStyle {
                size: 17.0,
                line_height: 24.0
            }
        );
        assert_eq!(SUBTEXT1.line_height, 16.0);
        assert_eq!(SUBTEXT2.size, 13.0);
        assert!(
            BODY.scaled(1.25)
                == TypeStyle {
                    size: 18.75,
                    line_height: 25.0
                }
        );
    }

    #[test]
    fn radii_follow_the_squircle_query() {
        // Chrome satisfies `@supports (corner-shape: squircle)`, so the
        // rounded-* utilities (2xl and full excluded) are 1.8x and squircle.
        assert_eq!(source::RADIUS_MULTIPLIER, 1.0);
        assert_eq!(source::RADIUS_MULTIPLIER_SQUIRCLE, 1.8);
        assert_eq!(
            RADIUS_XS_RADIUS,
            Radius {
                value: 7.2,
                round: 4.0,
                corner: CornerShape::Squircle
            }
        );
        assert_eq!(
            RADIUS_MD_RADIUS,
            Radius {
                value: 28.8,
                round: 16.0,
                corner: CornerShape::Squircle
            }
        );
        assert_eq!(
            RADIUS_2XL_RADIUS,
            Radius {
                value: 16.0,
                round: 16.0,
                corner: CornerShape::Round
            }
        );
        assert_eq!(RADIUS_FULL_RADIUS.corner, CornerShape::Round);
    }

    #[test]
    fn themes_resolve() {
        assert_eq!(LIGHT.bg_primary, Rgba::WHITE);
        assert_eq!(DARK.bg_primary, Rgba::BLACK);
        assert_eq!(LIGHT.fg_brand, Rgba::hex(0x1d9bf0));
        assert_eq!(LIGHT.fg_secondary, Rgba::hex(0x666666));
        assert_eq!(DARK.fg_secondary, Rgba::hex(0x999999));
        assert_eq!(colors(Theme::Dark).fg_primary, Rgba::WHITE);
    }
}
