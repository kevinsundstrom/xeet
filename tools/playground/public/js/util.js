// Small DOM and value helpers. No framework, no build step.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Makes an element. Children may be nodes or strings. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    timer = null;
    fn(...args);
  };
  return wrapped;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The paint time of a render: `ms.paint`, else `ms.render`, else `ms.total`. */
export function paintMsOf(data) {
  const ms = data?.ms ?? {};
  for (const key of ["paint", "render", "total"]) {
    if (Number.isFinite(ms[key])) return ms[key];
  }
  return Number.isFinite(data?.wall) ? data.wall : 0;
}

export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 10) return ms.toFixed(1);
  if (ms < 1000) return String(Math.round(ms));
  return (ms / 1000).toFixed(2) + "s";
}

export const nowIso = () => new Date().toISOString();

/** ISO → the value a datetime-local input wants, in local time. */
export function isoToLocalInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** datetime-local value (local time) → ISO 8601 in the same local offset. */
export function localInputToIso(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  // Keep the wall clock the user picked: "…-08:00", not the same instant in Z,
  // or the renderer would print a different time than the field shows.
  const pad = (n, width = 2) => String(Math.abs(Math.trunc(n))).padStart(width, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${sign}${pad(abs / 60)}:${pad(abs % 60)}`
  );
}

/** base64 (no data-URL prefix) for a File. */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// UTF-8 safe base64url for the URL hash.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeHashValue(value) {
  const bytes = encoder.encode(JSON.stringify(value));
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeHashValue(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(decoder.decode(bytes));
}

/** Runs `fn` after the browser has painted, so typing never waits for a render. */
export function nextPaint(fn) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => setTimeout(fn, 0));
  } else {
    setTimeout(fn, 0);
  }
}

export function deepClone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/** Stable JSON: object keys sorted, so cache keys do not depend on insert order. */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.filter((k) => value[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

export function shortRev(rev) {
  if (!rev) return null;
  return String(rev).slice(0, 7);
}
