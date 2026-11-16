// Timestamps are shown in the viewer's time zone, the way X shows them.
//
// The core has no clock and no locale: it formats whatever `createdAt`/`now`
// strings it is given, in that string's own offset. A resolved post arrives as
// UTC ("…Z"), so a Pacific viewer saw "Nov 5" for a post X showed as "Nov 4".
// Before a post goes to any target we rewrite its times into the chosen zone as
// ISO with an explicit offset, at the offset in effect at that instant (DST).

/** The viewer's zone, by default. */
export const LOCAL = "local";

export const ZONES = [
  { id: LOCAL, label: "browser" },
  { id: "UTC", label: "UTC" },
  { id: "America/Los_Angeles", label: "US Pacific" },
  { id: "America/New_York", label: "US Eastern" },
  { id: "Europe/London", label: "London" },
  { id: "Europe/Berlin", label: "Berlin" },
  { id: "Asia/Tokyo", label: "Tokyo" },
  { id: "Asia/Kolkata", label: "India" },
  { id: "Australia/Sydney", label: "Sydney" },
];

export function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function zoneLabel(id) {
  const zone = id === LOCAL ? browserZone() : id;
  const known = ZONES.find((z) => z.id === id);
  if (!known) return zone;
  return id === LOCAL ? `browser (${zone})` : `${known.label} (${id})`;
}

/** Minutes east of UTC that `zone` is at `instantMs` (DST included). */
export function offsetMinutesAt(instantMs, zone = LOCAL) {
  if (!zone || zone === LOCAL) return -new Date(instantMs).getTimezoneOffset();
  try {
    // "GMT-08:00" / "GMT+05:30" / "GMT", evaluated at that instant.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "longOffset",
    }).formatToParts(new Date(instantMs));
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const match = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
    if (match) {
      const sign = match[1] === "-" ? -1 : 1;
      return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
    }
    if (name === "GMT" || name === "UTC") return 0;
  } catch {
    // Fall through to the wall-clock computation.
  }
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = Object.fromEntries(dtf.formatToParts(new Date(instantMs)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60000);
  } catch {
    return -new Date(instantMs).getTimezoneOffset();
  }
}

const pad = (n, width = 2) => String(Math.abs(Math.trunc(n))).padStart(width, "0");

/** "2026-11-04T18:12:00.000-08:00" — the instant, in that zone, offset explicit. */
export function isoInZone(iso, zone = LOCAL) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const offset = offsetMinutesAt(ms, zone);
  const wall = new Date(ms + offset * 60000);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}` +
    `T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}` +
    `.${pad(wall.getUTCMilliseconds(), 3)}${sign}${pad(abs / 60)}:${pad(abs % 60)}`
  );
}

/**
 * Rewrites a post's times — and its quote's — into `zone`, in place.
 * An explicit timestamp override in the drawer wins: it is the user's own
 * string, so it is sent untouched.
 */
export function localizeTimes(post, zone = LOCAL, { explicit = false } = {}) {
  if (!post || typeof post !== "object" || explicit) return post;
  // The quote, and the quote's quote: each level has its own clock.
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 2) return;
    if (typeof node.createdAt === "string") node.createdAt = isoInZone(node.createdAt, zone);
    if (typeof node.now === "string") node.now = isoInZone(node.now, zone);
    walk(node.quote, depth + 1);
  };
  walk(post, 0);
  return post;
}
