// Pixel comparison and diff painting.
//
// The comparison follows docs/e2e-raster.md: a channel may differ by
// `tolerance` (8, the painter's own oracle tolerance), and a pixel counts as
// matching when any pixel within `slack` (1) neighbourhood matches — Chrome's
// baseline snap turns a quarter pixel of line-box difference into a whole
// pixel of ink, and a wider component is much wider than a pixel anyway.
//
// Matching is done as a separable dilation of the same-position match mask:
// two extra passes instead of nine neighbourhood tests per pixel, which keeps
// a 1200×1600 comparison under a frame.

export const TOLERANCE = 8;
export const SLACK = 1;

/** Decodes a PNG blob to a bitmap. */
export async function decodeImage(blob) {
  if (typeof createImageBitmap !== "function") throw new Error("this browser cannot decode images off-thread");
  return createImageBitmap(blob);
}

let offscreen = null;
/** RGBA of a bitmap, cached on the object under `__pixels`. */
export function pixelsOf(bitmap, cacheKey = "__pixels") {
  if (bitmap[cacheKey]) return bitmap[cacheKey];
  if (!offscreen || offscreen.width < bitmap.width || offscreen.height < bitmap.height) {
    offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
  }
  const width = bitmap.width;
  const height = bitmap.height;
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, width, height);
  bitmap[cacheKey] = data;
  return data;
}

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} a
 * @param {{width:number,height:number,data:Uint8ClampedArray}} b
 */
export function comparePixels(a, b, { tolerance = TOLERANCE, slack = SLACK } = {}) {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const n = width * height;
  const match = new Uint8Array(n);
  const A = a.data;
  const B = b.data;
  const aw = a.width;
  const bw = b.width;
  const ah = a.height;
  const bh = b.height;

  for (let y = 0; y < height; y++) {
    const rowA = y < ah;
    const rowB = y < bh;
    const baseA = y * aw;
    const baseB = y * bw;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const inA = rowA && x < aw;
      const inB = rowB && x < bw;
      if (!inA || !inB) continue; // outside one image: a difference, unless both are out
      const ai = (baseA + x) * 4;
      const bi = (baseB + x) * 4;
      const da = A[ai] - B[bi];
      const db = A[ai + 1] - B[bi + 1];
      const dc = A[ai + 2] - B[bi + 2];
      const dalpha = A[ai + 3] - B[bi + 3];
      match[i] =
        (da <= tolerance && da >= -tolerance) &&
        (db <= tolerance && db >= -tolerance) &&
        (dc <= tolerance && dc >= -tolerance) &&
        (dalpha <= tolerance && dalpha >= -tolerance)
          ? 1
          : 0;
    }
  }

  // A pixel outside both images (when the extents cross rather than nest) is
  // not a difference; outside exactly one is.
  if (aw < width || ah < height) {
    for (let y = 0; y < height; y++) {
      const inAy = y < ah;
      const inBy = y < bh;
      for (let x = 0; x < width; x++) {
        if (!(inAy && x < aw) && !(inBy && x < bw)) match[y * width + x] = 1;
      }
    }
  }

  let differing = 0;
  if (slack > 0) {
    const tmp = new Uint8Array(n);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const i = row + x;
        let v = match[i];
        if (!v && x > 0) v = match[i - 1];
        if (!v && x + 1 < width) v = match[i + 1];
        tmp[i] = v;
      }
    }
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const i = row + x;
        let v = tmp[i];
        if (!v && y > 0) v = tmp[i - width];
        if (!v && y + 1 < height) v = tmp[i + width];
        if (!v) {
          differing++;
          match[i] = 0;
        } else {
          match[i] = 1;
        }
      }
    }
  } else {
    for (let i = 0; i < n; i++) if (!match[i]) differing++;
  }

  let mask = null;
  if (differing > 0) {
    mask = new ImageData(width, height);
    const out = mask.data;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (match[i]) continue;
        const o = i * 4;
        out[o] = 244;
        out[o + 1] = 33;
        out[o + 2] = 46;
        out[o + 3] = 205;
      }
    }
  }

  return {
    width,
    height,
    differing,
    total: n,
    pct: n ? (differing / n) * 100 : 0,
    sameSize: a.width === b.width && a.height === b.height,
    mask,
    inkA: inkRatio(a),
    inkB: inkRatio(b),
  };
}

/** Fraction of pixels that differ from the top-left pixel by more than 24. */
function inkRatio(image) {
  if (typeof image.__ink === "number") return image.__ink;
  const { width, height, data } = image;
  if (!width || !height) return 0;
  const r0 = data[0];
  const g0 = data[1];
  const b0 = data[2];
  let ink = 0;
  const total = width * height;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (
      Math.abs(data[o] - r0) > 24 ||
      Math.abs(data[o + 1] - g0) > 24 ||
      Math.abs(data[o + 2] - b0) > 24
    ) {
      ink++;
    }
  }
  image.__ink = ink / total;
  return image.__ink;
}

/** Paints a comparison mask onto a canvas of the mask's pixel size. */
export function paintMask(canvas, result) {
  if (!result?.mask) {
    canvas.width = 1;
    canvas.height = 1;
    return;
  }
  canvas.width = result.mask.width;
  canvas.height = result.mask.height;
  canvas.getContext("2d").putImageData(result.mask, 0, 0);
}

// ---------------------------------------------------------------------------
// Geometry: box and line outlines, when a target reports them.
//
// The contract says `geometry?: { lines, boxes }` without fixing the shape, so
// accept the plausible spellings. Coordinates are CSS pixels of the render
// (the same space as `render.width`); device pixels are detected and divided
// down, so a target that reports PNG coordinates still lines up.

function rectOf(entry, fallbackH = 0) {
  if (!entry || typeof entry !== "object") return null;
  if (Array.isArray(entry.rect)) return entry.rect;
  if (Array.isArray(entry.box)) return entry.box;
  if (Array.isArray(entry.line) && entry.line.length === 4) return entry.line;
  let x = entry.x ?? entry.left ?? entry.l;
  let y = entry.y ?? entry.top ?? entry.t;
  let w = entry.w ?? entry.width ?? entry.bw;
  let h = entry.h ?? entry.height ?? entry.bh;
  if (x === undefined && entry.x1 !== undefined) x = entry.x1;
  if (y === undefined && entry.y1 !== undefined) y = entry.y1;
  const x2 = entry.x2 ?? entry.right;
  const y2 = entry.y2 ?? entry.bottom;
  if (w === undefined && x !== undefined && x2 !== undefined) w = x2 - x;
  if (h === undefined && y !== undefined && y2 !== undefined) h = y2 - y;
  // Chrome's line boxes come as {text, x, y, w}: a line has a width, not a
  // height, so the caller supplies the line height it inferred.
  if (h === undefined && fallbackH) h = fallbackH;
  if (![x, y, w, h].every((v) => Number.isFinite(Number(v)))) return null;
  return [Number(x), Number(y), Number(w), Number(h)];
}

function labelOf(entry) {
  const raw = entry.label ?? entry.name ?? entry.kind ?? entry.text ?? "";
  return typeof raw === "string" ? raw.slice(0, 40) : "";
}

function extent(list) {
  let maxX = 0;
  let maxY = 0;
  for (const entry of list) {
    const r = rectOf(entry);
    if (!r) continue;
    maxX = Math.max(maxX, r[0] + r[2]);
    maxY = Math.max(maxY, r[1] + r[3]);
  }
  return { maxX, maxY };
}

/** The line height a list of line boxes implies, for boxes that have none. */
function lineHeightOf(list) {
  const ys = [...new Set(list.map((l) => Number(l?.y)).filter(Number.isFinite))].sort((a, b) => a - b);
  let guess = 0;
  for (let i = 1; i < ys.length; i++) {
    const d = ys[i] - ys[i - 1];
    if (d > 1 && (!guess || d < guess)) guess = d;
  }
  return guess || 16;
}

const MAX_OUTLINES = 600;

/** Sets up a canvas for one or more geometries and paints them. */
function paintGeometries(canvas, layers, { dpr = 1, width = 0, height = 0 } = {}) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const usable = layers.filter((layer) => layer && layer.geometry);
  if (!usable.length) return;
  const all = [];
  for (const layer of usable) {
    all.push(...(Array.isArray(layer.geometry.lines) ? layer.geometry.lines : []));
    all.push(...(Array.isArray(layer.geometry.boxes) ? layer.geometry.boxes.slice(0, MAX_OUTLINES) : []));
  }
  if (!all.length) return;

  const { maxX, maxY } = extent(all);
  // CSS px unless the numbers overshoot the render's own CSS size.
  const scale = maxX > width * 1.02 || maxY > height * 1.02 ? 1 : dpr;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  ctx.lineWidth = 1;
  ctx.font = `${Math.round(9 * dpr)}px ui-monospace, monospace`;
  ctx.textBaseline = "top";

  const paint = (list, stroke, fallbackH, labels = false) => {
    for (const entry of list) {
      const r = rectOf(entry, fallbackH);
      if (!r) continue;
      const [x, y, w, h] = [r[0] * scale, r[1] * scale, r[2] * scale, r[3] * scale];
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 0 || h < 0) continue;
      ctx.strokeStyle = stroke;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
      const label = labels ? labelOf(entry) : "";
      // Only label boxes big enough to hold the text; line boxes are their own
      // label and would just cover the glyphs.
      if (label && w > 80 && h > 20) {
        ctx.fillStyle = stroke;
        ctx.fillText(label, x + 2, Math.max(0, y - 9 * dpr));
      }
    }
  };
  usable.forEach((layer, index) => {
    const lines = Array.isArray(layer.geometry.lines) ? layer.geometry.lines : [];
    const boxes = Array.isArray(layer.geometry.boxes) ? layer.geometry.boxes.slice(0, MAX_OUTLINES) : [];
    const lineH = lineHeightOf(lines);
    paint(lines, layer.stroke, lineH, false);
    paint(boxes, layer.boxStroke ?? layer.stroke, lineH, index === 0);
  });
}

export function paintGeometry(canvas, geometry, options) {
  paintGeometries(canvas, geometry ? [{ geometry, stroke: "rgba(29,155,240,0.85)" }] : [], options);
}

/** A and B on one layer, for the stacked diff modes where one pane covers the other. */
export function paintGeometryPair(canvas, a, b, options) {
  const layers = [];
  if (a) layers.push({ geometry: a, stroke: "rgba(29,155,240,0.9)" });
  if (b) layers.push({ geometry: b, stroke: "rgba(255,45,133,0.9)" });
  paintGeometries(canvas, layers, options);
}

export function hasGeometry(geometry) {
  if (!geometry) return false;
  const lines = Array.isArray(geometry.lines) ? geometry.lines.length : 0;
  const boxes = Array.isArray(geometry.boxes) ? geometry.boxes.length : 0;
  return lines + boxes > 0;
}
