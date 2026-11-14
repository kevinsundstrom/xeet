//! Timestamp formatting, ported from X's web client.
//!
//! X renders timestamps on the client from a timestamp in milliseconds. The
//! timeline uses `formatRelativePastTimestamp`; the post-detail view uses
//! `formatFullTimestamp`. The source is the web client chunk that installs
//! `window.__xClientTextFormatters` (0.1 MB chunk `C6bLYpE4.js` of app
//! `89824c04`, fetched logged out on 2026-11-09), decompiled here:
//!
//! ```js
//! function relative({timestamp, lang, timeZone, nowLabel, precision}) {
//!   const d = new Date(timestamp), f = new Date();
//!   const p = Math.floor((f.getTime() - d.getTime()) / 1000);
//!   if (p <= 0) return nowLabel ?? format(0, "second");        // "Now"
//!   if (p < 60) return "{p}s";
//!   if (p < 3600) return "{floor(p / 60)}m";
//!   if (p < 86400) {
//!     const e = "{floor(p / 3600)}h";
//!     const t = Math.floor((p % 3600) / 60);
//!     return precision === "Hours" || t === 0 ? e : `${e} ${t}m`;
//!   }
//!   return sameYear(d, f) ? "Mon D" : "Mon D, YYYY";          // Intl, month short
//! }
//! function full({timestamp}) {
//!   return `${format({hour: "numeric", minute: "2-digit"})} · ${format({month: "short", day: "numeric", year: "numeric"})}`;
//! }
//! ```
//!
//! Every surface passes `precision: "Hours"` and `nowLabel: "Now"`
//! (visible in the `window.__xClientTextFormatters.run(...)` arguments X
//! server-renders next to each timestamp), so the minutes suffix never
//! appears and a fresh post reads "Now".
//!
//! Two details the code leaves to `Intl` and we have to pin down:
//!
//! - **Time zone.** `timeZone` is not passed, so a browser uses its own. The
//!   core has no clock and no zone database, so it formats in UTC unless the
//!   ISO string carries an offset, which it then honours. The day a post
//!   crosses "yesterday" therefore depends on the caller; pass offsets in
//!   `created_at`/`now` to match a specific reader.
//! - **The space before AM/PM** is U+0020, not the narrow no-break space some
//!   ICU versions emit: the captured markup for post 20 reads
//!   `8:50 PM · Mar 21, 2006` with `20 50 4d` between the digits and `PM`
//!   (checked byte by byte in `assets/vendor/corpus/jack-20.html`).
//!
//! The separator is a middot (U+00B7) with one space on each side, and the day
//! is numeric without a leading zero ("Nov 9"), matching `Intl`'s en-US forms.

/// A parsed point in time: epoch milliseconds plus the offset it was written
/// in, in minutes east of UTC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Instant {
    pub ms: i64,
    pub offset_minutes: i32,
}

impl Instant {
    pub const UTC: Instant = Instant {
        ms: 0,
        offset_minutes: 0,
    };

    /// Parses the ISO 8601 shapes `Post::created_at` and `Post::now` use:
    /// `YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM|±HHMM]`.
    ///
    /// Also accepts a bare `YYYY-MM-DD`. Returns `None` for anything else, so
    /// callers can fall back to their own clock (the core has none).
    pub fn parse(text: &str) -> Option<Instant> {
        let s = text.trim();
        let bytes = s.as_bytes();
        if bytes.len() < 10 {
            return None;
        }
        let num =
            |range: std::ops::Range<usize>| -> Option<i32> { s.get(range)?.parse::<i32>().ok() };
        let year = num(0..4)?;
        if bytes[4] != b'-' || bytes[7] != b'-' {
            return None;
        }
        let month = num(5..7)?;
        let day = num(8..10)?;
        let (mut hour, mut minute, mut second, mut millis) = (0, 0, 0, 0);
        let mut offset_minutes = 0;
        let mut rest = &s[10..];
        if let Some(tail) = rest.strip_prefix('T').or_else(|| rest.strip_prefix(' ')) {
            if tail.len() < 5 || tail.as_bytes()[2] != b':' {
                return None;
            }
            hour = tail.get(0..2)?.parse().ok()?;
            minute = tail.get(3..5)?.parse().ok()?;
            rest = &tail[5..];
            if let Some(after) = rest.strip_prefix(':') {
                second = after.get(0..2)?.parse().ok()?;
                rest = &after[2..];
                if let Some(frac) = rest.strip_prefix('.') {
                    let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if digits.is_empty() {
                        return None;
                    }
                    let mut scaled = digits[..digits.len().min(3)].to_string();
                    while scaled.len() < 3 {
                        scaled.push('0');
                    }
                    millis = scaled.parse().ok()?;
                    rest = &frac[digits.len()..];
                }
            }
        }
        rest = rest.trim();
        match rest {
            "" | "Z" | "z" => {}
            _ => {
                let sign = match rest.as_bytes()[0] {
                    b'+' => 1,
                    b'-' => -1,
                    _ => return None,
                };
                let body = &rest[1..];
                let (hh, mm) = match body.len() {
                    2 => (body.parse::<i32>().ok()?, 0),
                    4 => (body[..2].parse().ok()?, body[2..].parse().ok()?),
                    5 if body.as_bytes()[2] == b':' => {
                        (body[..2].parse().ok()?, body[3..].parse().ok()?)
                    }
                    _ => return None,
                };
                if !(0..=23).contains(&hh) || !(0..=59).contains(&mm) {
                    return None;
                }
                offset_minutes = sign * (hh * 60 + mm);
            }
        }
        if !(1..=12).contains(&month)
            || !(1..=31).contains(&day)
            || hour > 23
            || minute > 59
            || second > 60
        {
            return None;
        }
        let days = days_from_civil(year as i64, month as u32, day as u32);
        let local_seconds = days * 86_400 + hour as i64 * 3600 + minute as i64 * 60 + second as i64;
        let ms = local_seconds * 1000 + millis as i64 - offset_minutes as i64 * 60_000;
        Some(Instant { ms, offset_minutes })
    }

    /// ISO 8601 in UTC, the shape [`Instant::parse`] accepts. Wrappers use it
    /// to hand the core a clock without the core reading one.
    pub fn to_iso8601(&self) -> String {
        let utc = Instant {
            ms: self.ms,
            offset_minutes: 0,
        };
        let c = utc.civil();
        let ms_of_day = utc.ms.rem_euclid(86_400_000);
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            c.year,
            c.month,
            c.day,
            c.hour,
            c.minute,
            ms_of_day / 1000 % 60,
            ms_of_day % 1000
        )
    }

    /// The calendar date and clock time at this instant's own offset.
    fn civil(&self) -> Civil {
        let shifted = self.ms + self.offset_minutes as i64 * 60_000;
        let days = shifted.div_euclid(86_400_000);
        let ms_of_day = shifted.rem_euclid(86_400_000);
        let (year, month, day) = civil_from_days(days);
        Civil {
            year,
            month,
            day,
            hour: (ms_of_day / 3_600_000) as u32,
            minute: (ms_of_day / 60_000 % 60) as u32,
        }
    }
}

struct Civil {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// X's `formatRelativePastTimestamp` with `precision: "Hours"`.
///
/// `now` is the reference instant; pass the same one for a whole page so every
/// timestamp on it agrees.
pub fn relative(created: Instant, now: Option<Instant>) -> String {
    let Some(now) = now else {
        // Without a reference time the only honest answer is the label X shows
        // for a post that was just created.
        return "Now".to_string();
    };
    // The rule lives in the rules stage (versioned ruleset, verified against
    // the client); shift both instants into the display offset first so the
    // calendar comparison happens in the reader's zone. The difference is
    // unchanged, so the elapsed-time rungs are identical.
    let shift = created.offset_minutes as i64 * 60_000;
    crate::rules::spec::format_relative_time(created.ms + shift, now.ms + shift, true)
}

/// X's `formatFullTimestamp`: `8:50 PM · Mar 21, 2006`.
pub fn full(created: Instant) -> String {
    let c = created.civil();
    let hour12 = match c.hour % 12 {
        0 => 12,
        h => h,
    };
    let meridiem = if c.hour < 12 { "AM" } else { "PM" };
    format!(
        "{}:{:02} {} · {} {}, {}",
        hour12,
        c.minute,
        meridiem,
        MONTHS[(c.month - 1) as usize],
        c.day,
        c.year
    )
}

/// The label a `Post` should show on a surface, from the model's ISO strings.
pub fn label(created_at: Option<&str>, now: Option<&str>, detail: bool) -> String {
    match created_at.and_then(Instant::parse) {
        Some(created) if detail => full(created),
        Some(created) => relative(created, now.and_then(Instant::parse)),
        None => "Now".to_string(),
    }
}

/// X iOS timestamp formatting: `< 60s` → `Xs`, `< 60m` → `Xm`, `< 24h` → `Xh`,
/// `1..=6` days → `Xd` (`1d`..`6d`), and `>= 7` days → numeric `M/D/YY`
/// (`7/7/26`); detail shows `8:50 PM · 3/21/06`.
pub fn label_ios(created_at: Option<&str>, now: Option<&str>, detail: bool) -> String {
    let Some(created) = created_at.and_then(Instant::parse) else {
        return "Now".to_string();
    };
    let c = created.civil();
    let yy = c.year.rem_euclid(100);
    if detail {
        let hour12 = match c.hour % 12 {
            0 => 12,
            h => h,
        };
        let meridiem = if c.hour < 12 { "AM" } else { "PM" };
        return format!(
            "{}:{:02} {} · {}/{}/{:02}",
            hour12, c.minute, meridiem, c.month, c.day, yy
        );
    }
    let Some(now) = now.and_then(Instant::parse) else {
        return "Now".to_string();
    };
    let secs = (now.ms - created.ms).div_euclid(1000);
    if secs <= 0 {
        "Now".to_string()
    } else if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        format!("{}h", secs / 3600)
    } else if secs < 7 * 86_400 {
        format!("{}d", secs / 86_400)
    } else {
        format!("{}/{}/{:02}", c.month, c.day, yy)
    }
}

// Howard Hinnant's `days_from_civil` / `civil_from_days`, the standard
// proleptic-Gregorian conversions, valid for any year.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> Instant {
        Instant::parse(s).unwrap_or_else(|| panic!("unparseable {s}"))
    }

    #[test]
    fn parses_iso_forms() {
        assert_eq!(at("2006-03-21T20:50:14Z").ms, 1_142_974_214_000);
        assert_eq!(at("2006-03-21T20:50:14.000Z").ms, 1_142_974_214_000);
        assert_eq!(at("2006-03-21T12:50:14-08:00").ms, 1_142_974_214_000);
        assert_eq!(at("2006-03-21T20:50:14+0000").ms, 1_142_974_214_000);
        assert_eq!(
            at("2006-03-21").ms,
            days_from_civil(2006, 3, 21) * 86_400_000
        );
        assert!(Instant::parse("not a date").is_none());
    }

    #[test]
    fn relative_ladder() {
        let t = at("2026-11-10T12:00:00Z");
        let ago = |s: i64| Instant {
            ms: t.ms - s * 1000,
            offset_minutes: 0,
        };
        assert_eq!(relative(t, Some(t)), "Now");
        assert_eq!(
            relative(
                Instant {
                    ms: t.ms + 5000,
                    offset_minutes: 0
                },
                Some(t)
            ),
            "Now"
        );
        assert_eq!(relative(ago(1), Some(t)), "1s");
        assert_eq!(relative(ago(59), Some(t)), "59s");
        assert_eq!(relative(ago(60), Some(t)), "1m");
        assert_eq!(relative(ago(3599), Some(t)), "59m");
        assert_eq!(relative(ago(3600), Some(t)), "1h");
        assert_eq!(relative(ago(86_399), Some(t)), "23h");
        // One day or more switches to a calendar date in the same year.
        assert_eq!(relative(ago(86_400), Some(t)), "Nov 9");
        // A different year appends it.
        assert_eq!(relative(at("2025-11-09T12:00:00Z"), Some(t)), "Nov 9, 2025");
        assert_eq!(
            relative(at("2024-03-21T12:00:00Z"), Some(t)),
            "Mar 21, 2024"
        );
        // No reference clock: X's "just posted" label.
        assert_eq!(relative(t, None), "Now");
    }

    #[test]
    fn full_timestamp_matches_capture() {
        // The exact string X server-rendered for https://x.com/jack/status/20.
        assert_eq!(full(at("2006-03-21T20:50:14Z")), "8:50 PM · Mar 21, 2006");
        // 12-hour clock edges.
        assert_eq!(full(at("2026-01-01T00:05:00Z")), "12:05 AM · Jan 1, 2026");
        assert_eq!(full(at("2026-01-01T12:00:00Z")), "12:00 PM · Jan 1, 2026");
        assert_eq!(full(at("2026-12-31T23:59:00Z")), "11:59 PM · Dec 31, 2026");
    }

    #[test]
    fn offset_changes_the_calendar_day() {
        // 2026-11-09T18:00 in Los Angeles is 2026-11-10T02:00Z. Two days later
        // the same offset is still on Nov 11, so the label is "Nov 9".
        let created = at("2026-11-09T18:00:00-08:00");
        let now = at("2026-11-11T18:00:00-08:00");
        assert_eq!(relative(created, Some(now)), "Nov 9");
        // The clock time is the local one, and the date is the local date.
        assert_eq!(full(created), "6:00 PM · Nov 9, 2026");
        // The same instant written in UTC formats as Nov 10, 2:00 AM.
        assert_eq!(
            full(Instant {
                ms: created.ms,
                offset_minutes: 0
            }),
            "2:00 AM · Nov 10, 2026"
        );
    }
}
