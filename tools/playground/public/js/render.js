// One column per target, and the per-target request state machine behind it.
//
// The wasm target renders in this tab on every keystroke (no debounce); the
// server targets are debounced and supersede each other: a new input aborts
// the request in flight, and only the newest key is allowed to land. Chrome
// gets a longer debounce and a visible "updating" state, because it is the
// slow one.

import { fmtMs, nextPaint, paintMsOf } from "./util.js";

export const BUILTIN_TARGETS = [
  { id: "chrome", label: "Chrome", truth: true },
  { id: "wasm", label: "WASM" },
  { id: "native", label: "native" },
  { id: "http", label: "HTTP fn" },
];

// The wasm target is debounced by a frame, not by a timer: a burst of keystrokes
// becomes one render (the module takes longer than a frame anyway), while a
// single keystroke still repaints on the next frame.
const DELAYS = { wasm: 16, native: 30, http: 30, chrome: 250 };

export const delayFor = (id) => DELAYS[id] ?? 30;

/**
 * Server target list merged with the order the user dragged them into.
 * Targets the server did not mention are kept, marked unavailable, so the UI
 * does not lose a column when a build is missing.
 */
export function mergeTargets(serverTargets, ordered) {
  const byId = new Map();
  for (const t of serverTargets ?? []) if (t && t.id) byId.set(t.id, t);
  const out = [];
  const seen = new Set();
  for (const entry of ordered) {
    const builtin = BUILTIN_TARGETS.find((t) => t.id === entry.id);
    if (!builtin) continue;
    const server = byId.get(entry.id);
    out.push({
      id: entry.id,
      label: server?.label ?? builtin.label,
      truth: builtin.truth ?? false,
      available: server ? server.available !== false : entry.id === "wasm",
      version: server?.version ?? null,
      stale: !!server?.stale,
      building: !!server?.building,
      error: server?.error ?? null,
      on: entry.on !== false,
    });
    seen.add(entry.id);
  }
  for (const [id, server] of byId) {
    if (seen.has(id)) continue;
    out.push({
      id,
      label: server.label ?? id,
      truth: false,
      available: server.available !== false,
      version: server.version ?? null,
      stale: !!server.stale,
      building: !!server.building,
      error: server.error ?? null,
      on: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request state machine

export class TargetRunner {
  constructor({ id, delay = 0, run, onUpdate, initialData = null }) {
    this.id = id;
    this.delay = delay;
    this.run = run;
    this.onUpdate = onUpdate;
    this.data = initialData;
    this.error = null;
    this.status = initialData ? "done" : "idle";
    /** The newest task the app wants; a start never clears it. */
    this.desired = null;
    /** Bumped whenever the wanted key changes; an older answer is dropped. */
    this.gen = 0;
    this.running = false;
    this.timer = null;
    this.scheduled = false;
    this.force = false;
    this.ctrl = null;
    this.wallMs = null;
    /** Consecutive dropped answers (superseded/aborted) for the wanted key. */
    this.retries = 0;
  }

  /** The key of the render on screen. */
  get shownKey() {
    return this.data?.key ?? null;
  }

  /** The key the input currently has. */
  get wantedKey() {
    return this.desired?.key ?? null;
  }

  /** True while the PNG on screen does not belong to the current input. */
  get stale() {
    return !!this.wantedKey && this.shownKey !== this.wantedKey;
  }

  emit() {
    this.onUpdate?.(this.id, this.snapshot());
  }

  snapshot() {
    return {
      status: this.status,
      data: this.data,
      error: this.error,
      wallMs: this.wallMs,
      key: this.shownKey,
      wantedKey: this.wantedKey,
      stale: this.stale,
    };
  }

  setTask(task) {
    // Same input: keep whatever is in flight instead of restarting it.
    if (task.key === this.wantedKey) {
      this.desired = task;
      return;
    }
    this.desired = task;
    this.gen++;
    this.retries = 0;
    this.error = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      // Supersede the request in flight; its completion reconciles.
      this.status = "updating";
      this.emit();
      this.ctrl?.abort();
      return;
    }
    if (!this.stale) {
      this.status = this.data ? "done" : "idle";
      this.emit();
      return;
    }
    this.status = "updating";
    this.schedule(0);
    this.emit();
  }

  /** Queues one render of the wanted task. Returns false if one is already due. */
  schedule(extra = 0, force = false) {
    if (!this.desired || this.running || this.timer || this.scheduled) return false;
    if (!this.stale && !force) return false;
    this.force = force;
    this.status = "updating";
    const wait = extra > 0 ? extra : this.data ? this.delay : 0;
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.start();
      }, wait);
    } else {
      this.scheduled = true;
      nextPaint(() => {
        this.scheduled = false;
        this.start();
      });
    }
    return true;
  }

  async start() {
    if (this.running || !this.desired) return;
    const task = this.desired;
    const gen = this.gen;
    const force = this.force;
    this.force = false;
    this.running = true;
    this.ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const started = performance.now();
    try {
      const result = await this.run(task, this.ctrl?.signal);
      if (gen === this.gen) {
        this.wallMs = performance.now() - started;
        result.key = task.key;
        this.data = result;
        this.error = null;
        this.status = "done";
      }
      // An answer for an older generation is dropped; reconcile re-issues.
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "SupersededError") {
        // Nothing to show: the answer was dropped before it was needed.
        if (gen === this.gen) this.retries++;
      } else if (gen === this.gen) {
        this.error = error;
        this.status = "error";
        this.wallMs = performance.now() - started;
      }
    } finally {
      this.running = false;
      this.ctrl = null;
      this.reconcile();
    }
  }

  /**
   * The one rule that makes the column converge: whatever happened, if the PNG
   * on screen is not the wanted key and nothing newer is on its way, ask again.
   */
  reconcile() {
    if (!this.desired) {
      this.emit();
      return;
    }
    if (!this.stale) {
      if (this.status === "updating" && this.data) this.status = "done";
      this.retries = 0;
      this.emit();
      return;
    }
    if (this.running || this.timer || this.scheduled) {
      this.emit();
      return;
    }
    if (this.status === "error") {
      // An error is honest for the current key; typing or Re-render retries.
      this.emit();
      return;
    }
    // A dropped answer is retried with a small backoff so two clients cannot
    // ping-pong supersessions at full speed.
    const backoff = this.retries ? Math.min(2000, 150 * 2 ** (this.retries - 1)) : 0;
    if (this.schedule(backoff)) this.emit();
    else this.emit();
  }

  /** Forced re-render of the current task (Re-render button, ⌘↵, SSE bump). */
  restart(task) {
    if (task) this.desired = task;
    this.gen++;
    this.retries = 0;
    this.error = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      this.status = "updating";
      this.emit();
      this.ctrl?.abort();
      return;
    }
    if (this.schedule(0, true)) this.emit();
    else this.emit();
  }
}

// ---------------------------------------------------------------------------
// Columns

export function classifyDelta(pct) {
  if (!Number.isFinite(pct)) return "";
  if (pct <= 0.5) return "good";
  if (pct < 5) return "warn";
  return "bad";
}

export function deltaLabel(delta) {
  if (!delta) return null;
  if (delta.status === "calculating") return "…";
  const h = delta.heightDelta;
  const hh = h === 0 ? "" : ` · Δh ${h > 0 ? "+" : ""}${Number.isInteger(h) ? h : h.toFixed(1)}`;
  return `${delta.pct.toFixed(2)}%${hh}`;
}

export class ColumnsView {
  constructor(container, handlers = {}) {
    this.container = container;
    this.handlers = handlers;
    this.columns = new Map();
    this.targets = [];
    this.smoothing = "antialiased";
    this.chromeModeEl = handlers.chromeModeEl ?? null;
  }

  setZoom(zoom) {
    this.container.style.setProperty("--colzoom", String(zoom));
  }

  /** Reflects the chrome render's glyph smoothing without a rebuild. */
  setSmoothing(value) {
    this.smoothing = value === "platform" ? "platform" : "antialiased";
    for (const col of this.columns.values()) {
      for (const btn of col.el.querySelectorAll("button[data-smoothing]")) {
        btn.classList.toggle("on", btn.dataset.smoothing === this.smoothing);
      }
    }
  }

  /** Rebuilds the DOM for this target list, preserving any render state. */
  setTargets(targets) {
    this.targets = targets;
    const keep = new Map();
    for (const [id, col] of this.columns) {
      if (col.data) keep.set(id, col.state);
    }
    this.columns.clear();
    this.container.textContent = "";
    for (const target of targets) {
      if (target.on === false) continue;
      const col = this.mount(target);
      this.columns.set(target.id, col);
      const state = keep.get(target.id);
      if (state) this.update(target.id, state);
    }
    if (!targets.some((t) => t.on !== false)) {
      const empty = document.createElement("div");
      empty.className = "col-placeholder";
      empty.textContent = "every target is hidden — press 1–4 or pick one above";
      this.container.append(empty);
    }
  }

  mount(target) {
    const col = document.createElement("article");
    col.className = "col" + (target.truth ? " truth" : "");
    col.dataset.status = "idle";
    col.dataset.id = target.id;
    col.style.setProperty("--shotw", "390px");

    const head = document.createElement("header");
    head.className = "col-head";
    head.innerHTML = `
      <div class="col-name"><span class="st"></span><span class="nm"></span>${
        target.truth ? '<span class="col-truth">truth</span>' : ""
      }</div>
      <div class="col-tools">
        <button data-act="left" title="Move left" aria-label="Move left">‹</button>
        <button data-act="right" title="Move right" aria-label="Move right">›</button>
        <button data-act="hide" title="Hide this target" aria-label="Hide">×</button>
      </div>`;
    head.querySelector(".nm").textContent = target.label;
    head.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "left") this.handlers.onMove?.(target.id, -1);
      else if (act === "right") this.handlers.onMove?.(target.id, 1);
      else if (act === "hide") this.handlers.onToggle?.(target.id, false);
    });

    const badges = document.createElement("div");
    badges.className = "col-badges";

    const shot = document.createElement("div");
    shot.className = "col-shot";
    shot.innerHTML = `<div class="col-placeholder">${
      target.available === false ? "not built" : "not rendered yet"
    }</div><div class="updating"><span class="chip">updating…</span></div>`;

    const foot = document.createElement("footer");
    foot.className = "col-foot";
    // The truth column's delta is a label, not a number; keep it across rebuilds.
    foot.innerHTML = `<span class="ms">—</span><span class="delta calc">${target.truth ? "reference" : "—"}</span>`;

    if (target.id === "chrome") {
      // Quiet, inline: a Chrome-only glyph rasterization switch.
      const smooth = document.createElement("div");
      smooth.className = "col-smoothing";
      smooth.title =
        "macOS thickens glyphs (CoreText); real x.com on a Mac looks like this. The gates compare antialiased.";
      smooth.innerHTML = `<div class="segmented xs" role="group" aria-label="Chrome glyph smoothing">
          <button type="button" data-smoothing="antialiased">AA</button>
          <button type="button" data-smoothing="platform">macOS</button>
        </div>`;
      smooth.addEventListener("click", (event) => {
        const btn = event.target.closest("button[data-smoothing]");
        if (btn) this.handlers.onSmoothing?.(btn.dataset.smoothing);
      });
      for (const btn of smooth.querySelectorAll("button[data-smoothing]")) {
        btn.classList.toggle("on", btn.dataset.smoothing === this.smoothing);
      }
      head.insertBefore(smooth, head.querySelector(".col-tools"));
      if (this.chromeModeEl) head.insertBefore(this.chromeModeEl, head.querySelector(".col-tools"));
    }

    col.append(head, badges, shot, foot);
    this.container.append(col);
    const entry = {
      el: col,
      badges,
      shot,
      foot,
      img: null,
      data: null,
      state: null,
      target,
      renderBadges: null,
    };
    entry.renderBadges = () => this.paintBadges(entry);
    entry.renderBadges();
    return entry;
  }

  paintBadges(entry) {
    const { target, badges } = entry;
    badges.textContent = "";
    // The column face stays quiet: version, ruleset and upstream live in the
    // header's tooltip, and only something actionable (a stale build) is drawn.
    const v = target.version ?? {};
    const title = [
      target.label,
      v.rev ? `built from ${String(v.rev).slice(0, 12)}${v.dirty ? " (dirty working tree)" : ""}` : null,
      v.builtAt ? `built ${v.builtAt}` : null,
      v.ruleset ? `ruleset ${v.ruleset}` : null,
      v.upstream ? `upstream X ${String(v.upstream).slice(0, 12)}` : null,
      target.available === false ? "not built: press Rebuild" : null,
    ]
      .filter(Boolean)
      .join("\n");
    const name = entry.el.querySelector(".col-name");
    if (name) name.title = title;

    if (target.available === false || target.stale) {
      const stale = document.createElement("span");
      stale.className = "badge-stale";
      stale.textContent = target.available === false ? "not built" : "stale";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = target.building ? "building…" : "Rebuild";
      btn.disabled = !!target.building;
      btn.addEventListener("click", () => this.handlers.onRebuild?.(target.id));
      stale.append(btn);
      badges.append(stale);
    } else if (target.building) {
      const b = document.createElement("span");
      b.className = "badge-stale";
      b.textContent = "building…";
      badges.append(b);
    }
  }

  updateVersion(target) {
    const entry = this.columns.get(target.id);
    if (!entry) return;
    entry.target = { ...entry.target, ...target };
    entry.renderBadges();
  }

  update(id, state) {
    const entry = this.columns.get(id);
    if (!entry) return;
    entry.state = state;
    const { el, shot, foot } = entry;
    el.dataset.status = state.status;
    el.dataset.stale = state.stale ? "1" : "0";
    const msEl = foot.querySelector(".ms");

    if (state.error) {
      foot.querySelector(".delta").textContent = "";
      foot.querySelector(".delta").className = "delta calc";
      let box = shot.querySelector(".col-error");
      if (!box) {
        box = document.createElement("div");
        box.className = "col-error";
        shot.append(box);
      }
      const code = state.error.code ?? "error";
      const message = state.error.message ?? String(state.error);
      box.innerHTML = "";
      const c = document.createElement("span");
      c.className = "code";
      c.textContent = code;
      box.append(c, document.createTextNode(message));
      shot.prepend(box);
      msEl.innerHTML = `<b>${fmtMs(state.wallMs)}</b>`;
      if (entry.img) entry.img.classList.add("blank");
      return;
    }
    shot.querySelector(".col-error")?.remove();

    if (state.data) {
      const data = state.data;
      const viewport = Math.round(data.viewport ?? data.width);
      const column = Math.round(data.width);
      if (entry.imgKey !== data.pngUrl) {
        entry.imgKey = data.pngUrl;
        if (!entry.img) {
          shot.querySelector(".col-placeholder")?.remove();
          // The column is min(viewport, 600); when the viewport is wider, the
          // frame draws it so the post's place on the device is visible.
          entry.frame = document.createElement("div");
          entry.frame.className = "col-frame";
          entry.frame.append(document.createElement("span"));
          entry.frame.firstChild.className = "frame-label";
          entry.img = document.createElement("img");
          entry.img.alt = `${entry.target.label} render`;
          entry.img.decoding = "async";
          entry.frame.append(entry.img);
          shot.prepend(entry.frame);
          entry.img.addEventListener("click", () => {
            this.handlers.onPickDiff?.(id);
            this.handlers.onInspect?.(id);
          });
          entry.img.style.cursor = "zoom-in";
          entry.img.title = "click to inspect: diff, report, matrix";
        }
        if (entry.url && entry.url !== data.pngUrl) URL.revokeObjectURL(entry.url);
        entry.url = data.pngUrl;
        entry.img.classList.remove("blank");
        entry.img.src = data.pngUrl;
        entry.img.width = column;
        entry.img.height = Math.round(data.height);
        el.style.setProperty("--shotw", `${column}px`);
      }
      if (entry.frame) {
        const wide = viewport > column + 0.5;
        entry.frame.classList.toggle("wide", wide);
        entry.frame.style.setProperty("--vpw", `${viewport}px`);
        el.style.setProperty("--vpw", `${viewport}px`);
        const label = entry.frame.firstChild;
        label.textContent = wide ? `${viewport} px viewport · ${column} column` : "";
        label.hidden = !wide;
        entry.frame.title = wide
          ? `the device viewport is ${viewport} CSS px; X's post column is min(viewport, 600) = ${column}`
          : "";
      }
      const m = data.ms ?? {};
      const paint = paintMsOf(data);
      // The footer is paint time and nothing else; fetching, IPC and wire
      // encoding live in the tooltip so a slow request cannot look slow to render.
      msEl.innerHTML = `<b>${fmtMs(paint)} ms</b> <span class="faint">paint</span>`;
      msEl.title = [
        `paint ${fmtMs(paint)} ms`,
        Number.isFinite(m.layout) ? `layout ${fmtMs(m.layout)} ms` : null,
        Number.isFinite(m.screenshot) ? `screenshot ${fmtMs(m.screenshot)} ms` : null,
        Number.isFinite(m.render) && m.render !== paint ? `render ${fmtMs(m.render)} ms` : null,
        Number.isFinite(m.encode) ? `encode ${fmtMs(m.encode)} ms` : null,
        Number.isFinite(m.fetch) ? `fetch ${fmtMs(m.fetch)} ms` : null,
        Number.isFinite(state.wallMs) ? `wall ${fmtMs(state.wallMs)} ms` : null,
        data.height ? `${data.width}×${data.height} css @${data.dpr}dpr` : null,
        data.at ? `at ${new Date(data.at).toLocaleTimeString()}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      entry.data = data;
    } else if (state.status === "updating" && !entry.img) {
      const ph = shot.querySelector(".col-placeholder");
      if (ph) ph.textContent = "rendering…";
    }
  }

  setDelta(id, delta) {
    const entry = this.columns.get(id);
    if (!entry) return;
    const el = entry.foot.querySelector(".delta");
    el.className = "delta " + (delta?.status === "calculating" ? "calc" : classifyDelta(delta?.pct));
    el.textContent = "";
    if (!delta) {
      el.textContent = entry.target.truth ? "reference" : "—";
      el.title = "";
      return;
    }
    if (delta.status === "error") {
      el.className = "delta calc";
      el.textContent = "no diff";
      el.title = delta.message ?? "";
      return;
    }
    if (delta.status === "calculating") {
      el.textContent = "diff…";
      return;
    }
    const label = deltaLabel(delta);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.title = `${delta.differing.toLocaleString()} of ${delta.total.toLocaleString()} px differ by more than ±8 (1 px slack)\nclick to open this pair in the diff`;
    btn.addEventListener("click", () => this.handlers.onPickDiff?.(id));
    el.append(btn);
  }

  get(id) {
    return this.columns.get(id);
  }
}
