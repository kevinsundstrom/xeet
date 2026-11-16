// @vercel's avatar, drawn rather than fetched.
//
// Measured on @vercel's 400×400 X avatar: solid #000000 with an antialiased
// #FFFFFF equilateral triangle, apex (200.5, 120.5), base (109.0, 279.5) to
// (292.0, 279.5). The bytes are generated in the browser, never stored in a
// post or a URL. The analytic branch keeps this usable without a canvas; it
// writes a PNG by hand.

const APEX = [200.5, 120.5];
const BASE_LEFT = [109.0, 279.5];
const BASE_RIGHT = [292.0, 279.5];
const REFERENCE = 400;

const cache = new Map();

export function vercelAvatarBase64(size = REFERENCE) {
  const px = Math.max(16, Math.round(size));
  if (cache.has(px)) return cache.get(px);
  const value = canDraw() ? drawWithCanvas(px) : drawAnalytic(px);
  cache.set(px, value);
  return value;
}

export function vercelAvatarUrl(size = REFERENCE) {
  return `data:image/png;base64,${vercelAvatarBase64(size)}`;
}

function canDraw() {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

function drawWithCanvas(size) {
  const scale = size / REFERENCE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(APEX[0] * scale, APEX[1] * scale);
  ctx.lineTo(BASE_LEFT[0] * scale, BASE_LEFT[1] * scale);
  ctx.lineTo(BASE_RIGHT[0] * scale, BASE_RIGHT[1] * scale);
  ctx.closePath();
  ctx.fill();
  return canvas.toDataURL("image/png").split(",")[1];
}

function inside(px, py) {
  const d1 = (px - BASE_LEFT[0]) * (APEX[1] - BASE_LEFT[1]) - (py - BASE_LEFT[1]) * (APEX[0] - BASE_LEFT[0]);
  const d2 = (px - APEX[0]) * (BASE_RIGHT[1] - APEX[1]) - (py - APEX[1]) * (BASE_RIGHT[0] - APEX[0]);
  const d3 = (px - BASE_RIGHT[0]) * (BASE_LEFT[1] - BASE_RIGHT[1]) - (py - BASE_RIGHT[1]) * (BASE_LEFT[0] - BASE_RIGHT[0]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function drawAnalytic(size) {
  const scale = size / REFERENCE;
  const samples = 4;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = (x + (sx + 0.5) / samples) / scale;
          const py = (y + (sy + 0.5) / samples) / scale;
          if (inside(px, py)) hits++;
        }
      }
      const value = Math.round((255 * hits) / (samples * samples));
      const i = (y * size + x) * 4;
      rgba[i] = value;
      rgba[i + 1] = value;
      rgba[i + 2] = value;
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const parts = [
    new Uint8Array(signature),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  return base64(concat(parts));
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function zlibStored(data) {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535;
    const slice = data.subarray(start, Math.min(start + 65535, data.length));
    out[at++] = i === blocks - 1 ? 1 : 0;
    out[at++] = slice.length & 0xff;
    out[at++] = (slice.length >> 8) & 0xff;
    out[at++] = ~slice.length & 0xff;
    out[at++] = (~slice.length >> 8) & 0xff;
    out.set(slice, at);
    at += slice.length;
  }
  new DataView(out.buffer).setUint32(at, adler32(data));
  return out;
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += ALPHABET[a >> 2] + ALPHABET[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? ALPHABET[c & 63] : "=";
  }
  return out;
}
