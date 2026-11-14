// The serverless routes on this origin. Every call is defensive: the site is
// usable from a static checkout (no functions) and from the deployed origin,
// and a missing route degrades to the WASM path instead of an empty page.

import { base64ToBytes } from "./util.js";

export class ApiError extends Error {
  constructor(message, { code = "request_failed", status = 0, fields = [] } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

const JSON_HEADERS = { "content-type": "application/json", accept: "application/json" };

async function request(path, { method = "GET", body, signal, timeout = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), timeout);
  const relay = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", relay, { once: true });
  try {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? { accept: "application/json" } : JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: "same-origin",
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!response.ok) {
      const error = data?.error ?? data ?? {};
      throw new ApiError(error.message ?? `xeet: ${response.status} ${response.statusText}`, {
        code: error.code ?? "request_failed",
        status: response.status,
        fields: error.fields ?? [],
      });
    }
    if (!data) throw new ApiError("xeet: the server sent something that is not JSON");
    return data;
  } catch (error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      throw new ApiError("xeet: the request timed out", { code: "timeout", status: 504 });
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(error?.message ?? "xeet: the request failed", { code: "network", status: 0 });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

/** Try the public path, then the playground's `/api/*` spelling. */
async function firstRoute(paths, options) {
  let last = null;
  for (const path of paths) {
    try {
      return await request(path, options);
    } catch (error) {
      last = error;
      if (error.status !== 404 && error.status !== 405) throw error;
    }
  }
  throw last ?? new ApiError("xeet: no route answered", { status: 404 });
}

function resolveEnvelope(data, input) {
  const nested = data?.result ?? data?.resolved ?? data?.data ?? null;
  const post = data?.post ?? nested?.post ?? (data && typeof data === "object" && "text" in data ? data : null);
  const links = data?.links ?? nested?.links ?? post?.links ?? {};
  return {
    kind: data?.kind ?? (String(input).trim().startsWith("{") ? "json" : "text"),
    post,
    links,
    warnings: [...(data?.warnings ?? []), ...(nested?.warnings ?? [])],
    ms: Number(data?.ms ?? nested?.ms ?? 0) || 0,
    source: data?.source ?? nested?.source ?? null,
    raw: data,
  };
}

/** Text | x.com URL | Post JSON → a complete Post (internal playground CORS proxy). */
export async function resolveInput(input, { media = true, width = 390, dpr = 2, signal } = {}) {
  const data = await firstRoute(["/_playground/resolve", "/api/resolve"], {
    method: "POST",
    body: { input, media, width, dpr },
    signal,
    timeout: 9_000,
  });
  return resolveEnvelope(data, input);
}

function linksFrom(data) {
  if (!data || typeof data !== "object") return {};
  if (data.links && typeof data.links === "object") return data.links;
  if (Array.isArray(data.results)) {
    return Object.fromEntries(
      data.results
        .map((row) => [row?.url ?? row?.input, row?.meta ?? row?.info?.meta ?? row])
        .filter(([url, meta]) => url && meta && typeof meta === "object"),
    );
  }
  if (data.meta && data.url) return { [data.url]: data.meta };
  return {};
}

/** t.co → Twitterbot redirect chain → Open Graph / `twitter:*` metadata. */
export async function resolveLinks(urls, { media = true, signal } = {}) {
  const list = [...new Set([].concat(urls).filter(Boolean))];
  if (!list.length) return { links: {}, notes: [] };
  const data = await firstRoute(["/_playground/resolve-links", "/api/resolve-links"], {
    method: "POST",
    body: { urls: list, media },
    signal,
    timeout: 9_000,
  });
  return { links: linksFrom(data), notes: data?.notes ?? [], raw: data };
}
