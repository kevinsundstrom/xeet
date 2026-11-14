// Small, dependency-free helpers the page uses everywhere.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** An element with attributes and children, for the bits built at runtime. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "dataset" && value && typeof value === "object") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function debounce(fn, ms) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms >= 100) return `${Math.round(ms)} ms`;
  return `${Math.round(ms * 10) / 10} ms`;
}

export function dataUrl(base64) {
  return base64 ? `data:image/png;base64,${base64}` : "";
}

export function shortUrl(url, max = 44) {
  const text = String(url ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function flash(button, text = "Copied", ms = 1200) {
  const original = button.dataset.label ?? button.textContent;
  button.dataset.label = original;
  button.textContent = text;
  button.classList.add("done");
  clearTimeout(button._flash);
  button._flash = setTimeout(() => {
    button.textContent = original;
    button.classList.remove("done");
  }, ms);
}

/** PNG dimensions straight from the IHDR, so the caption never guesses. */
export function pngSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x89504e47) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function bytesToBase64(bytes) {
  // Baseline in current browsers and Node: the engine's own encoder, which is
  // an order of magnitude faster than anything a loop here could do.
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  // Otherwise one call per 32 kB chunk into an array, then a single join: no
  // spread (an argument list per chunk is slower and can overflow the stack)
  // and no `+=` (a rope of a thousand pieces is worse to flatten than to build).
  const chunks = [];
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
  }
  return btoa(chunks.join(""));
}

export function base64ToBytes(base64) {
  const clean = String(base64 ?? "").replace(/^data:image\/png;base64,/, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function download(bytes, filename) {
  const blob = new Blob([bytes], { type: "image/png" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function errorMessage(error) {
  if (!error) return "something went wrong";
  if (error.name === "AbortError" || error.name === "TimeoutError") return "the request timed out";
  return error.message ?? String(error);
}
