//! The public contract: what a caller hands xeet, and what it gets back.
//!
//! These types are the JSON interface of the CLI, the HTTP function and the
//! WASM package (PLAN.md §6). Every stage reads from them; keep changes
//! additive (new optional fields) so all wrappers stay compatible.
//!
//! Byte fields (`data`) are base64 strings in JSON. They are optional: without
//! them the renderer draws a labeled placeholder with the correct geometry.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A draft post, as the author would compose it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Post {
    pub text: String,
    pub author: Author,
    /// Attached media, in attachment order. At most four images, or one video or GIF.
    pub media: Vec<Media>,
    /// Metadata for links in the text, keyed by the URL as written. Link
    /// metadata is an input: the core never fetches anything.
    pub links: BTreeMap<String, LinkMeta>,
    /// Display text for entities the server renders differently from the source
    /// token, keyed by the token as written (a payload's `@Bot` renders as the
    /// canonical `@bot`). A draft leaves this empty.
    pub entity_labels: BTreeMap<String, String>,
    pub card_state: CardState,
    pub quote: Option<Box<Post>>,
    pub poll: Option<Poll>,
    /// Post time as an ISO 8601 string, for the timestamp. Omitted: "now"
    /// is rendered as the relative time X shows for a fresh post.
    pub created_at: Option<String>,
    /// The reference time for relative timestamps (ISO 8601). The core has no
    /// clock, so callers that want "3h" pass it.
    pub now: Option<String>,
    /// Engagement counts for the action row. Omitted: the row has no numbers,
    /// as for a post that was just sent.
    pub counts: Option<Counts>,
    /// Server-provided state for long posts (`note_tweet`). When absent it is
    /// derived from the weighted length, as X's server would.
    pub long_post: Option<bool>,
    /// The body X's server puts in the timeline cell for a long post: the cut
    /// point already applied, in code points of the authored text. Absent for
    /// a draft, where rules derives the cut.
    pub long_post_body: Option<String>,
    /// The X client version (`data-app-version`) of the page or payload this
    /// post came from. Behavior changes between versions (for example the
    /// long-post expansion in SPEC.md §5), so rules keys those on this. Absent
    /// means "render like the newest client", which is what a draft gets.
    pub app_version: Option<String>,
    /// The status id this post replies to, when the input has it. X hides the
    /// leading mentions only of a reply; a plain post that starts with `@name`
    /// keeps them, so this is the signal rules uses. `replyToHandle` alone is
    /// not enough: a profile cell can print the handle for context and still
    /// show the mention (captured post levelsio/2119915360849727842).
    pub reply_to: Option<String>,
    /// The screen name of the post this one replies to, as the quote's
    /// `Replying to @handle` row prints it (the payload's
    /// `reply_to_user_results.result.core.screen_name`). Without the `@`.
    pub reply_to_handle: Option<String>,
    /// Accounts tagged in the media, shown under it ("Name and 2 others").
    /// Display names, in tag order.
    pub media_tags: Vec<String>,
    /// The context row X draws above the post *inside its cell*, e.g. `Pinned`
    /// on a profile timeline. `None` for a plain cell. (Additive: the frame
    /// draws it; the detail surface has no such row.)
    pub social_context: Option<SocialContext>,
}

/// What the row above a cell's post says, when X draws one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SocialContext {
    /// A pinned post on a profile: a pin icon and the word "Pinned".
    Pinned,
}

impl SocialContext {
    /// The row's label, as X renders it.
    pub fn label(self) -> &'static str {
        match self {
            SocialContext::Pinned => "Pinned",
        }
    }

    /// The icon sprite name (`#icon-pin-fill` in X's sprite).
    pub fn icon(self) -> &'static str {
        match self {
            SocialContext::Pinned => "icon-pin-fill",
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Author {
    pub name: String,
    pub handle: String,
    pub verified: Verified,
    /// Avatar image bytes (base64). Omitted: a neutral placeholder circle.
    pub avatar: Option<String>,
    /// Square avatar shape, which X uses for business accounts.
    pub square_avatar: bool,
    pub protected: bool,
    /// Affiliation (the small square organization badge after the name).
    pub affiliate: Option<Affiliate>,
}

/// An affiliated organization, shown as a small square badge after the name.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Affiliate {
    pub name: String,
    /// Badge image bytes (base64). Omitted: a placeholder square.
    pub badge: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Verified {
    #[default]
    None,
    /// Blue check.
    Blue,
    /// Gold check (verified organization).
    Business,
    /// Grey check (government).
    Government,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Media {
    pub kind: MediaKind,
    pub width: u32,
    pub height: u32,
    pub alt: Option<String>,
    /// Image bytes (base64): JPEG, PNG or WebP. For video and GIF, the poster frame.
    pub data: Option<String>,
    /// Video duration in seconds, for the duration badge.
    pub duration: Option<f32>,
    /// Original author when this media was embedded from another post ("Post
    /// video" / "Post photo", `source_user_results` on X). Shown in the media
    /// attribution badge when it differs from the post's own author.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_author: Option<Author>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    #[default]
    Image,
    Gif,
    Video,
}

/// What X's crawler would have read from a page's card tags.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LinkMeta {
    /// `twitter:card` type: "summary", "summary_large_image", "player", "app".
    /// `None` means the page has no valid card, so no card is shown.
    pub card: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    /// Domain shown on the card; defaults to the URL's host.
    pub domain: Option<String>,
    pub image: Option<ImageMeta>,
    /// The form X shows for this URL (`display_url` in the payload: scheme and
    /// `www.` stripped, long tails cut). Absent for a draft: rules computes it.
    pub display: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImageMeta {
    pub width: u32,
    pub height: u32,
    pub data: Option<String>,
}

/// The composer's card preview state. X keeps one flag per draft (PLAN.md §3).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CardState {
    #[default]
    Auto,
    Dismissed,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Poll {
    pub choices: Vec<String>,
    /// Vote counts per choice; omitted for an open poll that has no votes shown.
    pub votes: Option<Vec<u64>>,
    /// Remaining time label inputs: seconds left, or omitted for "Final results".
    pub seconds_left: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Counts {
    pub replies: u64,
    pub reposts: u64,
    pub likes: u64,
    pub views: u64,
    pub bookmarks: u64,
}

/// Where and how the post is shown.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RenderOptions {
    pub surface: Surface,
    /// Viewport width in CSS pixels. The post column is min(width, 600).
    pub width: f32,
    pub theme: Theme,
    /// Device pixel ratio: 1, 2 or 3.
    pub dpr: f32,
    /// X's user font-size setting, as a multiplier (1.0 is the default).
    pub font_scale: f32,
    /// Render with "Show more" toggled on: shows the full post body in place
    /// instead of cutting it on the timeline.
    pub expanded: bool,
}

impl Default for RenderOptions {
    fn default() -> Self {
        RenderOptions {
            surface: Surface::WebTimeline,
            width: 600.0,
            theme: Theme::Light,
            dpr: 2.0,
            font_scale: 1.0,
            expanded: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Surface {
    #[default]
    WebTimeline,
    WebDetail,
    IosTimeline,
    IosDetail,
}

impl Surface {
    pub fn is_ios(self) -> bool {
        matches!(self, Surface::IosTimeline | Surface::IosDetail)
    }

    pub fn is_detail(self) -> bool {
        matches!(self, Surface::WebDetail | Surface::IosDetail)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    #[default]
    Light,
    Dark,
}

/// Everything xeet decided, and why (PLAN.md §6). Ranges are in UTF-16 code
/// units of `Post::text`, as in X's own payloads.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Report {
    /// Ruleset the decisions came from, e.g. "x-web@3e351742".
    pub ruleset: String,
    pub verified_for: Vec<Surface>,
    pub length: Length,
    pub size: Size,
    pub text: TextReport,
    pub entities: Vec<Entity>,
    pub hidden: Vec<Hidden>,
    pub attachment: Option<Attachment>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Length {
    pub weighted: u32,
    pub limit: u32,
    pub valid: bool,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Size {
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TextReport {
    pub lines: usize,
    pub truncated: bool,
    /// Whether this render shows a "Show more" affordance (`show_more.is_some()`).
    pub has_show_more: bool,
    /// "inline" (long post, server-truncated) or "clamped" (line clamp), or none.
    pub show_more: Option<String>,
    /// The text as displayed, after hidden ranges, URL shortening and truncation.
    pub visible: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Entity {
    /// "url", "mention", "hashtag" or "cashtag".
    pub kind: String,
    pub range: [usize; 2],
    pub text: String,
    /// For URLs, the shortened form X displays.
    pub display: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Hidden {
    pub range: [usize; 2],
    pub why: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Attachment {
    /// "card", "media", "quote" or "poll".
    pub shown: String,
    pub url: Option<String>,
    pub why: String,
}
