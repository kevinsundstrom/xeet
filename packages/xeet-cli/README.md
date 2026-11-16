# `@xeet/cli`

Render X (Twitter) posts to Retina PNG from the command line — no headless browser, no system fonts to install.

**[xeet-rs.vercel.app](https://xeet-rs.vercel.app)** · **[GitHub](https://github.com/rauchg/xeet)**

## Install

```sh
npm i -g @xeet/cli
```

## Usage

```sh
# Resolve a live x.com URL and pipe directly into the renderer
xeet resolve "https://x.com/jack/status/20" --media | xeet render - -o post.png

# Render for iOS timeline (iPhone Duo 382pt @3x) or dark mode
xeet render post.json --surface ios-timeline --width 382 --dpr 3 --theme dark -o duo.png

# Expand a truncated "Show more" post
xeet render post.json --surface web-timeline --expanded -o expanded.png

# Inspect layout boxes & X rule decisions as JSON without rasterizing
xeet explain post.json --surface web-timeline --width 390

# Render a side-by-side contact sheet across widths & themes
xeet sheet post.json -o sheet.png
```

## Outputs & Exit Codes ([`commands/mod.rs`](https://github.com/rauchg/xeet/blob/main/crates/xeet-cli/src/commands/mod.rs#L11))

- `xeet render` / `xeet sheet` → writes PNG bytes to `-o <path>` (or stdout with `-o -`)
- `xeet explain` → writes [`Report`](https://github.com/rauchg/xeet/blob/main/crates/xeet-core/src/model.rs#L275) JSON (`{ ruleset, verifiedFor, size: { width, height }, length, text, entities, hidden, attachment, warnings }`) to stdout
- `xeet resolve` → writes [`Resolved`](https://github.com/rauchg/xeet/blob/main/crates/xeet-resolve/src/lib.rs#L322) JSON (`{ post, links, media, source, warnings }`, accepted directly by `xeet render -`) to stdout
- Exit codes: `0` success, `2` bad usage, `3` invalid input or over limit, `4` render failure, `5` file/network I/O error

## License

Apache-2.0 — see [`LICENSE`](../../LICENSE).
