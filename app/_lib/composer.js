// Composer & variant controls for `/`: brings the full playground power
// (author, quote tweet vs link vs embedded video, multi-image upload, polls,
// reply-to, counts, raw Post JSON, and variant/device customization) into the
// minimal Geist Serif page, with Vercel as the default author whenever unknown.

import {
  bodyForMode,
  cleanAuthor,
  cleanPost,
  cleanQuote,
  classify,
  hasCard,
  isStatusUrl,
  statusUrlInText,
  trailingStatusUrl,
  videoVariant,
  weightedLength,
} from "./post.js";
import { $, bytesToBase64, debounce, el } from "./util.js";
import { vercelAvatarBase64 } from "./vercel-avatar.js";

export const VERCEL_AUTHOR = {
  name: "Vercel",
  handle: "vercel",
  verified: "business",
  squareAvatar: true,
};

export const AUTHOR_PRESETS = {
  vercel: { ...VERCEL_AUTHOR },
  rauchg: { name: "Guillermo Rauch", handle: "rauchg", verified: "blue", squareAvatar: false },
  nasa: { name: "NASA Goddard", handle: "NASAGoddard", verified: "government", squareAvatar: true },
  plain: { name: "Jane Doe", handle: "janedoe", verified: "none", squareAvatar: false },
};

export const DEFAULT_VARIANTS = [
  { surface: "web-timeline", width: 390 },
  { surface: "web-detail", width: 390 },
  { surface: "web-timeline", width: 600 },
  { surface: "ios-timeline", width: 382, dpr: 3, label: "duo · 382", slug: "duo-382", comment: " // iPhone Duo (iOS)" },
];

export const VARIANT_PRESETS = [
  { id: "web-tl-390", label: "Web timeline · 390", variant: { surface: "web-timeline", width: 390, dpr: 2 } },
  { id: "web-dt-390", label: "Web detail · 390", variant: { surface: "web-detail", width: 390, dpr: 2 } },
  { id: "web-tl-600", label: "Web desktop · 600", variant: { surface: "web-timeline", width: 600, dpr: 2 } },
  {
    id: "ios-duo-382",
    label: "iPhone Duo · 382 (iOS)",
    variant: { surface: "ios-timeline", width: 382, dpr: 3, label: "duo · 382", slug: "duo-382", comment: " // iPhone Duo (iOS)" },
  },
  {
    id: "ios-dt-382",
    label: "iOS detail · 382",
    variant: { surface: "ios-detail", width: 382, dpr: 3, label: "ios detail · 382", slug: "ios-detail-382" },
  },
  {
    id: "ios-max-430",
    label: "iPhone Pro Max · 430 (iOS)",
    variant: { surface: "ios-timeline", width: 430, dpr: 3, label: "ios · 430", slug: "ios-430" },
  },
  {
    id: "ios-land-594",
    label: "Duo landscape · 594 (iOS)",
    variant: { surface: "ios-timeline", width: 594, dpr: 3, label: "duo · 594", slug: "duo-594" },
  },
  { id: "web-tl-320", label: "Web narrow · 320", variant: { surface: "web-timeline", width: 320, dpr: 2 } },
];

const VARIANTS_STORAGE_KEY = "xeet.variants.v1";

function sameVariant(a, b) {
  return (
    a.surface === b.surface &&
    Number(a.width) === Number(b.width) &&
    Number(a.dpr ?? 2) === Number(b.dpr ?? 2) &&
    Boolean(a.expanded) === Boolean(b.expanded)
  );
}

function variantDisplayLabel(v) {
  if (v.label) return `${v.label}${v.dpr && v.dpr !== 2 ? ` @${v.dpr}x` : ""}`;
  const map = {
    "web-timeline": "timeline",
    "web-detail": "detail",
    "ios-timeline": "ios",
    "ios-detail": "ios detail",
  };
  const base = `${map[v.surface] ?? v.surface} · ${v.width}`;
  const exp = v.expanded ? " · expanded" : "";
  const dpr = v.dpr && v.dpr !== 2 ? ` @${v.dpr}x` : "";
  return `${base}${exp}${dpr}`;
}

function loadSavedVariants() {
  try {
    const raw = localStorage.getItem(VARIANTS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.variants) || !parsed.variants.length) return null;
    return {
      variants: parsed.variants.slice(0, 8),
      autoExpand: parsed.autoExpand !== false,
      fontScale: Math.min(1.35, Math.max(0.8, Number(parsed.fontScale) || 1)),
    };
  } catch {
    return null;
  }
}

function saveVariantsState(state) {
  try {
    const isDefault =
      state.autoExpand &&
      state.fontScale === 1 &&
      state.variants.length === DEFAULT_VARIANTS.length &&
      state.variants.every((v, i) => sameVariant(v, DEFAULT_VARIANTS[i]));
    if (isDefault) localStorage.removeItem(VARIANTS_STORAGE_KEY);
    else localStorage.setItem(VARIANTS_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("couldn't read image file"));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      const data = bytesToBase64(bytes);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const width = img.naturalWidth || 1200;
        const height = img.naturalHeight || 900;
        URL.revokeObjectURL(url);
        resolve({ width, height, data });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("unsupported image file"));
      };
      img.src = url;
    };
    reader.readAsArrayBuffer(file);
  });
}

/** Ensures any post with an unknown/empty author defaults to Vercel (@vercel). */
export async function ensureAuthorAndAvatars(post, lookupStaticAvatar) {
  if (!post) return post;
  const out = { ...post };
  const hasIdentity = Boolean(out.author?.name?.trim() || out.author?.handle?.trim());
  if (!hasIdentity) {
    out.author = {
      ...VERCEL_AUTHOR,
      ...(out.author ?? {}),
      name: VERCEL_AUTHOR.name,
      handle: VERCEL_AUTHOR.handle,
      verified: out.author?.verified ?? VERCEL_AUTHOR.verified,
      squareAvatar: out.author?.squareAvatar ?? VERCEL_AUTHOR.squareAvatar,
      avatar: out.author?.avatar || vercelAvatarBase64(),
    };
  } else {
    const handle = String(out.author.handle ?? "").replace(/^@/, "");
    if (!out.author.avatar) {
      if (handle.toLowerCase() === "vercel") {
        out.author = {
          ...out.author,
          verified: out.author.verified ?? "business",
          squareAvatar: out.author.squareAvatar ?? true,
          avatar: vercelAvatarBase64(),
        };
      } else if (lookupStaticAvatar) {
        const avatar = await lookupStaticAvatar(handle);
        if (avatar) out.author = { ...out.author, avatar };
      }
    }
  }
  if (out.quote) {
    out.quote = await ensureAuthorAndAvatars(out.quote, lookupStaticAvatar);
  }
  return out;
}

export function createComposer({ input, getExample, resolveCached, lookupStaticAvatar, onChange }) {
  const saved = loadSavedVariants();
  const variantState = {
    variants: saved ? saved.variants : DEFAULT_VARIANTS.map((v) => ({ ...v })),
    autoExpand: saved ? saved.autoExpand : true,
    fontScale: saved ? saved.fontScale : 1,
  };

  // Per-draft state. Reset cleanly when cycling built-in examples; switched to
  // a blank Vercel draft on `new draft`.
  let customDraft = false;
  let userTyped = false;
  let urlAttachMode = null; // null (auto) | "quote" | "link" | "video"
  let openDrawer = null; // "author" | "quote" | "media" | "poll" | null

  let overrides = emptyOverrides();

  function emptyOverrides() {
    return {
      authorMode: "example", // "example" | "custom"
      author: { ...VERCEL_AUTHOR, avatar: "" },
      replyToHandle: "",
      countsOn: false,
      counts: { replies: "", reposts: "", likes: "", views: "", bookmarks: "" },
      quoteMode: "example", // "example" | "none" | "url" | "custom"
      quoteUrl: "",
      quoteCustom: { name: "Vercel", handle: "vercel", verified: "business", text: "" },
      mediaMode: "example", // "example" | "none" | "custom" | "videoUrl"
      mediaItems: [],
      mediaAlt: "",
      videoUrl: "",
      pollMode: "example", // "example" | "none" | "custom"
      poll: { choices: ["", "", "", ""], votes: ["", "", "", ""], hoursLeft: "24" },
      cardDismissed: false,
    };
  }

  const scheduleChange = debounce(() => onChange(), 140);

  // --- DOM hooks ------------------------------------------------------------
  const btnNewDraft = $("#btnNewDraft");
  const btnEditText = $("#btnEditText");
  const btnResetDraft = $("#btnResetDraft");
  const urlModeRow = $("#urlModeRow");
  const btnAuthor = $("#btnAuthor");
  const btnQuote = $("#btnQuote");
  const btnMedia = $("#btnMedia");
  const btnPoll = $("#btnPoll");
  const btnCardDismiss = $("#btnCardDismiss");
  const charCount = $("#charCount");

  const paneAuthor = $("#paneAuthor");
  const paneQuote = $("#paneQuote");
  const paneMedia = $("#paneMedia");
  const panePoll = $("#panePoll");
  const variantsBtn = $("#customizeVariants");
  const variantsPane = $("#variantsPane");

  function setDrawer(next) {
    openDrawer = openDrawer === next ? null : next;
    const map = { author: paneAuthor, quote: paneQuote, media: paneMedia, poll: panePoll };
    const btns = { author: btnAuthor, quote: btnQuote, media: btnMedia, poll: btnPoll };
    for (const [k, pane] of Object.entries(map)) {
      if (pane) pane.hidden = openDrawer !== k;
      if (btns[k]) btns[k].setAttribute("aria-expanded", String(openDrawer === k));
    }
  }

  btnAuthor?.addEventListener("click", () => {
    hydrateAuthorInputs();
    setDrawer("author");
  });
  btnQuote?.addEventListener("click", () => {
    hydrateQuoteInputs();
    setDrawer("quote");
  });
  btnMedia?.addEventListener("click", () => {
    renderMediaList();
    setDrawer("media");
  });
  btnPoll?.addEventListener("click", () => {
    hydratePollInputs();
    setDrawer("poll");
  });

  function syncInputHeight() {
    const isSingleUrl = /^https?:\/\/\S+$/.test(input.value.trim());
    if (isSingleUrl) input.dataset.url = "1";
    else delete input.dataset.url;
    const floor = parseFloat(getComputedStyle(input).minHeight) || 51;
    input.style.height = "0px";
    const needed = isSingleUrl ? floor : input.scrollHeight + 2;
    const clamped = Math.min(360, Math.max(floor, needed));
    input.style.height = `${clamped}px`;
    input.style.overflowY = needed > 360 ? "auto" : "hidden";
  }

  // --- New draft / Reset example -------------------------------------------
  btnNewDraft?.addEventListener("click", () => {
    customDraft = true;
    userTyped = true;
    urlAttachMode = null;
    overrides = emptyOverrides();
    overrides.authorMode = "custom";
    overrides.author = { ...VERCEL_AUTHOR, avatar: "" };
    overrides.quoteMode = "none";
    overrides.mediaMode = "none";
    overrides.pollMode = "none";
    $("#title").textContent = "Custom draft";
    $("#why").textContent = "Compose your own post, attach a quote tweet, upload media, build a poll, or paste an x.com URL.";
    input.value = "Ship it. ▲";
    syncInputHeight();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    syncToolbar(null);
    onChange();
  });

  btnEditText?.addEventListener("click", () => {
    const ex = getExample();
    if (!ex) return;
    userTyped = true;
    input.value = ex.post.text;
    syncInputHeight();
    input.focus();
    syncToolbar(ex.post);
    onChange();
  });

  btnResetDraft?.addEventListener("click", () => {
    resetForExample();
    const ex = getExample();
    $("#title").textContent = ex.title;
    $("#why").textContent = ex.why;
    input.value = ex.url;
    syncInputHeight();
    syncToolbar(ex.post);
    onChange();
  });

  // --- Inline status-URL mode bar (Quote vs Link in text vs Post video) -----
  urlModeRow?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-url-mode]");
    if (!btn) return;
    urlAttachMode = btn.dataset.urlMode;
    syncUrlModeBar();
    onChange();
  });

  function effectiveUrlMode(text) {
    if (classify(text) !== "text") return null;
    const anyUrl = statusUrlInText(text);
    if (!anyUrl) return null;
    if (urlAttachMode) return urlAttachMode;
    return trailingStatusUrl(text) ? "quote" : "link";
  }

  function syncUrlModeBar() {
    if (!urlModeRow) return;
    const text = input.value;
    const show = userTyped && classify(text) === "text" && Boolean(statusUrlInText(text));
    urlModeRow.hidden = !show;
    if (!show) return;
    const active = effectiveUrlMode(text);
    for (const b of urlModeRow.querySelectorAll("button[data-url-mode]")) {
      b.classList.toggle("on", b.dataset.urlMode === active);
      b.setAttribute("aria-pressed", String(b.dataset.urlMode === active));
    }
  }

  // --- Author & Counts controls --------------------------------------------
  function hydrateAuthorInputs() {
    const base = effectiveBaseAuthor();
    $("#aName").value = base.name ?? "";
    $("#aHandle").value = String(base.handle ?? "").replace(/^@/, "");
    $("#aVerified").value = base.verified ?? "none";
    $("#aSquare").checked = Boolean(base.squareAvatar);
    $("#aProtected").checked = Boolean(base.protected);
    $("#aAffiliate").value = base.affiliate?.name ?? "";
    $("#aReplyTo").value = overrides.replyToHandle || (customDraft ? "" : getExample()?.post?.replyToHandle ?? "");
    const c = overrides.countsOn ? overrides.counts : (customDraft ? {} : getExample()?.post?.counts ?? {});
    for (const [id, key] of [
      ["cReplies", "replies"],
      ["cReposts", "reposts"],
      ["cLikes", "likes"],
      ["cViews", "views"],
      ["cBookmarks", "bookmarks"],
    ]) {
      const val = c?.[key];
      $(`#${id}`).value = val != null && val !== "" ? String(val) : "";
    }
  }

  function effectiveBaseAuthor() {
    if (overrides.authorMode === "custom") return overrides.author;
    if (customDraft) return VERCEL_AUTHOR;
    return getExample()?.post?.author ?? VERCEL_AUTHOR;
  }

  paneAuthor?.querySelectorAll("button[data-author-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.authorPreset;
      if (key === "example") {
        overrides.authorMode = customDraft ? "custom" : "example";
        if (customDraft) overrides.author = { ...VERCEL_AUTHOR, avatar: "" };
      } else if (AUTHOR_PRESETS[key]) {
        overrides.authorMode = "custom";
        overrides.author = { ...AUTHOR_PRESETS[key], avatar: "" };
      }
      hydrateAuthorInputs();
      syncToolbar();
      onChange();
    });
  });

  const onAuthorFieldInput = () => {
    overrides.authorMode = "custom";
    const aff = $("#aAffiliate").value.trim();
    overrides.author = {
      ...overrides.author,
      name: $("#aName").value,
      handle: $("#aHandle").value.replace(/^@/, ""),
      verified: $("#aVerified").value,
      squareAvatar: $("#aSquare").checked,
      protected: $("#aProtected").checked,
      affiliate: aff ? { ...(overrides.author.affiliate ?? {}), name: aff } : undefined,
    };
    overrides.replyToHandle = $("#aReplyTo").value.trim().replace(/^@/, "");
    syncToolbar();
    scheduleChange();
  };
  for (const sel of ["#aName", "#aHandle", "#aVerified", "#aSquare", "#aProtected", "#aAffiliate", "#aReplyTo"]) {
    $(sel)?.addEventListener("input", onAuthorFieldInput);
    $(sel)?.addEventListener("change", onAuthorFieldInput);
  }

  $("#aAvatarFile")?.addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const img = await readImageFile(file);
      overrides.authorMode = "custom";
      overrides.author = { ...effectiveBaseAuthor(), avatar: img.data };
      syncToolbar();
      onChange();
    } catch {}
  });

  const onCountsInput = () => {
    overrides.countsOn = true;
    overrides.counts = {
      replies: $("#cReplies").value,
      reposts: $("#cReposts").value,
      likes: $("#cLikes").value,
      views: $("#cViews").value,
      bookmarks: $("#cBookmarks").value,
    };
    scheduleChange();
  };
  for (const sel of ["#cReplies", "#cReposts", "#cLikes", "#cViews", "#cBookmarks"]) {
    $(sel)?.addEventListener("input", onCountsInput);
  }

  // --- Quote controls -------------------------------------------------------
  function hydrateQuoteInputs() {
    const exQuote = !customDraft ? getExample()?.post?.quote : null;
    if (overrides.quoteMode === "url") {
      $("#qUrl").value = overrides.quoteUrl;
    } else if (overrides.quoteMode === "custom") {
      $("#qName").value = overrides.quoteCustom.name;
      $("#qHandle").value = overrides.quoteCustom.handle;
      $("#qVerified").value = overrides.quoteCustom.verified;
      $("#qText").value = overrides.quoteCustom.text;
    } else if (exQuote) {
      $("#qName").value = exQuote.author?.name ?? "Vercel";
      $("#qHandle").value = exQuote.author?.handle ?? "vercel";
      $("#qVerified").value = exQuote.author?.verified ?? "business";
      $("#qText").value = exQuote.text ?? "";
    } else {
      $("#qName").value = "Vercel";
      $("#qHandle").value = "vercel";
      $("#qVerified").value = "business";
      $("#qText").value = "";
    }
  }

  $("#qUrl")?.addEventListener("input", () => {
    const val = $("#qUrl").value.trim();
    if (val) {
      overrides.quoteMode = "url";
      overrides.quoteUrl = val;
    } else if (overrides.quoteMode === "url") {
      overrides.quoteMode = customDraft ? "none" : "example";
    }
    syncToolbar();
    scheduleChange();
  });

  const onCustomQuoteInput = () => {
    overrides.quoteMode = "custom";
    overrides.quoteCustom = {
      name: $("#qName").value,
      handle: $("#qHandle").value.replace(/^@/, ""),
      verified: $("#qVerified").value,
      text: $("#qText").value,
    };
    syncToolbar();
    scheduleChange();
  };
  for (const sel of ["#qName", "#qHandle", "#qVerified", "#qText"]) {
    $(sel)?.addEventListener("input", onCustomQuoteInput);
    $(sel)?.addEventListener("change", onCustomQuoteInput);
  }

  $("#qClear")?.addEventListener("click", () => {
    overrides.quoteMode = "none";
    overrides.quoteUrl = "";
    overrides.quoteCustom.text = "";
    $("#qUrl").value = "";
    $("#qText").value = "";
    syncToolbar();
    onChange();
  });

  // --- Media & Video controls -----------------------------------------------
  function renderMediaList() {
    const host = $("#mList");
    if (!host) return;
    const items =
      overrides.mediaMode === "custom"
        ? overrides.mediaItems
        : overrides.mediaMode === "none" || customDraft
          ? []
          : (getExample()?.post?.media ?? []);
    if (!items.length && overrides.mediaMode !== "videoUrl") {
      host.replaceChildren(el("span", { class: "faint-note", text: "No media attached." }));
      return;
    }
    if (overrides.mediaMode === "videoUrl") {
      host.replaceChildren(el("span", { class: "chip-item", text: `video URL: ${overrides.videoUrl}` }));
      return;
    }
    host.replaceChildren(
      ...items.map((m, idx) =>
        el("span", { class: "chip-item" }, [
          `${m.kind ?? "image"} ${m.width}×${m.height}${m.alt ? " · ALT" : ""} `,
          el("button", {
            type: "button",
            class: "chip-x",
            "aria-label": `Remove media ${idx + 1}`,
            text: "×",
            onclick: () => {
              if (overrides.mediaMode !== "custom") {
                overrides.mediaMode = "custom";
                overrides.mediaItems = [...items];
              }
              overrides.mediaItems.splice(idx, 1);
              if (!overrides.mediaItems.length) overrides.mediaMode = "none";
              renderMediaList();
              syncToolbar();
              onChange();
            },
          }),
        ]),
      ),
    );
  }

  $("#mFiles")?.addEventListener("change", async (ev) => {
    const files = [...(ev.target.files ?? [])];
    if (!files.length) return;
    const alt = $("#mAlt")?.value?.trim() || undefined;
    const base = overrides.mediaMode === "custom" ? [...overrides.mediaItems] : [];
    for (const file of files) {
      if (base.length >= 20) break;
      try {
        const img = await readImageFile(file);
        base.push({ kind: "image", width: img.width, height: img.height, data: img.data, ...(alt ? { alt } : {}) });
      } catch {}
    }
    if (base.length) {
      overrides.mediaMode = "custom";
      overrides.mediaItems = base;
      overrides.pollMode = overrides.pollMode === "custom" ? "none" : overrides.pollMode;
      renderMediaList();
      syncToolbar();
      onChange();
    }
    ev.target.value = "";
  });

  $("#mAlt")?.addEventListener("input", () => {
    const alt = $("#mAlt").value.trim();
    overrides.mediaAlt = alt;
    if (overrides.mediaMode === "custom" && overrides.mediaItems.length) {
      overrides.mediaItems = overrides.mediaItems.map((m, i) => (i === 0 ? { ...m, alt: alt || undefined } : m));
      renderMediaList();
      scheduleChange();
    }
  });

  $("#mVideoUrl")?.addEventListener("input", () => {
    const val = $("#mVideoUrl").value.trim();
    if (val) {
      overrides.mediaMode = "videoUrl";
      overrides.videoUrl = val;
    } else if (overrides.mediaMode === "videoUrl") {
      overrides.mediaMode = customDraft ? "none" : "example";
    }
    renderMediaList();
    syncToolbar();
    scheduleChange();
  });

  $("#mClear")?.addEventListener("click", () => {
    overrides.mediaMode = "none";
    overrides.mediaItems = [];
    overrides.videoUrl = "";
    if ($("#mVideoUrl")) $("#mVideoUrl").value = "";
    renderMediaList();
    syncToolbar();
    onChange();
  });

  // --- Poll controls --------------------------------------------------------
  function hydratePollInputs() {
    const p =
      overrides.pollMode === "custom"
        ? overrides.poll
        : !customDraft && overrides.pollMode === "example" && getExample()?.post?.poll
          ? {
              choices: [0, 1, 2, 3].map((i) => getExample().post.poll.choices?.[i] ?? ""),
              votes: [0, 1, 2, 3].map((i) =>
                getExample().post.poll.votes?.[i] != null ? String(getExample().post.poll.votes[i]) : "",
              ),
              hoursLeft: "24",
            }
          : overrides.poll;
    for (let i = 0; i < 4; i++) {
      $(`#pChoice${i}`).value = p.choices[i] ?? "";
      $(`#pVotes${i}`).value = p.votes[i] ?? "";
    }
    $("#pHours").value = p.hoursLeft ?? "24";
  }

  const onPollInput = () => {
    overrides.pollMode = "custom";
    overrides.poll = {
      choices: [0, 1, 2, 3].map((i) => $(`#pChoice${i}`).value),
      votes: [0, 1, 2, 3].map((i) => $(`#pVotes${i}`).value),
      hoursLeft: $("#pHours").value,
    };
    syncToolbar();
    scheduleChange();
  };
  for (let i = 0; i < 4; i++) {
    $(`#pChoice${i}`)?.addEventListener("input", onPollInput);
    $(`#pVotes${i}`)?.addEventListener("input", onPollInput);
  }
  $("#pHours")?.addEventListener("input", onPollInput);

  $("#pSample")?.addEventListener("click", () => {
    overrides.pollMode = "custom";
    overrides.mediaMode = "none";
    overrides.poll = {
      choices: ["Vercel", "Self-hosted VPS", "Managed Kubernetes", "localhost:3000"],
      votes: ["9120", "2430", "1970", "6220"],
      hoursLeft: "24",
    };
    hydratePollInputs();
    syncToolbar();
    onChange();
  });

  $("#pClear")?.addEventListener("click", () => {
    overrides.pollMode = "none";
    overrides.poll = { choices: ["", "", "", ""], votes: ["", "", "", ""], hoursLeft: "24" };
    hydratePollInputs();
    syncToolbar();
    onChange();
  });

  // --- Card dismiss toggle --------------------------------------------------
  btnCardDismiss?.addEventListener("click", () => {
    overrides.cardDismissed = !overrides.cardDismissed;
    onChange();
  });

  // --- Variants customizer --------------------------------------------------
  function renderVariantsPane() {
    if (variantsBtn) {
      const open = variantsPane && !variantsPane.hidden;
      variantsBtn.textContent = open
        ? `hide variants (${variantState.variants.length})`
        : `variants (${variantState.variants.length})`;
    }
    if (!variantsPane) return;
    const activeHost = $("#varActiveList");
    if (activeHost) {
      activeHost.replaceChildren(
        ...variantState.variants.map((v, idx) =>
          el("span", { class: "chip-item" }, [
            variantDisplayLabel(v),
            variantState.variants.length > 1
              ? el("button", {
                  type: "button",
                  class: "chip-x",
                  "aria-label": `Remove ${variantDisplayLabel(v)}`,
                  text: "×",
                  onclick: () => {
                    variantState.variants.splice(idx, 1);
                    saveVariantsState(variantState);
                    renderVariantsPane();
                    onChange();
                  },
                })
              : "",
          ]),
        ),
      );
    }
    const presetsHost = $("#varPresets");
    if (presetsHost) {
      presetsHost.replaceChildren(
        ...VARIANT_PRESETS.map((p) => {
          const active = variantState.variants.some((v) => sameVariant(v, p.variant));
          return el("button", {
            type: "button",
            class: `preset-chip${active ? " on" : ""}`,
            "aria-pressed": String(active),
            text: p.label,
            onclick: () => {
              const existing = variantState.variants.findIndex((v) => sameVariant(v, p.variant));
              if (existing >= 0) {
                if (variantState.variants.length > 1) variantState.variants.splice(existing, 1);
              } else if (variantState.variants.length < 8) {
                variantState.variants.push({ ...p.variant });
              }
              saveVariantsState(variantState);
              renderVariantsPane();
              onChange();
            },
          });
        }),
      );
    }
    if ($("#varAutoExpand")) $("#varAutoExpand").checked = variantState.autoExpand;
    if ($("#varFontScale")) $("#varFontScale").value = String(variantState.fontScale);
    if ($("#varFontScaleVal")) $("#varFontScaleVal").textContent = `${variantState.fontScale.toFixed(2)}×`;
  }

  variantsBtn?.addEventListener("click", () => {
    if (!variantsPane) return;
    const open = variantsPane.hidden;
    variantsPane.hidden = !open;
    variantsBtn.setAttribute("aria-expanded", String(open));
    renderVariantsPane();
  });

  $("#varAdd")?.addEventListener("click", () => {
    if (variantState.variants.length >= 8) return;
    const surface = $("#varSurface").value;
    const width = Math.min(600, Math.max(100, Math.round(Number($("#varWidth").value) || 390)));
    const dpr = Number($("#varDpr").value) || 2;
    const expanded = Boolean($("#varExpanded").checked);
    const candidate = { surface, width, dpr, ...(expanded ? { expanded: true } : {}) };
    if (!variantState.variants.some((v) => sameVariant(v, candidate))) {
      variantState.variants.push(candidate);
      saveVariantsState(variantState);
      renderVariantsPane();
      onChange();
    }
  });

  $("#varAutoExpand")?.addEventListener("change", (ev) => {
    variantState.autoExpand = ev.target.checked;
    saveVariantsState(variantState);
    onChange();
  });

  $("#varFontScale")?.addEventListener("input", (ev) => {
    variantState.fontScale = Number(ev.target.value) || 1;
    if ($("#varFontScaleVal")) $("#varFontScaleVal").textContent = `${variantState.fontScale.toFixed(2)}×`;
    saveVariantsState(variantState);
    scheduleChange();
  });

  $("#varReset")?.addEventListener("click", () => {
    variantState.variants = DEFAULT_VARIANTS.map((v) => ({ ...v }));
    variantState.autoExpand = true;
    variantState.fontScale = 1;
    saveVariantsState(variantState);
    renderVariantsPane();
    onChange();
  });

  renderVariantsPane();

  // --- Toolbar state sync ---------------------------------------------------
  function hasAnyOverride() {
    const ex = getExample();
    return (
      customDraft ||
      input.value.trim() !== (ex?.url ?? "") ||
      overrides.authorMode !== "example" ||
      overrides.countsOn ||
      Boolean(overrides.replyToHandle) ||
      overrides.quoteMode !== "example" ||
      overrides.mediaMode !== "example" ||
      overrides.pollMode !== "example" ||
      overrides.cardDismissed ||
      urlAttachMode !== null
    );
  }

  function syncToolbar(renderedPost = null, firstReport = null) {
    syncUrlModeBar();
    const ex = getExample();
    if (btnResetDraft) btnResetDraft.hidden = !hasAnyOverride();
    if (btnEditText) btnEditText.hidden = customDraft || input.value.trim() !== (ex?.url ?? "");

    const kind = classify(input.value);
    const activeAuthor =
      renderedPost?.author ??
      (kind === "url" ? null : effectiveBaseAuthor());
    if (btnAuthor) {
      const h = activeAuthor?.handle ? `@${String(activeAuthor.handle).replace(/^@/, "")}` : "@vercel";
      btnAuthor.textContent = h;
      btnAuthor.classList.toggle("is-set", overrides.authorMode === "custom" || customDraft);
    }

    const hasQuote = Boolean(
      renderedPost?.quote ||
        overrides.quoteMode === "url" ||
        (overrides.quoteMode === "custom" && overrides.quoteCustom.text.trim()) ||
        (!customDraft && overrides.quoteMode === "example" && getExample()?.post?.quote),
    );
    if (btnQuote) {
      btnQuote.textContent = hasQuote ? "quote ✓" : "+ quote";
      btnQuote.classList.toggle("is-set", hasQuote);
    }

    const mediaLen =
      renderedPost?.media?.length ??
      (overrides.mediaMode === "custom"
        ? overrides.mediaItems.length
        : overrides.mediaMode === "videoUrl"
          ? 1
          : !customDraft && overrides.mediaMode === "example"
            ? (getExample()?.post?.media?.length ?? 0)
            : 0);
    if (btnMedia) {
      const isVid = renderedPost?.media?.[0]?.kind === "video" || overrides.mediaMode === "videoUrl";
      btnMedia.textContent = mediaLen ? (isVid ? "video ✓" : `media (${mediaLen})`) : "+ media";
      btnMedia.classList.toggle("is-set", mediaLen > 0);
    }

    const hasPoll = Boolean(
      renderedPost?.poll ||
        (overrides.pollMode === "custom" && overrides.poll.choices.filter((c) => c.trim()).length >= 2) ||
        (!customDraft && overrides.pollMode === "example" && getExample()?.post?.poll),
    );
    if (btnPoll) {
      btnPoll.textContent = hasPoll ? "poll ✓" : "+ poll";
      btnPoll.classList.toggle("is-set", hasPoll);
    }

    if (btnCardDismiss) {
      const cardPresent = renderedPost ? hasCard(renderedPost) : false;
      btnCardDismiss.hidden = !cardPresent && !overrides.cardDismissed;
      btnCardDismiss.textContent = overrides.cardDismissed ? "restore card" : "card ×";
    }

    if (charCount) {
      const w = firstReport?.length?.weighted ?? weightedLength(kind === "url" || kind === "json" ? (renderedPost?.text ?? "") : input.value);
      charCount.textContent = w > 280 ? `${w.toLocaleString()} · long post` : `${w} / 280`;
    }
  }

  function markUserTyped() {
    userTyped = true;
    syncUrlModeBar();
  }

  function resetForExample() {
    customDraft = false;
    userTyped = false;
    urlAttachMode = null;
    overrides = emptyOverrides();
    if (openDrawer) setDrawer(openDrawer); // close open drawer on example switch
    syncUrlModeBar();
  }

  // --- Compose final Post ---------------------------------------------------
  async function buildComposedPost(rawText, buildExampleBase) {
    const kind = classify(rawText);

    // 1. Pasted Post JSON (`{ "text": "...", ... }`): validate & default unknown author to Vercel.
    if (kind === "json") {
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new Error("invalid Post JSON");
      }
      const postObj = parsed?.post && typeof parsed.post === "object" ? parsed.post : parsed;
      const withDefaults = await ensureAuthorAndAvatars(postObj, lookupStaticAvatar);
      return cleanPost(withDefaults);
    }

    // 2. Built-in example URL fast path: instant offline render from bundled Post + assets,
    //    with any composer overrides layered on top.
    const activeExample = !customDraft ? getExample() : null;
    if (activeExample && rawText.trim() === activeExample.url) {
      let post = await buildExampleBase(activeExample.post.text);
      post = await applyOverrides(post);
      post = await ensureAuthorAndAvatars(post, lookupStaticAvatar);
      return cleanPost(post);
    }

    // 3. Any other standalone x.com status URL: resolve full post live from X.
    if (kind === "url") {
      const url = rawText.trim();
      const resolved = await resolveCached(`input:${url}`);
      if (!resolved?.post) throw new Error("couldn't resolve that x.com link");
      let post = { ...resolved.post };
      post = await applyOverrides(post);
      post = await ensureAuthorAndAvatars(post, lookupStaticAvatar);
      return cleanPost(post);
    }

    // 3. Draft text (either a built-in example or a custom `@vercel` draft).
    const statusUrl = userTyped ? statusUrlInText(rawText) : null;
    const mode = statusUrl ? effectiveUrlMode(rawText) : null;
    const effectiveText = statusUrl && mode ? bodyForMode(rawText, statusUrl, mode) : rawText;

    let post;
    if (customDraft) {
      const now = new Date().toISOString();
      post = {
        now,
        createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
        author: { ...VERCEL_AUTHOR },
        text: effectiveText,
        counts: { replies: 12, reposts: 28, likes: 340, views: 18400 },
        links: {},
      };
    } else {
      post = await buildExampleBase(effectiveText);
    }

    // Inline status URL in text: resolve as quote card or embedded video!
    if (statusUrl && mode === "quote" && overrides.quoteMode === "example") {
      const resolved = await resolveCached(`input:${statusUrl}`);
      if (resolved?.post) {
        post.quote = cleanQuote(resolved.post);
      }
    } else if (statusUrl && mode === "video" && overrides.mediaMode === "example") {
      const vidUrl = videoVariant(statusUrl);
      const resolved = await resolveCached(`input:${vidUrl}`);
      if (resolved?.post?.media?.length) {
        const srcAuthor = resolved.post.author;
        post.media = resolved.post.media.slice(0, 1).map((m) => ({
          ...m,
          sourceAuthor: m.sourceAuthor ?? srcAuthor,
        }));
      }
    }

    post = await applyOverrides(post);
    post = await ensureAuthorAndAvatars(post, lookupStaticAvatar);
    return cleanPost(post);
  }

  async function applyOverrides(post) {
    const out = { ...post };

    if (overrides.authorMode === "custom") {
      const cleaned = cleanAuthor(overrides.author) ?? { ...VERCEL_AUTHOR };
      out.author = cleaned;
    }

    if (overrides.replyToHandle) {
      out.replyTo = "1";
      out.replyToHandle = overrides.replyToHandle;
    }

    if (overrides.countsOn) {
      const counts = {};
      for (const k of ["replies", "reposts", "likes", "views", "bookmarks"]) {
        const n = Number(overrides.counts[k]);
        if (Number.isFinite(n) && n > 0) counts[k] = Math.round(n);
      }
      out.counts = Object.keys(counts).length ? counts : undefined;
    }

    // Quote overrides
    if (overrides.quoteMode === "none") {
      delete out.quote;
    } else if (overrides.quoteMode === "url" && overrides.quoteUrl) {
      const resolved = await resolveCached(`input:${overrides.quoteUrl}`);
      if (resolved?.post) out.quote = cleanQuote(resolved.post);
    } else if (overrides.quoteMode === "custom") {
      if (overrides.quoteCustom.text.trim()) {
        out.quote = {
          text: overrides.quoteCustom.text,
          createdAt: out.now ?? new Date().toISOString(),
          author: {
            name: overrides.quoteCustom.name.trim() || VERCEL_AUTHOR.name,
            handle: overrides.quoteCustom.handle.trim() || VERCEL_AUTHOR.handle,
            verified: overrides.quoteCustom.verified || VERCEL_AUTHOR.verified,
            ...(overrides.quoteCustom.handle.trim().toLowerCase() === "vercel" || !overrides.quoteCustom.handle.trim()
              ? { squareAvatar: true }
              : {}),
          },
        };
      } else {
        delete out.quote;
      }
    }

    // Media / Video overrides
    if (overrides.mediaMode === "none") {
      delete out.media;
    } else if (overrides.mediaMode === "custom") {
      out.media = overrides.mediaItems.length ? [...overrides.mediaItems] : undefined;
      if (out.media?.length) delete out.poll;
    } else if (overrides.mediaMode === "videoUrl" && overrides.videoUrl) {
      const vUrl = isStatusUrl(overrides.videoUrl) ? videoVariant(overrides.videoUrl) : overrides.videoUrl;
      const resolved = await resolveCached(`input:${vUrl}`);
      if (resolved?.post?.media?.length) {
        const srcAuthor = resolved.post.author;
        out.media = resolved.post.media.slice(0, 1).map((m) => ({
          ...m,
          sourceAuthor: m.sourceAuthor ?? srcAuthor,
        }));
        delete out.poll;
      }
    }

    // Poll overrides
    if (overrides.pollMode === "none") {
      delete out.poll;
    } else if (overrides.pollMode === "custom") {
      const pairs = [0, 1, 2, 3]
        .map((i) => ({ choice: overrides.poll.choices[i]?.trim() ?? "", vote: overrides.poll.votes[i] }))
        .filter((p) => p.choice.length > 0);
      if (pairs.length >= 2) {
        const votes = pairs.map((p) => Math.max(0, Math.round(Number(p.vote) || 0)));
        const hasVotes = votes.some((v) => v > 0);
        const hours = Math.max(1, Math.round(Number(overrides.poll.hoursLeft) || 24));
        out.poll = {
          choices: pairs.map((p) => p.choice),
          ...(hasVotes ? { votes } : { secondsLeft: hours * 3600 }),
        };
        delete out.media;
      }
    }

    if (overrides.cardDismissed) {
      out.cardState = "dismissed";
    }

    return out;
  }

  return {
    getVariants: () => variantState.variants,
    getAutoExpand: () => variantState.autoExpand,
    getFontScale: () => variantState.fontScale,
    isCustomDraft: () => customDraft,
    hasActiveAttachment: () => {
      if (overrides.mediaMode === "custom" && overrides.mediaItems.length) return true;
      if (overrides.mediaMode === "videoUrl" && overrides.videoUrl) return true;
      if (overrides.quoteMode === "url" && overrides.quoteUrl) return true;
      if (overrides.quoteMode === "custom" && overrides.quoteCustom.text.trim()) return true;
      if (overrides.pollMode === "custom" && overrides.poll.choices.filter((c) => c.trim()).length >= 2) return true;
      if (!customDraft) {
        const ex = getExample()?.post;
        if (overrides.mediaMode === "example" && ex?.media?.length) return true;
        if (overrides.quoteMode === "example" && ex?.quote) return true;
        if (overrides.pollMode === "example" && ex?.poll) return true;
      }
      return false;
    },
    markUserTyped,
    resetForExample,
    syncToolbar,
    buildComposedPost,
  };
}
