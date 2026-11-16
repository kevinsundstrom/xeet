// Hard tweets: real X posts that break naive renderers. Every entry carries its
// real `https://x.com/<handle>/status/<id>` URL (which prefills `#input`) plus
// the resolved `Post` and local static image paths so cycling is instant and
// offline while pasting any other `x.com` URL resolves live.

const NOW = "2026-11-13T04:00:00.000Z";

const vercel = { name: "Vercel", handle: "vercel", verified: "business", squareAvatar: true };
const rauchg = { name: "Guillermo Rauch", handle: "rauchg", verified: "blue", affiliate: { name: "Vercel" } };
const mw = { name: "Merriam-Webster", handle: "MerriamWebster", verified: "blue" };

export const HARD = [
  {
    id: "jack-20",
    url: "https://x.com/jack/status/20",
    title: "Post ID 20 (March 21, 2006)",
    why: "The root post of X: twenty-year timestamp formatting across web and iOS, plus the Square affiliate badge.",
    assets: { affiliateBadge: "./avatars/jack-badge.jpg" },
    post: {
      createdAt: "2006-03-21T20:50:14.000Z",
      author: { name: "jack", handle: "jack", verified: "blue", affiliate: { name: "Square" } },
      text: "just setting up my twttr",
      counts: { replies: 19252, reposts: 134466, likes: 327287, bookmarks: 25604 },
    },
  },
  {
    id: "nasa",
    url: "https://x.com/NASAGoddard/status/928356699043491842",
    title: "Emoji as layout",
    why: "Runs of spaces, emoji and a hashtag, positioned by hand in 2017.",
    post: {
      text: `🌟   .  *       .         🌙
                       *
*   .      🛰️     .        ✨      *
  .     * 
Thanks @Twitter, we can
always use more space 🚀     
      .              .        .
. *       🌏                      *
                      🌞
  *       ☄️
#280characters`,
      author: { name: "NASA Goddard", handle: "NASAGoddard", verified: "government", squareAvatar: true },
      createdAt: "2017-11-08T20:20:00.000Z",
      counts: { replies: 880, reposts: 109000, likes: 251000, bookmarks: 38 },
    },
  },
  {
    id: "anyways",
    url: "https://x.com/MerriamWebster/status/905445022878879744",
    title: "Box drawing and halfwidth katakana",
    why: "┻┳ and ﾉ are not in X's fonts, so the fallback has to match the platform's.",
    assets: { cards: { "https://t.co/GEui4hTlVN": "./cards/anyways.jpg" } },
    post: {
      text: `┻┳|
┳┻|
┻┳|
┳┻|
┻┳|
┳┻|
┻┳|
┳┻| _
┻┳| •.•)  'Anyways' is in the dictionary.
┳┻|⊂ﾉ   
┻┳|
https://t.co/GEui4hTlVN`,
      author: mw,
      createdAt: "2017-09-06T14:58:00.000Z",
      counts: { replies: 63, reposts: 499, likes: 1200 },
      links: {
        "https://t.co/GEui4hTlVN": {
          card: "summary_large_image",
          title: "Let's Talk About 'Anyways'",
          domain: "www.merriam-webster.com",
          display: "merriam-webster.com/words-at-play/…",
          image: { width: 724, height: 543 },
        },
      },
    },
  },
  {
    id: "whataboutism",
    url: "https://x.com/MerriamWebster/status/908706514302570497",
    title: "Radio buttons made of emoji",
    why: "⚪️ and 🔘 need their emoji presentation, and the trailing link becomes a card.",
    assets: { cards: { "https://t.co/N1P5g8XvYN": "./cards/whataboutism.jpg" } },
    post: {
      text: `I know

⚪️ I am
🔘 you are 

but what

⚪️ are you 
🔘 am I 

'Whataboutism,' explained: https://t.co/N1P5g8XvYN`,
      author: mw,
      createdAt: "2017-09-15T14:58:00.000Z",
      counts: { replies: 15, reposts: 409, likes: 921, bookmarks: 1 },
      links: {
        "https://t.co/N1P5g8XvYN": {
          card: "summary_large_image",
          title: "What about 'whataboutism'?",
          domain: "www.merriam-webster.com",
          display: "merriam-webster.com/words-at-play/…",
          image: { width: 724, height: 543 },
        },
      },
    },
  },
  {
    id: "pizza",
    url: "https://x.com/pizzahut/status/928347864471875585",
    title: "A dancing figure",
    why: "Kaomoji, ╯, preserved spaces and a line of pizza emoji that has to wrap.",
    post: {
      text: `(•_•)
<)   )╯50%
/    \\

\\(•_•)
 (   (>  Off
/    \\

 (•_•)
<)   )>  Menu
/    \\

🍕🍕🍕🍕 🍕 🍕 🍕 🍕 🍕 🍕 🍕 🍕 🍕 🍕🍕🍕🍕🍕 🍕 🍕 🍕 🍕 

Through 11/12.
#280characters`,
      author: { name: "Pizza Hut", handle: "pizzahut", verified: "business", squareAvatar: true },
      createdAt: "2017-11-08T19:45:00.000Z",
      counts: { replies: 53, reposts: 388, likes: 1000, bookmarks: 2 },
    },
  },
  {
    id: "rauchg-math-nested",
    url: "https://x.com/rauchg/status/2120188488628977819",
    title: "Math digits, checkmarks, Show more & nested quote",
    why: "✓, sans-serif bold math digits (𝟱𝟳,𝟴𝟵𝟳), circled ① ②, Show more truncation, and a two-level quote of a quote.",
    assets: {
      affiliateBadge: "./avatars/rauchg-badge.jpg",
      quoteAffiliateBadge: "./avatars/rauchg-badge.jpg",
    },
    post: {
      createdAt: "2026-11-10T16:15:01.000Z",
      author: rauchg,
      longPost: true,
      longPostBody: `Vercel Security Review, less than 1 week since launch:
✓ 𝟱𝟳,𝟴𝟵𝟳 vulnerabilities identified
✓ 𝟲,𝟬𝟮𝟵 critical or high 
✓ 𝟭𝟰,𝟲𝟲𝟱 already patched by Agent

I'm shocked at ① the number of critical vulnerabilities that would go unnoticed and ② the ease at which the`,
      text: `Vercel Security Review, less than 1 week since launch:
✓ 𝟱𝟳,𝟴𝟵𝟳 vulnerabilities identified
✓ 𝟲,𝟬𝟮𝟵 critical or high 
✓ 𝟭𝟰,𝟲𝟲𝟱 already patched by Agent

I'm shocked at ① the number of critical vulnerabilities that would go unnoticed and ② the ease at which the agent automatically fixes them.

You can turn it on for any repo, no matter where you deploy to.`,
      counts: { replies: 148, reposts: 52, likes: 548, views: 48145, bookmarks: 138 },
      quote: {
        author: rauchg,
        createdAt: "2026-11-05T01:23:39.000Z",
        text: `In just 24 hours 🤯
✓ 𝟲,𝟴𝟭𝟳 vulnerabilities identified
✓ 𝟱𝟴𝟬 critical or high
✓ 𝟭,𝟰𝟭𝟭 already patched by Agent

Vercel Security Reviews are 100% free until Nov 10`,
        quote: {
          author: vercel,
          createdAt: "2026-11-03T21:10:35.000Z",
          text: `Today we are launching Vercel Security Review in public beta.

Run vulnerability reviews on every push, and ship fixes in one click with Vercel Agent.

Read the blog → https://t.co/Uc5Aw9d1Q7`,
          links: {
            "https://t.co/Uc5Aw9d1Q7": { display: "vercel.com/blog/vercel-se…" },
          },
          media: [{ kind: "video", width: 3840, height: 2160 }],
        },
      },
    },
  },
  {
    id: "espn-attribution",
    url: "https://x.com/espn/status/2120005259485425936",
    title: "ZWJ emoji & From NFL video attribution",
    why: "👨‍🍳 is a three-code-point ZWJ sequence, and the embedded video credits From NFL next to the duration.",
    assets: {
      media: ["./cards/espn-video.jpg"],
      sourceAvatar: "./avatars/NFL.jpg",
    },
    post: {
      createdAt: "2026-11-10T04:06:56.000Z",
      author: { name: "ESPN", handle: "espn", verified: "business", squareAvatar: true },
      text: "Let James Cook 🔥👨‍🍳\n\n(via @NFL)\nhttps://t.co/DB1Rt6ziL8",
      entityLabels: { "@NFL": "@NFL" },
      media: [
        {
          kind: "video",
          width: 1920,
          height: 1080,
          duration: 5.13,
          sourceAuthor: { name: "NFL", handle: "NFL", verified: "business", squareAvatar: true },
        },
      ],
      counts: { replies: 32, reposts: 80, likes: 616, views: 194785, bookmarks: 10 },
    },
  },
  {
    id: "showmore",
    url: "https://x.com/karpathy/status/2116957135661945283",
    title: "Long post Show more & note entity links",
    why: "Timeline renders X's server cut with block Show more; expanded and detail show the full HackerTube note.",
    assets: { media: ["./cards/karpathy-hackertube.jpg"] },
    post: {
      createdAt: "2026-11-01T18:14:46.000Z",
      author: { name: "Andrej Karpathy", handle: "karpathy", verified: "blue" },
      longPost: true,
      longPostBody: `Weekend hack: HackerTube. I was annoyed with YouTube's recommendations so I had Claude filter down 43M comments over 20 years of HN to 6,454 videos that keep being recommended. *Significantly* better viewing experience, ~2 hours with Opus 5.5:
https://t.co/xULTGY6VhH

- Excellent https://t.co/QRq80bJo4o`,
      text: `Weekend hack: HackerTube. I was annoyed with YouTube's recommendations so I had Claude filter down 43M comments over 20 years of HN to 6,454 videos that keep being recommended. *Significantly* better viewing experience, ~2 hours with Opus 5.5:
https://t.co/JIhXN7OSh1

- Excellent recs without any logins (state is kept in local browser session)
- Thumbnail is a representative frame from middle of the video instead of the super duper A/B test hyper-optimized user uploads
- Underlying data from the comment analysis as one zip file, point your Claude at it and ask for your own version
- HackerTube Longs ✊

A bit more on the process:
I use Claude Code (desktop app for Mac), Opus 5.5 on Medium effort as my default. I only talk to Claude and have it do everything, the only "manual work" I helped with in tandem was in the browser (reminiscent of MenuGen): 1) I had to create some kind of API key from Google Cloud UI to query YouTube for video metadata, 2) I booted up a VPS box for serving and 3) I bought the domain name. Once the box was up I gave Claude the IP and told it update, secure, harden, deploy and optimize the code, and it did the whole thing.

Many awesome projects that would have normally taken weeks/months even can now be few-shotted for breakfast. What else are we not thinking of.`,
      links: {
        "https://t.co/JIhXN7OSh1": {
          card: "summary",
          title: "HackerTube",
          description: "The YouTube videos that Hacker News keeps telling each other to watch.",
          domain: "hackertube.org",
          display: "hackertube.org",
        },
        "https://t.co/xULTGY6VhH": {
          display: "hackertube.org",
        },
      },
      media: [{ kind: "image", width: 2482, height: 1442 }],
      counts: { replies: 2400, reposts: 6669, likes: 52557, views: 5828829, bookmarks: 43905 },
    },
  },
  {
    id: "poll",
    url: "https://x.com/mattpocockuk/status/1925021766793019888",
    title: "A finished developer poll",
    why: "Three bars (including 🍿) sized from 3,289 votes: pill bars on web and rectangular bars on iOS.",
    post: {
      createdAt: "2025-05-21T02:52:09.000Z",
      author: { name: "Matt Pocock", handle: "mattpocockuk", verified: "blue" },
      text: "When building software, what matters more?",
      counts: { replies: 86, reposts: 12, likes: 68, views: 46856, bookmarks: 8 },
      poll: { choices: ["Software quality", "Iteration speed", "🍿"], votes: [1441, 1212, 636] },
    },
  },
  {
    id: "duo-mihar",
    url: "https://x.com/mihar_22/status/2121039800329457748",
    title: "Web vs iOS cutoff on a long post",
    why: "Web cuts at 278 chars with block Show more; iOS (duo · 382) clamps the full note at 9 rows inline.",
    assets: { quoteMedia: ["./cards/ui-sdk-poster.jpg"] },
    post: {
      now: "2026-11-13T02:48:00.000Z",
      createdAt: "2026-11-13T00:37:50.000Z",
      author: { name: "Rahim", handle: "mihar_22", verified: "blue" },
      longPost: true,
      longPostBody:
        'This is so genuinely cool. I love how it\'s been packaged up. So elegant @shadcn and @shuding! I\'ll be studying this for a while.\n\n1. createAgent is an "agent bridge" which gives a snapshot, act, and query tool. It allows agents to interact with the actual UI components directly',
      text: `This is so genuinely cool. I love how it's been packaged up. So elegant @shadcn and @shuding! I'll be studying this for a while.

1. createAgent is an "agent bridge" which gives a snapshot, act, and query tool. It allows agents to interact with the actual UI components directly

2. Change callbacks know when the agent made the change (details.source === "agent"), and the app can refuse it with \`cancel\` (I love this)

3. Data attributes handle access and safety: data-agent-confirm (ask a person first), data-agent-secret (fill but never read), data-agent-hidden

4. Primitives declare what agents are allowed to do: \`agent: { actions: [...] }\`

5. Page-level tracking of every UI change with \`observe\` and \`history\`. It can stage changes, seek back, and undo them! -> history.undoSource("agent")

6. Testing primitives: checkPattern (checks against WAI-ARIA patterns), checkServer, checkDirection

7. Now this I really love because we do this for video.js as well (thanks to @darius_cepulis): docs ship inside the npm packages, so agents read the version you installed

There's just so much more, I'd type forever. It wasn't obvious to me on the surface but when I started digging in I was blown away by how cool this all is. 

Bravo 👏`,
      counts: { replies: 1, likes: 5, views: 308, bookmarks: 3 },
      quote: {
        text: "Introducing the UI SDK.",
        author: vercel,
        createdAt: "2026-11-12T18:40:00.000Z",
        media: [{ kind: "video", width: 1920, height: 1080, duration: 101.6 }],
      },
    },
  },
  {
    id: "duo-bscholl",
    url: "https://x.com/bscholl/status/2121045779913597432",
    title: "Nine lines on iOS, full post on web, quote of a quote",
    why: "272 chars: never truncated on web, yet tall enough across three paragraphs to clamp on iOS.",
    post: {
      now: "2026-11-13T01:12:00.000Z",
      createdAt: "2026-11-13T01:01:35.000Z",
      author: { name: "Blake Scholl 🛫", handle: "bscholl", verified: "blue" },
      text: `Sometimes the line between smashing success and abject failure is paper thin.

Startups only die for one reason: the founder gave up. You can always chew more glass. Once, I thought I might have to buy Boom out of bankruptcy.

Choose worthy missions. So you never give up.`,
      counts: { replies: 7, reposts: 18, likes: 198, views: 7614, bookmarks: 23 },
      quote: {
        text: "Thanks for being vulnerable. It's important for people to know how narrow the gap is between success and failure.",
        author: { name: "Angik Sarkar", handle: "kyunbit", verified: "blue" },
        createdAt: "2026-11-13T00:55:00.000Z",
        quote: {
          text: "Boom also had a board meeting where the board told me to shut the company down. XB-1 hadn’t broken the sound barrier yet. The team deployed in the Mojave desert was exhausted from months of fighting tough technical issues. We had only a few weeks of cash left and no one saw a",
          author: { name: "Blake Scholl 🛫", handle: "bscholl", verified: "blue" },
          createdAt: "2026-07-07T23:54:00.000Z",
        },
      },
    },
  },
  {
    id: "video-and-quote",
    url: "https://x.com/anabology/status/2120010995309457643",
    title: "Video and a quote together",
    why: "Media and a quoted post share one attachment slot: the 16:9 video renders above a compact quote card with a 16 px avatar.",
    assets: { media: ["./cards/anabology-video.jpg"] },
    post: {
      now: "2026-11-13T03:05:00.000Z",
      createdAt: "2026-11-10T04:29:43.000Z",
      author: { name: "anabology", handle: "anabology", verified: "blue" },
      text: `This was not a one-shot

It was a two-shot

I told Fable 5.2 to make the video of it's dreams, and 9 hours later:`,
      media: [{ kind: "video", width: 1920, height: 1080, duration: 243.5 }],
      counts: { replies: 398, reposts: 860, likes: 4901, views: 920766, bookmarks: 3504 },
      quote: {
        author: { name: "anabology", handle: "anabology", verified: "blue" },
        text: "Let's see how Fable 5.2 does with videos",
        createdAt: "2026-11-09T19:23:32.000Z",
      },
    },
  },
  {
    id: "vertical-video",
    url: "https://x.com/zackdfilms1/status/2121016684291014940",
    title: "A 9:16 vertical video",
    why: "Portrait media keeps its 9:16 aspect ratio at narrow widths and caps height at 510 px on wide columns, left-aligned on timeline.",
    assets: { media: ["./cards/zackd-vertical.jpg"] },
    post: {
      now: "2026-11-13T03:05:00.000Z",
      createdAt: "2026-11-12T23:05:58.000Z",
      author: { name: "Zack D. Films", handle: "zackdfilms1", verified: "blue" },
      text: "How Food Companies Make You Eat More 🤤",
      media: [{ kind: "video", width: 1080, height: 1920, duration: 54.72 }],
      counts: { replies: 33, reposts: 278, likes: 6246, views: 437160, bookmarks: 1360 },
    },
  },
  {
    id: "two-image-carousel",
    url: "https://x.com/adamfuhrer/status/2121031916971593832",
    title: "Two-image portrait carousel",
    why: "Two 3:4 photos fit side by side with squircle borders, so no indicator pills render even with empty text.",
    assets: { media: ["./cards/adamfuhrer-0.jpg", "./cards/adamfuhrer-1.jpg"] },
    post: {
      now: "2026-11-13T03:05:00.000Z",
      createdAt: "2026-11-13T00:06:30.000Z",
      author: { name: "Adam Fuhrer", handle: "adamfuhrer", verified: "blue" },
      text: "",
      media: [
        { kind: "image", width: 1536, height: 2048 },
        { kind: "image", width: 1536, height: 2048 },
      ],
      counts: { replies: 1, likes: 12, views: 623, bookmarks: 1 },
    },
  },
  {
    id: "twenty-image-carousel",
    url: "https://x.com/justinbieber/status/2120954896363200630",
    title: "20-image carousel with overflow & indicators",
    why: "Textless overflowing carousels add pill indicators above the slides and bleed the peeking slide right.",
    assets: { media: ["./cards/bieber-0.jpg", "./cards/bieber-1.jpg"] },
    post: {
      now: "2026-11-13T03:05:00.000Z",
      createdAt: "2026-11-12T19:00:27.000Z",
      author: { name: "Justin Bieber", handle: "justinbieber", verified: "blue" },
      text: "",
      media: [
        { kind: "image", width: 2048, height: 1356 },
        { kind: "image", width: 2048, height: 1356 },
        { kind: "image", width: 2048, height: 1356 },
        { kind: "image", width: 2048, height: 1356 },
        { kind: "image", width: 2048, height: 1356 },
        { kind: "image", width: 2048, height: 1356 },
        { kind: "image", width: 2048, height: 1534 },
        { kind: "image", width: 720, height: 539 },
        { kind: "image", width: 720, height: 539 },
        { kind: "image", width: 720, height: 539 },
        { kind: "image", width: 2048, height: 1356 },
        { kind: "image", width: 2048, height: 1356 },
        { kind: "image", width: 1024, height: 767 },
        { kind: "image", width: 1024, height: 767 },
        { kind: "image", width: 1024, height: 767 },
        { kind: "image", width: 1024, height: 767 },
        { kind: "image", width: 917, height: 687 },
        { kind: "image", width: 1548, height: 1159 },
        { kind: "image", width: 596, height: 446 },
        { kind: "image", width: 1080, height: 715 },
      ],
      counts: { replies: 648, reposts: 4786, likes: 38585, views: 1966542, bookmarks: 898 },
    },
  },
  {
    id: "twenty-strip-panorama",
    url: "https://x.com/ciguleva/status/2121073443533881486",
    title: "20-strip panoramic carousel",
    why: "Twenty 102×2048 vertical slices spaced 4 px apart, with a 7-slot windowed indicator bar and the affiliate badge.",
    assets: {
      affiliateBadge: "./avatars/restream-badge.jpg",
      media: [
        "./cards/ciguleva-0.jpg",
        "./cards/ciguleva-1.jpg",
        "./cards/ciguleva-2.jpg",
        "./cards/ciguleva-3.jpg",
        "./cards/ciguleva-4.jpg",
        "./cards/ciguleva-5.jpg",
        "./cards/ciguleva-6.jpg",
        "./cards/ciguleva-7.jpg",
        "./cards/ciguleva-8.jpg",
        "./cards/ciguleva-9.jpg",
        "./cards/ciguleva-10.jpg",
        "./cards/ciguleva-11.jpg",
        "./cards/ciguleva-12.jpg",
        "./cards/ciguleva-13.jpg",
        "./cards/ciguleva-14.jpg",
        "./cards/ciguleva-15.jpg",
        "./cards/ciguleva-16.jpg",
        "./cards/ciguleva-17.jpg",
        "./cards/ciguleva-18.jpg",
        "./cards/ciguleva-19.jpg",
      ],
    },
    post: {
      now: "2026-11-13T03:15:00.000Z",
      createdAt: "2026-11-13T02:51:31.000Z",
      author: {
        name: "Tatiana Tsiguleva",
        handle: "ciguleva",
        verified: "blue",
        affiliate: { name: "Restream" },
      },
      text: "",
      media: [
        102, 103, 102, 103, 102, 102, 103, 102, 103, 102,
        102, 103, 102, 103, 102, 102, 103, 102, 103, 102,
      ].map((width) => ({ kind: "image", width, height: 2048 })),
      counts: { replies: 5, reposts: 4, likes: 86, views: 3075, bookmarks: 13 },
    },
  },
  {
    id: "mri-video-poster",
    url: "https://x.com/anabology/status/2095355496530071898",
    title: "Video poster + compact vs detail quote media",
    why: "Timeline shrinks quoted media under a video to a 96×96 square; detail keeps the full 4.18:1 MRI strip.",
    assets: {
      media: ["./cards/mri-video-poster.jpg"],
      quoteMedia: ["./cards/mri-aion-quote.jpg"],
    },
    post: {
      now: "2026-11-13T03:45:00.000Z",
      createdAt: "2026-09-03T03:37:34.000Z",
      author: { name: "anabology", handle: "anabology", verified: "blue" },
      text: "SHOT ON MRI",
      media: [{ kind: "video", width: 1920, height: 1080, duration: 29.43 }],
      counts: { replies: 38, reposts: 40, likes: 688, views: 275870, bookmarks: 170 },
      quote: {
        author: { name: "anabology", handle: "anabology", verified: "blue" },
        createdAt: "2026-09-01T17:23:01.000Z",
        text: `Fun demo today:

While traveling, I remotely drove an MRI in our lab to write AION into a tube of water

The 'ink' lasts seconds: the letters are physically written into the magnetization of the water protons (aka SPAMM MRI)`,
        media: [{ kind: "image", width: 3312, height: 792 }],
      },
    },
  },
].map((item) => ({ ...item, post: { now: NOW, ...item.post } }));
