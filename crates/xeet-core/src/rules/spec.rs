//! The ruleset as data: `rules/x-web.json`, embedded at build time.
//!
//! Every value the engine uses is in that file together with its evidence and
//! its status (`verified`, `derived`, `prior`). SPEC.md explains each one in
//! prose. Nothing here is invented in code; if a value is missing from the file
//! the build fails when the ruleset is first read, which is what makes a
//! ruleset bump a reviewable diff instead of a silent behavior change.
//!
//! The core stays offline: `include_str!` is a compile-time read, and the
//! parsed copy lives in a `OnceLock` for the life of the process.

use std::sync::OnceLock;

use serde::Deserialize;

static RULESET_JSON: &str = include_str!("../../rules/x-web.json");

/// The ruleset plus the id every report quotes.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ruleset {
    pub id: String,
    pub app_version: String,
    pub verified_at: String,
    pub rules: RuleValues,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleValues {
    pub length: LengthRule,
    pub long_post: LongPostRule,
    pub clamp: ClampRule,
    pub clamp_overflow: ClampOverflowRule,
    pub display_url: DisplayUrlRule,
    pub hidden_ranges: HiddenRangesRule,
    pub leading_mentions: LeadingMentionsRule,
    pub attachment_precedence: AttachmentPrecedenceRule,
    pub card_link: CardLinkRule,
    pub card_dismissal: CardDismissalRule,
    pub card_types: CardTypesRule,
    pub formatting: FormattingRule,
    pub nested_quote_preview: NestedQuotePreviewRule,
    pub embedded_media: EmbeddedMediaRule,
}

/// "Post video" / "Post photo": the media URL removed from the text
/// (`tU-nr9vs.js`, SPEC.md §3.1.2).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedMediaRule {
    pub hides_permalinks: String,
    pub hides_direct_media: String,
    pub requires: String,
    pub strips: String,
    pub leaves: String,
}

/// X's nested-quote preview (`dfWSwB9n.js`, SPEC.md §14).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NestedQuotePreviewRule {
    pub clamp: usize,
    pub media_thumb: MediaThumbRule,
    /// The eligibility checks, keyed by name (`outerCrowded`, …). Prose, and
    /// the values the engine enforces live in `nested_quote_eligible`.
    pub eligibility: std::collections::BTreeMap<String, String>,
    pub entity_rendering: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaThumbRule {
    pub size: u32,
    pub only_first: bool,
    pub overlay_count: bool,
    pub play_icon_for_video: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LengthRule {
    pub limit: u32,
    pub long_post_limit: u32,
    pub url_weight: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongPostRule {
    /// The preview budget, in UTF-16 code units (X counts surrogate pairs as 2).
    pub cut_units: usize,
    pub boundary: String,
    pub trim_trailing_whitespace: bool,
    pub inline_show_more_on: Vec<String>,
    pub truncate_on: Vec<String>,
    pub approximate: bool,
    /// Newer clients render the whole note when only a little of it is hidden.
    pub show_more_elision: ShowMoreElisionRule,
}

/// `BsiDb726.js` (1037d89b) function `f`: when a note is expandable and the cut
/// body is at least `minDisplayedLength` long while at most
/// `maxHiddenRemainder` characters are hidden, the client starts in the
/// expanded state and shows no inline link. `DIdg36-I.js` (89824c04) has no
/// such gate.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowMoreElisionRule {
    pub min_displayed_length: usize,
    pub max_hidden_remainder: usize,
    /// Client versions that apply the gate. Pinned as an allow-list: the live
    /// 55591fe0 timeline shows the cut and the link for a post that 1037d89b
    /// would expand, so an unknown or newer version defaults to the cut.
    #[serde(default)]
    pub enabled_for_app_versions: Vec<String>,
}

impl ShowMoreElisionRule {
    /// Version hashes are opaque, so match by prefix. Only a version that is
    /// known to run the gate expands; a draft (no version) renders like today's
    /// client, which shows the cut.
    pub fn enabled_for(&self, app_version: Option<&str>) -> bool {
        match app_version {
            Some(version) => self
                .enabled_for_app_versions
                .iter()
                .any(|known| version.starts_with(known.as_str())),
            None => false,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClampRule {
    pub timeline_main: Option<usize>,
    pub detail_main: Option<usize>,
    pub quote: Option<usize>,
    pub nested_quote: Option<usize>,
    pub profile_bio: Option<usize>,
    pub card_title: Option<usize>,
    pub card_description: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClampOverflowRule {
    pub button: String,
    pub inline_separator: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayUrlRule {
    pub strip_scheme: bool,
    pub strip_www: bool,
    pub drop_query: bool,
    pub path_units: usize,
    pub ellipsis: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenRangesRule {
    pub leading_mentions_in_reply: bool,
    pub trailing_url_when: Vec<String>,
    pub scan_from_end: bool,
    pub stop_at_first_unmatched_url: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeadingMentionsRule {
    pub hide_in: Vec<String>,
    pub dot_prefix_escapes: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPrecedenceRule {
    pub order: Vec<String>,
    pub media_beats_card: bool,
    pub quote_beats_card: bool,
    pub poll_beats_card: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardLinkRule {
    pub pick: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDismissalRule {
    pub marker: String,
    pub scope: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardTypesRule {
    pub recognized: Vec<String>,
    pub renders_when: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormattingRule {
    pub relative_time: RelativeTimeRule,
    pub counts: CountsRule,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelativeTimeRule {
    pub now_label: String,
}

/// X has more than one count formatter; which one applies is a call site, not
/// a preference. All four are recorded in the ruleset with their evidence.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountsRule {
    /// Replies, reposts, likes, bookmarks: the engagement pill.
    pub action_row: ActionRowCountRule,
    /// The detail view's "N Views" label and profile stats.
    pub views: ViewsCountRule,
    /// Community member counts.
    pub member_count: MemberCountRule,
    /// Poll totals: not abbreviated at all.
    pub poll_votes: PollVotesRule,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRowCountRule {
    pub initial_fraction_digits: u32,
    pub long_threshold_characters: usize,
    pub fallback_fraction_digits: u32,
    pub rounding_mode: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewsCountRule {
    pub plain_below: u64,
    pub maximum_fraction_digits: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberCountRule {
    pub maximum_fraction_digits: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollVotesRule {
    #[serde(default)]
    pub algorithm: String,
}

/// The parsed ruleset. Panics only if the embedded JSON is broken, which the
/// ruleset test guards against.
pub fn ruleset() -> &'static Ruleset {
    static ONCE: OnceLock<Ruleset> = OnceLock::new();
    ONCE.get_or_init(|| serde_json::from_str(RULESET_JSON).expect("embedded ruleset parses"))
}

/// `x-web@55591fe0`: the first eight characters of the current app version the
/// decisions were derived from, as in PLAN.md §6's report example. Older
/// versions the ruleset also covers are listed under `versions`/`appVersions`.
pub fn ruleset_id() -> &'static str {
    static ONCE: OnceLock<String> = OnceLock::new();
    ONCE.get_or_init(|| {
        let r = ruleset();
        let short: String = r.app_version.chars().take(8).collect();
        format!("{}@{}", r.id, short)
    })
    .as_str()
}

/// The date the ruleset was last verified against live X.
pub fn verified_at() -> &'static str {
    ruleset().verified_at.as_str()
}

// ---------------------------------------------------------------------------
// Formatting helpers, for the frame and the cards streams.
//
// Relative timestamps and compact counts are rules too: they live in the
// ruleset file with their evidence, and the functions below implement exactly
// what X's client does (SPEC.md "Formatting").
// ---------------------------------------------------------------------------

/// A count as X's **engagement pill** shows it (replies, reposts, likes,
/// bookmarks).
///
/// The client formats with one fraction digit and `roundingMode: "trunc"`, then
/// looks at the result: if it is five characters or longer it re-formats with
/// no fraction digits. That is the whole rule, and it is why `1938` is `1.9K`
/// but `12490` is `12K` and `987654` is `987K` (SPEC.md "Counts").
pub fn format_count(n: u64) -> String {
    let rule = &ruleset().rules.formatting.counts.action_row;
    let initial = compact_trunc(n, rule.initial_fraction_digits);
    if initial.chars().count() >= rule.long_threshold_characters {
        compact_trunc(n, rule.fallback_fraction_digits)
    } else {
        initial
    }
}

/// A count as the detail view's "N Views" label and the profile stats show it
/// (`view-count-utils`): plain and grouped below 10,000, compact with one
/// truncated fraction digit above.
pub fn format_views_count(n: u64) -> String {
    let rule = &ruleset().rules.formatting.counts.views;
    if n < rule.plain_below {
        format_plain_count(n)
    } else {
        compact_trunc(n, rule.maximum_fraction_digits)
    }
}

/// A community member count: compact with one truncated fraction digit at every
/// magnitude, including below 1,000.
pub fn format_member_count(n: u64) -> String {
    let rule = &ruleset().rules.formatting.counts.member_count;
    compact_trunc(n, rule.maximum_fraction_digits)
}

/// A plain grouped integer, as X shows poll totals (`1,234 votes`).
pub fn format_plain_count(n: u64) -> String {
    group_digits(n)
}

/// `Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: d,
/// roundingMode: "trunc" })`, for the magnitudes counts reach.
///
/// Intl never prints a trailing `.0`, and below 1,000 it prints the plain
/// integer without grouping. Above 999,999,999,999 the unit ladder is
/// extrapolated (`T`); no capture reaches it.
fn compact_trunc(n: u64, digits: u32) -> String {
    if n < 1_000 {
        return n.to_string();
    }
    let (unit, suffix) = if n >= 1_000_000_000_000 {
        (1_000_000_000_000u128, "T")
    } else if n >= 1_000_000_000 {
        (1_000_000_000, "B")
    } else if n >= 1_000_000 {
        (1_000_000, "M")
    } else {
        (1_000, "K")
    };
    let n = u128::from(n);
    let factor = 10u128.pow(digits);
    let scaled = n * factor / unit; // truncation happens here
    let whole = scaled / factor;
    let frac = scaled % factor;
    if frac == 0 {
        format!("{whole}{suffix}")
    } else if digits == 0 {
        // Unreachable: `frac == 0` when digits is 0. Kept for clarity.
        format!("{whole}{suffix}")
    } else {
        let frac_str = format!("{frac:0width$}", width = digits as usize);
        format!("{whole}.{}{suffix}", frac_str.trim_end_matches('0'))
    }
}

fn group_digits(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// X's relative past timestamp for a post.
///
/// `created_at_ms` and `now_ms` are Unix milliseconds (the core has no clock,
/// the caller passes "now"). `precision_hours` mirrors the client's
/// `precision: "Hours"`: it suppresses the `" 41m"` tail on the hours label,
/// which is what a timeline cell uses.
pub fn format_relative_time(created_at_ms: i64, now_ms: i64, precision_hours: bool) -> String {
    let now_label = &ruleset().rules.formatting.relative_time.now_label;
    let secs = (now_ms - created_at_ms) / 1000;
    if secs <= 0 {
        return now_label.clone();
    }
    if secs < 60 {
        return format!("{secs}s");
    }
    let minutes = secs / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 24 {
        let label = format!("{hours}h");
        let rest = (secs % 3600) / 60;
        if precision_hours || rest == 0 {
            return label;
        }
        return format!("{label} {rest}m");
    }
    let days = days_from_civil(now_ms / 1000);
    let created = days_from_civil(created_at_ms / 1000);
    let (y, m, d) = civil_from_days(created);
    let (ny, _, _) = civil_from_days(days);
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = MONTHS
        .get(m.saturating_sub(1) as usize)
        .copied()
        .unwrap_or("Jan");
    if y == ny {
        format!("{month} {d}")
    } else {
        format!("{month} {d}, {y}")
    }
}

fn days_from_civil(secs: i64) -> i64 {
    secs.div_euclid(86_400)
}

/// Howard Hinnant's civil-from-days, for the Gregorian calendar in UTC.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_ruleset_parses_and_is_consistent() {
        let r = ruleset();
        assert_eq!(r.id, "x-web");
        assert!(r.rules.length.limit > 0);
        assert_eq!(r.rules.length.limit, 280);
        assert!(r
            .rules
            .attachment_precedence
            .order
            .iter()
            .any(|k| k == "card"));
    }

    #[test]
    fn the_embedded_media_rule_is_in_the_data() {
        let media = &ruleset().rules.embedded_media;
        assert!(media.hides_permalinks.contains("video|photo"));
        assert!(media.hides_direct_media.contains("video.twimg.com"));
        assert!(media.strips.contains("one preceding space"));
        assert!(media.requires.contains("Post::media"));
    }

    #[test]
    fn the_nested_quote_preview_rule_is_in_the_data() {
        let preview = &ruleset().rules.nested_quote_preview;
        assert_eq!(preview.clamp, 2);
        assert_eq!(preview.media_thumb.size, 64);
        assert!(preview.media_thumb.only_first);
        assert!(preview.media_thumb.play_icon_for_video);
        assert!(preview.eligibility.contains_key("mediaBudget"));
        assert!(preview.entity_rendering.contains("inherit"));
    }

    #[test]
    fn ruleset_id_is_the_report_form() {
        let id = ruleset_id();
        assert!(id.starts_with("x-web@"));
        assert_eq!(id.len(), "x-web@".len() + 8);
    }

    #[test]
    fn action_row_counts_match_the_captured_markup() {
        // Values from the 464 aria-label/rendered pairs in frame/numbers.rs.
        assert_eq!(format_count(735), "735");
        assert_eq!(format_count(996), "996");
        assert_eq!(format_count(1000), "1K");
        assert_eq!(format_count(1036), "1K");
        assert_eq!(format_count(1113), "1.1K");
        assert_eq!(format_count(1938), "1.9K");
        assert_eq!(format_count(5264), "5.2K");
        assert_eq!(format_count(8071), "8K");
        assert_eq!(format_count(9900), "9.9K");
        assert_eq!(format_count(10_355), "10K");
        assert_eq!(format_count(12_490), "12K");
        assert_eq!(format_count(139_073), "139K");
        assert_eq!(format_count(987_654), "987K");
        assert_eq!(format_count(1_150_607), "1.1M");
        assert_eq!(format_count(4_082_915), "4M");
        assert_eq!(format_count(4_252_767), "4.2M");
        assert_eq!(format_count(37_047_269), "37M");
    }

    #[test]
    fn action_row_count_boundaries() {
        assert_eq!(format_count(0), "0");
        assert_eq!(format_count(999), "999");
        assert_eq!(format_count(9_999), "9.9K");
        assert_eq!(format_count(10_000), "10K");
        // Five characters with one fraction digit switches to none.
        assert_eq!(format_count(99_999), "99K");
        assert_eq!(format_count(100_000), "100K");
        assert_eq!(format_count(999_999), "999K");
        assert_eq!(format_count(1_000_000), "1M");
        assert_eq!(format_count(9_999_999), "9.9M");
        assert_eq!(format_count(10_000_000), "10M");
        assert_eq!(format_count(12_345_678), "12M");
        assert_eq!(format_count(999_999_999), "999M");
        assert_eq!(format_count(1_000_000_000), "1B");
        assert_eq!(format_count(1_234_567_890), "1.2B");
    }

    #[test]
    fn other_call_sites_use_their_own_formatters() {
        // Views: plain below 10,000, compact above (view-count-utils).
        assert_eq!(format_views_count(9_999), "9,999");
        assert_eq!(format_views_count(10_000), "10K");
        assert_eq!(format_views_count(12_490), "12.4K");
        assert_eq!(format_views_count(987_654), "987.6K");
        assert_eq!(format_views_count(1_234_567), "1.2M");
        // Member counts: compact at every magnitude.
        assert_eq!(format_member_count(1_234), "1.2K");
        assert_eq!(format_member_count(987_654), "987.6K");
        // Poll totals: never abbreviated.
        assert_eq!(format_plain_count(1_234), "1,234");
        assert_eq!(format_plain_count(987_654), "987,654");
    }

    #[test]
    fn relative_time_matches_the_client_thresholds() {
        let now = 1_800_000_000_000i64;
        assert_eq!(format_relative_time(now + 5_000, now, true), "Now");
        assert_eq!(format_relative_time(now - 5_000, now, true), "5s");
        assert_eq!(format_relative_time(now - 59_999, now, true), "59s");
        assert_eq!(format_relative_time(now - 60_000, now, true), "1m");
        assert_eq!(format_relative_time(now - 3_600_000, now, true), "1h");
        // 1h 41m below a day, unless the label asks for hours only.
        assert_eq!(
            format_relative_time(now - (3_600 + 41 * 60) * 1000, now, false),
            "1h 41m"
        );
        assert_eq!(
            format_relative_time(now - (3_600 + 41 * 60) * 1000, now, true),
            "1h"
        );
        // Older than a day: month and day, adding the year only when it differs.
        let old = now - 3 * 86_400_000;
        assert_eq!(format_relative_time(old, now, true), "Jan 12");
        let last_year = now - 400 * 86_400_000;
        assert_eq!(format_relative_time(last_year, now, true), "Dec 11, 2025");
    }
}
