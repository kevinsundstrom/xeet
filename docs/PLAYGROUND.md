# Playground

Paste a post, see it rendered in real time by every xeet target next to the
truth, and see exactly where they differ.

```
node tools/playground/server.mjs        → http://127.0.0.1:4177
```

Development only. Binds to localhost. Nothing here ships.

## What is on screen

```
┌ input ───────────────────────────────┐ ┌ controls ──────────────────────────────┐
│ paste text, an x.com URL or Post JSON│ │ surface · theme · width · dpr · author │
└──────────────────────────────────────┘ │ media · link card · quote · poll       │
                                          └────────────────────────────────────────┘
┌ Chrome (truth) ┐ ┌ WASM ┐ ┌ native ┐ ┌ HTTP fn ┐        one column per target
│      png       │ │ png  │ │  png   │ │  png    │        each: image, timing, version,
│  ms · version  │ │ ...  │ │  ...   │ │  ...    │        Δ vs Chrome (% px, height)
└────────────────┘ └──────┘ └────────┘ └─────────┘
┌ diff: pick A vs B → overlay / flicker / heatmap / side by side, box outlines ┐
┌ report: explain JSON (length, show more, attachment, hidden, warnings) ┐
```

## Targets

| id | what runs | where | latency goal |
|---|---|---|---|
| `wasm` | `packages/xeet/wasm/web` (wasm-bindgen web build) | the browser, every keystroke | < 10 ms |
| `native` | `xeet-render serve --stdio`, one long-lived process per binary | server | < 15 ms round trip |
| `http` | `tools/playground/lib/http.mjs`: the Node WASM build (`packages/xeet/src/node.js`) called in-process, as the deployed function calls it | server | < 30 ms |
| `chrome` | ground truth: X's real markup, stylesheet and fonts in a warm headless Chrome (`tools/oracle/browser.mjs`, hermetic) | server | < 300 ms, debounced |

`chrome` has two modes: **replica** (any post: X's captured cell and attachment
markup with the post's data injected, as `tools/oracle/replica.mjs` and
`tools/oracle/cards-*.mjs` do) and **page** (a pasted x.com URL: the captured
page itself, that article measured and screenshotted, as `tools/ship/e2e.mjs`
does). Page mode is the stronger truth; replica mode is what drafts get.

Every target reports **what version it is**: git revision and dirty flag it
was built from, build time, `ruleset` id, upstream app version, and whether it
is **stale** (source newer than the build). Stale targets offer a rebuild.

## HTTP API (the local dev server)

All JSON. Errors: `{ error: { code, message, fields? } }` with a 4xx/5xx status.
These routes exist only in `tools/playground/server.mjs`; nothing here is
deployed, and there is no public render endpoint. The web demo's only deployed
function is `api/playground-resolve.mjs`, which serves `/_playground/resolve`
and `/_playground/resolve-links` (resolve, not render).

```
GET  /api/targets
  → { targets: [{ id, label, available, version: { rev, dirty, builtAt, ruleset, upstream },
                  stale, building, error? }] }

POST /api/build { target: "native" | "wasm" | "http" }
  → { ok, ms, log }                      // rebuild a stale target

POST /api/resolve { input: string }
  → { kind: "text" | "json" | "url", post: Post, options?: RenderOptions,
      source?: { url, id, capturedAt, page: string } }
  // text → { text: input }; JSON → validated Post (strict, with "did you mean");
  // URL → fetched logged out (throttled ≥1 s, cached under assets/vendor/playground/),
  //       converted with tools/ship/corpus-post.mjs; `source.page` keys page mode.

POST /api/render { target: "native" | "http" | "chrome", post, options, mode?: "replica" | "page", source? }
  → { target, png: "<base64>", width, height, dpr,
      report?: Report, geometry?: { lines, boxes }, ms: { total, render, encode? },
      version: {...}, error? }

GET  /wasm/*      → packages/xeet/wasm/web (served with the right MIME types)
GET  /wasm/fonts/* → packages/xeet/wasm/fonts (the lazy packs)
GET  /events      → server-sent events: { type: "targets" } when a build finishes or
                    the tree changes (so the UI re-renders and refreshes badges)
```

`Post` and `RenderOptions` are `crates/xeet-core/src/model.rs` on the wire
(camelCase, strict). Images in the input are base64 as in the model.

Chrome-only option: `options.smoothing` = `"antialiased"` (default; the
platform-neutral reference every gate compares against) | `"platform"` (what a
Mac draws on x.com: CoreText thickens glyphs). The UI sends it to the chrome
target only. A post with no avatar bytes shows X's default profile picture
(`assets/vendor/default-avatar.png`) on every target.

Media: `/api/resolve` inlines real bytes by default (`media: false` opts out):
photos at the variant X's srcset picks for the cell × dpr, video/GIF poster
frames as `Media.data`, quoted media, avatars, badges and card images
(docs/MEDIA.md). Its `source.media` map is what Chrome's page mode serves for
the page's own image requests, so every column paints the same bytes. The
cache lives in git-ignored `assets/vendor/playground/media/` (LRU, 500 MB).

## Local development notes

- The user-facing commands (`render`, `explain`, `sheet`, `resolve`) live in
  `crates/xeet-cli/src/commands/`, shared with the `xeet-render` binary; native
  serving for the playground is `crates/xeet-cli/src/commands/serve.rs` plus the
  existing `xeet-render` binary.
- Build into `target/playground/` (its own `CARGO_TARGET_DIR`), never
  `target/{fast,release,debug}`, so a playground build cannot poison a release
  build.
- Develop on **4178** (`PORT=4178`): port 4177 may still be held by an older
  server.
- No framework, no bundler: plain ES modules, served as files. Keep it fast to
  start (`node tools/playground/server.mjs` and go).
