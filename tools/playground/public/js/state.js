// The playground's state: what is pasted, how it is rendered, what is on
// screen. Persisted twice — in the URL hash (shareable) and in localStorage
// (so a reload with a fresh URL keeps your draft).
//
// The hash is the shareable form, so it is compact: short keys, and base64
// data (media, avatars, card images) is dropped once the encoded state gets
// long, because a URL is not a place for images. Dimensions survive, which is
// all the renderer needs to lay out the same crop.

import { clamp, decodeHashValue, encodeHashValue } from "./util.js";

export const STORAGE_KEY = "xeet.playground.v2";
export const HASH_PARAM = "s";
/** Above this many characters of base64 payload, images stop being shareable. */
const PRUNE_ABOVE = 24000;

export const TARGET_ORDER_DEFAULT = ["chrome", "wasm", "native", "http"];

const prefersDark = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export const SAMPLE_TEXT = `We just shipped xeet: paste a post and every build lays it out next to Chrome.

No browser in the renderer, no fonts to install. The interesting part is the long tail: URL wrapping, emoji, bidi, and the exact place X says "Show more".

https://vercel.com/blog/the-thing`;

export const SAMPLE_URL = "https://vercel.com/blog/the-thing";

export function defaultState() {
  return {
    input: SAMPLE_TEXT,
    // Overrides applied on top of the post the input resolves to. An empty
    // object means "render what was pasted".
    patch: {
      author: { name: "Vercel", handle: "vercel", verified: "business", squareAvatar: true },
      links: {
        [SAMPLE_URL]: {
          card: "summary_large_image",
          title: "The thing, shipped",
          description: "What we built, why it took a week, and what broke on the way.",
          image: { width: 1200, height: 630 },
        },
      },
    },
    options: {
      surface: "web-timeline",
      theme: prefersDark() ? "dark" : "light",
      // An iPhone class viewport at its real density; the device picker sets
      // width and dpr together from js/devices.js.
      width: 390,
      dpr: 3,
      fontScale: 1,
      // Chrome only: how the oracle rasterizes glyphs. "antialiased" is what
      // the gates compare; "platform" is what x.com looks like on this Mac.
      smoothing: "antialiased",
    },
    targets: TARGET_ORDER_DEFAULT.map((id) => ({ id, on: true })),
    diff: { a: "chrome", b: "wasm", mode: "overlay", opacity: 0.5, zoom: 1, outlines: false },
    ui: {
      drawer: false,
      // "fit" scales the columns so every target sits side by side.
      zoom: "fit",
      matrix: false,
      // Which inspect tab is open, if any. Collapsed by default: previews first.
      inspect: null,
      reportFrom: null,
      chromeMode: "page",
    },
    quoteUrl: "",
    // The core has no clock: drafts get one timestamp for both `createdAt` and
    // `now`, re-stamped when the input changes unless it is frozen. Times are
    // rewritten into `zone` before they reach a target (see js/time.js).
    clock: { at: new Date().toISOString(), freeze: false, zone: "local" },
    // Link cards are resolved on the server; `media: true` also fetches images.
    links: { resolve: true, media: true },
  };
}

const SURFACES = new Set(["web-timeline", "web-detail"]);
const THEMES = new Set(["light", "dark"]);
const MODES = new Set(["overlay", "flicker", "heatmap", "side"]);

function num(value, fallback, lo, hi) {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

/** Short keys: the hash is a URL. */
function encode(state) {
  const o = state.options;
  return {
    i: state.input,
    p: state.patch && Object.keys(state.patch).length ? state.patch : undefined,
    o: [o.surface, o.theme, o.width, o.dpr, o.fontScale, o.smoothing],
    tg: state.targets.map((t) => [t.id, t.on ? 1 : 0]),
    d: {
      a: state.diff.a,
      b: state.diff.b,
      m: state.diff.mode,
      o: state.diff.opacity,
      z: state.diff.zoom,
      l: state.diff.outlines ? 1 : 0,
    },
    q: state.quoteUrl ? state.quoteUrl : undefined,
    u: {
      z: state.ui.zoom,
      m: state.ui.matrix ? 1 : 0,
      i: state.ui.inspect ?? undefined,
      d: state.ui.drawer ? 1 : 0,
      c: state.ui.chromeMode,
      r: state.ui.reportFrom ?? undefined,
      k: [state.clock?.at, state.clock?.freeze ? 1 : 0, state.clock?.zone],
      // media: 1 on, 2 off. A 0 is the old encoding, saved when the switch
      // defaulted to off, and now reads as the new default (on).
      l: [state.links?.resolve === false ? 0 : 1, state.links?.media === false ? 2 : 1],
    },
  };
}

function decode(raw, base) {
  if (!raw || typeof raw !== "object") return base;
  const out = base;
  if (typeof raw.i === "string") out.input = raw.i;
  if (typeof raw.q === "string") out.quoteUrl = raw.q;
  // Copy: callers hand in the encoded form, which shares its patch object with
  // the live state, and pruning the shareable copy must not touch the state.
  if (raw.p && typeof raw.p === "object") out.patch = JSON.parse(JSON.stringify(raw.p));
  // A business account is drawn with a rounded-square avatar. Sessions saved
  // before that default existed get it now, unless the drawer said otherwise.
  if (out.patch?.author?.verified === "business" && typeof raw.p?.author?.squareAvatar !== "boolean") {
    out.patch.author.squareAvatar = true;
  }
  if (Array.isArray(raw.o)) {
    const [surface, theme, width, dpr, fontScale, smoothing] = raw.o;
    if (SURFACES.has(surface)) out.options.surface = surface;
    if (THEMES.has(theme)) out.options.theme = theme;
    out.options.width = Math.round(num(width, out.options.width, 280, 1200));
    out.options.dpr = [1, 2, 3].includes(Number(dpr)) ? Number(dpr) : out.options.dpr;
    out.options.fontScale = num(fontScale, out.options.fontScale, 0.8, 1.35);
    out.options.smoothing = smoothing === "platform" ? "platform" : "antialiased";
  }
  if (Array.isArray(raw.tg)) {
    const seen = new Set();
    const list = [];
    for (const entry of raw.tg) {
      const [id, on] = [].concat(entry);
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      list.push({ id, on: !!on });
    }
    for (const id of TARGET_ORDER_DEFAULT) if (!seen.has(id)) list.push({ id, on: true });
    out.targets = list;
  }
  if (raw.d && typeof raw.d === "object") {
    const d = raw.d;
    if (typeof d.a === "string") out.diff.a = d.a;
    if (typeof d.b === "string") out.diff.b = d.b;
    if (MODES.has(d.m)) out.diff.mode = d.m;
    out.diff.opacity = num(d.o, out.diff.opacity, 0, 1);
    out.diff.zoom = [1, 2, 4, 8].includes(Number(d.z)) ? Number(d.z) : 1;
    out.diff.outlines = !!d.l;
  }
  if (raw.u && typeof raw.u === "object") {
    out.ui.zoom = raw.u.z === "fit" ? "fit" : [1, 0.75, 0.5].includes(Number(raw.u.z)) ? Number(raw.u.z) : "fit";
    out.ui.matrix = !!raw.u.m;
    out.ui.inspect = ["diff", "report", "matrix"].includes(raw.u.i) ? raw.u.i : null;
    out.ui.drawer = !!raw.u.d;
    out.ui.chromeMode = raw.u.c === "replica" ? "replica" : "page";
    if (typeof raw.u.r === "string") out.ui.reportFrom = raw.u.r;
    if (Array.isArray(raw.u.k)) {
      const [at, freeze, zone] = raw.u.k;
      if (typeof at === "string" && !Number.isNaN(Date.parse(at))) out.clock.at = at;
      out.clock.freeze = !!freeze;
      if (typeof zone === "string" && (zone === "local" || zone === "UTC" || /^[A-Za-z_]+\/[A-Za-z_+\-0-9]+$/.test(zone))) {
        out.clock.zone = zone;
      }
    }
    if (Array.isArray(raw.u.l)) {
      const [resolve, media] = raw.u.l;
      out.links.resolve = resolve !== 0;
      out.links.media = media !== 2;
    }
  }
  return out;
}

/** A base64 payload: long, and neither a URL nor prose. */
function isData(value) {
  return typeof value === "string" && value.length > 200 && !/^https?:/.test(value) && !value.includes(" ");
}

/**
 * How many characters of base64 the encoded state carries, without serializing
 * it. The hash is a URL and is re-encoded on every keystroke, so a 40 kB avatar
 * has to be dropped *before* `encodeHashValue` runs, not parsed back out of its
 * output; this is the cheap walk that decides.
 */
function carriedImageChars(encoded) {
  let total = 0;
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const item of Object.values(value)) {
      if (isData(item)) total += item.length;
      else walk(item);
    }
  };
  walk(encoded.p);
  const input = typeof encoded.i === "string" ? encoded.i.trim() : "";
  if (input.startsWith("{")) {
    try {
      walk(JSON.parse(input));
    } catch {
      // invalid JSON: resolve will report it
    }
  }
  return total;
}

/** Drops long base64 payloads from a state object, in place. Returns how many. */
function pruneImages(state) {
  let dropped = 0;

  const walkMedia = (list) => {
    if (!Array.isArray(list)) return;
    for (const m of list) {
      if (m && isData(m.data)) {
        delete m.data;
        dropped++;
      }
    }
  };
  const walkPost = (post) => {
    if (!post || typeof post !== "object") return;
    walkMedia(post.media);
    if (post.author && isData(post.author.avatar)) {
      delete post.author.avatar;
      dropped++;
    }
    if (post.author?.affiliate && isData(post.author.affiliate.badge)) {
      delete post.author.affiliate.badge;
      dropped++;
    }
    if (post.links && typeof post.links === "object") {
      for (const meta of Object.values(post.links)) {
        if (meta?.image && isData(meta.image.data)) {
          delete meta.image.data;
          dropped++;
        }
      }
    }
    if (post.quote) walkPost(post.quote);
  };

  walkPost(state.patch);
  // A pasted Post JSON carries its own images inside the input string.
  const input = state.input.trim();
  if (input.startsWith("{")) {
    try {
      const parsed = JSON.parse(input);
      const before = dropped;
      walkPost(parsed);
      if (dropped > before) state.input = JSON.stringify(parsed, null, 2);
    } catch {
      // invalid JSON: nothing to prune, resolve will report it
    }
  }
  return dropped;
}

function fromHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const raw = params.get(HASH_PARAM);
  if (!raw) return null;
  try {
    return decodeHashValue(raw);
  } catch {
    return null;
  }
}

function fromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function createStore() {
  const base = defaultState();
  const hashRaw = fromHash();
  const storedRaw = fromStorage();
  // A hash in the URL is an explicit share link and wins; otherwise the last
  // session wins; otherwise the sample.
  const state = decode(hashRaw ?? storedRaw, base);

  const subscribers = new Set();
  let saveTimer = null;
  let sharePruned = 0;
  let onPrune = null;
  /** The last hash text written, so an unchanged state is not re-serialized. */
  let lastHash = null;

  function persist() {
    saveTimer = null;
    const plain = encode(state);
    // localStorage keeps images: it is on this machine, private and large.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(plain));
    } catch {
      const copy = decode(plain, defaultState());
      pruneImages(copy);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(encode(copy)));
      } catch {
        // storage is full or disabled; the app still works
      }
    }

    // The hash is the shareable form, so images leave before it is encoded: a
    // keystroke that re-encoded a 40 kB avatar only to prune it again is the
    // most expensive thing this store could do, and it would do it per key.
    let share = plain;
    if (carriedImageChars(plain) > PRUNE_ABOVE * 0.75) {
      // Pruning works on a state-shaped copy, not on the encoded object.
      const copy = decode(plain, defaultState());
      const pruned = pruneImages(copy);
      if (pruned) {
        sharePruned += pruned;
        onPrune?.(pruned);
      }
      share = encode(copy);
    }
    const text = encodeHashValue(share);
    // Same state, same URL: writing it again costs a base64 encode of the whole
    // state and a history entry that says nothing new.
    if (text === lastHash) return;
    lastHash = text;
    try {
      const url = `${location.pathname}${location.search}#${HASH_PARAM}=${text}`;
      history.replaceState(null, "", url);
    } catch {
      // replaceState can throw on very long URLs; localStorage still has it
    }
  }

  /**
   * Persistence is invisible, so it belongs in the gap after the frame rather
   * than inside the frame a keystroke caused. `requestIdleCallback`'s timeout
   * bounds it: a page that never goes idle still saves, and a reload straight
   * after typing still finds the draft.
   */
  const idle =
    typeof requestIdleCallback === "function"
      ? (fn) => requestIdleCallback(fn, { timeout: 200 })
      : (fn) => setTimeout(fn, 0);

  const schedulePersist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      idle(persist);
    }, 120);
  };

  return {
    state,
    /** Mutates state in place, notifies, and persists (debounced). */
    set(mutate, { persist: shouldPersist = true } = {}) {
      const result = mutate(state);
      for (const fn of subscribers) fn(state, result);
      if (shouldPersist) schedulePersist();
      return result;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    persistNow: persist,
    /** How many base64 payloads the last hash write had to drop. */
    get sharePruned() {
      return sharePruned;
    },
    /** Called with how many payloads a hash write dropped, to warn the user. */
    set onPrune(fn) {
      onPrune = fn;
    },
    /** Replaces everything (used by "reset" and by hash navigation). */
    replace(next, { persist: shouldPersist = true } = {}) {
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, next);
      for (const fn of subscribers) fn(state, { replaced: true });
      if (shouldPersist) schedulePersist();
    },
  };
}
