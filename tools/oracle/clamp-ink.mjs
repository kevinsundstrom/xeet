// Chrome's `-webkit-line-clamp` ellipsis, measured in pixels.
//
// The DOM cannot show it: a Range over the clamped block still reports every
// line the clamp hides, and the `…` is not a text node at all. So compare the
// ink of the last visible line: the replica's screenshot against our own
// render, band by band.
//
//   node tools/oracle/replica.mjs --fixtures fixtures.json --out tmp/g --shot
//   cargo run -p xeet-core --example frame_parity -- --fixtures fixtures.json \
//     --geometry tmp/g --png tmp/ours
//   node tools/oracle/clamp-ink.mjs tmp/g/<fixture>.png tmp/ours/<fixture>.png \
//     tmp/g/<fixture>.json <last visible line index> <line height>
//
// Prints the ink bounding box of that line on both sides, in CSS px. A missing
// ellipsis moves the box by the ellipsis advance (11.04px at 15px); a trimmed
// trailing space moves it by the space (3.39px). Development only.

import { readFileSync } from "node:fs";
import { decodePng } from "./raster-lib.mjs";

const [chromePng, oursPng, fxJson, lineIndex, lineHeight] = process.argv.slice(2);
const chrome = decodePng(readFileSync(chromePng));
const ours = decodePng(readFileSync(oursPng));
const fx = JSON.parse(readFileSync(fxJson, "utf8"));
const box = fx.boxes.text;
const lh = Number(lineHeight);
const i = Number(lineIndex);
const y0 = Math.round((box.y + i * lh) * 2);
const y1 = Math.round((box.y + (i + 1) * lh) * 2);

const ink = (img) => {
  // The background is whatever the cell's top-left corner is.
  const bg = [img.data[0], img.data[1], img.data[2]];
  let left = Infinity, right = -Infinity, count = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      const d = Math.max(
        Math.abs(img.data[o] - bg[0]),
        Math.abs(img.data[o + 1] - bg[1]),
        Math.abs(img.data[o + 2] - bg[2]),
      );
      if (d > 12) {
        if (x < left) left = x;
        if (x > right) right = x;
        count++;
      }
    }
  }
  return { left: left / 2, right: (right + 1) / 2, count };
};

const c = ink(chrome);
const o = ink(ours);
console.log(JSON.stringify({
  fixture: fx.fixture.name,
  chromeSize: [chrome.width, chrome.height],
  oursSize: [ours.width, ours.height],
  inkChrome: c,
  inkOurs: o,
  dLeft: +(o.left - c.left).toFixed(2),
  dRight: +(o.right - c.right).toFixed(2),
}, null, 1));
