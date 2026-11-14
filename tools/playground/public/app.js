// xeet playground.
//
// One loop: state changes → compose the post → every enabled target renders
// (wasm here, the rest on the server) → columns, diff and report follow. The
// loop is cheap to re-enter, so typing runs it on every input event and only
// the network targets debounce.

import { $, $$, base64ToBytes, canonical, debounce, escapeHtml, fmtMs, nextPaint } from "./js/util.js";
import { createStore } from "./js/state.js";
import { createApi } from "./js/api.js";
import { classify, composePost, describeInput, pageKey, patchFromPost, urlsInText, withClock } from "./js/model.js";
import { mediaUrlInText, normalizeLinkInfo, statusUrlInText, trailingStatusUrl, urlSetKey, videoVariant } from "./js/links.js";
import { vercelAvatarBase64 } from "./js/vercel-avatar.js";
import { LOCAL, localizeTimes } from "./js/time.js";
import { ensureWasmFonts, loadWasm, renderWasm } from "./js/wasm.js";
import { ColumnsView, TargetRunner, delayFor, mergeTargets } from "./js/render.js";
import { createControls } from "./js/controls.js";
import {
  comparePixels,
  decodeImage,
  hasGeometry,
  paintGeometry,
  paintGeometryPair,
  paintMask,
  pixelsOf,
} from "./js/diff.js";
import {
  MATRIX_THEMES,
  MATRIX_WIDTHS,
  composeSheet,
  highlightHtml,
  matrixCell,
  matrixPlan,
  renderReport,
} from "./js/report.js";

const store = createStore();
const runtime = {
  mock: new URLSearchParams(location.search).has("mock"),
  api: null,
  kind: "text",
  base: { text: store.state.input },
  source: null,
  resolveFor: null,
  resolving: false,
  resolveError: null,
  serverTargets: [],
  targets: [],
  apiDown: false,
  runners: new Map(),
  states: new Map(),
  deltas: new Map(),
  compare: new Map(),
  reports: new Map(),
  upstream: "",
  matrix: null,
  sharePruned: 0,
  // Link cards resolved by /api/resolve, keyed by the set of URLs in the text.
  linkCache: new Map(),
  linkInfo: null,
  linksState: { status: "idle", count: 0, quote: null, message: "" },
  // X's Quote Tweet composer: a post attached out of band, costing no characters.
  quoteCache: new Map(),
  quoteSlot: { url: "", status: "idle", quote: null, fetchMs: null, message: "" },
};

const els = {
  live: $("#live"),
  liveText: $("#liveText"),
  upstream: $("#upstream"),
  detect: $("#detect"),
  detectDetail: $("#detectDetail"),
  resolveError: $("#resolveError"),
  columns: $("#columns"),
  chips: $("#targetChips"),
  reportBody: $("#reportBody"),
  reportTarget: $("#reportTarget"),
  diffStage: $("#diffStage"),
  diffWorld: $("#diffWorld"),
  imgA: $("#imgA"),
  imgB: $("#imgB"),
  mask: $("#maskCanvas"),
  geomA: $("#geomA"),
  geomB: $("#geomB"),
  geomTop: $("#geomTop"),
  diffStats: $("#diffStats"),
  diffEmpty: $("#diffEmpty"),
  toast: $("#toast"),
  colZoom: $("#colZoom"),
  matrix: $("#matrix"),
  matrixGrid: $("#matrixGrid"),
  matrixStatus: $("#matrixStatus"),
  inspect: $("#inspect"),
  insTabs: $("#insTabs"),
  insClose: $("#insClose"),
  inspectBtn: $("#inspectBtn"),
  banner: $("#banner"),
  avaImg: $("#avaImg"),
  avaName: $("#avaName"),
  avaHandle: $("#avaHandle"),
  avaBadge: $("#avaBadge"),
  charCount: $("#charCount"),
  ringArc: $("#ringArc"),
  countWrap: $("#countWrap"),
  longBadge: $("#longBadge"),
  modePill: $("#modePill"),
  cardChip: $("#cardChip"),
  cardDomain: $("#cardDomain"),
  cardDismiss: $("#cardDismiss"),
  cardRestore: $("#cardRestore"),
  mediaSlot: $("#mediaSlot"),
  mediaUrl: $("#mediaUrl"),
  mediaPill: $("#mediaPill"),
  mediaClear: $("#mediaClear"),
  pollSlot: $("#pollSlot"),
  pollClear: $("#pollClear"),
  authorBtn: $("#authorBtn"),
  authorPop: $("#authorPop"),
  authorPopClose: $("#authorPopClose"),
  authorPresets: $("#authorPresets"),
  viewBtn: $("#viewBtn"),
  viewPop: $("#viewPop"),
  viewClose: $("#viewClose"),
  drawerOpen: $("#drawerOpen"),
  drawerClose: $("#drawerClose"),
};

// ---------------------------------------------------------------------------
// Toast

let toastTimer = null;
function toast(message, kind = "") {
  els.toast.textContent = message;
  els.toast.dataset.kind = kind;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, kind === "error" ? 6000 : 2600);
}

// ---------------------------------------------------------------------------
// Boot

const columns = new ColumnsView(els.columns, {
  // Chrome's page/replica switch belongs in the Chrome column, not a toolbar.
  chromeModeEl: $("#chromeMode"),
  onToggle: (id, on) => toggleTarget(id, on),
  onMove: (id, delta) => moveTarget(id, delta),
  onRebuild: (id) => rebuildTarget(id),
  onPickDiff: (id) => pickDiff(id),
  onInspect: () => showInspect("diff"),
  onSmoothing: (value) => {
    store.set((s) => {
      s.options.smoothing = value === "platform" ? "platform" : "antialiased";
    });
    refresh({ reason: "smoothing" });
  },
});

let controls = null;

boot();

async function boot() {
  document.documentElement.dataset.theme = store.state.options.theme;
  controls = createControls({ store, toast });
  let pruneNotified = false;
  store.onPrune = (count) => {
    if (pruneNotified) return;
    pruneNotified = true;
    toast(
      `${count} image${count === 1 ? "" : "s"} left out of the share URL (too large); this browser still has them`,
      "error",
    );
  };
  $("#drawerBtn").addEventListener("click", () => {
    const drawer = $("#drawer");
    drawer.open = !drawer.open;
    drawer.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  $("#themeBtn")?.addEventListener("click", toggleTheme);
  $("#rerender")?.addEventListener("click", () => rerenderAll());
  document.addEventListener("xeet:rerender", () => rerenderAll());

  bindTargetToolbar();
  bindInspect();
  bindComposer();
  bindDiffControls();
  bindReportControls();
  bindKeyboard();
  bindDiffPan();
  bindQuoteSlot();
  observeDiff();

  runtime.api = await createApi({ mock: runtime.mock });
  if (runtime.mock) toast("mock API: renders are simulated locally");

  // wasm warms up in the background; the rest of the UI does not wait for it.
  loadWasm()
    .then((mod) => {
      runtime.upstream = mod.upstream_version?.() ?? "";
      return mod;
    })
    .catch((error) => {
      setLive("error", "wasm unavailable");
      toast(`wasm failed to load: ${error.message}`, "error");
    });

  await loadTargets();
  refresh({ reason: "boot" });

  store.subscribe(() => refresh({ reason: "store" }));
  applyDiffState();
  if (runtime.apiDown) setLive("error", "server API unavailable");
  else setLive("ready", runtime.mock ? "mock" : "ready");
}

// ---------------------------------------------------------------------------
// The loop

let refreshScheduled = false;
function refresh({ reason } = {}) {
  if (refreshScheduled) return;
  refreshScheduled = true;
  nextPaint(() => {
    refreshScheduled = false;
    runRefresh(reason);
  });
}

function runRefresh(reason) {
  const s = store.state;
  document.documentElement.dataset.theme = s.options.theme;

  const kind = classify(s.input);
  runtime.kind = kind;
  let linkKey = null;
  if (kind === "text") {
    runtime.base = { text: s.input };
    runtime.source = null;
    runtime.resolveError = null;
    runtime.resolving = false;
    runtime.resolveFor = null;
    // A resolved card belongs to the set of URLs, not to the text around it,
    // so a cached answer is reused while the prose changes.
    linkKey = urlSetKey(s.input);
    const hit = linkKey && s.links?.resolve !== false ? runtime.linkCache.get(linkKey) : null;
    if (hit) {
      runtime.base.links = hit.links;
      if (hit.media?.length) runtime.base.media = hit.media;
      // A trailing status URL was resolved into a quoted post; without it the
      // quote would silently disappear from every target.
      if (hit.quote) runtime.base.quote = hit.quote;
    }
    // The composer's Quote post slot is out of band: it wins over a URL left in
    // the text, and the drawer's own quote override still wins over both.
    const slot = runtime.quoteSlot.status === "ready" ? runtime.quoteSlot.quote : null;
    if (slot) runtime.base.quote = slot;
  } else if (runtime.resolveFor?.input !== s.input || runtime.resolveFor?.kind !== kind) {
    scheduleResolve(kind, s.input);
  }

  const post = withClock(composePost(runtime.base, s.patch), s.clock?.at);
  // A draft for @vercel gets the real avatar without it ever entering the
  // state: a URL hash must not carry image bytes.
  const handle = String(post.author?.handle ?? "").replace(/^@/, "").toLowerCase();
  if (handle === "vercel" && !post.author.avatar) post.author.avatar = vercelAvatarBase64(400);
  // X shows times in the viewer's zone. The core formats whatever offset the
  // string carries, so rewrite them here — unless the drawer pins a timestamp.
  const zone = s.clock?.zone ?? LOCAL;
  localizeTimes(post, zone, { explicit: "createdAt" in (s.patch ?? {}) || "now" in (s.patch ?? {}) });
  runtime.post = post;

  paintDetection(kind, post);
  if (kind === "text") scheduleLinks(s.input, linkKey);
  scheduleQuoteSlot(s.quoteUrl);
  paintQuoteSlot();
  paintMoveQuote();
  paintComposer();
  paintBanner();
  paintInspect();
  fitColumns();
  controls.sync(post, { kind, base: runtime.base });

  // Fetch all external data first, then paint every column at once in a single
  // stroke — never paint a progressive half-resolved frame and supersede it
  // 400 ms later, and never mix fetch latency into paint latency.
  const awaitingUrlOrJson =
    (kind === "url" || kind === "json") &&
    !runtime.resolveError &&
    (runtime.resolving || runtime.resolveFor?.input !== s.input || runtime.resolveFor?.kind !== kind);
  const allUrlsPatched = (() => {
    if (!linkKey) return true;
    if (trailingStatusUrl(s.input) || mediaUrlInText(s.input)) return false;
    const urls = urlsInText(s.input);
    return urls.length > 0 && urls.every((u) => s.patch?.links?.[u]);
  })();
  const awaitingTextLinks =
    kind === "text" &&
    s.links?.resolve !== false &&
    !!linkKey &&
    !allUrlsPatched &&
    !runtime.linkCache.has(linkKey) &&
    !(runtime.linksState.key === linkKey && runtime.linksState.status === "error");
  const cleanQuoteSlot = String(s.quoteUrl ?? "").trim();
  const awaitingQuoteSlot =
    !!trailingStatusUrl(cleanQuoteSlot) &&
    !runtime.quoteCache.has(cleanQuoteSlot) &&
    !(runtime.quoteSlot.url === cleanQuoteSlot && (runtime.quoteSlot.status === "error" || runtime.quoteSlot.status === "invalid"));

  if (awaitingUrlOrJson || awaitingTextLinks || awaitingQuoteSlot) {
    setLive("busy", "fetching…");
    return;
  }

  const options = { ...s.options };
  // Chrome's page mode is the stronger truth for a pasted x.com URL, but it
  // screenshots the captured article, so it ignores drawer overrides; the
  // replica is what drafts get. Both are one click apart in the toolbar.
  const pageAvailable = kind === "url" && !!runtime.source?.page;
  const chromeMode = s.ui.chromeMode === "replica" ? "replica" : "page";
  const mode = pageAvailable && chromeMode === "page" ? "page" : undefined;
  const source = mode === "page" ? runtime.source : undefined;
  const chromeModeEl = $("#chromeMode");
  if (chromeModeEl) {
    chromeModeEl.hidden = !pageAvailable;
    for (const btn of $$("button[data-cmode]", chromeModeEl)) btn.classList.toggle("on", btn.dataset.cmode === chromeMode);
  }

  // `smoothing` is a Chrome-oracle knob: the other targets reject it as an
  // unknown option, so it stays out of their request and out of their cache key.
  const smoothing = options.smoothing === "platform" ? "platform" : "antialiased";
  const baseOptions = { ...options };
  delete baseOptions.smoothing;
  const baseKey = canonical({ post, options: baseOptions, mode, source: pageKey(source) });
  const task = { key: baseKey, post, options: baseOptions, mode, source };
  const chromeTask = {
    key: canonical({ post, options: { ...baseOptions, smoothing }, mode, source: pageKey(source) }),
    post,
    options: baseOptions,
    chromeOptions: { ...baseOptions, smoothing },
    mode,
    source,
  };
  runtime.task = task;
  runtime.chromeTask = chromeTask;
  columns.setSmoothing(smoothing);

  for (const target of runtime.targets) {
    if (target.available === false) continue;
    // A hidden column still renders when the diff is comparing against it.
    const neededByDiff = target.id === s.diff.a || target.id === s.diff.b;
    if (target.on === false && !neededByDiff) continue;
    const runner = ensureRunner(target);
    runner.setTask(target.id === "chrome" ? chromeTask : task);
  }
  updateLive();
  if (store.state.ui.matrix) matrixRefresh();
}

function paintDetection(kind, post) {
  els.detect.dataset.kind = kind;
  els.detect.textContent = kind;
  els.detectDetail.textContent = describeInput(kind, post, runtime.source, runtime.resolveError?.message);
  if (runtime.resolveError) {
    els.resolveError.hidden = false;
    const err = runtime.resolveError;
    const fields = (err.fields ?? [])
      .map((f) => {
        const path = f.path ?? f.field ?? "";
        const suggestion = f.suggestion ?? f.didYouMean;
        return `${path}${path ? ": " : ""}${f.message ?? ""}${suggestion ? ` (did you mean ${suggestion}?)` : ""}`;
      })
      .join("\n");
    els.resolveError.textContent = `[${err.code ?? "invalid"}] ${err.message}${fields ? "\n" + fields : ""}`;
  } else {
    els.resolveError.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Resolve (json and url inputs)

let resolveTimer = null;
let resolveController = null;

function scheduleResolve(kind, input) {
  clearTimeout(resolveTimer);
  runtime.resolving = true;
  const delay = kind === "url" ? 400 : 150;
  resolveTimer = setTimeout(() => {
    resolveTimer = null;
    doResolve(kind, input);
  }, delay);
}

async function doResolve(kind, input) {
  resolveController?.abort();
  resolveController = new AbortController();
  try {
    const result = await runtime.api.resolve(input, resolveController.signal);
    if (store.state.input !== input) return;
    runtime.resolveFor = { input, kind };
    runtime.base = result.post ?? { text: "" };
    runtime.source = result.source ?? null;
    // A URL resolve also carries the resolver's link records (chain, tags…).
    if (result.links && typeof result.links === "object" && Object.keys(result.links).length) {
      runtime.linkInfo = {
        input,
        entries: Object.entries(result.links)
          .map(([url, info]) => normalizeLinkInfo(url, info))
          .filter(Boolean),
      };
    }
    runtime.resolveError = null;
    runtime.resolving = false;
    // A fresh resolution resets the overrides so the drawer shows the post.
    // For a URL that means: fill every section in, ready to be tweaked.
    const nextPatch = kind === "url" ? patchFromPost(runtime.base) : {};
    store.set((s) => {
      s.patch = nextPatch;
    });
    toast(kind === "url" ? "resolved from x.com" : "valid post JSON");
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (store.state.input !== input) return;
    runtime.resolveFor = { input, kind };
    runtime.resolveError = error;
    runtime.resolving = false;
    refresh({ reason: "resolve-error" });
  }
  refresh({ reason: "resolved" });
}

// ---------------------------------------------------------------------------
// Targets

async function loadTargets() {
  try {
    runtime.serverTargets = await runtime.api.targets();
    runtime.apiDown = false;
  } catch (error) {
    runtime.serverTargets = [];
    runtime.apiDown = true;
    if (!runtime.mock) {
      setLive("error", "server API unavailable");
      els.liveText.title = error.message;
    }
  }
  applyTargets({ rebuild: true });

  const notice = $("#notice");
  if (notice) {
    notice.hidden = !runtime.apiDown;
    if (runtime.apiDown) {
      notice.innerHTML =
        "server API unavailable — native, HTTP fn and Chrome cannot render. Start <code>node tools/playground/server.mjs</code>, or add <code>?mock</code> to this URL to use the mock API. The WASM target works on its own.";
    }
  }

  if (!runtime.eventsBound) {
    runtime.eventsBound = true;
    runtime.api.events(
      debounce(async () => {
        await loadTargets();
        for (const target of runtime.targets) {
          if (target.on !== false && target.available !== false) ensureRunner(target).restart(taskFor(target.id));
        }
      }, 200),
    );
  }
}

let lastTargetSig = "";
function applyTargets({ rebuild }) {
  const merged = mergeTargets(runtime.serverTargets, store.state.targets);
  for (const target of merged) {
    if (runtime.apiDown && target.id !== "wasm") target.available = false;
  }
  runtime.targets = merged;
  const sig = JSON.stringify(merged.map((t) => [t.id, t.on]));
  if (rebuild || sig !== lastTargetSig) {
    lastTargetSig = sig;
    columns.setTargets(merged.filter((t) => t.on !== false));
    $('#colZoom [data-z="1"]')?.classList.toggle("on", store.state.ui.zoom === 1);
  } else {
    for (const target of merged) columns.updateVersion(target);
  }
  renderTargetChips();
  fillSelect($("#diffA"), merged, { value: store.state.diff.a });
  fillSelect($("#diffB"), merged, { value: store.state.diff.b });
  fillSelect($("#reportTarget"), merged, { allowAuto: true, value: store.state.ui.reportFrom ?? "" });
  fillSelect($("#matrixTarget"), merged, { value: runtime.matrixTarget ?? "chrome" });
  const upstream =
    merged.find((t) => t.id === "chrome")?.version?.upstream ?? runtime.upstream ?? "";
  els.upstream.textContent = upstream ? `upstream ${String(upstream).slice(0, 10)}` : "";
  els.upstream.title = merged
    .filter((t) => t.version)
    .map((t) => `${t.id}: ${t.version.rev ?? "?"} rules ${t.version.ruleset ?? "?"}`)
    .join("\n");
}

function fillSelect(select, targets, { allowAuto = false, value = "" } = {}) {
  const available = targets.filter((t) => t.available !== false);
  select.innerHTML = "";
  if (allowAuto) {
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "auto (chrome)";
    select.append(auto);
  }
  for (const target of available) {
    const option = document.createElement("option");
    option.value = target.id;
    option.textContent = target.label;
    select.append(option);
  }
  const ids = available.map((t) => t.id);
  if (value && ids.includes(value)) select.value = value;
  else if (allowAuto) select.value = "";
  else if (ids.length) select.value = ids[0];
}

function renderTargetChips() {
  els.chips.textContent = "";
  runtime.targets.forEach((target, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.id = target.id;
    btn.classList.toggle("on", target.on !== false);
    btn.className = "tchip" + (target.on !== false ? " on" : "") + (target.truth ? " truth" : "");
    const short = String(target.label).replace(/^Chrome.*/i, "Chrome").replace(/^HTTP.*/i, "HTTP");
    btn.innerHTML = `${escapeHtml(short)} <span class="bd">${index + 1}</span>`;
    btn.title = `${target.on !== false ? "hide" : "show"} ${target.label}`;
    if (target.available === false) btn.title += " (not available)";
    btn.addEventListener("click", () => toggleTarget(target.id, target.on === false));
    els.chips.append(btn);
  });
}

function toggleTarget(id, on) {
  store.set((s) => {
    const entry = s.targets.find((t) => t.id === id);
    if (entry) entry.on = on;
    else s.targets.push({ id, on });
  });
  applyTargets({ rebuild: true });
  refresh({ reason: "toggle" });
}

function moveTarget(id, delta) {
  store.set((s) => {
    const index = s.targets.findIndex((t) => t.id === id);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= s.targets.length) return;
    const [entry] = s.targets.splice(index, 1);
    s.targets.splice(next, 0, entry);
  });
  applyTargets({ rebuild: true });
  refresh({ reason: "reorder" });
}

function ensureRunner(target) {
  let runner = runtime.runners.get(target.id);
  if (runner) return runner;
  runner = new TargetRunner({
    id: target.id,
    delay: target.id === "wasm" ? 0 : delayFor(target.id),
    run: (task, signal) => renderOnce(target.id, task, signal),
    onUpdate: (id, state) => {
      runtime.states.set(id, state);
      columns.update(id, state);
      if (state.data?.report) runtime.reports.set(id, { report: state.data.report, at: Date.now() });
      updateLive();
      // A landed Chrome render changes every delta, not just its own.
      if (id === "chrome" && state.data) {
        for (const target of runtime.targets) {
          if (target.id !== "chrome" && target.on !== false) scheduleDelta(target.id);
        }
      } else {
        scheduleDelta(id);
      }
      scheduleReport();
      scheduleDiff();
    },
  });
  runtime.runners.set(target.id, runner);
  return runner;
}

async function renderOnce(targetId, task, signal) {
  if (targetId === "wasm") {
    // Fetching and instantiating the module is startup, not rendering: it must
    // happen before the clock starts, or a cold keystroke pays for it. The same
    // goes for the lazy font packs the post needs.
    const mod = await loadWasm();
    await ensureWasmFonts(mod, { post: task.post, options: task.options });
    const started = performance.now();
    const out = renderWasm(mod, task.post, task.options);
    const blob = new Blob([out.png], { type: "image/png" });
    return {
      target: "wasm",
      pngUrl: URL.createObjectURL(blob),
      blob,
      width: Math.round(out.report?.size?.width ?? task.options.width),
      height: Math.round(out.report?.size?.height ?? 0),
      dpr: task.options.dpr,
      viewport: Math.round(task.options.width),
      report: out.report,
      geometry: null,
      ms: { paint: out.paintMs, render: out.paintMs, total: out.ms },
      wall: performance.now() - started,
      version: { ruleset: out.report?.ruleset, upstream: out.upstream },
      at: Date.now(),
    };
  }

  const started = performance.now();
  const body = { target: targetId, post: task.post, options: task.chromeOptions ?? task.options };
  if (targetId === "chrome" && task.mode) {
    body.mode = task.mode;
    if (task.source) body.source = task.source;
  }
  const res = await runtime.api.render(body, signal);
  // A superseded request answers 200 `{superseded:true}` with no PNG: a newer
  // request for this target is on its way, so this answer is dropped, not shown.
  if (res?.superseded) {
    const skipped = new Error("superseded by a newer request");
    skipped.name = "SupersededError";
    throw skipped;
  }
  if (typeof res?.png !== "string" || !res.png) {
    const broken = new Error("the render response had no png");
    broken.name = "ProtocolError";
    broken.code = "bad_response";
    throw broken;
  }
  const bytes = base64ToBytes(res.png);
  const blob = new Blob([bytes], { type: "image/png" });
  return {
    ...res,
    pngUrl: URL.createObjectURL(blob),
    blob,
    width: Math.round(res.width ?? task.options.width),
    height: Math.round(res.height ?? 0),
    dpr: res.dpr ?? task.options.dpr,
    viewport: Math.round(task.options.width),
    wall: performance.now() - started,
    at: Date.now(),
  };
}

/** Chrome's task carries `smoothing`; every other target must not see it. */
function taskFor(id) {
  return id === "chrome" ? runtime.chromeTask ?? runtime.task : runtime.task;
}

function rerenderAll() {
  if (!runtime.task) return;
  for (const target of runtime.targets) {
    if (target.on === false || target.available === false) continue;
    ensureRunner(target).restart(taskFor(target.id));
  }
  toast("re-rendering every target");
}

async function rebuildTarget(id) {
  const target = runtime.targets.find((t) => t.id === id);
  if (target) {
    target.building = true;
    columns.updateVersion(target);
  }
  toast(`rebuilding ${id}…`);
  try {
    const result = await runtime.api.build(id);
    const ms = Number.isFinite(result.ms) ? ` in ${fmtMs(result.ms)} ms` : "";
    toast(`${id} rebuilt${ms}`);
    if (result.log) console.info(`[xeet build ${id}]\n${result.log}`);
    await loadTargets();
    rerenderAll();
  } catch (error) {
    toast(`build failed: ${error.message}`, "error");
    console.error(error);
  }
}

// ---------------------------------------------------------------------------
// Link cards for plain text: /api/resolve follows the redirects and reads the
// card tags, the way X's crawler does. Renders never wait for it: the post
// goes out without a card and re-renders when the answer lands.

let linkTimer = null;
let linkController = null;

function scheduleLinks(text, key) {
  const enabled = store.state.links?.resolve !== false;
  if (!enabled || !key) {
    clearTimeout(linkTimer);
    linkTimer = null;
    if (runtime.linksState.status !== "idle") {
      runtime.linksState = { status: "idle", count: 0, quote: null, message: "" };
      paintLinksChip();
    }
    return;
  }
  const cached = runtime.linkCache.get(key);
  if (cached) {
    runtime.linksState = { key, status: "ready", ...describeLinks(cached.links, cached.quote, cached.media), fetchMs: null, message: "" };
    runtime.linkInfo = {
      input: text,
      entries: Object.entries(cached.info ?? {})
        .map(([url, info]) => normalizeLinkInfo(url, info))
        .filter(Boolean),
    };
    paintLinksChip();
    return;
  }
  if (runtime.linksState.key === key && runtime.linksState.status === "busy") return;
  runtime.linksState = { key, status: "busy", count: key.split("\n").length, quote: null, message: "" };
  paintLinksChip();
  clearTimeout(linkTimer);
  linkTimer = setTimeout(() => {
    linkTimer = null;
    resolveLinks(text, key);
  }, 150);
}

async function resolveLinks(text, key) {
  linkController?.abort();
  linkController = new AbortController();
  const wantsMedia = store.state.links?.media === true;
  const started = performance.now();
  // An answer is only wanted if the input, the URL set and the switches are
  // still the ones that asked for it (the mock, like a slow server, may finish
  // after its request was abandoned).
  const stillWanted = () =>
    store.state.links?.resolve !== false &&
    (store.state.links?.media === true) === wantsMedia &&
    urlSetKey(store.state.input) === key;
  try {
    const res = await runtime.api.resolve(text, linkController.signal, { media: wantsMedia });
    if (!stillWanted()) return;
    const info = res?.links && typeof res.links === "object" ? res.links : {};
    // The post's own links map is what renders: it carries the card image's
    // bytes (`image.data`). The per-URL `meta` in `links` is the report's
    // summary and has only the image's size, so it is the fallback.
    const links = {};
    const rendered = res?.post?.links && typeof res.post.links === "object" ? res.post.links : {};
    for (const [url, entry] of Object.entries(info)) {
      const meta = rendered[url] ?? entry?.meta ?? entry;
      if (meta && typeof meta === "object") links[url] = meta;
    }
    for (const [url, meta] of Object.entries(rendered)) if (!links[url]) links[url] = meta;
    // A text that ends on another post's URL resolves to a *quote*, not a card.
    const quote = res?.post?.quote ?? null;
    // A /video/1, /photo/1 or twimg URL in the text is lifted into post media.
    const media = Array.isArray(res?.post?.media) ? res.post.media : [];
    runtime.linkCache.set(key, { links, info, quote, media });
    if (runtime.linkCache.size > 32) runtime.linkCache.delete(runtime.linkCache.keys().next().value);
    runtime.linksState = {
      key,
      status: "ready",
      ...describeLinks(links, quote, media),
      // Fetching is not rendering: the time belongs on the chip, not the column.
      fetchMs: performance.now() - started,
      message: "",
    };
    runtime.linkInfo = {
      input: text,
      entries: Object.entries(info)
        .map(([url, entry]) => normalizeLinkInfo(url, entry))
        .filter(Boolean),
    };
    paintLinksChip();
    refresh({ reason: "links" });
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (!stillWanted()) return;
    runtime.linksState = { key, status: "error", count: 0, quote: null, message: error.message ?? String(error) };
    paintLinksChip();
    refresh({ reason: "links-error" });
  }
}

function paintLinksChip() {
  const chip = $("#linksChip");
  if (!chip) return;
  const state = runtime.linksState ?? { status: "idle" };
  if (state.status === "idle") {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  chip.className = "chip";
  if (state.status === "busy") {
    chip.classList.add("warn");
    chip.textContent = "resolving links…";
    chip.title = "asking the server to follow the link and read its card tags";
  } else if (state.status === "error") {
    chip.classList.add("bad");
    chip.textContent = "links failed";
    chip.title = state.message;
  } else {
    // The fetch time belongs here, next to the fetch, and only when it was a
    // network round trip (a cached answer costs nothing to show).
    const fetched = Number.isFinite(state.fetchMs) ? ` · ${Math.round(state.fetchMs)} ms` : "";
    const timing = Number.isFinite(state.fetchMs)
      ? `resolved in ${Math.round(state.fetchMs)} ms`
      : "resolved from the cache";
    if (state.quote) {
      const handle = state.quote.handle ? `@${state.quote.handle}` : "a post";
      chip.classList.add("good");
      chip.textContent = state.count
        ? `quote ${handle} · ${state.count} link${state.count === 1 ? "" : "s"}${fetched}`
        : `quote ${handle}${fetched}`;
      chip.title = `the text ends on ${handle}'s post: the resolver read it into post.quote\n${timing}`;
    } else if (state.media) {
      const from = state.media.handle ? ` @${state.media.handle}` : "";
      chip.classList.add("good");
      chip.textContent = `${state.media.kind}${from}${fetched}`;
      chip.title = `embedded media from the URL in this text\n${timing}`;
    } else if (!state.count) {
      chip.textContent = `no card${fetched}`;
      chip.title = `the resolver found no card metadata for the links in this text\n${timing}`;
    } else {
      chip.classList.add("good");
      chip.textContent = `${state.count} link${state.count === 1 ? "" : "s"}${fetched}`;
      chip.title = `card metadata from /api/resolve; see the report for the redirect chain\n${timing}`;
    }
  }
}

/** What a resolved answer means for the chip: card links, a quote, or embedded media. */
function describeLinks(links, quote, media = []) {
  const cardCount = Object.values(links ?? {}).filter((meta) => meta && meta.card).length;
  const firstMedia = Array.isArray(media) && media.length ? media[0] : null;
  return {
    count: cardCount,
    quote: quote
      ? {
          handle: quote.author?.handle ?? "",
          name: quote.author?.name ?? "",
          text: String(quote.text ?? ""),
          nested: quote.quote?.author?.handle ?? null,
        }
      : null,
    media: firstMedia
      ? {
          kind: firstMedia.kind === "video" || firstMedia.kind === "gif" ? firstMedia.kind : "photo",
          handle: firstMedia.sourceAuthor?.handle ?? "",
        }
      : null,
  };
}

function linkEntries() {
  const info = runtime.linkInfo;
  return info && info.input === store.state.input ? info.entries : [];
}

function resetLinkState() {
  clearTimeout(linkTimer);
  linkTimer = null;
  linkController?.abort();
  runtime.linkCache.clear();
  runtime.linkInfo = null;
  runtime.linksState = { status: "idle", count: 0, quote: null, message: "" };
  paintLinksChip();
}

document.addEventListener("xeet:links-changed", () => {
  resetLinkState();
  refresh({ reason: "links-option" });
});

// ---------------------------------------------------------------------------
// The composer: who is posting, how the attachment behaves, and the length.
//
// X's essential complexity lives here and nowhere else: a post can end on a
// status URL (+23 characters, inline quote), attach a post out of band (0
// characters, `attachment_url`), or embed that post's video (`/video/1`, the
// media travels instead of the quote). One pill switches between them.

const BADGE_KINDS = new Set(["blue", "business", "government"]);
const AUTHOR_PRESETS = {
  vercel: { name: "Vercel", handle: "vercel", verified: "business", squareAvatar: true },
  rauchg: { name: "Guillermo Rauch", handle: "rauchg", verified: "blue" },
  nasa: { name: "NASA", handle: "NASA", verified: "government" },
  plain: null,
};
const RING_CIRCUMFERENCE = 2 * Math.PI * 8;

function avatarSrc(value) {
  const raw = String(value ?? "");
  if (!raw) return "";
  return raw.startsWith("data:") ? raw : `data:image/png;base64,${raw}`;
}

/** Who is posting: the avatar, the name, the badge and the handle. */
function paintComposerAuthor(post) {
  const author = post?.author ?? {};
  const handle = String(author.handle ?? "").replace(/^@/, "");
  const src = avatarSrc(author.avatar);
  if (els.avaImg) {
    els.avaImg.hidden = !src;
    if (src) els.avaImg.src = src;
    else els.avaImg.removeAttribute("src");
    els.avaImg.classList.toggle("square", author.squareAvatar === true);
    els.avaImg.alt = author.name ? `${author.name} avatar` : "";
  }
  els.avaName.textContent = author.name || (handle ? `@${handle}` : "No author");
  els.avaHandle.textContent = handle ? `@${handle}` : "add an author";
  const kind = BADGE_KINDS.has(author.verified) ? author.verified : null;
  els.avaBadge.hidden = !kind;
  if (kind) els.avaBadge.dataset.kind = kind;
  els.authorBtn.title = `${author.name || "No author"}${handle ? ` @${handle}` : ""}${kind ? ` · ${kind} verified` : ""}\nclick for presets and overrides`;
}

/** The weighted length, X style: a number and a ring that fills up. */
function paintCounter() {
  if (!els.charCount) return;
  const report = runtime.reports.get("wasm")?.report ?? runtime.reports.get("chrome")?.report ?? null;
  const length = report?.length ?? null;
  const text = String(runtime.post?.text ?? store.state.input ?? "");
  const weighted = Number.isFinite(length?.weighted) ? length.weighted : text.length;
  const limit = Number.isFinite(length?.limit) && length.limit > 0 ? length.limit : 280;
  els.charCount.textContent = String(weighted);
  els.countWrap.title = `${weighted} of ${limit} weighted characters (a URL counts as 23)`;
  const ratio = Math.max(0, Math.min(1, weighted / limit));
  els.ringArc.setAttribute(
    "stroke-dasharray",
    `${(ratio * RING_CIRCUMFERENCE).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`,
  );
  els.countWrap.classList.toggle("near", weighted >= limit * 0.93 && weighted <= limit);
  els.countWrap.classList.toggle("over", weighted > limit);
  if (els.longBadge) els.longBadge.hidden = weighted <= limit;
}

/** `Quote (0c) | Inline URL (+23c) | Post video` — X's own three shapes. */
const MODES = [
  { id: "quote", label: "Quote · 0c", title: "Quote Tweet: attached out of band (attachment_url), no characters used" },
  { id: "inline", label: "Inline · +23c", title: "The post URL at the end of the text: it costs 23 characters" },
  { id: "video", label: "Post video", title: "The /video/1 form: X embeds the video and credits its author" },
];

function postUrlInPlay() {
  const state = store.state;
  const fromText = statusUrlInText(state.input);
  if (fromText) return fromText.replace(/(?:\/video|\/photo)\/\d+$/, "");
  const slot = String(state.quoteUrl ?? "").trim();
  return slot ? slot.replace(/\/$/, "").replace(/(?:\/video|\/photo)\/\d+$/, "") : null;
}

function composerMode() {
  if (mediaUrlInText(store.state.input)) return "video";
  if (String(store.state.quoteUrl ?? "").trim()) return "quote";
  if (trailingStatusUrl(store.state.input)) return "inline";
  return null;
}

function paintModePill() {
  if (!els.modePill) return;
  const url = postUrlInPlay();
  els.modePill.hidden = !url;
  if (!url) {
    els.modePill.textContent = "";
    return;
  }
  const active = composerMode();
  els.modePill.textContent = "";
  for (const mode of MODES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.mode = mode.id;
    btn.textContent = mode.label;
    btn.title = mode.title;
    btn.classList.toggle("on", active === mode.id);
    els.modePill.append(btn);
  }
}

/** Rewrites the post between the three shapes without losing the body text. */
function applyComposeMode(mode) {
  const base = postUrlInPlay();
  if (!base) return;
  store.set((next) => {
    let text = next.input;
    for (const variant of [videoVariant(base), base]) {
      const at = text.lastIndexOf(variant);
      if (at >= 0) text = text.slice(0, at) + text.slice(at + variant.length);
    }
    text = text.replace(/[ \t]+$/, "").replace(/\n+$/, "");
    next.input = text;
    if (mode === "quote") {
      next.quoteUrl = base;
    } else if (mode === "inline") {
      next.quoteUrl = "";
      next.input = `${text}${text ? "\n" : ""}${base}`;
    } else if (mode === "video") {
      next.quoteUrl = "";
      next.input = `${text}${text ? "\n" : ""}${videoVariant(base)}`;
    }
  });
  refresh({ reason: "compose-mode" });
}

/** The link card X shows in the composer, with its dismiss ×. */
function paintCardChip() {
  if (!els.cardChip) return;
  const links = runtime.post?.links ?? {};
  const entry = Object.entries(links).find(([, meta]) => meta && meta.card);
  const dismissed = runtime.post?.cardState === "dismissed";
  els.cardChip.hidden = !entry || !!runtime.post?.quote || !!runtime.post?.poll;
  if (els.cardChip.hidden) return;
  const [url, meta] = entry;
  els.cardDomain.textContent = meta.domain ?? (() => {
    try { return new URL(url).hostname; } catch { return url; }
  })();
  els.cardChip.title = meta.title ?? url;
  els.cardDismiss.hidden = dismissed;
  els.cardRestore.hidden = !dismissed;
  els.cardChip.classList.toggle("dismissed", dismissed);
}

function paintComposer() {
  const post = runtime.post;
  paintComposerAuthor(post);
  paintCounter();
  paintModePill();
  paintCardChip();
  // The quote slot's body opens itself once there is a quote or an empty slot
  // the user asked for; paintQuoteSlot owns that part.
  paintMediaSlot();
  paintPollSlot();
}

function paintMediaSlot() {
  if (!els.mediaSlot) return;
  const media = mediaUrlInText(store.state.input);
  const video = (runtime.post?.media ?? []).find((m) => m.kind === "video" || m.kind === "gif");
  const open = !!media || runtime.mediaOpen === true;
  els.mediaSlot.hidden = !open;
  if (els.mediaPill) {
    els.mediaPill.hidden = !video;
    if (video) {
      const who = video.sourceAuthor?.handle ? `@${video.sourceAuthor.handle}` : null;
      const secs = Number.isFinite(video.duration) ? `${Math.floor(video.duration / 60)}:${String(Math.round(video.duration % 60)).padStart(2, "0")} · ` : "";
      els.mediaPill.textContent = `${secs}${video.width}×${video.height}${who ? ` · ${who}` : ""}`;
      els.mediaPill.classList.add("good");
    }
  }
  if (document.activeElement !== els.mediaUrl && els.mediaUrl.value !== (media ?? "")) els.mediaUrl.value = media ?? "";
}

function paintPollSlot() {
  if (!els.pollSlot) return;
  const poll = store.state.patch?.poll;
  const open = !!poll || runtime.pollOpen === true;
  els.pollSlot.hidden = !open;
  if (!open) return;
  const choices = poll?.choices ?? [];
  ["#pollA", "#pollB", "#pollC", "#pollD"].forEach((sel, index) => {
    const input = $(sel);
    if (input && document.activeElement !== input) input.value = choices[index] ?? "";
  });
}

function writePollFromSlots() {
  const choices = ["#pollA", "#pollB", "#pollC", "#pollD"]
    .map((sel) => $(sel).value.trim())
    .filter(Boolean);
  store.set((s) => {
    if (choices.length >= 2) s.patch.poll = { choices };
    else if (s.patch.poll) delete s.patch.poll;
  });
}

/** Reply: X hides the leading mention of a reply — `.@handle` keeps it. */
function toggleReply() {
  const handle = String(runtime.post?.author?.handle ?? "").replace(/^@/, "");
  const on = store.state.patch?.replyTo != null;
  store.set((s) => {
    if (on) {
      delete s.patch.replyTo;
      delete s.patch.replyToHandle;
      s.input = s.input.replace(/^\.?@[A-Za-z0-9_]+\s+/, "");
    } else {
      s.patch.replyTo = "1";
      s.patch.replyToHandle = handle || "someone";
      if (handle && !new RegExp(`^\\.?@${handle}\\b`, "i").test(s.input)) s.input = `@${handle} ${s.input}`;
    }
  });
  $("#toolReply")?.setAttribute("aria-pressed", String(!on));
  refresh({ reason: "reply" });
}

function bindComposer() {
  els.authorBtn?.addEventListener("click", () => togglePop(els.authorBtn, els.authorPop));
  els.authorPopClose?.addEventListener("click", () => togglePop(els.authorBtn, els.authorPop, false));
  els.viewBtn?.addEventListener("click", () => togglePop(els.viewBtn, els.viewPop));
  els.viewClose?.addEventListener("click", () => togglePop(els.viewBtn, els.viewPop, false));

  els.authorPresets?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-preset]");
    if (!btn) return;
    const preset = AUTHOR_PRESETS[btn.dataset.preset];
    store.set((s) => {
      if (preset) s.patch.author = { ...preset };
      else if (s.patch.author) delete s.patch.author;
      s.ui = s.ui ?? {};
      s.ui.quoteTouched = false;
    });
  });

  els.modePill?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-mode]");
    if (btn) applyComposeMode(btn.dataset.mode);
  });

  $("#toolQuote")?.addEventListener("click", () => {
    if (postUrlInPlay()) applyComposeMode("quote");
    else {
      runtime.quoteOpen = true;
      paintQuoteSlot();
      $("#quoteUrl")?.focus();
    }
    $("#toolQuote").setAttribute("aria-pressed", "true");
  });
  $("#toolMedia")?.addEventListener("click", () => {
    runtime.mediaOpen = true;
    paintMediaSlot();
    const base = postUrlInPlay();
    if (base && !mediaUrlInText(store.state.input) && !store.state.quoteUrl) {
      store.set((s) => {
        s.input = `${s.input.replace(/\s+$/, "")}${s.input.trim() ? "\n" : ""}${videoVariant(base)}`;
      });
    } else {
      $("#mediaUrl")?.focus();
    }
  });
  $("#toolPoll")?.addEventListener("click", () => {
    runtime.pollOpen = !(runtime.pollOpen || !!store.state.patch?.poll);
    paintPollSlot();
    if (runtime.pollOpen) $("#pollA")?.focus();
  });
  $("#toolReply")?.addEventListener("click", toggleReply);

  for (const sel of ["#pollA", "#pollB", "#pollC", "#pollD"]) {
    $(sel)?.addEventListener("input", writePollFromSlots);
  }
  els.pollClear?.addEventListener("click", () => {
    runtime.pollOpen = false;
    store.set((s) => {
      if (s.patch.poll) delete s.patch.poll;
    });
    paintPollSlot();
  });

  els.mediaUrl?.addEventListener("input", () => {
    const value = els.mediaUrl.value.trim();
    const base = postUrlInPlay();
    store.set((s) => {
      let text = s.input;
      const previous = mediaUrlInText(text);
      if (previous && previous !== value) text = text.replace(previous, "").replace(/[ \t]+$/, "").trimEnd();
      if (value) text = `${text}${text ? "\n" : ""}${value}`;
      s.input = text;
      if (value) s.quoteUrl = "";
    });
  });
  els.mediaClear?.addEventListener("click", () => {
    runtime.mediaOpen = false;
    store.set((s) => {
      const url = mediaUrlInText(s.input);
      if (url) s.input = s.input.replace(url, "").replace(/[ \t]+$/, "").trimEnd();
    });
    paintMediaSlot();
  });

  els.cardDismiss?.addEventListener("click", () => {
    store.set((s) => {
      s.patch.cardState = "dismissed";
    });
  });
  els.cardRestore?.addEventListener("click", () => {
    store.set((s) => {
      if (s.patch && "cardState" in s.patch) delete s.patch.cardState;
    });
  });

  els.banner?.addEventListener("click", (event) => {
    if (!event.target.closest("button")) return;
    editAsDraft();
  });

  $("#drawerBtn")?.addEventListener("click", () => togglePop(els.authorBtn, els.authorPop, false));
  els.drawerOpen?.addEventListener("click", () => {
    togglePop(els.authorBtn, els.authorPop, false);
    const drawer = $("#drawer");
    if (drawer) {
      drawer.open = true;
      drawer.show?.();
    }
  });
  els.drawerClose?.addEventListener("click", () => {
    const drawer = $("#drawer");
    if (drawer) drawer.open = false;
  });
}

/** Take a resolved post into the composer as an editable draft. */
function editAsDraft() {
  const base = runtime.base ?? {};
  store.set((s) => {
    s.patch = { ...patchFromPost(base), ...(s.patch ?? {}) };
    s.input = base.text ?? "";
    s.quoteUrl = "";
  });
  toast("loaded as a draft: every field is now an override");
}

function paintBanner() {
  if (!els.banner) return;
  const kind = runtime.kind;
  const source = runtime.base?.source ?? {};
  const handle = runtime.base?.author?.handle ?? "";
  if (kind !== "url" && kind !== "json") {
    els.banner.hidden = true;
    return;
  }
  els.banner.hidden = false;
  els.banner.innerHTML = "";
  const label = kind === "url" ? "Live post" : "Post JSON";
  const text = document.createElement("span");
  text.innerHTML = `${label}: <b>${escapeHtml(handle ? `@${handle}` : "loaded")}</b>${
    source.page ? " · captured from x.com" : ""
  }`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Edit as draft";
  els.banner.append(text, btn);
}

function togglePop(anchor, pop, force) {
  if (!pop) return;
  const open = force ?? pop.hidden;
  pop.hidden = !open;
  anchor?.setAttribute("aria-expanded", String(open));
  for (const other of [els.authorPop, els.viewPop]) {
    if (other && other !== pop) other.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// X's Quote Tweet composer. The quoted post is attached by URL (`attachment_url`
// on X), out of band: it adds no characters to the body, and the body may end
// on an ordinary link whose card yields to the quote while the link stays.

let quoteTimer = null;
let quoteController = null;

function scheduleQuoteSlot(url) {
  const clean = String(url ?? "").trim();
  if (!clean) {
    clearTimeout(quoteTimer);
    quoteTimer = null;
    if (runtime.quoteSlot.status !== "idle") {
      runtime.quoteSlot = { url: "", status: "idle", quote: null, fetchMs: null, message: "" };
      paintQuoteSlot();
      refresh({ reason: "quote-slot-cleared" });
    }
    return;
  }
  if (!trailingStatusUrl(clean)) {
    // Not a post URL yet: say so, do not fetch.
    runtime.quoteSlot = { url: clean, status: clean.length > 12 ? "invalid" : "idle", quote: null, fetchMs: null, message: "" };
    paintQuoteSlot();
    return;
  }
  const cached = runtime.quoteCache.get(clean);
  if (cached) {
    if (runtime.quoteSlot.url === clean && runtime.quoteSlot.status === "ready") {
      paintQuoteSlot();
      return;
    }
    runtime.quoteSlot = { url: clean, status: "ready", quote: cached.quote, fetchMs: null, message: "" };
    paintQuoteSlot();
    refresh({ reason: "quote-slot-cached" });
    return;
  }
  if (runtime.quoteSlot.url === clean && (runtime.quoteSlot.status === "ready" || runtime.quoteSlot.status === "busy")) {
    paintQuoteSlot();
    return;
  }
  runtime.quoteSlot = { url: clean, status: "busy", quote: null, fetchMs: null, message: "" };
  paintQuoteSlot();
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(() => {
    quoteTimer = null;
    resolveQuoteSlot(clean);
  }, 150);
}

async function resolveQuoteSlot(url) {
  quoteController?.abort();
  quoteController = new AbortController();
  const started = performance.now();
  try {
    const res = await runtime.api.resolve(url, quoteController.signal, {
      media: store.state.links?.media !== false,
    });
    if (store.state.quoteUrl.trim() !== url) return;
    const quote = res?.post ?? null;
    if (!quote || !quote.author?.handle) {
      runtime.quoteSlot = { url, status: "invalid", quote: null, fetchMs: null, message: "that URL did not resolve to a post" };
      paintQuoteSlot();
      refresh({ reason: "quote-slot-invalid" });
      return;
    }
    runtime.quoteCache.set(url, { quote });
    if (runtime.quoteCache.size > 24) runtime.quoteCache.delete(runtime.quoteCache.keys().next().value);
    runtime.quoteSlot = { url, status: "ready", quote, fetchMs: performance.now() - started, message: "" };
    paintQuoteSlot();
    refresh({ reason: "quote-slot" });
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (store.state.quoteUrl.trim() !== url) return;
    runtime.quoteSlot = { url, status: "error", quote: null, fetchMs: null, message: error.message ?? String(error) };
    paintQuoteSlot();
    refresh({ reason: "quote-slot-error" });
  }
}

function paintQuoteSlot() {
  const body = $("#quoteSlotBody");
  const input = $("#quoteUrl");
  const pill = $("#quotePill");
  const toggle = $("#quoteToggle");
  const clear = $("#quoteClear");
  if (!body || !input) return;
  const state = runtime.quoteSlot;
  const open = !!store.state.quoteUrl || runtime.quoteOpen === true;
  body.hidden = !open;
  toggle?.setAttribute("aria-pressed", String(open));
  if (toggle) toggle.textContent = open ? "Quote post" : "+ Quote post";
  if (document.activeElement !== input && input.value !== (store.state.quoteUrl ?? "")) {
    input.value = store.state.quoteUrl ?? "";
  }
  clear.hidden = !store.state.quoteUrl;

  pill.hidden = false;
  pill.className = "chip";
  const secs = Number.isFinite(state.fetchMs) ? ` · ${Math.round(state.fetchMs)} ms` : "";
  if (state.status === "busy") {
    pill.classList.add("warn");
    pill.textContent = "resolving quote…";
  } else if (state.status === "ready" && state.quote) {
    pill.classList.add("good");
    pill.textContent = `Quoting @${state.quote.author?.handle ?? "someone"} · 0 chars`;
    pill.title = [
      "attached out of band: it adds no characters to the post",
      state.quote.text?.slice(0, 140) ?? null,
      Number.isFinite(state.fetchMs) ? `resolved in ${Math.round(state.fetchMs)} ms` : "resolved from the cache",
    ]
      .filter(Boolean)
      .join("\n");
  } else if (state.status === "error" || state.status === "invalid") {
    pill.classList.add("bad");
    pill.textContent = state.status === "invalid" ? "not a post URL" : "quote failed";
    pill.title = state.message;
  } else {
    pill.hidden = true;
  }
  if (state.status !== "busy") pill.hidden = pill.hidden || !store.state.quoteUrl;
}

/** The small "Move to Quote slot" affordance for an inline trailing URL. */
function paintMoveQuote() {
  const button = $("#moveQuote");
  if (!button) return;
  const inline = trailingStatusUrl(store.state.input);
  button.hidden = !(inline && !store.state.quoteUrl);
  if (inline) button.textContent = "Move to Quote slot (−23 chars)";
}

function moveToQuoteSlot() {
  const url = trailingStatusUrl(store.state.input);
  if (!url) return;
  const text = store.state.input;
  const at = text.lastIndexOf(url);
  const before = text.slice(0, at).replace(/[ \t]+$/, "").replace(/\n+$/, "\n").replace(/\n$/, "");
  store.set((s) => {
    s.input = before;
    s.quoteUrl = url;
  });
  refresh({ reason: "move-to-quote-slot" });
}

// ---------------------------------------------------------------------------
// Deltas vs Chrome (client side, docs/e2e-raster.md tolerances)

const deltaQueue = new Set();
let deltaTimer = null;

function scheduleDelta(id) {
  deltaQueue.add(id);
  if (deltaTimer) return;
  // Back-to-back comparisons would queue up behind each other on the main
  // thread; wait proportionally to the last one instead.
  const wait = Math.min(400, Math.max(40, (runtime.compareMs ?? 0) * 2));
  deltaTimer = setTimeout(async () => {
    deltaTimer = null;
    const next = deltaQueue.values().next().value;
    if (!next) return;
    deltaQueue.delete(next);
    await computeDelta(next);
    if (deltaQueue.size) scheduleDelta([...deltaQueue][0]);
  }, wait);
}

async function computeDelta(id) {
  if (id === "chrome") {
    columns.setDelta(id, null);
    return;
  }
  const chrome = runtime.runners.get("chrome")?.data;
  const target = runtime.runners.get(id)?.data;
  if (!chrome || !target) {
    columns.setDelta(id, null);
    return;
  }
  const key = `${id}|${chrome.key}|${target.key}`;
  const cached = runtime.compare.get(key);
  if (cached) {
    runtime.deltas.set(id, cached);
    columns.setDelta(id, { ...cached, heightDelta: target.height - chrome.height });
    return;
  }
  columns.setDelta(id, { status: "calculating" });
  try {
    const [a, b] = await Promise.all([pixelsFor(chrome), pixelsFor(target)]);
    const started = performance.now();
    const result = comparePixels(a, b);
    runtime.compareMs = performance.now() - started;
    const delta = {
      pct: result.pct,
      differing: result.differing,
      total: result.total,
      sameSize: result.sameSize,
      inkA: result.inkA,
      inkB: result.inkB,
      at: Date.now(),
      chromeKey: chrome.key,
      targetKey: target.key,
    };
    runtime.compare.set(key, delta);
    if (runtime.compare.size > 60) runtime.compare.delete(runtime.compare.keys().next().value);
    if (result.inkB < 0.002 && chrome.height > 40) {
      delta.blank = true;
    }
    runtime.deltas.set(id, delta);
    columns.setDelta(id, { ...delta, heightDelta: target.height - chrome.height });
  } catch (error) {
    columns.setDelta(id, { status: "error", message: error.message });
  }
}

const pixelCache = new WeakMap();
function pixelsFor(data) {
  if (!pixelCache.has(data)) {
    pixelCache.set(
      data,
      decodeImage(data.blob).then((bitmap) => {
        data.bitmap = bitmap;
        return pixelsOf(bitmap);
      }),
    );
  }
  return pixelCache.get(data);
}

// ---------------------------------------------------------------------------
// Diff view

let diffTimer = null;
let flickerTimer = null;
let flickerMode = null;
const pan = { x: 12, y: 12 };

function scheduleDiff() {
  if (diffTimer) return;
  const wait = Math.min(700, Math.max(140, (runtime.diffMs ?? 0) * 3));
  diffTimer = setTimeout(() => {
    diffTimer = null;
    paintDiff();
  }, wait);
}

function bindQuoteSlot() {
  const input = $("#quoteUrl");
  const toggle = $("#quoteToggle");
  const clear = $("#quoteClear");
  const move = $("#moveQuote");
  if (!input) return;
  toggle?.addEventListener("click", () => {
    runtime.quoteOpen = !(runtime.quoteOpen || !!store.state.quoteUrl);
    paintQuoteSlot();
    if (runtime.quoteOpen) input.focus();
  });
  input.addEventListener("input", () => {
    const value = input.value.trim();
    if (value === store.state.quoteUrl) return;
    store.set((s) => {
      s.quoteUrl = value;
    });
  });
  clear.addEventListener("click", () => {
    input.value = "";
    store.set((s) => {
      s.quoteUrl = "";
    });
    input.focus();
  });
  if (move) move.addEventListener("click", moveToQuoteSlot);
}

function bindDiffControls() {
  const { diff } = store.state;
  $("#diffA").addEventListener("change", () => {
    store.set((s) => {
      s.diff.a = $("#diffA").value;
    });
    paintDiff();
  });
  $("#diffB").addEventListener("change", () => {
    store.set((s) => {
      s.diff.b = $("#diffB").value;
    });
    paintDiff();
  });
  $("#diffMode").addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-mode]");
    if (!btn) return;
    store.set((s) => {
      s.diff.mode = btn.dataset.mode;
    });
    paintDiff();
  });
  const opacity = $("#diffOpacity");
  opacity.value = String(diff.opacity);
  opacity.addEventListener("input", () => {
    store.set((s) => {
      s.diff.opacity = Number(opacity.value);
    });
    applyDiffState();
  });
  $("#diffZoom").addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-z]");
    if (!btn) return;
    setZoom(Number(btn.dataset.z));
  });
  $("#diffOutlines").addEventListener("change", () => {
    store.set((s) => {
      s.diff.outlines = $("#diffOutlines").checked;
    });
    paintDiff();
  });
  $("#diffReset").addEventListener("click", () => {
    pan.x = 12;
    pan.y = 12;
    setZoom(1);
  });
  els.diffStage.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const current = store.state.diff.zoom;
      const steps = [1, 2, 4, 8];
      const index = steps.indexOf(current);
      const next = event.deltaY < 0 ? Math.min(steps.length - 1, index + 1) : Math.max(0, index - 1);
      setZoom(steps[next]);
    },
    { passive: false },
  );
  $("#diffStage").addEventListener("dblclick", () => {
    pan.x = 0;
    pan.y = 0;
    setZoom(store.state.diff.zoom === 1 ? 4 : 1);
  });
}

function setZoom(zoom) {
  store.set((s) => {
    s.diff.zoom = zoom;
  });
  applyDiffState();
}

function applyDiffState() {
  const { mode, opacity, zoom, outlines } = store.state.diff;
  els.diffWorld.dataset.mode = mode;
  els.imgB.style.opacity = mode === "overlay" ? String(opacity) : "";
  els.diffWorld.style.setProperty("--pz", String(zoom));
  els.diffWorld.style.setProperty("--px", `${pan.x}px`);
  els.diffWorld.style.setProperty("--py", `${pan.y}px`);
  for (const btn of $$("button[data-mode]", $("#diffMode"))) btn.classList.toggle("on", btn.dataset.mode === mode);
  for (const btn of $$("button[data-z]", $("#diffZoom"))) btn.classList.toggle("on", Number(btn.dataset.z) === zoom);
  $("#diffOpacityVal").textContent = `${Math.round(opacity * 100)}%`;
  $("#opacityWrap").style.visibility = mode === "overlay" ? "visible" : "hidden";
  $("#diffOutlines").checked = outlines;
  // Only rebuild the flicker timer when the mode changes: a render landing
  // every 250 ms must not restart the flicker phase, or it never flips.
  if (mode !== flickerMode) {
    flickerMode = mode;
    clearInterval(flickerTimer);
    flickerTimer = null;
    els.diffWorld.classList.remove("flash");
    if (mode === "flicker") {
      flickerTimer = setInterval(() => els.diffWorld.classList.toggle("flash"), 420);
    }
  }
}

function bindDiffPan() {
  let dragging = null;
  els.diffStage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y };
    els.diffStage.setPointerCapture(event.pointerId);
    els.diffStage.classList.add("dragging");
  });
  els.diffStage.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    pan.x = dragging.px + (event.clientX - dragging.x);
    pan.y = dragging.py + (event.clientY - dragging.y);
    els.diffWorld.style.setProperty("--px", `${pan.x}px`);
    els.diffWorld.style.setProperty("--py", `${pan.y}px`);
  });
  const end = () => {
    dragging = null;
    els.diffStage.classList.remove("dragging");
  };
  els.diffStage.addEventListener("pointerup", end);
  els.diffStage.addEventListener("pointercancel", end);
}

async function paintDiff() {
  const { a, b, mode, zoom, outlines } = store.state.diff;
  const A = runtime.runners.get(a)?.data;
  const B = runtime.runners.get(b)?.data;
  applyDiffState();
  const ready = !!(A && B);
  els.diffEmpty.hidden = ready;
  els.diffWorld.classList.toggle("ready", ready);
  if (!ready) {
    els.diffStats.textContent = "—";
    els.diffStats.className = "chip stat";
    return;
  }
  // Off-screen diffs cost a full pixel comparison; the columns already show
  // the number, so only paint when the panel is actually in view.
  if (runtime.diffInView === false) return;

  if (els.imgA.dataset.key !== A.pngUrl) {
    els.imgA.dataset.key = A.pngUrl;
    els.imgA.dataset.dpr = String(A.dpr ?? 1);
    els.imgA.src = A.pngUrl;
  }
  if (els.imgB.dataset.key !== B.pngUrl) {
    els.imgB.dataset.key = B.pngUrl;
    els.imgB.dataset.dpr = String(B.dpr ?? 1);
    els.imgB.src = B.pngUrl;
  }
  sizePane(els.imgA, A);
  sizePane(els.imgB, B);

  $("#legendA").textContent = `${labelOf(a)} · ${A.width}×${A.height}`;
  $("#legendB").textContent = `${labelOf(b)} · ${B.width}×${B.height}`;
  $("#diffNote").textContent = `${fmtMs(A.ms?.total ?? 0)} vs ${fmtMs(B.ms?.total ?? 0)}`;

  // Outlines. In the stacked modes one pane covers the other, so A's boxes are
  // drawn on a canvas above both; side by side, each pane owns its outlines.
  const side = mode === "side";
  const stackedOpts = { dpr: A.dpr, width: Math.max(A.width, B.width), height: Math.max(A.height, B.height) };
  if (side) {
    paintGeometry(els.geomA, outlines ? A.geometry : null, { dpr: A.dpr, width: A.width, height: A.height });
    paintGeometry(els.geomB, outlines ? B.geometry : null, { dpr: B.dpr, width: B.width, height: B.height });
    sizeCanvas(els.geomA, A.dpr);
    sizeCanvas(els.geomB, B.dpr);
    els.geomA.style.display = outlines && hasGeometry(A.geometry) ? "" : "none";
    els.geomB.style.display = outlines && hasGeometry(B.geometry) ? "" : "none";
    els.geomTop.style.display = "none";
  } else {
    els.geomA.style.display = "none";
    els.geomB.style.display = "none";
    const showB = mode !== "heatmap";
    paintGeometryPair(
      els.geomTop,
      outlines && hasGeometry(A.geometry) ? A.geometry : null,
      outlines && showB && hasGeometry(B.geometry) ? B.geometry : null,
      stackedOpts,
    );
    sizeCanvas(els.geomTop, A.dpr);
    els.geomTop.style.display = outlines && (hasGeometry(A.geometry) || (showB && hasGeometry(B.geometry))) ? "" : "none";
  }

  try {
    const result = await maskFor(A, B);
    paintMask(els.mask, result);
    sizeCanvas(els.mask, A.dpr);
    const pct = result.pct;
    els.diffStats.textContent = `${pct.toFixed(2)}% px · Δh ${signed(B.height - A.height)}`;
    els.diffStats.className = "chip stat " + (pct <= 0.5 ? "good" : pct < 5 ? "warn" : "bad");
    els.diffStats.title = `${result.differing.toLocaleString()} of ${result.total.toLocaleString()} pixels differ by more than ±8 (1 px slack)`;
    if (result.inkB !== undefined && result.inkB < 0.002) {
      els.diffStats.title += "\nB looks blank: the render probably failed";
    }
  } catch (error) {
    els.diffStats.textContent = "diff failed";
    els.diffStats.className = "chip stat bad";
    els.diffStats.title = error.message;
  }
  applyDiffState();
}

function sizePane(img, data) {
  const dpr = data.dpr || 1;
  const apply = () => {
    if (!img.naturalWidth) return;
    img.style.width = `${img.naturalWidth / dpr}px`;
    img.style.height = `${img.naturalHeight / dpr}px`;
  };
  if (img.complete) apply();
  else img.addEventListener("load", apply, { once: true });
}

function sizeCanvas(canvas, dpr) {
  if (!canvas.width) return;
  canvas.style.width = `${canvas.width / (dpr || 1)}px`;
  canvas.style.height = `${canvas.height / (dpr || 1)}px`;
}

async function maskFor(A, B) {
  const key = `${A.pngUrl}|${B.pngUrl}`;
  const cached = runtime.masks?.get(key);
  if (cached) return cached;
  const [a, b] = await Promise.all([pixelsFor(A), pixelsFor(B)]);
  const started = performance.now();
  const result = comparePixels(a, b);
  runtime.diffMs = performance.now() - started;
  runtime.masks ??= new Map();
  // A mask is width × height × 4 bytes at device resolution; keep only small
  // ones around, and only the last few pairs.
  if (result.width * result.height <= 4_000_000) {
    runtime.masks.set(key, result);
    if (runtime.masks.size > 3) runtime.masks.delete(runtime.masks.keys().next().value);
  }
  return result;
}

function signed(n) {
  const v = Number(n) || 0;
  return `${v > 0 ? "+" : ""}${Number.isInteger(v) ? v : v.toFixed(1)}`;
}

function labelOf(id) {
  return runtime.targets.find((t) => t.id === id)?.label ?? id;
}

function pickDiff(id) {
  store.set((s) => {
    s.diff.a = "chrome";
    s.diff.b = id === "chrome" ? "wasm" : id;
  });
  $("#diffA").value = store.state.diff.a;
  $("#diffB").value = store.state.diff.b;
  runtime.diffInView = true;
  paintDiff();
  flash($("#diff"));
  $("#diff").scrollIntoView({ behavior: "smooth", block: "center" });
}

function flash(node) {
  node.animate?.(
    [
      { boxShadow: "0 0 0 2px var(--accent)" },
      { boxShadow: "0 0 0 2px transparent" },
    ],
    { duration: 900, easing: "ease-out" },
  );
}

function observeDiff() {
  if (typeof IntersectionObserver !== "function") return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        runtime.diffInView = entry.isIntersecting;
        if (entry.isIntersecting) paintDiff();
      }
    },
    { rootMargin: "200px" },
  );
  observer.observe($("#diff"));
}

// ---------------------------------------------------------------------------
// Report + matrix

let reportTimer = null;
function scheduleReport() {
  if (reportTimer) return;
  reportTimer = setTimeout(() => {
    reportTimer = null;
    paintReport();
  }, 120);
}

function paintReport() {
  const chosen = store.state.ui.reportFrom || "";
  const order = [chosen, "chrome", "wasm", "native", "http"].filter(Boolean);
  let report = null;
  let from = null;
  for (const id of order) {
    const entry = runtime.reports.get(id);
    if (entry?.report) {
      report = entry.report;
      from = id;
      break;
    }
  }
  renderReport(els.reportBody, {
    report,
    targetLabel: from ? labelOf(from) : null,
    post: runtime.post,
    links: linkEntries(),
  });
  if ($("#reportTarget").value !== (chosen || "")) $("#reportTarget").value = chosen || "";

  // Hidden ranges belong in the input, but only when the input *is* the text.
  const canMirror = runtime.kind === "text" && runtime.post && runtime.post.text === store.state.input;
  if (report && canMirror) controls.setHighlight(highlightHtml(store.state.input, report));
  else controls.setHighlight(escapeHtml(store.state.input));
}

// ---------------------------------------------------------------------------
// The inspect sheet: diff, report and matrix live here, collapsed by default so
// the previews own the screen. Clicking a preview (or D) opens it.

function currentInspectTab() {
  return store.state.ui.inspect ?? null;
}

function showInspect(tab) {
  const next = tab ?? null;
  if (next === currentInspectTab()) {
    paintInspect();
    if (next === "matrix") runMatrix();
    return;
  }
  store.set((s) => {
    s.ui.inspect = next;
    // The matrix is a tab now; the report's own toggle drives the same state.
    s.ui.matrix = next === "matrix";
  });
  paintInspect();
  if (next === "matrix") runMatrix();
}

function paintInspect() {
  const tab = currentInspectTab();
  els.inspect.hidden = !tab;
  document.body.classList.toggle("inspecting", !!tab);
  els.inspectBtn.setAttribute("aria-pressed", String(!!tab));
  for (const btn of $$("button[data-tab]", els.insTabs)) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", String(on));
  }
  for (const pane of $$(".ins-pane", els.inspect)) {
    pane.hidden = pane.dataset.pane !== tab;
  }
  if (els.matrix) els.matrix.hidden = tab !== "matrix";
  const mBtn = $("#matrixBtn");
  if (mBtn) mBtn.setAttribute("aria-pressed", String(tab === "matrix"));
  if (tab === "diff") paintDiff();
  else if (tab === "report") paintReport();
  else if (tab === "matrix") runMatrix();
}

function bindInspect() {
  els.inspectBtn.addEventListener("click", () => showInspect(currentInspectTab() ? null : "diff"));
  els.insClose.addEventListener("click", () => showInspect(null));
  window.addEventListener("resize", () => fitColumns(true));
  els.insTabs.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-tab]");
    if (btn) showInspect(btn.dataset.tab);
  });
}

function bindReportControls() {
  $("#reportTarget").addEventListener("change", () => {
    store.set((s) => {
      s.ui.reportFrom = $("#reportTarget").value || null;
    });
    paintReport();
  });
  $("#matrixBtn")?.addEventListener("click", () => showInspect("matrix"));
  $("#matrixTarget").addEventListener("change", () => {
    runtime.matrixTarget = $("#matrixTarget").value;
    runMatrix({ force: true });
  });
  $("#matrixSheet").addEventListener("click", saveSheet);
}

const matrixRefresh = debounce(() => {
  if (!store.state.ui.matrix) return;
  runMatrix();
}, 600);

let matrixRun = 0;
let lastMatrixKey = null;

async function runMatrix({ force = false } = {}) {
  if (!runtime.post) return;
  const targetId = $("#matrixTarget").value || "chrome";
  const key = canonical({
    targetId,
    post: runtime.post,
    surface: store.state.options.surface,
    dpr: Math.min(store.state.options.dpr, 2),
    fontScale: store.state.options.fontScale,
    smoothing: targetId === "chrome" ? store.state.options.smoothing : undefined,
  });
  if (!force && key === lastMatrixKey && els.matrixGrid.children.length > 0) return;
  lastMatrixKey = key;
  const run = ++matrixRun;
  const plan = matrixPlan(MATRIX_WIDTHS, MATRIX_THEMES);
  els.matrixGrid.textContent = "";
  els.matrixStatus.textContent = `0 / ${plan.length}`;
  const cells = plan.map((entry) => {
    const fig = matrixCell(entry);
    els.matrixGrid.append(fig);
    return { plan: entry, fig, data: null };
  });
  let done = 0;
  for (const cell of cells) {
    if (run !== matrixRun) return;
    // Same rule as the columns: `smoothing` goes to Chrome and nowhere else.
    const options = {
      surface: store.state.options.surface,
      theme: cell.plan.theme,
      width: cell.plan.width,
      dpr: Math.min(store.state.options.dpr, 2),
      fontScale: store.state.options.fontScale,
    };
    const task = { post: runtime.post, options, mode: undefined, source: undefined };
    if (targetId === "chrome") {
      task.chromeOptions = {
        ...options,
        smoothing: store.state.options.smoothing === "platform" ? "platform" : "antialiased",
      };
    }
    try {
      const data = await renderOnce(targetId, task, undefined);
      if (run !== matrixRun) return;
      cell.data = data;
      cell.fig.replaceWith(matrixCell({ width: cell.plan.width, theme: cell.plan.theme, data }));
    } catch (error) {
      if (run !== matrixRun) return;
      cell.fig.replaceWith(matrixCell({ width: cell.plan.width, theme: cell.plan.theme, error }));
    }
    done++;
    els.matrixStatus.textContent = `${done} / ${plan.length}`;
  }
  runtime.matrix = { targetId, cells: cells.filter((c) => c.data) };
}

async function saveSheet() {
  const cells = runtime.matrix?.cells ?? [];
  if (!cells.length) {
    toast("nothing to save: render the matrix first", "error");
    return;
  }
  const prepared = [];
  for (const cell of cells) {
    const bitmap = await createImageBitmap(cell.data.blob);
    prepared.push({ plan: cell.plan, image: bitmap });
  }
  const blob = await composeSheet(prepared);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `xeet-sheet-${Date.now()}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast("sheet saved");
}

// ---------------------------------------------------------------------------
// Keyboard, theme, column zoom, live state

function bindKeyboard() {
  window.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      $("#input").focus();
      $("#input").select();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      rerenderAll();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "t" || event.key === "T") {
      event.preventDefault();
      toggleTheme();
    } else if (event.key === "d" || event.key === "D") {
      event.preventDefault();
      showInspect("diff");
    } else if (event.key === "Escape") {
      togglePop(els.authorBtn, els.authorPop, false);
      togglePop(els.viewBtn, els.viewPop, false);
      if (currentInspectTab()) showInspect(null);
    } else if (/^[1-4]$/.test(event.key)) {
      const entry = runtime.targets[Number(event.key) - 1];
      if (!entry) return;
      event.preventDefault();
      toggleTarget(entry.id, entry.on === false);
    }
  });

  els.colZoom.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-z]");
    if (!btn) return;
    const raw = btn.dataset.z;
    const zoom = raw === "fit" ? "fit" : Number(raw);
    store.set((s) => {
      s.ui.zoom = zoom;
    });
    for (const b of $$("button[data-z]", els.colZoom)) b.classList.toggle("on", b.dataset.z === String(zoom));
    fitColumns(true);
  });
}

function toggleTheme() {
  store.set((s) => {
    s.options.theme = s.options.theme === "dark" ? "light" : "dark";
  });
  const theme = store.state.options.theme;
  document.documentElement.dataset.theme = theme;
  $("#themeIcon")?.setAttribute(
    "d",
    theme === "dark" ? "M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z" : "M12 4v2m0 12v2m8-8h-2M6 12H4m12.7-6.7-1.4 1.4M7.7 16.3l-1.4 1.4m0-11.4 1.4 1.4m8.6 8.6 1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  );
}

function setLive(state, text) {
  els.live.dataset.state = state;
  els.liveText.textContent = text;
}

function updateLive() {
  if (runtime.apiDown) return;
  const states = [...runtime.states.values()];
  const busy = states.filter((s) => s.status === "updating").length;
  const errors = states.filter((s) => s.status === "error").length;
  if (errors) setLive("error", `${errors} failing`);
  else if (busy) setLive("busy", "rendering");
  else setLive("ready", "ready");
}

/** "fit": scale every visible column so they sit side by side, no scrolling. */
let fitSignature = null;
function fitColumns(force = false) {
  const zoom = store.state.ui.zoom;
  if (zoom !== "fit") {
    columns.setZoom(typeof zoom === "number" ? zoom : 1);
    return;
  }
  const cols = [...els.columns.querySelectorAll(".col")];
  if (!cols.length) return;
  const stage = els.columns.parentElement ?? els.columns;
  const available = stage.clientWidth - 36;
  const gap = 12;
  const naturals = cols.map((col) => {
    const shot = parseFloat(col.style.getPropertyValue("--shotw")) || 390;
    const vp = parseFloat(col.style.getPropertyValue("--vpw")) || 0;
    return Math.max(shot, vp) + 22;
  });
  const total = naturals.reduce((sum, n) => sum + n, 0) + gap * (cols.length - 1);
  const signature = `${available}|${naturals.join(",")}`;
  if (!force && signature === fitSignature) return;
  fitSignature = signature;
  const fitted = Math.max(0.35, Math.min(1, available / total));
  columns.setZoom(Number(fitted.toFixed(3)));
  document.documentElement.style.setProperty("--colzoom", String(Number(fitted.toFixed(3))));
}

function bindTargetToolbar() {
  fitColumns(true);
  for (const btn of $$("button[data-z]", els.colZoom)) {
    btn.classList.toggle("on", btn.dataset.z === String(store.state.ui.zoom));
  }
  $("#chromeMode")?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-cmode]");
    if (!btn) return;
    store.set((s) => {
      s.ui.chromeMode = btn.dataset.cmode;
    });
    refresh({ reason: "chrome-mode" });
  });
  if (els.matrix) els.matrix.hidden = currentInspectTab() !== "matrix";
  $("#matrixBtn")?.setAttribute("aria-pressed", String(currentInspectTab() === "matrix"));
}

// Expose a small surface for the verification script and for the console.
window.xeetPlayground = {
  get state() {
    return store.state;
  },
  get runtime() {
    return runtime;
  },
  rerender: rerenderAll,
  paintDiff,
  /** Exactly the post the targets are sent: composed, clocked, and zoned. */
  compose: () =>
    runtime.post ?? localizeTimes(withClock(composePost(runtime.base, store.state.patch), store.state.clock?.at), store.state.clock?.zone ?? LOCAL),
  base: () => runtime.base,
  /** Run the UI's own composition on an arbitrary post (for the tests). */
  norm: (post) => composePost(post, {}),
  /** …and its time-zone rewrite, as a post would be sent to a target. */
  zone: (post, zone) => localizeTimes(composePost(post, {}), zone ?? store.state.clock?.zone ?? LOCAL),
  /** The key the current input asks for, per target (chrome has its own). */
  keys: () => ({
    base: runtime.task?.key ?? null,
    chrome: runtime.chromeTask?.key ?? null,
  }),
  /** What each target is showing versus what it was asked for. */
  runners: () =>
    [...runtime.runners].map(([id, runner]) => ({
      id,
      status: runner.status,
      shown: runner.shownKey,
      wanted: runner.wantedKey,
      stale: runner.stale,
    })),
  hash: () => location.hash,
};
