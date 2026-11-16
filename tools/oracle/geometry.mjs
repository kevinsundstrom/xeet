// Page-side geometry extraction, shared by every oracle script.
// `dumpGeometry` runs inside the page (Playwright serializes it), so it must
// not reference anything outside its own body.

/** Returns { rect, boxes, texts } for the nth element matching `selector`. */
export function dumpGeometry({ selector, index = 0, maxDepth = 40 }) {
  const root = document.querySelectorAll(selector)[index];
  if (!root) return null;
  const origin = root.getBoundingClientRect();
  const r4 = (v) => Math.round(v * 1000) / 1000;
  const texts = [];
  const boxes = [];
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  function textFragments(node, depth) {
    const s = node.data;
    if (!s) return;
    const parent = node.parentElement;
    const style = getComputedStyle(parent);
    const role = parent.closest("[data-xeet]")?.dataset.xeet ?? null;
    const range = document.createRange();
    let cur = null;
    // Walk by grapheme so a cluster is never split across a measurement.
    for (const { segment, index: at } of seg.segment(s)) {
      range.setStart(node, at);
      range.setEnd(node, at + segment.length);
      const rects = range.getClientRects();
      if (rects.length === 0) {
        // Not rendered: a newline in pre-wrap, or clipped content.
        if (segment === "\n") cur = null;
        else if (cur) cur.text += segment;
        continue;
      }
      const r = rects[0];
      const sameLine = cur && Math.abs(cur.top - r.top) < 0.5 && r.left >= cur.right - 0.75;
      if (sameLine) {
        cur.text += segment;
        cur.right = r.right;
      } else {
        cur = {
          text: segment, left: r.left, right: r.right, top: r.top, height: r.height,
          depth, role, size: parseFloat(style.fontSize), weight: Number(style.fontWeight), color: style.color,
        };
        texts.push(cur);
      }
    }
  }

  function walk(el, depth) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const r = el.getBoundingClientRect();
    const hasBorder = cs.borderTopWidth !== "0px" || cs.borderBottomWidth !== "0px";
    boxes.push({
      depth,
      tag: el.tagName.toLowerCase(),
      role: el.dataset?.xeet ?? null,
      cls: (el.getAttribute("class") ?? "").slice(0, 400),
      x: r4(r.left - origin.left), y: r4(r.top - origin.top), w: r4(r.width), h: r4(r.height),
      radius: cs.borderTopLeftRadius !== "0px" ? cs.borderTopLeftRadius : undefined,
      bg: cs.backgroundColor !== "rgba(0, 0, 0, 0)" ? cs.backgroundColor : undefined,
      border: hasBorder ? `${cs.borderTopWidth} ${cs.borderBottomWidth} ${cs.borderTopColor}` : undefined,
      color: cs.color,
    });
    if (depth >= maxDepth) return;
    for (const child of el.childNodes) {
      if (child.nodeType === 1) walk(child, depth + 1);
      else if (child.nodeType === 3) textFragments(child, depth + 1);
    }
  }

  walk(root, 0);
  return {
    rect: { x: r4(origin.left), y: r4(origin.top), w: r4(origin.width), h: r4(origin.height) },
    boxes,
    texts: texts.map((t) => ({
      text: t.text, role: t.role, depth: t.depth, size: t.size, weight: t.weight, color: t.color,
      x: r4(t.left - origin.left), y: r4(t.top - origin.top), w: r4(t.right - t.left), h: r4(t.height),
    })),
  };
}
