// Extracts xeet's design tokens from X's stylesheet.
//
//   node tools/extract-tokens.mjs [--css assets/vendor/upstream/styles.css] [--out assets/vendor/tokens.json]
//
// Development only: reads the vendored stylesheet (git-ignored, like the rest
// of assets/vendor) and writes `assets/vendor/tokens.json`, which
// `crates/xeet-core/build.rs` embeds and `src/tokens.rs` re-exports as typed
// constants. Nothing here ships, and nothing here is a general CSS engine: it
// resolves exactly the declarations the post frame uses and asserts that each
// one was found, so an upstream change breaks the sync instead of drifting.
//
// How it resolves:
//   - `:root,:host{...}`                       raw palette and units
//   - selectors containing `[data-theme=light]`  light theme variables
//   - selectors containing `[data-theme=dark]`   dark theme variables
//   - `var(--x-*)` chains are followed per theme
//   - `calc()` is evaluated with `--x-font-scale: 1` and `1rem = 16px`
//
// Lengths that multiply by `--x-font-scale` are marked `scales: true`; the Rust
// side multiplies them by `RenderOptions::font_scale` at layout time.

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "assets", "vendor");

// ------------------------------------------------------------ css parsing --

/** Splits a stylesheet into flat rules, unwrapping `@media`/`@supports`/`@layer`. */
export function parseCss(css, skip = ["font-face", "keyframes", "property", "charset", "import", "namespace"]) {
  const out = [];
  parseRange(css, 0, css.length, out, skip, []);
  return out;
}

function parseRange(css, from, to, out, skip, conditions) {
  let i = from;
  const skipTrivia = () => {
    for (;;) {
      while (i < to && /\s/.test(css[i])) i++;
      if (css.startsWith("/*", i)) {
        const end = css.indexOf("*/", i + 2);
        i = end < 0 ? to : end + 2;
        continue;
      }
      return;
    }
  };
  while (i < to) {
    skipTrivia();
    if (i >= to) break;
    if (css[i] === "}") {
      i++;
      continue;
    }
    // Read the prelude up to `{` or `;`, ignoring those inside strings/parens.
    const start = i;
    let depth = 0;
    let inString = null;
    let terminator = null;
    for (; i < to; i++) {
      const c = css[i];
      if (c === "\\") {
        i++; // an escaped character never opens or closes anything
        continue;
      }
      if (inString) {
        if (c === inString) inString = null;
        continue;
      }
      if (c === '"' || c === "'") inString = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (depth === 0 && c === "{") {
        terminator = "{";
        break;
      } else if (depth === 0 && c === ";") {
        terminator = ";";
        break;
      }
    }
    const prelude = css.slice(start, i).trim();
    if (terminator === ";") {
      i++;
      continue;
    }
    if (terminator !== "{") break;
    // Matching close brace for this block.
    const open = i;
    let braces = 1;
    inString = null;
    for (i = open + 1; i < to && braces > 0; i++) {
      const c = css[i];
      if (c === "\\") {
        i++;
        continue;
      }
      if (inString) {
        if (c === inString) inString = null;
        continue;
      }
      if (c === '"' || c === "'") inString = c;
      else if (c === "{") braces++;
      else if (c === "}") braces--;
    }
    const body = css.slice(open + 1, i - 1);
    if (prelude.startsWith("@")) {
      const name = prelude.slice(1).split(/[\s(]/)[0];
      if (!skip.includes(name)) parseRange(css, open + 1, i - 1, out, skip, [...conditions, prelude]);
    } else if (prelude) {
      out.push({
        selectors: prelude.split(",").map((x) => x.trim()).filter(Boolean),
        body,
        at: start,
        conditions,
      });
    }
  }
}

function declarations(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  let inString = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (c === inString && body[i - 1] !== "\\") inString = null;
      continue;
    }
    if (c === '"' || c === "'") inString = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  const map = new Map();
  for (const decl of out) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    const name = decl.slice(0, colon).trim();
    const value = decl.slice(colon + 1).trim().replace(/\s+/g, " ");
    if (name) map.set(name, value);
  }
  return map;
}

// --------------------------------------------------------------- resolving --

/** Evaluates the subset of `calc()` X's tokens use: + - * /, px, rem, numbers. */
function evalLength(expr) {
  const tokens = expr.match(/[-+]?(\d*\.?\d+)(px|rem|em)?|[()*/+-]/g);
  if (!tokens) throw new Error("cannot evaluate " + expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function factor() {
    const t = next();
    if (t === "(") {
      const v = additive();
      if (next() !== ")") throw new Error("unbalanced calc: " + expr);
      return v;
    }
    if (t === "-") return -factor();
    const m = /^(\d*\.?\d+)(px|rem|em)?$/.exec(t);
    if (!m) throw new Error(`unexpected ${t} in ${expr}`);
    const n = parseFloat(m[1]);
    if (m[2] === "rem" || m[2] === "em") return n * 16;
    return n;
  }
  function multiplicative() {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const rhs = factor();
      v = op === "*" ? v * rhs : v / rhs;
    }
    return v;
  }
  function additive() {
    let v = multiplicative();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const rhs = multiplicative();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  }
  const v = additive();
  if (pos !== tokens.length) throw new Error("trailing tokens in " + expr);
  return v;
}

// `@supports` conditions the pinned Chrome satisfies. Verified against the
// pinned release (see PLAN.md §3/§11); X adds conditions rarely, and an
// unknown one is recorded in the output instead of being applied blindly.
// The one that matters for layout is `(corner-shape: squircle)`: it is what
// turns `--x-radius-m` from 1 into 1.8 for the rounded-* utilities.
const SUPPORTED_FEATURES = [
  /corner-shape\s*:\s*squircle/,
  /color-mix\(in lab/,
  /linear-gradient\(in lab/,
  /justify-content\s*:\s*safe/,
  /clip-path\s*:\s*border-box/,
  // The Tailwind "properties" guard: matches because webkit-hyphens exists and
  // margin-trim does not (or the second branch for -moz-orient).
  /margin-trim/,
  /contain-intrinsic-size/,
  /-webkit-hyphens/,
  /-moz-orient/,
];
// `@media` blocks are skipped: the tokens are the unconditional cascade. No
// utility the frame uses is overridden inside a media query (checked by
// `--audit-media`), and breakpoints belong to the frame, not to the tokens.
/** Class names a selector list can match, e.g. `:is(.a,.b)` -> a, b. */
function classesOf(selectors) {
  const out = new Set();
  for (const sel of selectors) {
    for (const m of sel.matchAll(/\.((?:[A-Za-z0-9_-]|\\.)+)/g)) out.add(m[1].replace(/\\(.)/g, "$1"));
  }
  return out;
}

const NAMED = { white: "#ffffff", black: "#000000", transparent: "transparent", gray: "#808080" };

function hexOf(color) {
  const c = color.trim().toLowerCase();
  if (NAMED[c]) return NAMED[c];
  const m = /^#([0-9a-f]{3,8})$/.exec(c);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((x) => x + x).join("");
  if (h.length === 4) h = [...h].map((x) => x + x).join("");
  return "#" + h;
}

export class Sheet {
  constructor(css) {
    this.rules = parseCss(css);
    this.base = new Map();
    this.light = new Map();
    this.dark = new Map();
    this.utilities = new Map();
    // Class-scoped custom properties and `corner-shape` from feature queries
    // that apply (the squircle block sets `--x-radius-m: 1.8` on
    // `:is(.rounded-xs,…)`), plus a record of what was skipped.
    this.classVars = new Map();
    this.classCornerShape = new Map();
    this.appliedSupports = new Set();
    this.skippedSupports = new Set();
    this.skippedMedia = new Set();
    for (const rule of this.rules) {
      const conditions = rule.conditions ?? [];
      const media = conditions.find((c) => c.startsWith("@media"));
      if (media) {
        this.skippedMedia.add(media);
        continue;
      }
      const supports = conditions.filter((c) => c.startsWith("@supports"));
      const unsupported = supports.find((c) => !SUPPORTED_FEATURES.some((re) => re.test(c)));
      if (unsupported) {
        this.skippedSupports.add(unsupported);
        continue;
      }
      for (const c of supports) this.appliedSupports.add(c);
      const decls = declarations(rule.body);
      // Feature-query overrides that name classes apply to those classes only.
      if (supports.length) {
        for (const cls of classesOf(rule.selectors)) {
          if (!this.classVars.has(cls)) this.classVars.set(cls, new Map());
          const vars = this.classVars.get(cls);
          for (const [name, value] of decls) if (name.startsWith("--")) vars.set(name, value);
          const shape = decls.get("corner-shape");
          if (shape) this.classCornerShape.set(cls, shape);
        }
      }
      const isBase = rule.selectors.some((s) => /^:root$/.test(s) || /^:host$/.test(s));
      const highContrast = rule.selectors.some((s) => /data-high-contrast/.test(s));
      const isLight = !highContrast && rule.selectors.some((s) => /\[data-theme=["']?light["']?\]/.test(s));
      const isDark = !highContrast && rule.selectors.some((s) => /\[data-theme=["']?dark["']?\]/.test(s));
      const target = [isBase && this.base, isLight && this.light, isDark && this.dark].filter(Boolean);
      for (const map of target) {
        for (const [name, value] of decls) if (name.startsWith("--")) map.set(name, value);
      }
      for (const sel of rule.selectors) {
        // Exact single-class utilities only: `.<name>` with escaped dots.
        const m = /^\.((?:[A-Za-z0-9_-]|\\.)+)$/.exec(sel);
        if (m) {
          const name = m[1].replace(/\\(.)/g, "$1");
          // Last definition wins, as in the cascade (utilities come after base).
          this.utilities.set(name, decls);
        }
      }
    }
  }

  /** Replaces every `var(--name[, fallback])`, fallbacks included, via `lookup`. */
  substitute(value, lookup) {
    let out = "";
    let i = 0;
    for (;;) {
      const at = value.indexOf("var(", i);
      if (at < 0) {
        out += value.slice(i);
        return out;
      }
      out += value.slice(i, at);
      // Find the matching close paren.
      let depth = 0;
      let j = at + 3;
      for (; j < value.length; j++) {
        if (value[j] === "(") depth++;
        else if (value[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      const inner = value.slice(at + 4, j);
      // Split off the fallback at the first top-level comma.
      let comma = -1;
      let d = 0;
      for (let k = 0; k < inner.length; k++) {
        if (inner[k] === "(") d++;
        else if (inner[k] === ")") d--;
        else if (inner[k] === "," && d === 0) {
          comma = k;
          break;
        }
      }
      const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
      const found = lookup(name);
      if (found != null) out += `(${this.substitute(found, lookup)})`;
      else if (fallback != null) out += `(${this.substitute(fallback, lookup)})`;
      else throw new Error(`unresolved var ${name} in ${value}`);
      i = j + 1;
    }
  }

  /** Resolves a declaration value to a number of px, following var chains. */
  length(value, theme, classOverlay = null) {
    const lookup = (name) => classOverlay?.get(name) ?? theme.get(name) ?? this.base.get(name) ?? null;
    let v = this.substitute(value, lookup).trim();
    const calc = /^calc\((.*)\)$/s.exec(v);
    const expr = (calc ? calc[1] : v).trim();
    const num = evalLength(expr);
    return Math.round(num * 1000) / 1000;
  }

  /** Resolves a color to `#rrggbb[aa]`, following var chains. */
  color(value, theme) {
    let v = value.trim();
    let guard = 0;
    while (v.startsWith("var(")) {
      if (guard++ > 20) throw new Error("color var cycle in " + value);
      const m = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/.exec(v);
      if (!m) break;
      const found = theme.get(m[1]) ?? this.base.get(m[1]) ?? m[2];
      if (found == null) throw new Error(`unresolved color var ${m[1]}`);
      v = found.trim();
    }
    const hex = hexOf(v);
    if (!hex) throw new Error(`cannot resolve color ${value} -> ${v}`);
    return hex;
  }

  utility(name, prop) {
    const decls = this.utilities.get(name);
    if (!decls) throw new Error(`utility .${name} not found in the stylesheet`);
    const value = decls.get(prop);
    if (value == null) throw new Error(`utility .${name} has no ${prop} (has: ${[...decls.keys()].join(", ")})`);
    return value;
  }

  /** px value of a utility's property, with font-scale detection. */
  px(name, prop, theme) {
    const raw = this.utility(name, prop);
    // A class-scoped override (from an applicable `@supports`) wins, exactly as
    // it does in the cascade for an element with that class.
    return { value: this.length(raw, theme, this.classVars.get(name) ?? null), scales: /--x-font-scale/.test(raw), raw };
  }

  /** The same utility resolved without any class-scoped feature overrides. */
  pxRound(name, prop, theme) {
    const raw = this.utility(name, prop);
    return { value: this.length(raw, theme), scales: /--x-font-scale/.test(raw), raw };
  }

  /** `corner-shape` the browser applies to a utility's class, if any. */
  cornerShape(name) {
    return this.classCornerShape.get(name) ?? "round";
  }

  /** Spacing multiple: `--spacing` (4px) times n, cross-checked against the utility when present. */
  spacing(n) {
    const spacing = this.length("var(--spacing)", this.light);
    const expected = Math.round(n * spacing * 1000) / 1000;
    const name = Number.isInteger(n) ? `gap-${n}` : `gap-${String(n).replace(".", "\\.")}`;
    if (this.utilities.has(name)) {
      const actual = Number(this.utility(name, "gap").replace("px", ""));
      if (Math.abs(actual - expected) > 0.001) throw new Error(`.${name} is ${actual}px, expected ${expected}px`);
    }
    return expected;
  }
}

// ------------------------------------------------------------------ tokens --

const TYPE = ["body", "lead", "subtext1", "subtext2", "headline1", "headline2", "title4"];
const WEIGHTS = ["normal", "medium", "semibold", "bold", "extrabold"];

// Colors the frame draws with, by CSS variable.
const COLORS = {
  bgPrimary: "--x-bg-primary",
  bgSecondary: "--x-bg-secondary",
  fgPrimary: "--x-fg-primary",
  fgSecondary: "--x-fg-secondary",
  fgTertiary: "--x-fg-tertiary",
  fgBrand: "--x-fg-brand",
  borderNormal: "--x-border-normal",
  borderDivider: "--x-border-divider",
};

export function extractTokens(css) {
  const sheet = new Sheet(css);
  const theme = sheet.light; // length-only lookups: the themes share lengths
  const px = (name, prop) => sheet.px(name, prop, theme).value;

  const type = {};
  for (const name of TYPE) {
    const size = sheet.px(`text-${name}`, "font-size", theme);
    const lh = sheet.px(`text-${name}`, "line-height", theme);
    type[name] = { size: size.value, lineHeight: lh.value, scales: size.scales || lh.scales };
  }

  const weights = {};
  for (const name of WEIGHTS) {
    const raw = sheet.base.get(`--font-weight-${name}`);
    if (!raw) throw new Error(`--font-weight-${name} missing`);
    weights[name] = Number(raw);
  }

  // Line breaking and font features, straight from the utilities X puts on
  // post text and handles.
  const wrap = {
    // post text: whitespace-pre-wrap wrap-anywhere
    textWhiteSpace: sheet.utility("whitespace-pre-wrap", "white-space"),
    textOverflowWrap: sheet.utility("wrap-anywhere", "overflow-wrap"),
    // handle: line-clamp-1 wrap-break-word
    handleOverflowWrap: sheet.utility("wrap-break-word", "overflow-wrap"),
    // name: line-clamp-1 break-all
    nameWordBreak: sheet.utility("break-all", "word-break"),
    // `.tabular-nums` sets a Tailwind variable chain; the flag is what matters.
    tabularNums: sheet.utilities.get("tabular-nums")?.has("--tw-numeric-spacing")
      ? "tabular-nums"
      : (() => {
          throw new Error(".tabular-nums not found");
        })(),
  };

  const layout = {
    // Container: px-horizontal / py-vertical on the post's cell.
    paddingX: px("px-horizontal", "padding-inline"),
    paddingY: px("py-vertical", "padding-block"),
    // Avatar column and the gap to the content column.
    avatarSize: px("size-10", "width"),
    avatarGap: sheet.spacing(2),
    // Header: gap-1 inside the name span and between name and handle,
    // gap-2 on the row, gap-0.5 between header and text.
    gapTight: sheet.spacing(1),
    gapHalf: sheet.spacing(0.5),
    gapRow: sheet.spacing(2),
    gapBlock: sheet.spacing(3),
    // The "More" button: h-8/w-8, -my-2, icon size-4, and the negative
    // end margin that pulls it into the padding (-me-[5px] on the timeline,
    // -me-0.5 on the detail view; arbitrary values from the markup).
    moreButtonSize: px("h-8", "height"),
    moreIconSize: px("size-4", "width"),
    moreMarginY: -sheet.spacing(2),
    moreMarginEndTimeline: -5,
    moreMarginEndDetail: -sheet.spacing(0.5),
    // Action row: h-5, -mx-2, and the pill's paddings, heights and icon sizes.
    actionRowHeight: px("h-5", "height"),
    actionRowBleed: sheet.spacing(2),
    pillHeightTimeline: px("h-9", "height"),
    pillPaddingXTimeline: px("px-2.5", "padding-inline"),
    pillIconSizeTimeline: 18.75, // size-[18.75px], arbitrary value in the markup
    pillHeightDetail: px("h-10", "height"),
    pillPaddingXDetail: px("px-3", "padding-inline"),
    pillIconSizeDetail: px("size-5", "width"),
    countPaddingStart: px("ps-1", "padding-inline-start"),
    // The middot separator X inserts between header parts is a ::before with
    // padding-inline: 4px and content "·".
    dotPadding: 4,
    // The badge is size-[1em] of the header's text-body.
    badgeSize: type.body.size,
    // Bookmark is hidden by a container query at narrow widths; see
    // docs/INTERFACES.md (frame) for how frame resolves it.
    bookmarkHiddenBelowArticleWidth: 290,
  };

  // Radii: X sets `--x-radius-m: 1.8` inside `@supports (corner-shape:
  // squircle)` for `:is(.rounded-xs,.rounded-sm,.rounded,.rounded-md,
  // .rounded-lg,.rounded-xl)`, and current Chrome satisfies that query, so
  // those classes draw 1.8x larger and as superellipses. `rounded-2xl` (1rem)
  // and `rounded-full` are not in that list. Both values are recorded: the
  // effective one (what Chrome draws) and the round fallback.
  const RADIUS_CLASSES = ["xs", "sm", "md", "lg", "xl", "2xl", "full"];
  const radii = {};
  const radiiRound = {};
  const cornerShape = {};
  for (const name of RADIUS_CLASSES) {
    const utility = `rounded-${name}`;
    radii[name] = px(utility, "border-radius");
    radiiRound[name] = sheet.pxRound(utility, "border-radius", theme).value;
    cornerShape[name] = sheet.cornerShape(utility);
  }
  const radiusMultiplier = sheet.length("var(--x-radius-m)", theme);
  // The squircle multiplier, read from the feature override itself.
  const squircleClass = Array.from(sheet.classVars.keys()).find((c) => c.startsWith("rounded-"));
  const radiusMultiplierSquircle = squircleClass
    ? sheet.length(sheet.classVars.get(squircleClass).get("--x-radius-m"), theme)
    : radiusMultiplier;
  if (cornerShape.xs !== "squircle" && radiusMultiplierSquircle !== radiusMultiplier) {
    throw new Error("radius override found but corner-shape was not applied");
  }

  const colors = {};
  for (const [themeName, map] of [
    ["light", sheet.light],
    ["dark", sheet.dark],
  ]) {
    const entry = {};
    for (const [label, varName] of Object.entries(COLORS)) {
      const raw = map.get(varName) ?? sheet.base.get(varName);
      if (!raw) throw new Error(`${varName} missing for ${themeName}`);
      entry[label] = sheet.color(raw, map);
    }
    colors[themeName] = entry;
  }

  return {
    source: {
      advertisedAppVersion: "see assets/upstream.lock.json",
      stylesheetSha256: createHash("sha256").update(css).digest("hex"),
    },
    units: {
      spacing: sheet.length("var(--spacing)", theme),
      rootFontSize: 16,
      fontScale: 1,
      radiusMultiplier,
      radiusMultiplierSquircle,
    },
    // Which feature queries were applied, and which were skipped and why, so a
    // change upstream is visible in the token diff instead of silent.
    supports: {
      applied: [...sheet.appliedSupports],
      skippedSupports: [...sheet.skippedSupports],
      skippedMedia: [...sheet.skippedMedia],
    },
    type,
    weights,
    wrap,
    layout,
    radii,
    radiiRound,
    cornerShape,
    colors,
  };
}

export async function writeTokens({ vendor = VENDOR, cssPath = join(vendor, "upstream", "styles.css") } = {}) {
  const css = await readFile(cssPath, "utf8");
  const tokens = extractTokens(css);
  await writeFile(join(vendor, "tokens.json"), JSON.stringify(tokens, null, 2) + "\n");
  return tokens;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const cssIdx = args.indexOf("--css");
  const outIdx = args.indexOf("--out");
  const vendor = outIdx >= 0 ? dirname(args[outIdx + 1]) : VENDOR;
  const tokens = await writeTokens({ vendor, cssPath: cssIdx >= 0 ? args[cssIdx + 1] : undefined });
  const out = outIdx >= 0 ? args[outIdx + 1] : join(VENDOR, "tokens.json");
  if (outIdx >= 0) await writeFile(out, JSON.stringify(tokens, null, 2) + "\n");
  console.log(JSON.stringify(tokens, null, 2));
}
