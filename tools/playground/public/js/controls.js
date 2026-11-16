// Controls: the paste box, the viewport options and the post-details drawer.
//
// Every drawer field maps to a field of crates/xeet-core/src/model.rs. A
// section is an *override* only when it is switched on; until then the value
// comes from whatever the input resolved to (a URL fills the whole drawer).

import { $, $$, clamp, fileToBase64, isoToLocalInput, localInputToIso, nowIso } from "./util.js";
import { mediaProblem, urlsInText } from "./model.js";
import { SAMPLE_TEXT } from "./state.js";
import { DEVICES, DEVICE_NOTE, deviceFor, deviceById, deviceLabel } from "./devices.js";
import { LOCAL, ZONES, isoInZone, zoneLabel } from "./time.js";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function mimeOfBase64(b64) {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("UklGR")) return "image/webp";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  return "image/png";
}

function dataUrl(base64) {
  return `data:${mimeOfBase64(base64)};base64,${base64}`;
}

function imageSize(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: 0, height: 0 });
    };
    img.src = url;
  });
}

export function createControls({ store, toast }) {
  const els = {
    input: $("#input"),
    charCount: $("#charCount"),
    hlInner: $("#hlInner"),
    surface: $("#surface"),
    theme: $("#theme"),
    width: $("#width"),
    widthVal: $("#widthVal"),
    widthPresets: $("#widthPresets"),
    dpr: $("#dpr"),
    fontScale: $("#fontScale"),
    fontScaleVal: $("#fontScaleVal"),
    drawer: $("#drawer"),
    mList: $("#mList"),
  };

  // ---------------------------------------------------------------- paste box
  function autoGrowInput() {
    if (!els.input) return;
    els.input.style.height = "auto";
    els.input.style.height = `${Math.max(84, els.input.scrollHeight)}px`;
  }

  els.input.addEventListener("input", () => {
    autoGrowInput();
    const value = els.input.value;
    store.set((s) => {
      s.input = value;
      // One instant for createdAt and now, re-stamped as the draft changes
      // (unless frozen, so renders stay stable while typing).
      if (!s.clock?.freeze) s.clock.at = nowIso();
      // A quote override that was only copied from a resolved quote must not
      // follow the text to an unrelated post; a hand-edited one is the user's.
      if (s.patch?.quote && !s.ui?.quoteTouched) delete s.patch.quote;
      // A link override is keyed by the URL as written; once that URL is gone
      // from the text it can never render, so drop it instead of letting a
      // stale card shadow the resolved one.
      if (s.patch?.links) {
        const urls = new Set(urlsInText(value));
        for (const key of Object.keys(s.patch.links)) if (!urls.has(key)) delete s.patch.links[key];
        if (!Object.keys(s.patch.links).length) delete s.patch.links;
      }
    });
  });
  els.input.addEventListener("scroll", syncHighlightScroll);
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      document.dispatchEvent(new CustomEvent("xeet:rerender"));
    }
  });

  $("#sampleBtn").addEventListener("click", () => {
    store.set((s) => {
      s.input = SAMPLE_TEXT;
      if (!s.clock?.freeze) s.clock.at = nowIso();
    });
  });
  $("#clearBtn").addEventListener("click", () => {
    els.input.value = "";
    els.input.focus();
    store.set((s) => {
      s.input = "";
      if (!s.clock?.freeze) s.clock.at = nowIso();
    });
  });

  // ------------------------------------------------------------------- clock
  const zoneSelect = $("#clockZone");
  for (const zone of ZONES) {
    const option = document.createElement("option");
    option.value = zone.id;
    option.textContent = zoneLabel(zone.id);
    zoneSelect.append(option);
  }
  zoneSelect.addEventListener("change", () => {
    store.set((s) => {
      s.clock.zone = zoneSelect.value || LOCAL;
    });
  });

  $("#clockFreeze").addEventListener("change", (event) => {
    const freeze = event.target.checked;
    store.set((s) => {
      s.clock.freeze = freeze;
      if (!freeze) s.clock.at = nowIso();
    });
  });
  $("#clockNow").addEventListener("click", () => {
    store.set((s) => {
      s.clock.at = nowIso();
    });
  });

  // ------------------------------------------------------------- link options
  const onLinkOption = () => {
    store.set((s) => {
      s.links = { resolve: $("#resolveLinks").checked, media: $("#realImages").checked };
    });
    document.dispatchEvent(new CustomEvent("xeet:links-changed"));
  };
  $("#resolveLinks").addEventListener("change", onLinkOption);
  $("#realImages").addEventListener("change", onLinkOption);

  // ------------------------------------------------------------------ device
  // The picker sets width and dpr together; the raw controls stay authoritative
  // (moving them simply makes the picker read "custom").
  const deviceSelect = $("#device");
  deviceSelect.title = DEVICE_NOTE;
  const customOption = document.createElement("option");
  customOption.value = "";
  customOption.textContent = "custom";
  deviceSelect.append(customOption);
  for (const groupName of [...new Set(DEVICES.map((d) => d.group))]) {
    const group = document.createElement("optgroup");
    group.label = groupName;
    for (const device of DEVICES.filter((d) => d.group === groupName)) {
      const option = document.createElement("option");
      option.value = device.id;
      option.textContent = deviceLabel(device);
      group.append(option);
    }
    deviceSelect.append(group);
  }
  deviceSelect.addEventListener("change", () => {
    const device = deviceById(deviceSelect.value);
    if (!device) return;
    store.set((s) => {
      s.options.width = device.width;
      s.options.dpr = device.dpr;
    });
  });

  // ----------------------------------------------------------------- options
  els.surface.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-v]");
    if (!btn) return;
    store.set((s) => {
      s.options.surface = btn.dataset.v;
    });
  });
  els.theme.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-v]");
    if (!btn) return;
    store.set((s) => {
      s.options.theme = btn.dataset.v;
    });
  });
  els.dpr.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-v]");
    if (!btn) return;
    store.set((s) => {
      s.options.dpr = Number(btn.dataset.v);
    });
  });
  els.widthPresets.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-w]");
    if (!btn) return;
    store.set((s) => {
      s.options.width = Number(btn.dataset.w);
    });
  });
  els.width.addEventListener("input", () => {
    const width = clamp(Number(els.width.value), 280, 1200);
    store.set((s) => {
      s.options.width = width;
    });
  });
  els.fontScale.addEventListener("input", () => {
    const fontScale = clamp(Number(els.fontScale.value), 0.8, 1.35);
    store.set((s) => {
      s.options.fontScale = fontScale;
    });
  });

  // ------------------------------------------------------------------ drawer
  const patchOf = (s) => s.patch ?? (s.patch = {});
  // The post the drawer currently shows (resolved input + overrides). Set by sync().
  let currentPost = { text: store.state.input };
  const updatePatch = (fn, { rebuildMedia = false } = {}) => {
    store.set((s) => {
      fn(patchOf(s));
    });
    if (rebuildMedia) renderMedia();
  };
  const onField = (id, fn) => {
    const node = $(id);
    node.addEventListener("input", () =>
      updatePatch((patch) => fn(patch, node.type === "checkbox" ? node.checked : node.value)),
    );
    node.addEventListener("change", () =>
      updatePatch((patch) => fn(patch, node.type === "checkbox" ? node.checked : node.value)),
    );
  };
  const onSelect = (id, fn) => $(id).addEventListener("change", () => updatePatch((patch) => fn(patch, $(id).value)));

  const section = (name, checkbox, init) => {
    $(checkbox).addEventListener("change", (event) => {
      const on = event.target.checked;
      updatePatch((patch) => {
        if (on) init(patch, store.state);
        else {
          for (const key of [].concat(SECTION_KEYS[name])) delete patch[key];
        }
      });
      renderMedia();
    });
  };

  const SECTION_KEYS = {
    author: ["author"],
    counts: ["counts"],
    createdAt: ["createdAt", "now"],
    media: ["media"],
    links: ["links"],
    quote: ["quote"],
    poll: ["poll"],
    advanced: ["cardState", "socialContext", "longPost", "replyTo", "replyToHandle", "mediaTags", "appVersion"],
  };

  section("author", "#aOn", (patch) => {
    // Start from whatever the input resolved to (avatar, affiliation, shape…).
    patch.author = { ...(currentPost.author ?? {}) };
  });
  section("counts", "#cOn", (patch) => {
    patch.counts = { ...(currentPost.counts ?? { replies: 0, reposts: 0, likes: 0, views: 0 }) };
  });
  section("createdAt", "#tOn", (patch) => {
    patch.createdAt = currentPost.createdAt ?? isoInZone(nowIso(), LOCAL);
    patch.now = isoInZone(nowIso(), LOCAL);
  });
  section("media", "#mOn", (patch) => {
    patch.media = (currentPost.media ?? []).length
      ? currentPost.media.map((m) => ({ ...m }))
      : [{ kind: "image", width: 1600, height: 900 }];
  });
  section("links", "#lOn", (patch) => {
    const urls = Object.keys(currentPost.links ?? {});
    const url = urls[0] ?? urlsInText(currentPost.text ?? store.state.input)[0] ?? "";
    const existing = url ? currentPost.links?.[url] : null;
    patch.links = {};
    if (url) {
      patch.links[url] = existing ? { ...existing } : { card: "summary_large_image" };
    }
  });
  section("quote", "#qOn", (patch) => {
    patch.quote = currentPost.quote
      ? JSON.parse(JSON.stringify(currentPost.quote))
      : { text: "", author: { name: "", handle: "", verified: "none" } };
  });
  section("poll", "#pOn", (patch) => {
    patch.poll = currentPost.poll ? JSON.parse(JSON.stringify(currentPost.poll)) : { choices: ["", ""] };
  });
  section("advanced", "#xOn", (patch) => {
    if (currentPost.cardState) patch.cardState = currentPost.cardState;
    if (currentPost.socialContext) patch.socialContext = currentPost.socialContext;
    if (typeof currentPost.longPost === "boolean") patch.longPost = currentPost.longPost;
  });

  const author = (patch) => (patch.author ??= {});
  onField("#aName", (p, v) => (author(p).name = v));
  onField("#aHandle", (p, v) => (author(p).handle = String(v).replace(/^@/, "")));
  // X draws a business account's avatar as a rounded square; picking the gold
  // check turns that on. It stays a visible checkbox in the drawer, so it can
  // be switched back off.
  onSelect("#aVerified", (p, v) => {
    const a = author(p);
    a.verified = v;
    if (v === "business") a.squareAvatar = true;
  });
  onField("#aSquare", (p, v) => (author(p).squareAvatar = v));
  onField("#aProtected", (p, v) => (author(p).protected = v));
  onField("#aAffName", (p, v) => {
    const a = author(p);
    a.affiliate = { ...(a.affiliate ?? {}), name: v };
  });

  uploadField("#aAvatar", async (b64) => {
    updatePatch((p) => (author(p).avatar = b64));
  });
  uploadField("#aAffBadge", async (b64) => {
    updatePatch((p) => {
      const a = author(p);
      a.affiliate = { ...(a.affiliate ?? {}), badge: b64 };
    });
  });
  $("#aAvatarClear").addEventListener("click", () => updatePatch((p) => delete author(p).avatar));

  for (const [id, key] of [
    ["#cReplies", "replies"],
    ["#cReposts", "reposts"],
    ["#cLikes", "likes"],
    ["#cViews", "views"],
    ["#cBookmarks", "bookmarks"],
  ]) {
    onField(id, (p, v) => {
      const counts = (p.counts ??= {});
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) counts[key] = Math.round(n);
      else delete counts[key];
    });
  }

  onField("#tCreated", (p, v) => {
    const iso = localInputToIso(v);
    if (iso) p.createdAt = iso;
    else delete p.createdAt;
    if (!p.now) p.now = isoInZone(nowIso(), LOCAL);
  });
  onField("#tNow", (p, v) => {
    if (v) p.now = v;
    else delete p.now;
  });
  $("#tNowBtn").addEventListener("click", () =>
    updatePatch((p) => {
      p.now = isoInZone(nowIso(), LOCAL);
    }),
  );

  $("#mAdd").addEventListener("click", () => {
    updatePatch((p) => {
      const media = (p.media ??= []);
      if (media.length >= 4) return;
      media.push({ kind: "image", width: 1600, height: 900 });
    }, { rebuildMedia: true });
  });

  onField("#lUrl", (p, v) => {
    const links = (p.links ??= {});
    const entries = Object.entries(links);
    const meta = entries.length ? entries[0][1] : { card: "summary_large_image" };
    p.links = { [v]: meta };
  });
  const linkMeta = (p) => {
    const links = (p.links ??= {});
    const key = Object.keys(links)[0];
    if (!key) {
      const url = urlsInText(store.state.input)[0] ?? "https://example.com";
      links[url] = { card: "summary_large_image" };
      return links[url];
    }
    return links[key];
  };
  onSelect("#lCard", (p, v) => {
    const meta = linkMeta(p);
    if (v) meta.card = v;
    else delete meta.card;
  });
  onField("#lTitle", (p, v) => {
    const meta = linkMeta(p);
    if (v) meta.title = v;
    else delete meta.title;
  });
  onField("#lDesc", (p, v) => {
    const meta = linkMeta(p);
    if (v) meta.description = v;
    else delete meta.description;
  });
  onField("#lDomain", (p, v) => {
    const meta = linkMeta(p);
    if (v) meta.domain = v;
    else delete meta.domain;
  });
  onField("#lDisplay", (p, v) => {
    const meta = linkMeta(p);
    if (v) meta.display = v;
    else delete meta.display;
  });
  const cardImage = (p) => {
    const meta = linkMeta(p);
    meta.image = meta.image ?? { width: 0, height: 0 };
    return meta.image;
  };
  onField("#lImageW", (p, v) => {
    const img = cardImage(p);
    img.width = Math.max(0, Math.round(Number(v) || 0));
  });
  onField("#lImageH", (p, v) => {
    const img = cardImage(p);
    img.height = Math.max(0, Math.round(Number(v) || 0));
  });
  uploadField("#lImageFile", async (b64, file) => {
    const size = await imageSize(file);
    updatePatch((p) => {
      const img = cardImage(p);
      img.data = b64;
      if (!img.width) img.width = size.width;
      if (!img.height) img.height = size.height;
    });
  });

  // Every quote field marks the override as hand-edited, so an automatic copy
  // of a resolved quote can be dropped when the text moves on but an edit stays.
  const onQuoteField = (selector, fn) => {
    const node = $(selector);
    const apply = () => {
      store.set((s) => {
        fn(s.patch ?? (s.patch = {}), node.type === "checkbox" ? node.checked : node.value);
        s.ui = s.ui ?? {};
        s.ui.quoteTouched = true;
      });
    };
    node.addEventListener("input", apply);
    node.addEventListener("change", apply);
  };
  onQuoteField("#qText", (p, v) => ((p.quote ??= {}).text = v));
  onQuoteField("#qName", (p, v) => ((p.quote ??= {}).author = { ...((p.quote ?? {}).author ?? {}), name: v }));
  onQuoteField("#qHandle", (p, v) => ((p.quote ??= {}).author = { ...((p.quote ?? {}).author ?? {}), handle: v }));
  onQuoteField("#qVerified", (p, v) => ((p.quote ??= {}).author = { ...((p.quote ?? {}).author ?? {}), verified: v }));

  // Enabling the section copies the resolved quote in, so it starts unedited.
  $("#qOn").addEventListener("change", () => {
    store.set((s) => {
      s.ui = s.ui ?? {};
      s.ui.quoteTouched = false;
    });
  });

  // "reset to resolved": drop the override, the resolver's quote shows through.
  $("#qReset").addEventListener("click", () => {
    store.set((s) => {
      if (s.patch && "quote" in s.patch) delete s.patch.quote;
      s.ui = s.ui ?? {};
      s.ui.quoteTouched = false;
    });
  });

  onField("#pChoices", (p, v) => {
    const choices = String(v).split("\n").map((c) => c.trim()).filter((c, i, all) => c || i < all.length - 1);
    (p.poll ??= {}).choices = choices;
  });
  onField("#pVotes", (p, v) => {
    const votes = String(v)
      .split(/[\s,]+/)
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x >= 0);
    const poll = (p.poll ??= {});
    if (votes.length) poll.votes = votes;
    else delete poll.votes;
  });
  onField("#pLeft", (p, v) => {
    const poll = (p.poll ??= {});
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) poll.secondsLeft = Math.round(n);
    else delete poll.secondsLeft;
  });

  onSelect("#xCardState", (p, v) => {
    if (v === "dismissed") p.cardState = "dismissed";
    else delete p.cardState;
  });
  onSelect("#xSocial", (p, v) => {
    if (v) p.socialContext = v;
    else delete p.socialContext;
  });
  onSelect("#xLongPost", (p, v) => {
    if (v === "true") p.longPost = true;
    else if (v === "false") p.longPost = false;
    else delete p.longPost;
  });
  onField("#xReplyTo", (p, v) => (v ? (p.replyTo = v) : delete p.replyTo));
  onField("#xReplyHandle", (p, v) => (v ? (p.replyToHandle = v) : delete p.replyToHandle));
  onField("#xMediaTags", (p, v) => {
    const tags = String(v).split(",").map((t) => t.trim()).filter(Boolean);
    if (tags.length) p.mediaTags = tags;
    else delete p.mediaTags;
  });
  onField("#xAppVersion", (p, v) => (v ? (p.appVersion = v) : delete p.appVersion));

  $("#resetPatch").addEventListener("click", () => {
    store.set((s) => {
      s.patch = {};
    });
    renderMedia();
    sync();
  });

  // Undo the link-card overrides for the URL in the field: with the patch entry
  // gone, the resolved card shows through again.
  $("#lReset").addEventListener("click", () => {
    const url = $("#lUrl").value;
    updatePatch((p) => {
      if (!p.links || !(url in p.links)) return;
      delete p.links[url];
      if (!Object.keys(p.links).length) delete p.links;
    });
  });

  function uploadField(selector, apply) {
    const node = $(selector);
    node.addEventListener("change", async () => {
      const file = node.files?.[0];
      if (!file) return;
      if (file.size > MAX_IMAGE_BYTES) {
        toast?.(`${file.name} is larger than 4 MB; the playground keeps uploads small`, "error");
        node.value = "";
        return;
      }
      try {
        const b64 = await fileToBase64(file);
        await apply(b64, file);
      } catch (error) {
        toast?.(error.message ?? String(error), "error");
      }
      node.value = "";
    });
  }

  // ------------------------------------------------------------------- media
  let mediaRows = 0;
  function renderMedia() {
    const media = store.state.patch?.media ?? [];
    if (media.length === mediaRows) {
      syncMediaValues();
      return;
    }
    mediaRows = media.length;
    els.mList.textContent = "";
    media.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "media-row";
      row.dataset.index = String(index);
      row.innerHTML = `
        <span class="idx">${index + 1}</span>
        <div class="mrow-outer">
          <div class="mrow">
            <select data-k="kind">
              <option value="image">image</option>
              <option value="gif">gif</option>
              <option value="video">video</option>
            </select>
            <input data-k="width" type="number" min="0" placeholder="width" aria-label="width">
            <input data-k="height" type="number" min="0" placeholder="height" aria-label="height">
          </div>
          <div class="mfoot">
            <img data-k="thumb" alt="" hidden>
            <input data-k="alt" placeholder="alt text" aria-label="alt text">
            <input data-k="duration" type="number" min="0" step="0.1" placeholder="s" aria-label="duration" style="width:52px">
            <input data-k="file" type="file" accept="image/png,image/jpeg,image/webp">
            <button class="btn ghost xs" data-act="remove" type="button" title="remove">×</button>
          </div>
        </div>`;
      row.addEventListener("input", (event) => {
        const input = event.target.closest("[data-k]");
        const k = input?.dataset.k;
        if (!k || k === "file" || k === "thumb") return;
        const value = input.value;
        updatePatch((p) => {
          const m = (p.media ?? [])[index];
          if (!m) return;
          if (k === "width" || k === "height") m[k] = Math.max(0, Math.round(Number(value) || 0));
          else if (k === "duration") {
            const d = Number(value);
            if (Number.isFinite(d) && d > 0) m.duration = d;
            else delete m.duration;
          } else m[k] = value;
        });
      });
      row.addEventListener("change", async (event) => {
        const input = event.target;
        if (input.dataset.k === "kind") {
          updatePatch((p) => {
            const m = (p.media ?? [])[index];
            if (m) m.kind = input.value;
          });
        }
        if (input.dataset.k === "file") {
          const file = input.files?.[0];
          if (!file) return;
          if (file.size > MAX_IMAGE_BYTES) {
            toast?.(`${file.name} is larger than 4 MB`, "error");
            return;
          }
          const b64 = await fileToBase64(file);
          const size = await imageSize(file);
          updatePatch(
            (p) => {
              const m = (p.media ?? [])[index];
              if (!m) return;
              m.data = b64;
              if (!m.width) m.width = size.width;
              if (!m.height) m.height = size.height;
            },
            { rebuildMedia: false },
          );
          syncMediaValues();
        }
      });
      row.querySelector('[data-act="remove"]').addEventListener("click", () => {
        updatePatch((p) => {
          (p.media ?? []).splice(index, 1);
        }, { rebuildMedia: true });
      });
      els.mList.append(row);
    });
    syncMediaValues();
  }

  function syncMediaValues() {
    const media = store.state.patch?.media ?? [];
    $$(".media-row", els.mList).forEach((row, index) => {
      const m = media[index];
      if (!m) return;
      const get = (k) => row.querySelector(`[data-k="${k}"]`);
      const setVal = (node, value) => {
        if (node && document.activeElement !== node) node.value = value ?? "";
      };
      setVal(get("kind"), m.kind ?? "image");
      setVal(get("width"), m.width ?? "");
      setVal(get("height"), m.height ?? "");
      setVal(get("alt"), m.alt ?? "");
      setVal(get("duration"), m.duration ?? "");
      const thumb = get("thumb");
      if (thumb) {
        if (m.data) {
          thumb.src = dataUrl(m.data);
          thumb.hidden = false;
        } else {
          thumb.hidden = true;
          thumb.removeAttribute("src");
        }
      }
    });
  }

  // -------------------------------------------------------------------- sync
  function syncHighlightScroll() {
    if (!els.hlInner) return;
    els.hlInner.style.transform = `translate(${-els.input.scrollLeft}px, ${-els.input.scrollTop}px)`;
  }

  function setHighlight(html) {
    if (!els.hlInner) return;
    els.hlInner.innerHTML = html;
    syncHighlightScroll();
  }

  function setVal(selector, value) {
    const node = $(selector);
    if (!node) return;
    if (document.activeElement === node) return;
    node.value = value ?? "";
  }

  function syncOptions() {
    const { options } = store.state;
    for (const btn of $$("button[data-v]", els.surface)) btn.classList.toggle("on", btn.dataset.v === options.surface);
    for (const btn of $$("button[data-v]", els.theme)) btn.classList.toggle("on", btn.dataset.v === options.theme);
    for (const btn of $$("button[data-v]", els.dpr)) btn.classList.toggle("on", Number(btn.dataset.v) === options.dpr);
    for (const btn of $$("button[data-w]", els.widthPresets)) {
      btn.classList.toggle("on", Number(btn.dataset.w) === Math.round(options.width));
    }
    const device = $("#device");
    if (device) {
      const id = deviceFor(options.width, options.dpr);
      const custom = device.querySelector('option[value=""]');
      if (custom) custom.textContent = `custom · ${Math.round(options.width)} @${options.dpr}x`;
      if (id) device.value = id;
      else device.value = "";
      // A custom pair has no option of its own; say so in the label.
      device.dataset.custom = id ? "" : "1";
    }
    if (document.activeElement !== els.width) els.width.value = String(Math.round(options.width));
    els.widthVal.textContent = String(Math.round(options.width));
    if (document.activeElement !== els.fontScale) els.fontScale.value = String(options.fontScale);
    els.fontScaleVal.textContent = "×" + Number(options.fontScale).toFixed(2);
  }

  /** Drawer values come from the effective post; focus is never stolen. */
  function sync(resolvedPost, ctx = {}) {
    const post = resolvedPost ?? currentPost;
    currentPost = post;
    const patch = store.state.patch ?? {};

    const group = (name) => $(`.group[data-group="${name}"]`);
    const on = (name) => {
      const g = group(name);
      const box = $("input[type=checkbox]", g);
      const has = SECTION_KEYS[name].some((k) => k in patch);
      g.classList.toggle("on", has);
      if (document.activeElement !== box) box.checked = has;
      return has;
    };

    on("author");
    setVal("#aName", post.author?.name);
    setVal("#aHandle", post.author?.handle);
    setVal("#aVerified", post.author?.verified ?? "none");
    setVal("#aSquare", post.author?.squareAvatar);
    setVal("#aProtected", post.author?.protected);
    setVal("#aAffName", post.author?.affiliate?.name);
    $("#aSquare").checked = !!post.author?.squareAvatar;
    $("#aProtected").checked = !!post.author?.protected;

    on("counts");
    setVal("#cReplies", post.counts?.replies ?? "");
    setVal("#cReposts", post.counts?.reposts ?? "");
    setVal("#cLikes", post.counts?.likes ?? "");
    setVal("#cViews", post.counts?.views ?? "");
    setVal("#cBookmarks", post.counts?.bookmarks ?? "");

    on("createdAt");
    setVal("#tCreated", post.createdAt ? isoToLocalInput(post.createdAt) : "");
    setVal("#tNow", post.now ?? "");
    // The shared clock is always visible: it is what every target renders the
    // post at, so the two never disagree about "Now" versus a date.
    const at = post.createdAt ?? store.state.clock?.at ?? null;
    const clockValue = $("#clockValue");
    if (clockValue) {
      const when = at ? new Date(at) : null;
      clockValue.textContent = when && !Number.isNaN(when.getTime())
        ? when.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
          })
        : "—";
      clockValue.title = at ? `${at}${ctx.kind === "url" ? "\nfrom the resolved payload" : ""}` : "no post time";
    }
    const clockOverride = "createdAt" in patch;
    $("#clockRow").classList.toggle("dim", clockOverride);
    $("#clockFreeze").disabled = clockOverride;
    $("#clockNow").disabled = clockOverride;
    $("#clockFreeze").checked = !!store.state.clock?.freeze;
    const zone = store.state.clock?.zone ?? LOCAL;
    if (document.activeElement !== zoneSelect) zoneSelect.value = zone;
    zoneSelect.disabled = clockOverride;
    $("#clockZoneRow").classList.toggle("dim", clockOverride);
    $("#clockZoneRow").title = clockOverride
      ? "an explicit timestamp override is set, so its own offset is sent"
      : `times are rewritten into ${zone === LOCAL ? zoneLabel(LOCAL) : zoneLabel(zone)} before any target sees them`;
    $("#resolveLinks").checked = store.state.links?.resolve !== false;
    $("#realImages").checked = !!store.state.links?.media;

    on("media");
    renderMedia();
    const problem = mediaProblem(patch.media);
    const mGroup = group("media");
    let warn = mGroup.querySelector(".media-warn");
    if (problem && "media" in patch) {
      if (!warn) {
        warn = document.createElement("div");
        warn.className = "media-warn resolve-error";
        mGroup.querySelector(".fields").prepend(warn);
      }
      warn.textContent = problem;
    } else warn?.remove();

    const linkOn = on("links");
    // Prefer a URL that is actually in the text: an override for a URL that was
    // edited away cannot render, and showing it would be a lie.
    const textUrls = new Set(urlsInText(post.text ?? ""));
    const pickKey = (map) =>
      Object.keys(map ?? {}).find((url) => textUrls.has(url)) ?? Object.keys(map ?? {})[0];
    const linkKey = linkOn ? pickKey(patch.links) : pickKey(post.links);
    const meta = linkKey ? post.links?.[linkKey] : null;
    const reset = $("#lReset");
    if (reset) {
      const overridden = !!(linkOn && linkKey && patch.links && linkKey in patch.links);
      reset.disabled = !overridden;
      reset.title = overridden
        ? "drop the edits for this URL and use the resolved card again"
        : "no edits to reset: this card is what the resolver returned";
    }
    setVal("#lUrl", linkKey ?? "");
    setVal("#lCard", meta?.card ?? "");
    setVal("#lTitle", meta?.title ?? "");
    setVal("#lDesc", meta?.description ?? "");
    setVal("#lDomain", meta?.domain ?? "");
    setVal("#lDisplay", meta?.display ?? "");
    setVal("#lImageW", meta?.image?.width || "");
    setVal("#lImageH", meta?.image?.height || "");
    const urlList = $("#linkUrls");
    if (urlList) {
      urlList.innerHTML = urlsInText(post.text ?? "")
        .map((u) => `<option value="${u.replace(/"/g, "&quot;")}">`)
        .join("");
    }

    const quoteOn = on("quote");
    const quoteReset = $("#qReset");
    if (quoteReset) {
      const resolved = !!ctx.base?.quote;
      const overridden = quoteOn && "quote" in patch;
      quoteReset.disabled = !(overridden && resolved);
      quoteReset.title = !resolved
        ? "no quote was resolved for this text"
        : overridden
          ? "drop the edits and use the resolved quote again"
          : "this is the resolved quote; nothing to reset";
    }
    setVal("#qText", post.quote?.text ?? "");
    setVal("#qName", post.quote?.author?.name ?? "");
    setVal("#qHandle", post.quote?.author?.handle ?? "");
    setVal("#qVerified", post.quote?.author?.verified ?? "none");

    on("poll");
    setVal("#pChoices", (post.poll?.choices ?? []).join("\n"));
    setVal("#pVotes", (post.poll?.votes ?? []).join(", "));
    setVal("#pLeft", post.poll?.secondsLeft ?? "");

    on("advanced");
    setVal("#xCardState", post.cardState === "dismissed" ? "dismissed" : "auto");
    setVal("#xSocial", post.socialContext ?? "");
    setVal("#xLongPost", post.longPost === true ? "true" : post.longPost === false ? "false" : "");
    setVal("#xReplyTo", post.replyTo ?? "");
    setVal("#xReplyHandle", post.replyToHandle ?? "");
    setVal("#xMediaTags", (post.mediaTags ?? []).join(", "));
    setVal("#xAppVersion", post.appVersion ?? "");

    if (document.activeElement !== els.input && els.input.value !== store.state.input) {
      els.input.value = store.state.input;
    }
    autoGrowInput();
    syncOptions();
    if (store.state.ui.drawer && !els.drawer.open) els.drawer.open = true;
  }

  // A datalist for the card URL, filled from the text.
  const datalist = document.createElement("datalist");
  datalist.id = "linkUrls";
  document.body.append(datalist);
  $("#lUrl").setAttribute("list", "linkUrls");

  // <dialog> fires close; <details> fired toggle. Both keep the state honest.
  for (const type of ["close", "toggle"]) {
    els.drawer.addEventListener(type, () => {
      store.set((s) => {
        s.ui.drawer = els.drawer.open;
      });
    });
  }

  return { sync, setHighlight, syncHighlightScroll };
}
