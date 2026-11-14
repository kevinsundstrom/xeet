// Shared Chrome launcher for the oracle. Development only.
//
// Every page is rendered hermetically: requests for X's stylesheet and fonts
// are answered from assets/vendor/, X's scripts are blocked (so the
// server-rendered markup is laid out exactly as delivered, with no hydration),
// and everything else is aborted unless `allowImages` is set.
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VENDOR = join(ROOT, "assets", "vendor");

function findChromium() {
  if (process.env.XEET_CHROME) return process.env.XEET_CHROME;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  const linuxCache = join(homedir(), ".cache", "ms-playwright");
  for (const base of [cache, linuxCache]) {
    if (!existsSync(base)) continue;
    const dirs = readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const d of dirs) {
      for (const rel of ["chrome-mac/headless_shell", "chrome-linux/headless_shell"]) {
        const p = join(base, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined; // let Playwright resolve its own
}

/** The most recently built `xeet` binary, or $XEET_BIN. */
export function xeetBinary() {
  if (process.env.XEET_BIN) return process.env.XEET_BIN;
  let best = null;
  for (const profile of ["fast", "release", "debug"]) {
    const p = join(ROOT, "target", profile, "xeet");
    if (!existsSync(p)) continue;
    const mtime = statSync(p).mtimeMs;
    if (!best || mtime > best.mtime) best = { p, mtime };
  }
  if (!best) throw new Error("no xeet binary found; run `cargo build --profile fast -p xeet-cli`");
  return best.p;
}

// A 1x1 transparent PNG, used when images are stubbed.
const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

export async function launch() {
  // Hinting off and LCD text off: the reference is fractional glyph positions
  // with grayscale anti-aliasing, as on phones and macOS.
  return chromium.launch({
    executablePath: findChromium(),
    args: ["--font-render-hinting=none", "--disable-lcd-text", "--disable-font-subpixel-positioning=false"],
  });
}

export async function newPage(browser, { width = 600, height = 900, dpr = 2, theme = "light", allowImages = false, images = {} } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    colorScheme: theme === "dark" ? "dark" : "light",
    locale: "en-US",
    timezoneId: "UTC",
  });
  const page = await context.newPage();
  const lock = JSON.parse(await readFile(join(ROOT, "assets", "upstream.lock.json"), "utf8"));
  const fontByUrl = new Map(lock.fonts.map((f) => [f.url, f.file.replace(/\.ttf$/, ".woff2")]));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();
    if (url.startsWith("https://x.com/") && type === "document") return route.fallback();
    // xeet's own bundled fallback fonts, for hermetic comparisons.
    if (url.startsWith("https://x.com/__xeet/fonts/")) {
      const file = decodeURIComponent(url.slice("https://x.com/__xeet/fonts/".length));
      if (/^[\w.-]+$/.test(file) && existsSync(join(VENDOR, "fonts", file))) {
        return route.fulfill({ contentType: "font/ttf", body: await readFile(join(VENDOR, "fonts", file)) });
      }
      return route.abort();
    }
    if (/\/styles-[^/]+\.css$/.test(url)) {
      return route.fulfill({ contentType: "text/css", body: await readFile(join(VENDOR, "upstream", "styles.css")) });
    }
    if (fontByUrl.has(url)) {
      return route.fulfill({
        contentType: "font/woff2",
        headers: { "access-control-allow-origin": "*" },
        body: await readFile(join(VENDOR, "fonts", fontByUrl.get(url))),
      });
    }
    if (images[url]) return route.fulfill({ contentType: images[url].type, body: images[url].body });
    if (type === "image") {
      if (allowImages) return route.continue();
      return route.fulfill({ contentType: "image/png", body: BLANK_PNG });
    }
    return route.abort();
  });
  return { context, page };
}

/**
 * CSS that makes Chrome fall back to exactly the files xeet embeds instead of
 * this machine's system fonts. Apply with the class `xeet-fallback`.
 *
 * The order and the ranges mirror `fonts::FontDb::select_with`: TwitterChirp,
 * then the fallback faces in manifest order — Arial first, then the emoji
 * font, then the open stand-ins — each limited to its manifest unicode-range.
 * The platform UI fonts (-apple-system, Helvetica) are left out: they cannot
 * be bundled, and the ranges already say which characters Chrome reaches the
 * shared families for.
 *
 * Emoji stay on the system emoji font, whose advances xeet models, but the
 * manifest's emoji face is registered against `local("Apple Color Emoji")`
 * so the same unicode-range scopes it: characters Chrome on Apple draws as
 * text ("★", "✈", "☺") must not come from the emoji font here either.
 */
export async function bundledFallbackCss() {
  const manifest = JSON.parse(await readFile(join(VENDOR, "fonts", "manifest.json"), "utf8"));
  const extra = manifest.filter((f) => f.kind === "fallback" || f.kind === "emoji");
  const faces = extra
    .map((f) => {
      const family = f.kind === "emoji" ? "xeet emoji" : `xeet ${f.family}`;
      const src = f.kind === "emoji" ? 'local("Apple Color Emoji")' : `url("/__xeet/fonts/${f.file}")`;
      return `@font-face{font-family:"${family}";font-weight:${f.weight};src:${src};unicode-range:${f.unicodeRange ?? "U+0-10FFFF"}}`;
    })
    .join("\n");
  // Arial is first, then the emoji face, then the rest, as in the engine. The
  // weight variants of one family collapse to one entry: the browser picks.
  const order = [];
  for (const f of extra) {
    const family = f.kind === "emoji" ? "xeet emoji" : `xeet ${f.family}`;
    if (!order.includes(family)) order.push(family);
  }
  const families = order.map((f) => `"${f}"`).join(",");
  return `${faces}\n.xeet-fallback{font-family:TwitterChirp,${families},sans-serif!important}`;
}

/** Serves `html` as if it were https://x.com<path>, so relative URLs and CORS behave as on the real site. */
export async function setContentAs(page, html, path = "/i/xeet-oracle") {
  await page.route(`https://x.com${path}`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  await page.goto(`https://x.com${path}`, { waitUntil: "load" });
  // Fallback web fonts are only requested once layout needs them, so force
  // a layout first; otherwise `fonts.ready` can resolve before they load.
  // Loading every declared face up front (they are all served locally) is
  // the only reliable way; text is relaid out once they arrive.
  await page.evaluate(async () => {
    void document.body.offsetHeight;
    await Promise.all([...document.fonts].map((f) => f.load().catch(() => null)));
    await document.fonts.ready;
    void document.body.offsetHeight;
  });
}
