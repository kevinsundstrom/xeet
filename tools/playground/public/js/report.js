// The report panel: everything xeet decided, and the text map that shows
// where it decided it. Plus the matrix sheet (widths × themes for one target).

import { el, escapeHtml, fmtMs, paintMsOf } from "./util.js";
import { chainLabel, stripScheme } from "./links.js";

function block(title, children, cls = "") {
  return el("div", { class: `rblock ${cls}`.trim() }, [el("h3", { text: title }), ...[].concat(children)]);
}

/**
 * Segments of `text` with a class per range. Hidden ranges beat entities when
 * they overlap, which is what a reader wants: the part that is not rendered.
 */
export function segments(text, report) {
  const src = String(text ?? "");
  const cls = new Array(src.length).fill("");
  const why = new Array(src.length).fill("");
  for (const hidden of report?.hidden ?? []) {
    const [start, end] = hidden.range ?? [];
    for (let i = Math.max(0, start); i < Math.min(src.length, end); i++) {
      cls[i] = "h-hidden";
      why[i] = hidden.why ?? "hidden";
    }
  }
  for (const entity of report?.entities ?? []) {
    const [start, end] = entity.range ?? [];
    const name = entity.kind === "url" ? "h-url" : "h-entity";
    const title = entity.display ? `${entity.kind} → ${entity.display}` : entity.kind;
    for (let i = Math.max(0, start); i < Math.min(src.length, end); i++) {
      if (!cls[i]) {
        cls[i] = name;
        why[i] = title;
      }
    }
  }
  const out = [];
  let i = 0;
  while (i < src.length) {
    let j = i + 1;
    while (j < src.length && cls[j] === cls[i] && why[j] === why[i]) j++;
    out.push({ text: src.slice(i, j), cls: cls[i], title: why[i] });
    i = j;
  }
  return out;
}

export function highlightHtml(text, report) {
  return segments(text, report)
    .map((s) => {
      const safe = escapeHtml(s.text);
      if (!s.cls) return safe;
      return `<span class="${s.cls}" title="${escapeHtml(s.title)}">${safe}</span>`;
    })
    .join("");
}

export function renderReport(container, { report, targetLabel, post, links } = {}) {
  container.textContent = "";
  if (!report) {
    container.append(el("p", { class: "empty", text: "no report yet" }));
    return;
  }

  const length = report.length ?? { weighted: 0, limit: 280, valid: true };
  const ratio = length.limit ? length.weighted / length.limit : 0;
  const state = ratio > 1 ? "over" : ratio > 0.9 ? "near" : "ok";
  const lengthSub =
    length.weighted > length.limit
      ? `${length.weighted - length.limit} over the limit`
      : `${length.limit - length.weighted} left${length.valid ? "" : " · invalid"}`;

  const size = report.size ?? { width: 0, height: 0 };
  const text = report.text ?? {};
  const attachment = report.attachment;

  const lengthBlock = block("Weighted length", [
    el("div", { class: "big", text: `${length.weighted} / ${length.limit}` }),
    el("div", { class: "sub", text: lengthSub }),
    el("div", { class: "bar", dataset: { state } }, [
      el("i", { style: { width: `${Math.min(100, Math.round(ratio * 100))}%` } }),
    ]),
  ]);

  const sizeBlock = block("Size", [
    el("div", { class: "big", text: `${Math.round(size.width)} × ${Math.round(size.height)}` }),
    el("div", {
      class: "sub",
      text: `${text.lines ?? "?"} lines${text.truncated ? " · truncated" : ""}${
        report.verifiedFor?.length ? " · verified " + report.verifiedFor.join(", ") : ""
      }`,
    }),
  ]);

  const showMore = text.showMore
    ? block("Show more", [
        el("div", { class: "big", text: text.showMore }),
        el("div", { class: "sub", text: text.truncated ? "the timeline cuts this post" : "fits in the cell" }),
      ])
    : block("Show more", [
        el("div", { class: "big", text: "none" }),
        el("div", { class: "sub", text: `${text.lines ?? 0} lines, nothing cut` }),
      ]);

  const attachmentBlock = block(
    "Attachment",
    attachment
      ? [
          el("div", { class: "big", text: attachment.shown }),
          el("div", { class: "sub", text: attachment.why || "—" }),
          attachment.url ? el("div", { class: "sub mono", text: attachment.url }) : null,
        ]
      : [el("div", { class: "big", text: "none" }), el("div", { class: "sub", text: "nothing is attached" })],
  );

  const hidden = report.hidden ?? [];
  const hiddenBlock = block(
    "Hidden ranges",
    hidden.length
      ? el(
          "ul",
          { class: "rlist" },
          hidden.map((h) =>
            el("li", {}, [
              el("span", { class: "k", text: `[${h.range[0]}, ${h.range[1]})` }),
              el("span", { class: "why", text: h.why }),
            ]),
          ),
        )
      : el("ul", { class: "rlist ok" }, [el("li", { text: "the whole text is rendered" })]),
  );

  const entities = report.entities ?? [];
  const entityBlock = block(
    `Entities · ${entities.length}`,
    entities.length
      ? el(
          "ul",
          { class: "rlist" },
          entities.slice(0, 24).map((e) =>
            el("li", {}, [
              el("span", { class: "k", text: e.kind }),
              el("span", { text: e.text }),
              e.display ? el("span", { class: "why", text: "→ " + e.display }) : null,
            ]),
          ),
        )
      : el("div", { class: "sub", text: "no URLs, mentions, hashtags or cashtags" }),
  );

  const warnings = report.warnings ?? [];
  const warningBlock = block(
    `Warnings · ${warnings.length}`,
    warnings.length
      ? el("ul", { class: "rlist warnings" }, warnings.map((w) => el("li", { text: w })))
      : el("ul", { class: "rlist ok" }, [el("li", { text: "none" })]),
  );

  const source = block("Report", [
    el("div", { class: "sub mono", text: report.ruleset || "no ruleset id" }),
    el("div", { class: "sub", text: targetLabel ? `from ${targetLabel}` : "" }),
    post ? el("div", { class: "sub", text: `${[...post.text].length} code points pasted` }) : null,
  ]);

  container.append(
    lengthBlock,
    sizeBlock,
    showMore,
    attachmentBlock,
    source,
    warningBlock,
    hiddenBlock,
    entityBlock,
  );

  const textmap = block(
    "Text as parsed",
    [
      el("div", { class: "textmap", html: highlightHtml(post?.text ?? "", report) }),
      el("div", { class: "legend-inline" }, [
        el("span", { html: '<i style="background:var(--red-soft);box-shadow:inset 0 -2px 0 var(--red)"></i>hidden' }),
        el("span", { html: '<i style="background:var(--accent-soft)"></i>entity' }),
        el("span", { html: '<i style="background:var(--green-soft)"></i>url' }),
      ]),
    ],
    "wide",
  );
  container.append(textmap);

  // A quote is an attachment of its own: show who and what, and the nested one.
  const quote = post?.quote;
  if (quote) {
    const qa = quote.author ?? {};
    const preview = String(quote.text ?? "").replace(/\s+/g, " ").slice(0, 160);
    const nested = quote.quote;
    container.append(
      block(
        "Quote",
        [
          el("div", { class: "big" }, [
            document.createTextNode(qa.handle ? `@${qa.handle}` : qa.name || "a post"),
            qa.name && qa.handle ? el("span", { class: "sub", text: ` · ${qa.name}` }) : null,
          ]),
          el("div", { class: "sub", text: preview + (String(quote.text ?? "").length > 160 ? "…" : "") }),
          quote.createdAt
            ? el("div", { class: "sub mono", text: `created ${quote.createdAt}` })
            : null,
          nested
            ? el("div", { class: "sub" }, [
                el("span", { class: "k", text: "quotes" }),
                document.createTextNode(
                  ` @${nested.author?.handle ?? nested.author?.name ?? "a post"}${
                    nested.text ? ` — ${String(nested.text).replace(/\s+/g, " ").slice(0, 80)}` : ""
                  }`,
                ),
              ])
            : null,
        ],
        "wide",
      ),
    );
  }

  const linkList = Array.isArray(links) ? links : [];
  if (linkList.length) {
    const rows = linkList.map((info) => {
      const chain = chainLabel(info);
      return el("div", { class: "linkinfo" }, [
        el("div", {
          class: "chain mono",
          text: chain || stripScheme(info.url),
          title: [info.url, ...info.chain.filter((s) => s.url).map((s) => `${s.status ?? ""} ${s.url}`.trim()), info.finalUrl]
            .filter(Boolean)
            .join("\n"),
        }),
        el("div", { class: "sub mono" }, [
          el("span", { class: "k", text: "final" }),
          document.createTextNode(" " + stripScheme(info.finalUrl ?? info.url)),
        ]),
        el("div", { class: "sub" }, [
          el("span", { class: "k", text: "card" }),
          document.createTextNode(
            ` ${info.card ?? "none"}${info.title ? ` · "${info.title}"` : ""}${
              info.image ? ` · image ${info.image.width}×${info.image.height}` : ""
            }`,
          ),
        ]),
        info.tags.length
          ? el("div", { class: "sub" }, [
              el("span", { class: "k", text: "tags" }),
              document.createTextNode(" " + info.tags.join(" · ")),
            ])
          : el("div", { class: "sub" }, [el("span", { class: "k", text: "tags" }), document.createTextNode(" none read")]),
        info.notes.length
          ? el("ul", { class: "rlist warnings" }, info.notes.map((note) => el("li", { text: note })))
          : null,
      ]);
    });
    container.append(block(`Links · ${linkList.length}`, rows, "wide"));
  }
}

// ---------------------------------------------------------------------------
// Matrix: widths × themes for one target, composed into a downloadable sheet.

// The two iPhone Duo poses first (the reason to look at a sheet), then the
// phone and desktop column widths the columns already offer.
export const MATRIX_WIDTHS = [382, 669, 320, 390, 600];
export const MATRIX_THEMES = ["light", "dark"];

export function matrixPlan(widths = MATRIX_WIDTHS, themes = MATRIX_THEMES) {
  const plan = [];
  for (const theme of themes) for (const width of widths) plan.push({ theme, width });
  return plan;
}

export function matrixCell({ width, theme, data, error }) {
  const column = data ? Math.round(data.width) : width;
  const wide = !!data && Math.round(width) > column + 0.5;
  const fig = el("figure", { class: `matrix-cell${wide ? " wide" : ""}` });
  if (data?.pngUrl) {
    if (wide) {
      const frame = el("div", { class: "matrix-frame", style: { width: `${width}px` } }, [
        el("img", {
          src: data.pngUrl,
          alt: `${width} ${theme}`,
          style: { width: `${column}px`, height: "auto" },
        }),
        el("span", { class: "frame-label", text: `${width} px viewport · ${column} column` }),
      ]);
      fig.append(frame);
    } else {
      fig.append(
        el("img", {
          src: data.pngUrl,
          alt: `${width} ${theme}`,
          style: { width: `${column}px`, height: "auto" },
        }),
      );
    }
  } else {
    fig.classList.add("pending");
    fig.append(
      el("div", { class: "placeholder" }, [el("span", { text: error ? String(error.message ?? error) : "rendering…" })]),
    );
  }
  fig.append(
    el("figcaption", {}, [
      el("span", { text: wide ? `${width} · ${theme} · ${column} col` : `${width} · ${theme}` }),
      el("span", { class: "mms", text: data ? `${fmtMs(paintMsOf(data))} ms paint` : "" }),
    ]),
  );
  fig.dataset.width = String(width);
  fig.dataset.theme = theme;
  return fig;
}

/** Composes matrix cells (already rendered images) into one labeled PNG. */
export async function composeSheet(cells, { background = "#ffffff" } = {}) {
  const gap = 24;
  const pad = 24;
  const labelH = 26;
  const columns = Math.max(...cells.map((c) => Math.max(c.plan.width, c.image.width)));
  const rows = [];
  for (const theme of [...new Set(cells.map((c) => c.plan.theme))]) {
    rows.push(cells.filter((c) => c.plan.theme === theme).sort((a, b) => a.plan.width - b.plan.width));
  }
  const cellWidth = (cell) => Math.max(cell.plan.width, cell.image.width);
  const rowWidths = rows.map((row) => row.reduce((sum, c) => sum + cellWidth(c), 0) + gap * (row.length - 1));
  const width = pad * 2 + Math.max(columns, ...rowWidths);
  const height =
    pad * 2 + rows.reduce((sum, row) => sum + labelH + Math.max(...row.map((c) => c.image.height)) + gap, -gap);

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "middle";
  let y = pad;
  for (const row of rows) {
    let x = pad;
    const rowHeight = Math.max(...row.map((c) => c.image.height));
    for (const cell of row) {
      const wide = cell.plan.width > cell.image.width + 0.5;
      ctx.fillStyle = "#536471";
      ctx.font = "600 13px ui-monospace, monospace";
      const caption = wide
        ? `${cell.plan.width} · ${cell.plan.theme} → ${cell.image.width} column`
        : `${cell.plan.width} · ${cell.plan.theme}`;
      ctx.fillText(caption, x, y + labelH / 2);
      if (wide) {
        // The device viewport, with the post column as it actually sits in it.
        ctx.save();
        ctx.strokeStyle = "#cfd9de";
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x + 0.5, y + labelH + 0.5, cell.plan.width - 1, cell.image.height - 1);
        ctx.restore();
      }
      ctx.drawImage(cell.image, x, y + labelH);
      x += cellWidth(cell) + gap;
    }
    y += labelH + rowHeight + gap;
  }
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}
