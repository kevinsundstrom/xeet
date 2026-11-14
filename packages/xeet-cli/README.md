# `@xeet/cli`

Render X (Twitter) posts to Retina PNG from the command line — no headless browser, no system fonts to install.

**[xeet.vercel.dev](https://xeet.vercel.dev)** · **[GitHub](https://github.com/vercel-labs/xeet)**

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

## License

Apache-2.0 — see [`LICENSE`](../../LICENSE).
