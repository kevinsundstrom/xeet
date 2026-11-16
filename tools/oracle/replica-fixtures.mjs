// The frame stream's fixture suite: posts x surfaces x widths x themes.
//
//   node tools/oracle/replica-fixtures.mjs > tmp/frame/fixtures.json
//   node tools/oracle/replica.mjs --fixtures tmp/frame/fixtures.json --out tmp/frame/geometry
//
// The geometry it produces is the ground truth `examples/frame_parity.rs`
// compares xeet's layout against. Every case is chosen for a decision the
// frame has to make: truncation of names and handles, badges, counts that
// abbreviate, blank lines, entities, RTL, long posts that clamp.

// Two long-post cuts: at 320/390/600 the first leaves room for the button on
// the last line, the second does not (Chrome then keeps the body's space at the
// end of the line and starts the button at x 0 on the next one).
const LONG_BODY_FIT =
  "Introducing Gemini 4 Carbon, our latest frontier model. Carbon delivers improved performance across domains and sets a new state-of-the-art.";
const LONG_BODY_WRAP =
  "We are first making Carbon available to a subset of trusted cyber defenders across the network, and it will roll out to everyone else over the coming weeks as we finish the remaining evals.";

// Verbatim from the captured cell (`Google.html`, status 2119788086490001906),
// including the trailing space the page leaves before the button.
const LONG_BODY_GOOGLE_REAL =
  "Today, we're expanding our eighth-generation TPU portfolio with two new systems built specifically for the agentic era \u2014 bringing our total to four distinct eighth-generation TPU systems launched in a single year.\n\nTPU 8i Max was built for massive context windows and the highest ";

const LONG_BODY_TAIL =
  "I just added the National Center for AI to the institute network, which grows it to more than 40 institutes across the country. More soon.";

const NOW = 1794300000000; // 2026-11-10T06:00:00Z, fixed so runs are reproducible
const DAY = 86400000;

export const POSTS = [
  {
    name: "plain",
    post: {
      name: "Vercel",
      handle: "vercel",
      verified: "blue",
      timestamp: NOW - 3 * 3600 * 1000,
      counts: { replies: 1266, reposts: 3400000, likes: 12345678, views: 987654, bookmarks: 12 },
      text: [{ kind: "plain", text: "We just shipped the thing." }],
    },
  },
  {
    name: "entities",
    post: {
      name: "Guillermo Rauch",
      handle: "rauchg",
      verified: "blue",
      timestamp: NOW - 42 * 60 * 1000,
      counts: { replies: 12, reposts: 340, likes: 5432, views: 133337, bookmarks: 4 },
      text: [
        { kind: "plain", text: "Shipping " },
        { kind: "mention", text: "@vercel" },
        { kind: "plain", text: " with " },
        { kind: "hashtag", text: "#ShipIt" },
        { kind: "plain", text: " and " },
        { kind: "cashtag", text: "$TSLA" },
        { kind: "plain", text: ".\n\nRead: " },
        { kind: "url", text: "https://vercel.com/blog/the-thing", display: "vercel.com/blog/the-thing" },
      ],
    },
  },
  {
    name: "blank-lines",
    post: {
      name: "Lines",
      handle: "lines",
      verified: "none",
      timestamp: NOW - 5 * 1000,
      text: [{ kind: "plain", text: "one\n\ntwo\nthree\n\n\nfour" }],
    },
  },
  {
    name: "no-badge-no-counts",
    post: {
      name: "Anonymous",
      handle: "anon",
      verified: "none",
      timestamp: NOW - 5 * DAY,
      text: [{ kind: "plain", text: "Hello." }],
    },
  },
  {
    name: "long-name",
    post: {
      name: "The Extremely Long Display Name Of A Person Who Really Needed Every Character",
      handle: "longnamer",
      verified: "government",
      timestamp: NOW - 400 * DAY,
      counts: { replies: 1, reposts: 1, likes: 999, views: 1000, bookmarks: 1 },
      text: [{ kind: "plain", text: "Short." }],
    },
  },
  {
    name: "emoji-name",
    post: {
      name: "🚀 Launchpad 🛰️ — Space Stuff",
      handle: "launchpad",
      verified: "business",
      timestamp: NOW - 2 * 24 * 3600 * 1000 - 60 * 1000,
      counts: { replies: 2, reposts: 3, likes: 4, views: 5, bookmarks: 6 },
      text: [{ kind: "plain", text: "Emoji in the text 🎉🙌🏽 and a long word: supercalifragilisticexpialidocious-and-then-some" }],
    },
  },
  {
    name: "long-handle",
    post: {
      name: "Name",
      handle: "a_really_long_handle_that_should_not_fit_anywhere_near_the_header_row",
      verified: "blue",
      timestamp: NOW - 3600 * 1000,
      counts: { replies: 1, reposts: 2, likes: 3, views: 4, bookmarks: 5 },
      text: [{ kind: "plain", text: "Handle truncation." }],
    },
  },
  {
    name: "clamp",
    post: {
      name: "Long Post",
      handle: "longpost",
      verified: "blue",
      timestamp: NOW - 30 * 60 * 1000,
      counts: { replies: 126, reposts: 1290, likes: 54321, views: 654321, bookmarks: 78 },
      clamp: 4,
      text: [
        {
          kind: "plain",
          text:
            "Here is a longer post that exists purely so the timeline has something to clamp, with enough words in it to run past four lines at every width we test. It keeps going for a while: one more sentence, another clause, and then a final trailing fragment that will not fit.",
        },
      ],
    },
  },
  {
    // Chrome's `-webkit-line-clamp` ellipsis, the four shapes it can take.
    // The DOM exposes the clamped line's text and box but not the `…` glyph
    // (a pseudo-element), so these fixtures exist to be compared in pixels.
    name: "clamp-blank",
    post: {
      name: "Clamped",
      handle: "clamped",
      verified: "blue",
      timestamp: NOW - 40 * 60 * 1000,
      counts: { replies: 2, reposts: 3, likes: 4, views: 5000, bookmarks: 1 },
      clamp: 5,
      text: [
        {
          kind: "plain",
          text:
            "One line of text here.\nTwo line of text here.\nThree line of text here.\nFour line of text here.\n\nAnd here is a second paragraph that the clamp has to cut off, because it goes on and on.",
        },
      ],
    },
  },
  {
    name: "clamp-overflow",
    post: {
      name: "Clamped",
      handle: "clamped",
      verified: "blue",
      timestamp: NOW - 40 * 60 * 1000,
      counts: { replies: 2, reposts: 3, likes: 4, views: 5000, bookmarks: 1 },
      clamp: 3,
      text: [
        {
          kind: "plain",
          text:
            "Here is a longer post that exists purely so the timeline has something to clamp, with enough words in it to run past three lines at every width we test. It keeps going for a while: one more sentence, another clause, and then a final trailing fragment that will not fit.",
        },
      ],
    },
  },
  {
    name: "clamp-rtl",
    post: {
      name: "مرحبا بالعالم",
      handle: "arabic",
      verified: "blue",
      timestamp: NOW - 40 * 60 * 1000,
      counts: { replies: 2, reposts: 3, likes: 4, views: 5000, bookmarks: 1 },
      clamp: 2,
      text: [
        {
          kind: "plain",
          text:
            "مرحبا بالعالم هذا نص عربي طويل جدا يحتاج الى اسطر كثيرة للعرض على الشاشة ثم يقطع عند السطر الثاني",
        },
      ],
    },
  },
  {
    name: "clamp-emoji",
    post: {
      name: "Clamped",
      handle: "clamped",
      verified: "blue",
      timestamp: NOW - 40 * 60 * 1000,
      counts: { replies: 2, reposts: 3, likes: 4, views: 5000, bookmarks: 1 },
      clamp: 2,
      text: [
        {
          kind: "plain",
          text:
            "one two three four five six 🎉🎉🎉 seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen",
        },
      ],
    },
  },
  {
    // A business account: X gives it `x-avatar rounded-[10%] size-10` (4px on
    // the 40px slot) instead of `rounded-full` (20px), and a square shape.
    name: "business-square",
    post: {
      name: "NBA",
      handle: "NBA",
      verified: "business",
      squareAvatar: true,
      timestamp: NOW - 90 * 60 * 1000,
      counts: { replies: 120, reposts: 340, likes: 5600, views: 91000, bookmarks: 12 },
      text: [{ kind: "plain", text: "Square avatar, gold check." }],
    },
  },
  {
    name: "rtl",
    post: {
      name: "مرحبا بالعالم",
      handle: "arabic",
      verified: "blue",
      timestamp: NOW - 7200 * 1000,
      counts: { replies: 10, reposts: 20, likes: 30, views: 40, bookmarks: 50 },
      text: [{ kind: "plain", text: "هذا نص بالعربية مع أرقام 12345 وكلمات إنجليزية mixed in." }],
    },
  },
  {
    // The detail view's "N Views" label switches format at 10,000
    // (`view-count-utils`): plain grouped below, compact above. These four
    // posts straddle that boundary; the timeline shows the same numbers
    // through the *action row* formatter, which is a different ladder.
    name: "views-9999",
    post: {
      name: "Views",
      handle: "views",
      verified: "blue",
      timestamp: NOW - 4 * 3600 * 1000,
      counts: { replies: 1, reposts: 2, likes: 3, views: 9999, bookmarks: 4 },
      text: [{ kind: "plain", text: "Just short of the boundary." }],
    },
  },
  {
    name: "views-10000",
    post: {
      name: "Views",
      handle: "views",
      verified: "blue",
      timestamp: NOW - 4 * 3600 * 1000,
      counts: { replies: 1, reposts: 2, likes: 3, views: 10000, bookmarks: 4 },
      text: [{ kind: "plain", text: "Exactly the boundary." }],
    },
  },
  {
    name: "views-10355",
    post: {
      name: "Views",
      handle: "views",
      verified: "blue",
      timestamp: NOW - 4 * 3600 * 1000,
      counts: { replies: 1, reposts: 2, likes: 3, views: 10355, bookmarks: 4 },
      text: [{ kind: "plain", text: "One truncated fraction digit above it." }],
    },
  },
  {
    name: "views-1234567",
    post: {
      name: "Views",
      handle: "views",
      verified: "blue",
      timestamp: NOW - 4 * 3600 * 1000,
      counts: { replies: 1, reposts: 2, likes: 3, views: 1234567, bookmarks: 4 },
      text: [{ kind: "plain", text: "Millions." }],
    },
  },
  {
    // Affiliation badge: a second 1em square after the check, 4px later, so the
    // name span is 19px wider (measured on jack's post). A long name makes the
    // badge eat into the name and squeeze the handle.
    name: "affiliate-blue",
    post: {
      name: "The Extremely Long Display Name Of A Person With An Affiliation",
      handle: "affiliate",
      verified: "blue",
      affiliate: { name: "Square", color: "#f0b429" },
      timestamp: NOW - 3 * 3600 * 1000,
      counts: { replies: 12, reposts: 340, likes: 5432, views: 133337, bookmarks: 4 },
      text: [{ kind: "plain", text: "Affiliated and verbose." }],
    },
  },
  {
    name: "affiliate-business",
    post: {
      name: "Acme",
      handle: "acme",
      verified: "business",
      affiliate: { name: "Acme Labs", color: "#6b4fbb" },
      timestamp: NOW - 26 * 3600 * 1000,
      counts: { replies: 1266, reposts: 3400000, likes: 12345678, views: 987654, bookmarks: 12 },
      text: [{ kind: "plain", text: "Gold check with an affiliate." }],
    },
  },
  {
    // A long post: the server cut the body and the inline `Show more` button
    // (`display: inline-block`, atomic) follows the last span after one space.
    // Two cuts — one leaving room for the button on the last line, one not, so
    // both "trails the last line" and "wraps as a unit onto its own line" are
    // covered at every width.
    name: "longpost-fit",
    // Timeline only: the cut body and its `Show more` are the timeline
    // affordance — `rules::decide` reports `ShowMore::Inline` on that surface
    // and leaves the detail view's body whole.
    surfaces: ["timeline"],
    post: {
      name: "Google DeepMind",
      handle: "GoogleDeepMind",
      verified: "blue",
      timestamp: NOW - 2 * 3600 * 1000,
      counts: { replies: 91, reposts: 412, likes: 3102, views: 88112, bookmarks: 23 },
      longPost: true,
      body: LONG_BODY_FIT,
      showMore: true,
      text: [{ kind: "plain", text: LONG_BODY_FIT }],
    },
  },
  {
    name: "longpost-wrap",
    surfaces: ["timeline"],
    post: {
      name: "Cloudflare",
      handle: "Cloudflare",
      verified: "blue",
      timestamp: NOW - 26 * 3600 * 1000,
      counts: { replies: 12, reposts: 88, likes: 903, views: 41002, bookmarks: 7 },
      longPost: true,
      body: LONG_BODY_WRAP,
      showMore: true,
      text: [{ kind: "plain", text: LONG_BODY_WRAP }],
    },
  },
  {
    // The exact post from `Google.html` (`2119788086490001906`) that the e2e
    // harness reports as `long-post:text`: the page shows five lines of body
    // and puts `Show more` on a sixth (the column is 520px, the last line ends
    // at 456.3125 + a 3.390625 space, and the button is 77.703125 wide —
    // 456.3125 + 3.390625 + 77.703125 = 537.4 > 520). Ours kept it on the
    // fifth line, which is what this fixture pins down.
    name: "longpost-google-real",
    surfaces: ["timeline"],
    post: {
      name: "Google",
      handle: "Google",
      verified: "blue",
      timestamp: NOW - 4 * 3600 * 1000,
      counts: { replies: 210, reposts: 1804, likes: 21033, views: 640012, bookmarks: 402 },
      longPost: true,
      body: LONG_BODY_GOOGLE_REAL,
      showMore: true,
      text: [{ kind: "plain", text: LONG_BODY_GOOGLE_REAL }],
    },
  },
  {
    // The other half of the pair: a cut whose last line is short, so the button
    // stays on it (Chrome: `Google.html`'s first long post keeps the button at
    // x 152.266 on the text's last line).
    name: "longpost-tail",
    surfaces: ["timeline"],
    post: {
      name: "Google AI",
      handle: "GoogleAI",
      verified: "blue",
      timestamp: NOW - 5 * 3600 * 1000,
      counts: { replies: 18, reposts: 204, likes: 1876, views: 53033, bookmarks: 9 },
      longPost: true,
      body: LONG_BODY_TAIL,
      showMore: true,
      text: [{ kind: "plain", text: LONG_BODY_TAIL }],
    },
  },
  {
    // A pinned cell: the context row ("Pinned") is the article's first child,
    // one 4px gap above the avatar/header row, and adds 20px (16 + 4). A long
    // name keeps it in play with the truncation model.
    name: "pinned",
    surfaces: ["timeline"],
    post: {
      name: "Acme",
      handle: "acme",
      verified: "blue",
      pinned: true,
      timestamp: NOW - 5 * 3600 * 1000,
      counts: { replies: 12, reposts: 340, likes: 5432, views: 133337, bookmarks: 4 },
      text: [{ kind: "plain", text: "The pinned one." }],
    },
  },
  {
    name: "pinned-longname",
    surfaces: ["timeline"],
    post: {
      name: "A Very Long Display Name That Will Need Truncating On Narrow Columns",
      handle: "a_really_long_handle_to_squeeze_the_header",
      verified: "government",
      pinned: true,
      timestamp: NOW - 3 * 24 * 3600 * 1000,
      counts: { replies: 1, reposts: 2, likes: 3, views: 4, bookmarks: 5 },
      text: [{ kind: "plain", text: "Pinned with a long name." }],
    },
  },
  {
    name: "single-char",
    post: {
      name: "x",
      handle: "x",
      verified: "none",
      timestamp: NOW - 1000 * 1000,
      text: [{ kind: "plain", text: "." }],
    },
  },
];

export const SURFACES = ["timeline", "detail"];
export const WIDTHS = [320, 390, 600];
export const THEMES = ["light", "dark"];

/** The full matrix, plus a scaled-font case for each surface. */
export function suite() {
  const out = matrix();
  for (const theme of THEMES) {
    for (const surface of SURFACES) {
      const plain = POSTS[0];
      out.push({
        name: `fontscale.${surface}.390.${theme}`,
        surface,
        width: 390,
        theme,
        dpr: 2,
        fontScale: 1.25,
        post: { ...plain.post, now: NOW },
      });
    }
    // A pinned cell at a scaled font: the row is `max(16, subtext2 line-height)`
    // and the icon never scales.
    const pinned = POSTS.find((p) => p.name === "pinned");
    out.push({
      name: `fontscale.pinned.390.${theme}`,
      surface: "timeline",
      width: 390,
      theme,
      dpr: 2,
      fontScale: 1.25,
      post: { ...pinned.post, now: NOW },
    });
  }
  return out;
}

function matrix() {
  const out = [];
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      for (const surface of SURFACES) {
        for (const p of POSTS) {
          if (p.surfaces && !p.surfaces.includes(surface)) continue;
          out.push({
            name: `${p.name}.${surface}.${width}.${theme}`,
            surface,
            width,
            theme,
            dpr: 2,
            post: { ...p.post, now: NOW },
          });
        }
      }
    }
  }
  return out;
}

if (process.argv[1]?.endsWith("replica-fixtures.mjs")) {
  const light = process.argv.includes("--theme") ? process.argv[process.argv.indexOf("--theme") + 1] : null;
  const all = suite();
  console.log(JSON.stringify(light ? all.filter((f) => f.theme === light) : all, null, 2));
}
