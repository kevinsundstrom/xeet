# `@xeet/core`

Render X (Twitter) posts to Retina PNG without a browser — X's own layout, fonts, emoji, fallback shaping, and line-breaking rules rebuilt in safe Rust and compiled to WebAssembly.

**[xeet-rs.vercel.app](https://xeet-rs.vercel.app)** · **[GitHub](https://github.com/rauchg/xeet)**

## Install

```sh
npm i @xeet/core
```

## Node.js / Bun / Deno

```ts
import { writeFileSync } from "node:fs";
import { loadXeet } from "@xeet/core/node";

const xeet = await loadXeet();

// Resolve a live x.com URL (follows t.co links, cards, and media)
const { post } = await xeet.resolve("https://x.com/jack/status/20", { media: true });

// Render to PNG + structured layout report (synchronous, zero network I/O)
const { png, report } = xeet.render(post, {
  surface: "web-timeline", // "web-timeline" | "web-detail" | "ios-timeline" | "ios-detail"
  width: 390,
  theme: "dark",
  dpr: 2,
});

writeFileSync("post.png", png);
console.log(report.size);
```

## Browser / Edge WebAssembly

```ts
import { bind, createFontPacks } from "@xeet/core";
import init, * as wasm from "./wasm/xeet_wasm.js";

await init("./wasm/xeet_wasm_bg.wasm");
const packs = createFontPacks({
  manifest: await fetch("./wasm/fonts/packs.json").then((r) => r.json()),
  read: (name) => fetch(`./wasm/fonts/${name}`).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
});
const post = {
  text: "Ship fast, render faster.",
  author: { name: "Vercel", handle: "vercel", verified: "business", squareAvatar: true },
};
await packs.ensureFonts(wasm, { post });
const xeet = bind(wasm);

const { png, report } = xeet.render(post, { surface: "ios-timeline", width: 382, theme: "dark", dpr: 3 });
```

## Exports

| Export | Description |
|---|---|
| `@xeet/core` | `bind(wasm)`, `createFontPacks(...)`, `whatwgHost(...)`, `XeetError`, `LIMITS`, `POST_SCHEMA` |
| `@xeet/core/node` | `loadXeet()`, `loadXeetSync()` — loads the bundled WASM core and lazy font packs in Node.js |
| `@xeet/core/resolve` | `whatwgHost({ fetch, lookup, cache })` — network adapter injected into `xeet.resolve()` and `xeet.resolveLinks()` |
| `@xeet/core/schemas` | JSON Schemas (`POST_SCHEMA`, `RENDER_OPTIONS_SCHEMA`) |
| `@xeet/core/limits` | Validation limits (`LIMITS`, e.g. `media: 20`, `width: [100, 1200]`, `dpr: [1, 4]`) |
| `@xeet/core/mcp` | Model Context Protocol tool definitions (`TOOLS`) |

### Instance methods (`loadXeet()` / `bind()`)

- `render(post, options?)` → `{ png: Uint8Array, report: Report }`
- `renderPng(post, options?)` → `Uint8Array`
- `renderMany(post, optionsList)` → `Array<{ png: Uint8Array, report: Report, paint: number }>`
- `explain(post, options?)` → `Report` (layout & rule decisions only, no rasterization)
- `hasShowMore(post, options?)` → `boolean` (pass `{ expanded: true }` to `render` to expand `"Show more"`)
- `sheet({ post, widths?, themes?, dpr? })` → `Uint8Array`
- `resolve(input, options?, host?)` → `Promise<Resolved>`
- `resolveLinks(url, options?, host?)` → `Promise<unknown>`

## License

Apache-2.0 — see [`LICENSE`](../../LICENSE).
