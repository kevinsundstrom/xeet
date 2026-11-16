//! The timestamp X shows next to a quoted post's author.
//!
//! This delegates to `frame::time`'s label path rather than re-deriving it.
//! That matters for the calendar day: X prints the *viewer's* local date (the
//! playground sends timestamps in the viewer's offset), and
//! `frame::time::relative` shifts both instants into the offset the timestamp
//! was written in before the rules stage compares days. Parsing to UTC first —
//! what this module used to do — collapses the offset and prints the wrong day
//! for a quote made late in the evening west of UTC.
//!
//! The quote's **own** `createdAt` is what counts here: a quoted post can carry
//! a different offset than the post around it, and its header shows the day in
//! that offset (the quoting post's `now` is only the reference instant).

/// The quote header's timestamp label, e.g. `Nov 5` or `3h`.
///
/// `created` is the quote's `created_at`, `now` the reference instant (the
/// quote's own `now`, falling back to the outer post's). Missing input yields
/// X's "Now" label, which is what a post made a moment ago shows.
pub fn time_label(created: Option<&str>, now: Option<&str>) -> String {
    crate::frame::time::label(created, now, false)
}

pub fn time_label_for(created: Option<&str>, now: Option<&str>, ios: bool) -> String {
    if ios {
        crate::frame::time::label_ios(created, now, false)
    } else {
        crate::frame::time::label(created, now, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The calendar day is decided in the offset the timestamp was *written* in,
    /// not in UTC: these three strings are the same instant
    /// (`2026-11-05T02:12:00Z`), and X shows the day the reader's local clock
    /// had. `frame::time` is the implementation of that rule for the main post's
    /// timestamp; the quote header goes through the same path.
    #[test]
    fn the_day_is_taken_in_the_strings_own_offset() {
        let now = Some("2026-11-11T12:00:00Z");
        assert_eq!(time_label(Some("2026-11-05T02:12:00Z"), now), "Nov 5");
        // 18:12 on Nov 4 in UTC−8 — the same instant, one day earlier locally.
        assert_eq!(time_label(Some("2026-11-04T18:12:00-08:00"), now), "Nov 4");
        // 11:12 on Nov 5 in UTC+9.
        assert_eq!(time_label(Some("2026-11-05T11:12:00+09:00"), now), "Nov 5");
    }

    /// Inside the elapsed-time rungs the label is the delta, and the offset does
    /// not change it (both instants are shifted by the same amount).
    #[test]
    fn a_recent_quote_shows_the_elapsed_time() {
        let now = Some("2026-11-11T12:00:00Z");
        assert_eq!(time_label(Some("2026-11-11T09:00:00Z"), now), "3h");
        // 04:00 in UTC−5 is the same instant as 09:00Z.
        assert_eq!(time_label(Some("2026-11-11T04:00:00-05:00"), now), "3h");
        assert_eq!(time_label(Some("2026-11-11T11:30:00Z"), now), "30m");
        // Under a minute the rung is seconds; at or before the reference
        // instant it is X's `nowLabel`.
        assert_eq!(time_label(Some("2026-11-11T11:59:40Z"), now), "20s");
        assert_eq!(time_label(Some("2026-11-11T12:00:00Z"), now), "Now");
    }

    /// An earlier year prints the year, and missing input is the "now" label.
    #[test]
    fn older_and_missing_timestamps() {
        let now = Some("2026-11-11T12:00:00Z");
        assert_eq!(
            time_label(Some("2024-03-21T20:50:00Z"), now),
            "Mar 21, 2024"
        );
        assert_eq!(time_label(None, now), "Now");
    }
}
