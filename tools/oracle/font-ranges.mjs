#!/usr/bin/env node
// Derives the unicode-ranges xeet's fallback faces must be limited to, from
// the fonts on this Mac. Chasing Chrome on Apple devices is the point: X's
// stack is
//
//   TwitterChirp, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto,
//   Helvetica, Arial, Apple Color Emoji, …, sans-serif
//
// so Chrome walks it per character and picks the first family that has the
// character. A family can therefore only ever win the characters no earlier
// family covers:
//
//   Arial   = Arial's cmap  − SF − Helvetica
//   emoji   = Apple Color Emoji's cmap − SF − Helvetica − Arial
//
// Those two ranges are the only characters Chrome on macOS draws with Arial
// and the emoji font. Every other character belongs to a font that cannot be
// bundled (SF, Helvetica, Apple Symbols, Menlo, Hiragino, Zapf Dingbats, …),
// and is approximated by whatever open font covers it.
//
//   node tools/oracle/font-ranges.mjs      # prints the constants for sync-upstream.mjs
//
// Re-run after a macOS, Chrome or X font update; compare the output with what
// tools/sync-upstream.mjs has. The evidence tables behind the choices are in
// tools/oracle/fonts-used.mjs and PLAN.md §14.
import { readFileSync } from "node:fs";

const FONTS = {
  sf: ["/System/Library/Fonts/SFNS.ttf"],
  helvetica: ["/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Helvetica.ttc@1", "/System/Library/Fonts/Helvetica.ttc@2"],
  arial: ["/System/Library/Fonts/Supplemental/Arial.ttf"],
  emoji: ["/System/Library/Fonts/Apple Color Emoji.ttc", "/System/Library/Fonts/Apple Color Emoji.ttc@1"],
};

/** The code points a font file (or every face of a .ttc) has a glyph for. */
export function coverage(specs) {
  const out = new Set();
  for (const spec of specs) {
    const [path, face] = spec.split("@");
    for (const cp of readCmap(readFileSync(path), Number(face ?? 0))) out.add(cp);
  }
  return out;
}

function difference(a, ...subs) {
  const out = new Set(a);
  for (const s of subs) for (const c of s) out.delete(c);
  return out;
}
/** Date-free Unicode-range string, merging adjacent code points. */
export function unicodeRange(cps) {
  const runs = [];
  for (const c of [...cps].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && c === last[1] + 1) last[1] = c;
    else runs.push([c, c]);
  }
  const hex = (c) => c.toString(16).toUpperCase().padStart(4, "0");
  return runs.map(([a, b]) => (a === b ? `U+${hex(a)}` : `U+${hex(a)}-${hex(b)}`)).join(",");
}

/** The derived ranges: `{ arial, emoji }`. */
export function derivedRanges() {
  const sf = coverage(FONTS.sf);
  const helvetica = coverage(FONTS.helvetica);
  const arial = coverage(FONTS.arial);
  const emoji = coverage(FONTS.emoji);
  // The joiners stay in the emoji range even though SF covers them: they are
  // never the first character of a cluster, so the engine never asks for them,
  // and a unicode-range that leaves a ZWJ sequence ("❤️‍🔥") out splits the run
  // in the browser and loses the ligature.
  const joiners = new Set([0x200c, 0x200d]);
  return {
    arial: difference(arial, sf, helvetica),
    emoji: new Set([...difference(emoji, sf, helvetica, arial), ...joiners]),
  };
}

if (process.argv[1]?.endsWith("font-ranges.mjs")) {
  const { arial, emoji } = derivedRanges();
  // Wraps the range as a JS string constant, ~90 characters per line.
  const wrap = (name, cps) => {
    const parts = unicodeRange(cps).split(",");
    const lines = [];
    let line = "";
    for (const [i, part] of parts.entries()) {
      const piece = i === parts.length - 1 ? part : `${part},`;
      if (line && line.length + piece.length > 88) {
        lines.push(line);
        line = "";
      }
      line += piece;
    }
    if (line) lines.push(line);
    return `// ${cps.size} code points\nconst ${name} =\n${lines.map((l) => `  "${l}"`).join(" +\n")};`;
  };
  console.log(wrap("ARIAL_RANGE", arial));
  console.log();
  console.log(wrap("EMOJI_RANGE", emoji));
  console.log();
  // The one range that is a shape judgement rather than a coverage fact: the
  // characters Noto Sans Symbols 2 gives up so STIX Two Math draws them. It is
  // recorded in sync-upstream.mjs with the measured advances; this prints what
  // that means for the face's unicode-range.
  const { SYMBOL_STAND_IN_EXCEPTIONS, complement } = await import("../sync-upstream.mjs");
  console.log(`const SYMBOL_STAND_IN_EXCEPTIONS = "${SYMBOL_STAND_IN_EXCEPTIONS}";`);
  console.log(`// Noto Sans Symbols 2 keeps: ${complement("U+0-10FFFF", SYMBOL_STAND_IN_EXCEPTIONS)}`);
}

// A TrueType/OpenType `cmap` reader, enough for coverage: formats 4, 6, 12 and
// 0, which is what fonts in the wild use. Also reads collection (ttcf) files.
function readCmap(buf, faceIndex = 0) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  let base = 0;
  if (tag(0) === "ttcf") {
    if (faceIndex >= dv.getUint32(8)) throw new Error("ttc face index out of range");
    base = dv.getUint32(12 + 4 * faceIndex);
  }
  let cmap = 0;
  for (let i = 0, n = dv.getUint16(base + 4); i < n; i++) {
    const rec = base + 12 + 16 * i;
    if (tag(rec) === "cmap") cmap = dv.getUint32(rec + 8);
  }
  if (!cmap) throw new Error("no cmap table");
  const subtables = [];
  for (let i = 0, n = dv.getUint16(cmap + 2); i < n; i++) {
    const rec = cmap + 4 + 8 * i;
    subtables.push({ off: cmap + dv.getUint32(rec + 4) });
  }
  const cps = new Set();
  // Prefer a full-repertoire (format 12) subtable, then a BMP one (format 4).
  const byFormat = (s) => dv.getUint16(s.off);
  for (const s of subtables.sort((a, b) => (byFormat(b) === 12) - (byFormat(a) === 12))) {
    const format = byFormat(s);
    if (format === 4) {
      const segX2 = dv.getUint16(s.off + 6);
      const ends = s.off + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const rangeOffs = deltas + segX2;
      for (let i = 0; i < segX2 / 2; i++) {
        const [start, end] = [dv.getUint16(starts + 2 * i), dv.getUint16(ends + 2 * i)];
        if (start === 0xffff) continue;
        const delta = dv.getInt16(deltas + 2 * i);
        const ro = dv.getUint16(rangeOffs + 2 * i);
        for (let c = start; c <= end; c++) {
          let g;
          if (ro === 0) g = (c + delta) & 0xffff;
          else {
            const at = rangeOffs + 2 * i + ro + 2 * (c - start);
            g = dv.getUint16(at) && (dv.getUint16(at) + delta) & 0xffff;
          }
          if (g) cps.add(c);
        }
      }
    } else if (format === 12) {
      for (let i = 0, n = dv.getUint32(s.off + 12); i < n; i++) {
        const g = s.off + 16 + 12 * i;
        const [start, end, first] = [dv.getUint32(g), dv.getUint32(g + 4), dv.getUint32(g + 8)];
        for (let c = start; c <= end; c++) if (first + (c - start)) cps.add(c);
      }
    } else if (format === 6) {
      const [first, count] = [dv.getUint16(s.off + 6), dv.getUint16(s.off + 8)];
      for (let i = 0; i < count; i++) if (dv.getUint16(s.off + 10 + 2 * i)) cps.add(first + i);
    } else if (format === 0) {
      for (let c = 0; c < 256; c++) if (buf[s.off + 6 + c]) cps.add(c);
    }
    if (cps.size) break;
  }
  return cps;
}
