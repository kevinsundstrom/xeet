#!/usr/bin/env node
// The replica's timestamp port, checked against xeet's own literals.
//
//   node tools/playground/test/oracle-stamps.mjs
//
// `chrome-markup.mjs` formats a post's timestamp from `createdAt`/`now` alone
// (xeet has no clock, so the replica must not have one). It is a port of
// `crates/xeet-core/src/frame/time.rs`; every expectation below is a literal
// from that file's tests, so the two implementations can only disagree if one of
// them changes.
//
// Exit code 1 on any mismatch.
import { parseInstant, relativeLabel, fullLabel, stampLabel } from "../lib/chrome-markup.mjs";

const rows = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  rows.push({ name, got, want, ok });
}

// --- Instant::parse: the four ISO forms of one instant, a bare date, garbage.
{
  const want = 1_142_974_214_000;
  for (const text of ["2006-03-21T20:50:14Z", "2006-03-21T20:50:14.000Z", "2006-03-21T12:50:14-08:00", "2006-03-21T20:50:14+0000"]) {
    check(`parse ${text}`, parseInstant(text)?.ms ?? null, want);
  }
  check("parse 2006-03-21", parseInstant("2006-03-21")?.ms ?? null, Date.UTC(2006, 2, 21));
  check("parse garbage", parseInstant("not a date"), null);
  check("parse empty", parseInstant(""), null);
  check("parse missing", parseInstant(undefined), null);
  check("offset kept", parseInstant("2006-03-21T12:50:14-08:00")?.offset, -480);
}

// --- relative_ladder
{
  const t = parseInstant("2026-11-10T12:00:00Z");
  const ago = (s) => ({ ms: t.ms - s * 1000, offset: 0 });
  check("same instant", relativeLabel(t, t), "Now");
  check("five seconds ahead", relativeLabel({ ms: t.ms + 5000, offset: 0 }, t), "Now");
  check("1s", relativeLabel(ago(1), t), "1s");
  check("59s", relativeLabel(ago(59), t), "59s");
  check("60s", relativeLabel(ago(60), t), "1m");
  check("3599s", relativeLabel(ago(3599), t), "59m");
  check("3600s", relativeLabel(ago(3600), t), "1h");
  check("86399s", relativeLabel(ago(86_399), t), "23h");
  check("86400s", relativeLabel(ago(86_400), t), "Nov 9");
  check("last year", relativeLabel(parseInstant("2025-11-09T12:00:00Z"), t), "Nov 9, 2025");
  check("two years", relativeLabel(parseInstant("2024-03-21T12:00:00Z"), t), "Mar 21, 2024");
  check("no reference clock", relativeLabel(t, null), "Now");
}

// --- full_timestamp_matches_capture
{
  check("jack-20", fullLabel(parseInstant("2006-03-21T20:50:14Z")), "8:50 PM · Mar 21, 2006");
  check("midnight edge", fullLabel(parseInstant("2026-01-01T00:05:00Z")), "12:05 AM · Jan 1, 2026");
  check("noon edge", fullLabel(parseInstant("2026-01-01T12:00:00Z")), "12:00 PM · Jan 1, 2026");
  check("last minute", fullLabel(parseInstant("2026-12-31T23:59:00Z")), "11:59 PM · Dec 31, 2026");
}

// --- offset_changes_the_calendar_day
{
  const created = parseInstant("2026-11-09T18:00:00-08:00");
  const now = parseInstant("2026-11-11T18:00:00-08:00");
  check("offset calendar day", relativeLabel(created, now), "Nov 9");
  check("offset clock time", fullLabel(created), "6:00 PM · Nov 9, 2026");
}

// --- label(): the surface decision, and the no-clock rule
{
  check("detail", stampLabel("2006-03-21T20:50:14Z", undefined, { detail: true }), "8:50 PM · Mar 21, 2006");
  check("timeline", stampLabel("2026-11-10T09:00:00Z", "2026-11-10T12:00:00Z"), "3h");
  check("detail, no createdAt", stampLabel(undefined, "2026-11-10T12:00:00Z", { detail: true }), "Now");
  check("timeline, no createdAt", stampLabel(undefined, "2026-11-10T12:00:00Z"), "Now");
  check("detail, unparseable", stampLabel("2026-13-45T99:99:00Z", undefined, { detail: true }), "Now");
  check("timeline, no now", stampLabel("2026-11-10T09:00:00Z", undefined), "Now");
  check("bare date, detail", stampLabel("2026-11-10", undefined, { detail: true }), "12:00 AM · Nov 10, 2026");
}

// --- the quoted post's stamp: its own `createdAt`, the *post's* `now`
//
// A quote is a nested `Post`, so it has a `createdAt` of its own — but the
// reference clock belongs to the render, not to the quoted post: `/api/resolve`
// and the UI pass `now` once, on the outer post, and a quoted post almost never
// carries one. The replica read `quote.now` and printed "Now" for every quote,
// which three different `createdAt` values could not distinguish (byte-identical
// PNGs). These are the labels of `frame::time::relative` for the same three
// strings the audit uses, with the render clock a week after them.
{
  const now = "2026-11-10T18:12:00Z";
  // 02:12Z on the 5th: its own offset is UTC, so the day is the 5th.
  check("quote stamp, Z", stampLabel("2026-11-05T02:12:00Z", now), "Nov 5");
  // 18:12 on the 4th at -08:00 — a different *day* for the same UTC hour band.
  check("quote stamp, -08:00", stampLabel("2026-11-04T18:12:00-08:00", now), "Nov 4");
  // 11:12 on the 5th at +09:00 — the same instant as the Z case above, so the
  // same label: identical pixels here are correct, not a bug.
  check("quote stamp, +09:00", stampLabel("2026-11-05T11:12:00+09:00", now), "Nov 5");
  check("quote stamp, 3h ago", stampLabel("2026-11-10T15:12:00Z", now), "3h");
  check("quote stamp, no clock", stampLabel("2026-11-05T02:12:00Z", undefined), "Now");
}

const failed = rows.filter((r) => !r.ok);
const w = (s, n) => String(s ?? "").padEnd(n);
console.log(`\n${w("case", 24)}${w("got", 30)}want`);
for (const r of rows) console.log(`${w(r.name, 24)}${w(JSON.stringify(r.got), 30)}${r.ok ? "" : `${JSON.stringify(r.want)}   FAIL`}`);
console.log(`\n${rows.length - failed.length}/${rows.length} timestamp cases match xeet's frame::time literals`);
process.exit(failed.length ? 1 : 0);
