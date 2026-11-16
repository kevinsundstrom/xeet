// Device presets: a viewport width and the pixel density together.
//
// The iPhone Duo figures are WebKit's, published at launch (2026-10-23) in
// "WebKit Features for Safari 27.1": CSS px at dpr 3. The closed outer display
// is 382, not 466 — Safari keeps an 84 pt system strip there.
//
// X's post column is min(viewport, 600), so the wide poses (669, 951) render a
// 600 column inside a wider viewport; the UI draws that viewport around the
// column so the difference is visible.

export const DEVICE_SOURCE = "WebKit “WebKit Features for Safari 27.1”";
export const DEVICE_NOTE =
  `${DEVICE_SOURCE} (2026-10-23): CSS px at dpr 3. The Duo's closed outer display is 382, not 466 — ` +
  `Safari keeps an 84 pt system strip there. X's column is min(viewport, 600).`;

export const DEVICES = [
  { id: "duo-closed", group: "iPhone Duo", label: "iPhone Duo · closed 382", width: 382, dpr: 3 },
  { id: "duo-closed-landscape", group: "iPhone Duo", label: "iPhone Duo · closed landscape 594", width: 594, dpr: 3 },
  { id: "duo-open", group: "iPhone Duo", label: "iPhone Duo · open 669", width: 669, dpr: 3 },
  { id: "duo-open-landscape", group: "iPhone Duo", label: "iPhone Duo · open landscape 951", width: 951, dpr: 3 },
  { id: "duo-split", group: "iPhone Duo", label: "iPhone Duo · split view 385", width: 385, dpr: 3 },
  { id: "iphone-375", group: "iPhone", label: "iPhone SE · 375", width: 375, dpr: 2 },
  { id: "iphone-390", group: "iPhone", label: "iPhone 16 / 15 · 390", width: 390, dpr: 3 },
  { id: "iphone-430", group: "iPhone", label: "iPhone 17 Pro Max · 430", width: 430, dpr: 3 },
  { id: "iphone-440", group: "iPhone", label: "iPhone Plus · 440", width: 440, dpr: 3 },
  { id: "desktop-600", group: "Desktop", label: "Desktop column · 600", width: 600, dpr: 2 },
  { id: "desktop-1200", group: "Desktop", label: "Desktop · 1200", width: 1200, dpr: 2 },
];

/** The label X's own column width brings: min(viewport, 600). */
export const COLUMN_MAX = 600;
export const columnWidth = (viewport) => Math.min(Number(viewport) || COLUMN_MAX, COLUMN_MAX);

/** The preset that matches a width/dpr pair exactly, or "" for a custom one. */
export function deviceFor(width, dpr) {
  const w = Math.round(Number(width));
  const d = Number(dpr);
  const match = DEVICES.find((device) => device.width === w && device.dpr === d);
  return match?.id ?? "";
}

export function deviceById(id) {
  return DEVICES.find((device) => device.id === id) ?? null;
}

/** "iPhone Duo · open 669 @3x" */
export function deviceLabel(device) {
  return `${device.label} @${device.dpr}x`;
}
