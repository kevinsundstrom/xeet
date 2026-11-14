// JSON Schema for the input contract, for agents (PLAN.md §2 point 1).
//
// This mirrors `crates/xeet-core/src/model.rs`. It is checked against the Rust
// source in CI (`tools/ship/check-schema.mjs`) so the two cannot drift: the
// schema is documentation for a model, and documentation that lies is worse
// than none.

const VERIFIED = ["none", "blue", "business", "government"];
const MEDIA_KIND = ["image", "gif", "video"];
const CARD_TYPES = ["summary", "summary_large_image", "player", "app"];

/**
 * The fields of a `Post` (model.rs), *without* `quote`: a quoted post has the
 * same shape as the post that quotes it, so the depth lives in one place below.
 */
const authorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "Display name, as shown in bold." },
    handle: { type: "string", description: "Handle without the @." },
    verified: { type: "string", enum: VERIFIED, description: "Badge: none, blue, business (gold) or government (grey)." },
    avatar: { type: "string", description: "Avatar image bytes, base64 (PNG, JPEG or WebP). Omit for a placeholder." },
    squareAvatar: { type: "boolean", description: "Square avatar, as X uses for business accounts." },
    protected: { type: "boolean", description: "Account is protected (lock icon)." },
    affiliate: {
      type: ["object", "null"],
      description: "Affiliated organization, shown as a small square badge after the name.",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        badge: { type: ["string", "null"], description: "Badge image bytes, base64. Omit for a placeholder square." },
      },
    },
  },
};

const postProps = {
    text: {
      type: "string",
      description:
        "The post body, exactly as typed. Twitter-text is applied to it: URLs, mentions, hashtags and cashtags are found, and weighted length is measured (280 unless a long post).",
      maxLength: 100000,
    },
    author: authorSchema,
    media: {
      type: "array",
      maxItems: 20,
      description: "Attachments in order: up to 20 carousel images, or one video or GIF.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["width", "height"],
        properties: {
          kind: { type: "string", enum: MEDIA_KIND },
          width: { type: "integer", minimum: 1, maximum: 8192 },
          height: { type: "integer", minimum: 1, maximum: 8192 },
          alt: { type: "string", description: "ALT text; shows the ALT badge." },
          data: { type: "string", description: "Image bytes, base64. Omit to render the placeholder with the correct crop." },
          duration: { type: "number", description: "Video duration in seconds, for the badge." },
          sourceAuthor: {
            ...authorSchema,
            type: ["object", "null"],
            description: "Original author when this media was embedded from another post (Post video / Post photo).",
          },
        },
      },
    },
    links: {
      type: "object",
      description:
        "Card metadata keyed by the URL as written in the text. Link metadata is input: xeet never fetches a URL.",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          card: {
            type: ["string", "null"],
            enum: [...CARD_TYPES, null],
            description: "The twitter:card type. null means the page has no valid card, so no card is shown.",
          },
          title: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          domain: { type: ["string", "null"], description: "Domain on the card; defaults to the URL's host." },
          image: {
            type: ["object", "null"],
            additionalProperties: false,
            properties: {
              width: { type: "integer" },
              height: { type: "integer" },
              data: { type: "string", description: "base64 image bytes" },
            },
          },
        },
      },
    },
    entityLabels: {
      type: "object",
      description:
        "Display text for entities the server renders differently from the source token, keyed by the token as written (a payload's `@Bot` renders as the canonical `@bot`). A draft leaves this empty.",
      additionalProperties: { type: "string" },
    },
    cardState: {
      type: "string",
      enum: ["auto", "dismissed"],
      description:
        "The composer's card preview state. `dismissed` means the author closed the card: no card renders, and no other link inherits it (PLAN.md §3).",
    },
    poll: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        choices: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", maxLength: 25 } },
        votes: { type: ["array", "null"], items: { type: "integer", minimum: 0 } },
        secondsLeft: { type: ["integer", "null"], minimum: 0 },
      },
    },
    createdAt: { type: "string", description: "ISO 8601 post time, for the timestamp." },
    now: { type: "string", description: "ISO 8601 reference time for relative timestamps. The core has no clock." },
    counts: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        replies: { type: "integer", minimum: 0 },
        reposts: { type: "integer", minimum: 0 },
        likes: { type: "integer", minimum: 0 },
        views: { type: "integer", minimum: 0 },
        bookmarks: { type: "integer", minimum: 0 },
      },
    },
    longPost: { type: ["boolean", "null"], description: "Server flag for long posts (note_tweet). Derived from length when absent." },
    longPostBody: {
      type: ["string", "null"],
      description:
        "The body X's server puts in a timeline cell for a long post: the cut point already applied, in code points of the authored text. Absent for a draft, where rules derives the cut.",
    },
    appVersion: {
      type: ["string", "null"],
      description:
        "X web client version (data-app-version) whose rules to apply, for reproducing a captured page. Absent: the newest version in the ruleset. Long-post expansion differs between versions (SPEC.md §5.1).",
    },
    replyTo: {
      type: ["string", "null"],
      description:
        "Set when the post is a reply (the status id it answers). X hides a reply's leading mentions; a plain post that starts with @name keeps them.",
    },
    replyToHandle: {
      type: ["string", "null"],
      description:
        "Screen name of the post this replies to, without the @, as the `Replying to @handle` row prints it.",
    },
    socialContext: {
      type: ["string", "null"],
      enum: ["pinned", null],
      description: "The context row X draws above the post inside its cell: `pinned` on a profile timeline. Omit for a plain cell.",
    },
    mediaTags: {
      type: "array",
      description: "Accounts tagged in the media, as display names in tag order (X shows \"Name and 2 others\" under the media).",
      items: { type: "string" },
  },
};

/**
 * A quoted post, spelled out to the depth X renders.
 *
 * `post.quote` is depth 1 and `post.quote.quote` is depth 2; at depth 2 the
 * `quote` field is typed `null`, so a third level is invalid here exactly as it
 * is in the Rust core (`invalid_post` at `post.quote.quote.quote`, PLAN.md §13).
 * The recursion is inlined
 * rather than written as a `$ref`, because a `$defs` block is not resolved by
 * every MCP client — the same reason the rest of this schema is inlined — and it
 * is bounded at two, so the blow-up is one extra copy of the field list.
 */
const quotedPost = (depth) => ({
  type: ["object", "null"],
  additionalProperties: false,
  required: ["text"],
  description:
    depth === 1
      ? "The quoted post (depth 1)."
      : "The quoted post's quote (depth 2): the deepest level X renders.",
  properties: {
    ...postProps,
    quote:
      depth === 1
        ? quotedPost(2)
        : {
            type: "null",
            description:
              "X shows at most two levels of quoting: a third is refused (`invalid_post` at `post.quote.quote.quote`).",
          },
  },
});

export const postSchema = {
  $id: "https://xeet.sh/schema/post.json",
  title: "Post",
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { ...postProps, quote: quotedPost(1) },
};

/** `RenderOptions` (model.rs). */
export const optionsSchema = {
  $id: "https://xeet.sh/schema/options.json",
  title: "RenderOptions",
  type: "object",
  additionalProperties: false,
  properties: {
    surface: {
      type: "string",
      enum: ["web-timeline", "web-detail", "ios-timeline", "ios-detail"],
      description:
        "Which view of X. web-timeline cuts note_tweet posts and renders Show more on its own line; ios-timeline clamps bodies at 9 visual rows with inline '... Show more', 47.5pt avatars and equal-spaced actions; web-detail and ios-detail render full lead text without truncating.",
      default: "web-timeline",
    },
    width: { type: "number", minimum: 100, maximum: 1200, description: "Viewport width in CSS pixels. The column is min(width, 600).", default: 600 },
    theme: { type: "string", enum: ["light", "dark"], default: "light" },
    dpr: { type: "number", enum: [1, 2, 3], description: "Device pixel ratio.", default: 2 },
    fontScale: { type: "number", minimum: 0.5, maximum: 2, description: "X's user font-size setting.", default: 1 },
    expanded: {
      type: "boolean",
      description: "Render with Show more toggled on: shows the full post body in place instead of cutting it on the timeline.",
      default: false,
    },
  },
};

/** The `sheet` request. */
export const sheetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["post"],
  properties: {
    post: postSchema,
    widths: { type: "array", maxItems: 6, items: { type: "number", minimum: 100, maximum: 1200 }, default: [320, 390, 600] },
    themes: { type: "array", items: { type: "string", enum: ["light", "dark"] }, default: ["light", "dark"] },
    dpr: { type: "number", enum: [1, 2, 3], default: 2 },
  },
};
