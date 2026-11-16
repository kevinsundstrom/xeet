// A stand-in for the playground server, for building the UI before pg-server's
// routes exist (add ?mock to the URL).
//
// It answers the same shapes as docs/PLAYGROUND.md and renders real PNGs on a
// canvas — the four targets differ slightly on purpose, so the pixel diff, the
// height delta and the column state machine get exercised end to end. Every
// target reports a version, `native` is stale so the Rebuild button has work.

const FONT = '"Chirp", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

const VERSIONS = {
  chrome: {
    rev: "3f2a1c9d4b7e6051a8c3f9d2e1b0a4c7d6e5f803",
    dirty: false,
    builtAt: "2026-11-09T18:04:12.000Z",
    ruleset: "x-web@3e351742",
    upstream: "89824c04",
  },
  wasm: {
    rev: "3f2a1c9d4b7e6051a8c3f9d2e1b0a4c7d6e5f803",
    dirty: false,
    builtAt: "2026-11-09T18:05:40.000Z",
    ruleset: "x-web@3e351742",
    upstream: "89824c04",
  },
  native: {
    rev: "9a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d",
    dirty: true,
    builtAt: "2026-11-09T12:31:02.000Z",
    ruleset: "x-web@3e351742",
    upstream: "89824c04",
  },
  http: {
    rev: "3f2a1c9d4b7e6051a8c3f9d2e1b0a4c7d6e5f803",
    dirty: false,
    builtAt: "2026-11-09T18:06:11.000Z",
    ruleset: "x-web@3e351742",
    upstream: "89824c04",
  },
};

const LATENCY = { chrome: [170, 90], native: [7, 5], http: [14, 9] };

class MockApiError extends Error {
  constructor(code, message, fields = []) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = 400;
    this.fields = fields;
  }
}

// ---------------------------------------------------------------------------
// Text layout (a stand-in for the renderer: same kind of boxes, not the same)

function wrapText(ctx, text, width) {
  const out = [];
  for (const paragraph of String(text).split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue;
      const candidate = line + word;
      if (ctx.measureText(candidate).width <= width || !line) {
        line = candidate;
      } else {
        out.push(line.replace(/\s+$/, ""));
        line = word.replace(/^\s+/, "");
      }
      while (ctx.measureText(line).width > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.replace(/\s+$/, ""));
  }
  return out;
}

function palette(theme) {
  return theme === "dark"
    ? { bg: "#000000", text: "#e7e9ea", muted: "#71767b", line: "#2f3336", fill: "#16181c", accent: "#1d9bf0" }
    : { bg: "#ffffff", text: "#0f1419", muted: "#536471", line: "#cfd9de", fill: "#f7f9f9", accent: "#1d9bf0" };
}

function timeLabel(post) {
  const created = post.createdAt ? new Date(post.createdAt) : new Date();
  const now = post.now ? new Date(post.now) : created;
  const seconds = Math.max(0, (now - created) / 1000);
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  const d = created;
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function humanCount(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K`;
  return `${(n / 1e6).toFixed(1)}M`;
}

function layoutPost(post, options) {
  const dpr = options.dpr ?? 2;
  // X's post column is min(viewport, 600), the same rule the real renderer has.
  const width = Math.min(Number(options.width) || 390, 600);
  const detail = options.surface === "web-detail";
  const scale = options.fontScale ?? 1;
  const fs = (detail ? 17 : 15) * scale;
  const lh = (detail ? 24 : 20) * scale;
  const pad = 16;
  const avatarSize = detail ? 44 : 40;
  const x0 = pad + avatarSize + 12;
  const tw = width - x0 - pad;
  const p = palette(options.theme);
  const measure = document.createElement("canvas").getContext("2d");

  const ops = [];
  const geometry = { lines: [], boxes: [] };
  let y = pad;

  const author = post.author ?? {};
  const name = author.name || "New post";
  const handle = author.handle ? `@${author.handle}` : "@draft";

  ops.push({ type: "avatar", x: pad, y, size: avatarSize, square: !!author.squareAvatar, data: author.avatar ?? null });
  measure.font = `700 ${fs}px ${FONT}`;
  ops.push({ type: "text", x: x0, y, fs, weight: 700, text: name, color: p.text });
  let x = x0 + measure.measureText(name).width + 5;
  if (author.verified && author.verified !== "none") {
    ops.push({ type: "badge", x, y: y + 2, size: fs - 1, kind: author.verified });
    x += fs + 2;
  }
  if (author.affiliate?.name) {
    ops.push({ type: "square", x, y: y + 2, size: fs - 1, color: p.muted });
    x += fs + 2;
  }
  measure.font = `400 ${fs}px ${FONT}`;
  const sub = `${handle} · ${timeLabel(post)}`;
  ops.push({ type: "text", x, y, fs, text: sub, color: p.muted });
  geometry.boxes.push({ x: x0, y, w: tw, h: lh, kind: "author" });
  y += lh + 2;

  measure.font = `400 ${fs}px ${FONT}`;
  const lines = wrapText(measure, post.text ?? "", tw);
  for (let i = 0; i < lines.length; i++) {
    ops.push({ type: "text", x: x0, y: y + i * lh, fs, text: lines[i], color: p.text, lineIndex: i });
    geometry.lines.push({ x: x0, y: y + i * lh, w: tw, h: lh, text: lines[i] });
  }
  y += Math.max(1, lines.length) * lh + 6;

  // Attachments: media, then card, then poll (the mock does not pick: it draws
  // whichever the post carries, which is enough to exercise the diff).
  const media = Array.isArray(post.media) ? post.media.slice(0, 4) : [];
  if (media.length) {
    const boxH = media.length === 1 ? Math.round(tw * 0.56) : Math.round(tw * 0.5);
    ops.push({ type: "media", x: x0, y, w: tw, h: boxH, items: media });
    geometry.boxes.push({ x: x0, y, w: tw, h: boxH, kind: "media" });
    y += boxH + 8;
  } else if (post.poll?.choices?.length) {
    const rowH = 30;
    const boxH = post.poll.choices.length * rowH + 8;
    ops.push({ type: "poll", x: x0, y, w: tw, h: boxH, poll: post.poll });
    geometry.boxes.push({ x: x0, y, w: tw, h: boxH, kind: "poll" });
    y += boxH + 8;
  } else if (post.quote) {
    const quoteLines = wrapText(measure, post.quote.text ?? "", tw - 24);
    const boxH = quoteLines.length * lh + 52;
    ops.push({ type: "quote", x: x0, y, w: tw, h: boxH, quote: post.quote, lines: quoteLines });
    geometry.boxes.push({ x: x0, y, w: tw, h: boxH, kind: "quote" });
    y += boxH + 8;
  } else {
    const card = post.links ? Object.values(post.links)[0] : null;
    if (card) {
      const imageH = card.card === "summary_large_image" ? Math.round(tw * 0.5) : 0;
      const boxH = imageH + (card.title || card.description ? 52 : 24);
      ops.push({ type: "card", x: x0, y, w: tw, h: boxH, imageH, meta: card });
      geometry.boxes.push({ x: x0, y, w: tw, h: boxH, kind: "card" });
      y += boxH + 8;
    }
  }

  // Action row
  const counts = post.counts ?? {};
  const actions = [
    ["reply", counts.replies],
    ["repost", counts.reposts],
    ["like", counts.likes],
    ["view", counts.views],
    ["bookmark", counts.bookmarks],
  ];
  ops.push({ type: "actions", x: x0, y: y + 4, w: tw, items: actions });
  y += 30 + pad;
  geometry.boxes.push({ x: 0, y: 0, w: width, h: Math.ceil(y), kind: "cell" });

  return { ops, height: Math.ceil(y), width, dpr, p, fs, lh, x0, tw, pad, geometry, lines: lines.length };
}

function drawPost(canvas, layout, variant = {}) {
  const { width, height, dpr, p } = layout;
  const dy = variant.dy ?? 0;
  const lhDelta = variant.lhDelta ?? 0;
  const extra = Math.max(0, dy) + Math.max(0, (layout.lines ?? 1) - 1) * lhDelta;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round((height + extra) * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, width, height + extra);

  for (const op of layout.ops) {
    const y = op.y + dy + (op.lineIndex ? op.lineIndex * lhDelta : 0);
    if (op.type === "avatar") {
      const x = op.x;
      const r = op.size / 2;
      ctx.save();
      if (op.square) {
        roundRect(ctx, x, y, op.size, op.size, 9);
      } else {
        ctx.beginPath();
        ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
      }
      const image = op.data ? avatarImages.get(op.data) : null;
      if (image && image.complete && image.naturalWidth) {
        // A real avatar (the generated @vercel mark, an upload) is drawn as-is.
        ctx.clip();
        ctx.drawImage(image, x, y, op.size, op.size);
      } else {
        const grad = ctx.createLinearGradient(x, y, x + op.size, y + op.size);
        grad.addColorStop(0, "#1d9bf0");
        grad.addColorStop(1, "#7856ff");
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.restore();
    } else if (op.type === "text") {
      ctx.fillStyle = op.color ?? p.text;
      ctx.font = `${op.weight ?? 400} ${op.fs}px ${FONT}`;
      ctx.textBaseline = "top";
      ctx.fillText(op.text, op.x, y + (op.weight === 700 ? 0 : 1) + (op.weight ? 0 : 0));
    } else if (op.type === "badge") {
      const color =
        op.kind === "business" ? "#e2b719" : op.kind === "government" ? "#8b98a5" : p.accent;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(op.x + op.size / 2, y + op.size / 2, op.size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = p.bg;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(op.x + op.size * 0.28, y + op.size * 0.52);
      ctx.lineTo(op.x + op.size * 0.45, y + op.size * 0.69);
      ctx.lineTo(op.x + op.size * 0.74, y + op.size * 0.34);
      ctx.stroke();
    } else if (op.type === "square") {
      roundRect(ctx, op.x, y, op.size, op.size, 3);
      ctx.fillStyle = op.color;
      ctx.fill();
    } else if (op.type === "media") {
      const gap = 2;
      const cells =
        op.items.length === 1
          ? [[op.x, y, op.w, op.h]]
          : op.items.length === 2
            ? [
                [op.x, y, (op.w - gap) / 2, op.h],
                [op.x + (op.w + gap) / 2, y, (op.w - gap) / 2, op.h],
              ]
            : op.items.length === 3
              ? [
                  [op.x, y, (op.w - gap) / 2, op.h],
                  [op.x + (op.w + gap) / 2, y, (op.w - gap) / 2, (op.h - gap) / 2],
                  [op.x + (op.w + gap) / 2, y + (op.h + gap) / 2, (op.w - gap) / 2, (op.h - gap) / 2],
                ]
              : [
                  [op.x, y, (op.w - gap) / 2, (op.h - gap) / 2],
                  [op.x + (op.w + gap) / 2, y, (op.w - gap) / 2, (op.h - gap) / 2],
                  [op.x, y + (op.h + gap) / 2, (op.w - gap) / 2, (op.h - gap) / 2],
                  [op.x + (op.w + gap) / 2, y + (op.h + gap) / 2, (op.w - gap) / 2, (op.h - gap) / 2],
                ];
      cells.forEach(([cx, cy, cw, ch], index) => {
        const grad = ctx.createLinearGradient(cx, cy, cx + cw, cy + ch);
        grad.addColorStop(0, index % 2 ? "#2f3336" : "#3a3f45");
        grad.addColorStop(1, index % 2 ? "#5b6066" : "#1d9bf0");
        roundRect(ctx, cx, cy, cw, ch, 4);
        ctx.fillStyle = grad;
        ctx.fill();
        const item = op.items[index];
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = `600 10px ${MONO}`;
        ctx.textBaseline = "middle";
        ctx.fillText(`${item.width}×${item.height}`, cx + 6, cy + ch - 10);
      });
    } else if (op.type === "card") {
      roundRect(ctx, op.x, y, op.w, op.h, 12);
      ctx.strokeStyle = p.line;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (op.imageH) {
        const grad = ctx.createLinearGradient(op.x, y, op.x + op.w, y + op.imageH);
        grad.addColorStop(0, "#0f1419");
        grad.addColorStop(1, "#1d9bf0");
        ctx.save();
        roundRect(ctx, op.x, y, op.w, op.imageH, 12);
        ctx.clip();
        ctx.fillStyle = grad;
        ctx.fillRect(op.x, y, op.w, op.imageH);
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.font = `600 10px ${MONO}`;
        ctx.textBaseline = "middle";
        ctx.fillText("1200×630", op.x + 8, y + op.imageH - 12);
        ctx.restore();
      }
      const ty = y + op.imageH;
      ctx.fillStyle = p.text;
      ctx.font = `700 13px ${FONT}`;
      ctx.textBaseline = "top";
      ctx.fillText(op.meta.title ?? "", op.x + 10, ty + 8);
      ctx.fillStyle = p.muted;
      ctx.font = `400 12px ${FONT}`;
      const desc = (op.meta.description ?? "").slice(0, 90);
      ctx.fillText(desc, op.x + 10, ty + 26);
      ctx.font = `400 11px ${FONT}`;
      ctx.fillStyle = p.muted;
      ctx.fillText(op.meta.domain ?? "", op.x + 10, ty + op.imageH + 30);
    } else if (op.type === "poll") {
      const votes = op.poll.votes ?? [];
      const total = votes.reduce((a, b) => a + b, 0) || op.poll.choices.length;
      op.poll.choices.forEach((choice, i) => {
        const rowY = y + i * 30;
        roundRect(ctx, op.x, rowY, op.w, 24, 4);
        ctx.fillStyle = p.fill;
        ctx.fill();
        const share = votes[i] ? votes[i] / total : 1 / op.poll.choices.length;
        roundRect(ctx, op.x, rowY, Math.max(8, op.w * share), 24, 4);
        ctx.fillStyle = "rgba(29,155,240,0.25)";
        ctx.fill();
        ctx.fillStyle = p.text;
        ctx.font = `400 13px ${FONT}`;
        ctx.textBaseline = "middle";
        ctx.fillText(choice, op.x + 8, rowY + 12);
        if (votes[i] !== undefined) {
          ctx.fillStyle = p.muted;
          ctx.fillText(`${Math.round(share * 100)}%`, op.x + op.w - 30, rowY + 12);
        }
      });
      ctx.fillStyle = p.muted;
      ctx.font = `400 12px ${FONT}`;
      const label = op.poll.secondsLeft ? `${Math.ceil(op.poll.secondsLeft / 3600)}h left` : "Final results";
      ctx.textBaseline = "top";
      ctx.fillText(`${total ? total + " votes · " : ""}${label}`, op.x, y + op.poll.choices.length * 30 + 2);
    } else if (op.type === "quote") {
      roundRect(ctx, op.x, y, op.w, op.h, 12);
      ctx.strokeStyle = p.line;
      ctx.stroke();
      const q = op.quote;
      ctx.fillStyle = p.text;
      ctx.font = `700 12px ${FONT}`;
      ctx.textBaseline = "top";
      ctx.fillText(`${q.author?.name ?? ""} ${q.author?.handle ? "@" + q.author.handle : ""}`, op.x + 10, y + 8);
      ctx.font = `400 12px ${FONT}`;
      op.lines.forEach((line, i) => ctx.fillText(line, op.x + 10, y + 26 + i * 18));
    } else if (op.type === "actions") {
      const gap = op.w / op.items.length;
      ctx.textBaseline = "middle";
      ctx.font = `400 11px ${FONT}`;
      op.items.forEach(([kind, count], i) => {
        const cx = op.x + gap * i + 6;
        const cy = y + 10;
        ctx.strokeStyle = p.muted;
        ctx.fillStyle = p.muted;
        ctx.lineWidth = 1.4;
        if (kind === "like") {
          ctx.beginPath();
          ctx.arc(cx, cy, 5, 0, Math.PI * 2);
          ctx.stroke();
        } else if (kind === "repost") {
          ctx.strokeRect(cx - 5, cy - 4, 10, 8);
        } else if (kind === "reply") {
          roundRect(ctx, cx - 6, cy - 4, 12, 8, 3);
          ctx.stroke();
        } else if (kind === "view") {
          ctx.beginPath();
          ctx.ellipse(cx, cy, 6, 3.5, 0, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(cx, cy + 4);
          ctx.lineTo(cx, cy - 4);
          ctx.stroke();
        }
        const label = humanCount(Number(count) || 0);
        if (label) ctx.fillText(label, cx + 9, cy + 1);
      });
    }
  }
  // The lhDelta variant shifts every text line, which is what a half-pixel
  // line-height difference looks like in a diff.
  return { canvas, height: height + extra, lines: layout.lines };
}

const avatarImages = new Map();

/** Decodes any avatar the post carries, so the sync draw can paint it. */
async function preloadAvatars(post) {
  const authors = [post?.author, post?.quote?.author, post?.quote?.quote?.author];
  for (const author of authors) {
    const b64 = author?.avatar;
    if (!b64 || avatarImages.has(b64)) continue;
    const img = new Image();
    img.src = b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
    avatarImages.set(b64, img);
    try {
      await img.decode();
    } catch {
      /* a broken avatar falls back to the gradient */
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Report

function reportFor(post, layout) {
  const text = post.text ?? "";
  const urls = text.match(/https?:\/\/[^\s]+/g) ?? [];
  const limit = 280;
  let weighted = 0;
  for (const ch of text) weighted += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
  weighted -= urls.reduce((sum, u) => sum + [...u].length, 0);
  weighted += urls.length * 23;

  const attachment = post.poll
    ? { shown: "poll", why: "a poll replaces the link card and the quote" }
    : post.media?.length
      ? { shown: "media", why: `${post.media.length} ${post.media.length === 1 ? "attachment" : "attachments"} in the post` }
      : post.quote
        ? { shown: "quote", why: "the quoted post is the attachment" }
        : post.links && Object.keys(post.links).length
          ? {
              shown: "card",
              url: Object.keys(post.links)[0],
              why: post.cardState === "dismissed" ? "the author dismissed the card" : "last link in text, no media attached",
            }
          : null;

  const hidden = [];
  if (attachment?.shown === "card" && attachment.url) {
    const index = text.indexOf(attachment.url);
    if (index >= 0) hidden.push({ range: [index, index + attachment.url.length], why: "trailing URL replaced by its card" });
  }
  if (post.replyTo && text.startsWith("@")) {
    const firstLine = text.split("\n")[0];
    const mentions = firstLine.match(/^(@\w+\s*)+/);
    if (mentions) hidden.push({ range: [0, mentions[0].length], why: "leading mentions of a reply" });
  }

  const warnings = [];
  if (post.media?.length && post.links && Object.keys(post.links).length) {
    warnings.push("an image is attached, so the link card will not render");
  }
  if (weighted > limit) warnings.push(`weighted length is ${weighted}; this needs a Premium account`);
  if (layout.ops.some((o) => o.type === "text" && o.fs > 15)) warnings.push("detail surface: larger type, never truncated");
  if (post.poll && !post.poll.votes) warnings.push("the poll has no votes yet, so no percentages are shown");

  const entities = [];
  for (const url of urls) {
    const index = text.indexOf(url);
    entities.push({ kind: "url", range: [index, index + url.length], text: url, display: url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 30) });
  }
  for (const m of text.matchAll(/(^|\s)([@#])(\w+)/g)) {
    const start = m.index + m[1].length;
    entities.push({ kind: m[2] === "@" ? "mention" : "hashtag", range: [start, start + m[0].length - m[1].length], text: m[3] });
  }

  return {
    ruleset: "x-web@3e351742",
    verifiedFor: ["web-timeline", "web-detail"],
    length: { weighted, limit, valid: weighted <= limit },
    size: { width: layout.width, height: layout.height },
    text: {
      lines: layout.geometry.lines.length,
      truncated: false,
      showMore: null,
      visible: text,
    },
    entities,
    hidden,
    attachment,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// The API

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = ([base, spread]) => base + Math.random() * spread;

export async function createMock() {
  const stale = { native: true };
  const versions = JSON.parse(JSON.stringify(VERSIONS));
  const canvas = document.createElement("canvas");

  function variantFor(target, options) {
    if (target === "chrome") return {};
    if (target === "wasm") return { dy: 0, lhDelta: 0 };
    if (target === "native") return { dy: 1, lhDelta: 0 };
    return { dy: 0, lhDelta: options.surface === "web-detail" ? 2 : 1 };
  }

  function renderSync(target, post, options) {
    if ((post.media?.length ?? 0) > 4) {
      throw new MockApiError("invalid_post", "post.media is limited to four items", [
        { path: "post.media", message: "5 items" },
      ]);
    }
    if ((post.text ?? "").includes("[fail]")) {
      throw new MockApiError("render_failed", "the mock was asked to fail (text contains [fail])");
    }
    const layout = layoutPost(post, options);
    const variant = variantFor(target, options);
    const drawn = drawPost(canvas, layout, variant);
    const png = drawn.canvas.toDataURL("image/png").split(",")[1];
    const report = reportFor(post, layout);
    if (stale[target]) {
      report.warnings.push(`${target} is built from an older tree (mock)`);
    }
    return {
      target,
      png,
      width: layout.width,
      height: drawn.height,
      dpr: options.dpr,
      report: { ...report, size: { width: layout.width, height: drawn.height } },
      geometry: target === "native" ? null : shiftGeometry(layout.geometry, variant),
      ms: { total: 0, render: 0, encode: 0 },
      version: { ...versions[target], stale: !!stale[target] },
    };
  }

  return {
    mock: true,

    async targets() {
      await sleep(30);
      return [
        { id: "chrome", label: "Chrome", available: true, version: versions.chrome, stale: false, building: false },
        { id: "wasm", label: "WASM", available: true, version: versions.wasm, stale: false, building: false },
        {
          id: "native",
          label: "native",
          available: true,
          version: versions.native,
          stale: !!stale.native,
          building: false,
        },
        { id: "http", label: "HTTP fn", available: true, version: versions.http, stale: false, building: false },
      ];
    },

    async resolve(input, _signal, options = {}) {
      await sleep(60);
      const trimmed = String(input ?? "").trim();
      if (!trimmed) return { kind: "text", post: { text: "" } };
      if (trimmed.startsWith("{")) {
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch (error) {
          throw new MockApiError("invalid_json", `not JSON: ${error.message}`);
        }
        if (parsed && typeof parsed === "object" && "text" in parsed && typeof parsed.text !== "string") {
          throw new MockApiError("invalid_post", "post.text must be a string", [
            { path: "post.text", message: "expected a string", suggestion: '"text": "hello"' },
          ]);
        }
        return { kind: "json", post: parsed };
      }
      if (/^(https?:\/\/)?(www\.)?(x|twitter)\.com\//i.test(trimmed)) {
        await sleep(320);
        const id = (trimmed.match(/status(?:es)?\/(\d+)/) ?? [])[1] ?? "2119915360849727842";
        const handle = (trimmed.match(/\.com\/([A-Za-z0-9_]+)\//) ?? [])[1] ?? "levelsio";
        return {
          kind: "url",
          post: {
            text: `just shipped something small and useful. no announcement post, just a slightly better day for everyone using it\n\nhttps://example.com/a/really/long/path/that/keeps/going?utm_source=x`,
            author: { name: handle, handle, verified: "blue" },
            createdAt: "2026-11-09T16:20:00.000Z",
            counts: { replies: 42, reposts: 118, likes: 2403, views: 184000, bookmarks: 91 },
            links: {
              "https://example.com/a/really/long/path/that/keeps/going?utm_source=x": {
                card: "summary_large_image",
                title: "A slightly better day",
                description: "What changed, and the one thing that almost broke it.",
                domain: "example.com",
              },
            },
          },
          source: {
            url: `https://x.com/${handle}/status/${id}`,
            id,
            capturedAt: "2026-11-09T18:02:00.000Z",
            page: `x.com/${handle}/status/${id}`,
          },
        };
      }
      // Plain text: follow the links the way the server's crawler will, so
      // the card, the report's chain and the toggles are all exercised.
      const source = String(input);
      const urls = source.match(/https?:\/\/[^\s]+/g) ?? [];
      if (urls.length) {
        await sleep(260);
        // X turns a post whose text ends on another post's URL into a quote;
        // the same URL with text after it is just a link.
        const lastUrl = urls[urls.length - 1].replace(/[),.;:!?]+$/, "");
        const after = source.slice(source.lastIndexOf(urls[urls.length - 1]) + urls[urls.length - 1].length);
        // Anchored, like the server: a bare post URL at the end is a quote,
        // `…/status/1/video/1` is media, and `…/status/1 more` is just a link.
        const statusUrl =
          /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}\/status(?:es)?\/\d+|i\/(?:web\/)?status\/\d+)\/?$/i.test(
            lastUrl,
          );
        const quoted = statusUrl && /^\s*$/.test(after);
        // X lifts a video/photo variant or a twimg asset into post media, with
        // the original author credited on the pill instead of a quote.
        const mediaUrl = urls
          .map((u) => u.replace(/[),.;:!?]+$/, ""))
          .find(
            (u) =>
              /^https?:\/\/(?:video|pbs)\.twimg\.com\//i.test(u) ||
              /\/status(?:es)?\/\d+\/(?:video|photo)\/\d+\/?$/i.test(u),
          );
        const embedded = mediaUrl
          ? [
              {
                kind: "video",
                width: 864,
                height: 1080,
                duration: 24,
                sourceAuthor: {
                  name: "Cursor",
                  handle: "cursor_ai",
                  verified: "business",
                  squareAvatar: true,
                },
              },
            ]
          : [];
        const quoteHandle =
          /\.com\/([A-Za-z0-9_]+)\//.exec(lastUrl)?.[1] ?? "someone";
        const links = {};
        const info = {};
        const isStatusLink = (url) =>
          /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}\/status(?:es)?\/\d+|i\/(?:web\/)?status\/\d+)/i.test(
            url.replace(/[),.;:!?]+$/, ""),
          );
        for (const url of urls) {
          // A link lifted into media is not a card either.
          if (embedded.length && url.replace(/[),.;:!?]+$/, "") === mediaUrl) continue;
          // A link to an X post never has a card, quoted or not.
          if (isStatusLink(url)) {
            const meta = { card: null, description: null, display: `x.com/${quoteHandle}/st…`, domain: "x.com", image: null, title: null };
            links[url] = meta;
            info[url] = {
              meta,
              chain: [],
              finalUrl: url,
              tags: {},
              notes: ["a link to an X post has no card"],
            };
            continue;
          }
          const finalUrl = mockFinalUrl(url);
          let host = "example.com";
          try {
            host = new URL(finalUrl).hostname;
          } catch {}
          const meta = {
            card: "summary_large_image",
            title: "The thing, shipped",
            description: "What we built, why it took a week, and what broke on the way.",
            domain: host,
          };
          if (options.media === true) meta.image = { width: 1200, height: 630, data: gradientPng() };
          links[url] = meta;
          info[url] = {
            meta,
            chain: [
              { url, status: 301 },
              { url: finalUrl, status: 200 },
            ],
            finalUrl,
            tags: ["twitter:card: summary_large_image", "og:title: The thing, shipped", "og:image: 1200x630"],
            notes: /t\.co|bit\.ly/.test(url) ? ["a shortener: the crawler follows it to the final page"] : [],
          };
        }
        const post = { text: input, links };
        if (embedded.length) post.media = embedded;
        if (quoted) {
          post.quote = {
            text: "November 2026, Security Update\n\nBetter Auth v1.7.16 and v1.8.x patch two issues; details in the blog post.",
            author: { name: quoteHandle, handle: quoteHandle, verified: "business" },
            createdAt: "2026-11-03T21:43:31.000Z",
            links: { "https://t.co/bGs1ta1do3": { card: null, display: "better-auth.com/blog/security-…" } },
            counts: { replies: 2, reposts: 39, likes: 368, views: 59336, bookmarks: 0 },
            // No nested quote: the current core rejects post.quote.quote, and
            // the mock must look like the real renderer. The nested path is
            // covered by the composition/time-zone checks in verify.mjs.
          };
        }
        return { kind: "text", post, links: info };
      }
      return { kind: "text", post: { text: input } };
    },

    async render(body, signal) {
      const { target, post, options } = body;
      const aborted = () => signal?.aborted;
      if (!versions[target]) {
        throw new MockApiError("unknown_target", `no target \`${target}\``);
      }
      await sleep(jitter(LATENCY[target] ?? [10, 5]));
      if (aborted()) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      await preloadAvatars(post);
      const started = performance.now();
      const out = renderSync(target, post, options);
      const elapsed = performance.now() - started;
      // The shape the real server now sends: paint is the render, and the wire
      // costs (encode) are reported separately.
      out.ms = { paint: elapsed * 0.8, render: elapsed * 0.8, encode: elapsed * 0.2, total: elapsed + 1 };
      return out;
    },

    async build(target) {
      if (!versions[target]) throw new MockApiError("unknown_target", `no target \`${target}\``);
      await sleep(900);
      stale[target] = false;
      versions[target].builtAt = new Date().toISOString();
      versions[target].rev = "4b8e2d1c0f3a5967b2d4e6f8a0c1b3d5e7f90123";
      return { ok: true, ms: 1180, log: `mock: rebuilt ${target}` };
    },

    events() {
      return () => {};
    },
  };
}

function mockFinalUrl(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)(t\.co|bit\.ly|buff\.ly)$/.test(u.hostname)) return "https://vercel.com/changelog/the-thing";
    return u.toString();
  } catch {
    return url;
  }
}

let gradientCache = null;
/** A 1200×630 card image, for `media: true`. */
function gradientPng() {
  if (gradientCache) return gradientCache;
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 630;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 1200, 630);
  g.addColorStop(0, "#0f1419");
  g.addColorStop(1, "#1d9bf0");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1200, 630);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "700 54px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("The thing, shipped", 64, 330);
  gradientCache = c.toDataURL("image/png").split(",")[1];
  return gradientCache;
}

function shiftGeometry(geometry, variant) {
  const dy = variant.dy ?? 0;
  const lhDelta = variant.lhDelta ?? 0;
  return {
    lines: geometry.lines.map((line, index) => ({
      ...line,
      y: line.y + dy + index * lhDelta,
    })),
    boxes: geometry.boxes.map((box) => ({ ...box, y: box.y + dy })),
  };
}
