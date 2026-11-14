// The server API (docs/PLAYGROUND.md), plus the mock used before pg-server's
// routes exist. Everything here is promise based and abortable; the renderer
// supersedes requests rather than queueing them.

export class ApiError extends Error {
  constructor(body, status = 0) {
    const e = body?.error ?? body ?? {};
    super(typeof e === "string" ? e : e.message ?? "the request failed");
    this.name = "ApiError";
    this.code = typeof e === "object" ? e.code ?? "request_failed" : "request_failed";
    this.status = status || e.status || 0;
    this.fields = typeof e === "object" ? e.fields ?? [] : [];
  }
}

function parseErrorBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: "bad_response", message: text.slice(0, 400) } };
  }
}

async function request(path, { method = "GET", body, signal } = {}) {
  const res = await fetch(path, {
    method,
    signal,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  const parsed = text ? parseErrorBody(text) : {};
  if (!res.ok) throw new ApiError(parsed, res.status);
  if (parsed && parsed.error) throw new ApiError(parsed, res.status);
  return parsed;
}

// The server supersedes requests per client+target. Two tabs (or a tab and a
// script) sharing one client id would knock each other's renders out, so every
// page session names itself.
const CLIENT = (() => {
  try {
    const key = "xeet.playground.client";
    let id = sessionStorage.getItem(key);
    if (!id) {
      id =
        typeof crypto?.randomUUID === "function"
          ? crypto.randomUUID().slice(0, 12)
          : Math.random().toString(36).slice(2, 14);
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    return "ui";
  }
})();

const real = {
  async targets(signal) {
    const body = await request("/api/targets", { signal });
    return body.targets ?? [];
  },
  async resolve(input, signal, options = {}) {
    const body = { input };
    // `media: true` asks the resolver to fetch card images, not just tags.
    // Explicit either way: the server inlines images by default.
    if (typeof options.media === "boolean") body.media = options.media;
    // The render options the caller will draw with, when it knows them: the
    // resolver then fetches the image variants that render needs, instead of
    // the 390/2 default followed by a second fetch at render time. The server
    // reads them from `body.options` (its `resolveInput`), and a caller that
    // omits them gets the defaults.
    const width = Number(options.width);
    const dpr = Number(options.dpr);
    if (Number.isFinite(width) && Number.isFinite(dpr) && width > 0 && dpr > 0) {
      body.options = { width, dpr };
    }
    return request("/api/resolve", { method: "POST", body, signal });
  },
  async render(body, signal) {
    return request("/api/render", { method: "POST", body: { ...body, client: CLIENT }, signal });
  },
  async build(target) {
    return request("/api/build", { method: "POST", body: { target } });
  },
  events(onTargets) {
    if (typeof EventSource !== "function") return () => {};
    const source = new EventSource("/events");
    // Fires on the first connection and on every reconnect, which is how the
    // page notices that the server came up after a cold start.
    source.onopen = () => onTargets({ type: "targets", reason: "open" });
    source.onmessage = (event) => {
      let data = null;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data?.type === "targets") onTargets(data);
    };
    return () => source.close();
  },
};

/**
 * @param {{ mock?: boolean }} options
 */
export async function createApi({ mock = false } = {}) {
  const impl = mock ? await (await import("../dev/mock.js")).createMock() : real;
  return { ...impl, mock };
}
