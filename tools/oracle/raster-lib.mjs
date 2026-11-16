// Shared helpers for the raster oracles: PNG in/out, pixel diffs, and running
// xeet's painter. Development only.
//
// There is no image library in tools/, so PNG is decoded with zlib here: all
// the oracle produces is 8-bit RGBA/RGB from Playwright screenshots and from
// xeet itself (which always writes RGBA8).

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { join } from "node:path";
import { ROOT } from "./browser.mjs";

/** Decodes an 8-bit PNG (gray, RGB, RGBA; no interlace) to RGBA. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let p = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = unfilter(filter, line, prev, channels);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 6) {
        out[o] = cur[x * 4];
        out[o + 1] = cur[x * 4 + 1];
        out[o + 2] = cur[x * 4 + 2];
        out[o + 3] = cur[x * 4 + 3];
      } else if (colorType === 2) {
        out[o] = cur[x * 3];
        out[o + 1] = cur[x * 3 + 1];
        out[o + 2] = cur[x * 3 + 2];
        out[o + 3] = 255;
      } else if (colorType === 0) {
        out[o] = out[o + 1] = out[o + 2] = cur[x];
        out[o + 3] = 255;
      } else if (colorType === 4) {
        out[o] = out[o + 1] = out[o + 2] = cur[x * 2];
        out[o + 3] = cur[x * 2 + 1];
      } else if (colorType === 3) {
        const i = cur[x];
        out[o] = palette[i * 3];
        out[o + 1] = palette[i * 3 + 1];
        out[o + 2] = palette[i * 3 + 2];
        out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      }
    }
    prev = cur;
  }
  return { width, height, data: out };
}

function unfilter(filter, line, prev, bpp) {
  const cur = Buffer.alloc(line.length);
  for (let i = 0; i < line.length; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    const x = line[i];
    let v;
    switch (filter) {
      case 0: v = x; break;
      case 1: v = x + a; break;
      case 2: v = x + b; break;
      case 3: v = x + ((a + b) >> 1); break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        break;
      }
      default: throw new Error(`bad filter ${filter}`);
    }
    cur[i] = v & 0xff;
  }
  return cur;
}

/** Encodes RGBA as a PNG (unfiltered, zlib). */
export function encodePng({ width, height, data }) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunks = [];
  const chunk = (type, body) => {
    const b = Buffer.alloc(8 + body.length + 4);
    b.writeUInt32BE(body.length, 0);
    b.write(type, 4, "ascii");
    body.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + body.length)), 8 + body.length);
    chunks.push(b);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  chunk("IHDR", ihdr);
  chunk("IDAT", deflateSync(raw, { level: 6 }));
  chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function readPng(path) {
  return decodePng(readFileSync(path));
}

export function writePng(path, img) {
  writeFileSync(path, encodePng(img));
}

/**
 * Compares two same-size images.
 *
 * A pixel counts as equal when every channel is within `tolerance`. Pixels
 * that differ are classified as "edge" when the same pixel, in either image,
 * is within `edgeRadius` px of a pixel that differs from its own neighbours by
 * more than `edgeStep` — i.e. ink meets background, which is where
 * anti-aliasing lives.
 */
export function diff(a, b, { tolerance = 8, edgeRadius = 2, edgeStep = 32 } = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    return { sizeMismatch: true, sizeA: [a.width, a.height], sizeB: [b.width, b.height] };
  }
  const { width: w, height: h } = a;
  const total = w * h;
  const bad = new Uint8Array(total);
  let within = 0;
  let maxDelta = 0;
  let sumDelta = 0;
  let worst = null;
  // Histogram of per-pixel channel deltas, so a report can say how far off the
  // outliers are instead of only how many crossed the tolerance.
  const hist = [0, 0, 0, 0, 0, 0];
  const buckets = [2, 8, 16, 32, 64];
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a.data[o + k] - b.data[o + k]));
    sumDelta += d;
    if (d > maxDelta) {
      maxDelta = d;
      worst = { x: i % w, y: Math.floor(i / w), a: [...a.data.subarray(o, o + 4)], b: [...b.data.subarray(o, o + 4)] };
    }
    if (d <= tolerance) within++;
    else bad[i] = 1;
    hist[buckets.findIndex((b) => d <= b) < 0 ? 5 : buckets.findIndex((b) => d <= b)]++;
  }
  // Gradient mask: a pixel whose right or lower neighbour jumps.
  const grad = new Uint8Array(total);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx >= w || ny >= h) continue;
        const no = (ny * w + nx) * 4;
        let d = 0;
        for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a.data[o + k] - a.data[no + k]), Math.abs(b.data[o + k] - b.data[no + k]));
        if (d > edgeStep) {
          grad[i] = 1;
          grad[ny * w + nx] = 1;
        }
      }
    }
  }
  const nearEdge = new Uint8Array(total);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!grad[y * w + x]) continue;
      for (let dy = -edgeRadius; dy <= edgeRadius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -edgeRadius; dx <= edgeRadius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          nearEdge[ny * w + nx] = 1;
        }
      }
    }
  }
  let outside = 0;
  for (let i = 0; i < total; i++) if (bad[i] && !nearEdge[i]) outside++;
  let badCount = 0;
  for (let i = 0; i < total; i++) if (bad[i]) badCount++;
  return {
    width: w,
    height: h,
    total,
    within,
    histogram: { within2: hist[0], within8: hist[1], within16: hist[2], within32: hist[3], within64: hist[4], above64: hist[5] },
    withinPct: +((within / total) * 100).toFixed(4),
    differing: badCount,
    differingPct: +((badCount / total) * 100).toFixed(4),
    differingOutsideEdges: outside,
    differingOutsideEdgesPct: +((outside / total) * 100).toFixed(4),
    meanChannelDelta: +(sumDelta / total).toFixed(3),
    maxChannelDelta: maxDelta,
    worst,
    bad,
  };
}

/** Heatmap of differing pixels: red where they differ, the original in grey. */
export function diffImage(base, d) {
  const out = { width: base.width, height: base.height, data: Buffer.alloc(base.data.length) };
  for (let i = 0; i < base.width * base.height; i++) {
    const o = i * 4;
    const g = Math.round((base.data[o] + base.data[o + 1] + base.data[o + 2]) / 3);
    const light = 255 - Math.round((255 - g) * 0.25);
    if (d.bad && d.bad[i]) {
      out.data[o] = 255;
      out.data[o + 1] = 0;
      out.data[o + 2] = 0;
      out.data[o + 3] = 255;
    } else {
      out.data[o] = out.data[o + 1] = out.data[o + 2] = light;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/**
 * A paint example binary, built by this stream: `paint_text` for the text
 * oracle and `paint_fixture` for the geometry oracles. `XEET_PAINT_TEXT` /
 * `XEET_PAINT_FIXTURE` override the lookup, which is what
 * `tmp/paint-iter/` builds use while other streams have the crate mid-edit.
 */
export function paintBinary(which = "paint_fixture") {
  const override = process.env[which === "paint_text" ? "XEET_PAINT_TEXT" : "XEET_PAINT_FIXTURE"];
  if (override) return override;
  for (const profile of ["fast", "release", "debug"]) {
    const p = join(ROOT, "target", "agent-paint", profile, "examples", which);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `no ${which} example found; build with ` +
      "`CARGO_TARGET_DIR=target/agent-paint cargo build --profile fast --examples -p xeet-core`",
  );
}

export function runPaint(args, which = "paint_text") {
  return execFileSync(paintBinary(which), args, { maxBuffer: 1 << 28 }).toString();
}

export function mtime(path) {
  return statSync(path).mtimeMs;
}
