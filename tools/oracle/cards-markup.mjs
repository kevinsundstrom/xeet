// Markup for the two components the corpus does not contain, written out from
// the client component code so Chrome still lays it out with X's stylesheet.
//
// Sources: `HlKpYMvh.js` (the `summary` card: `thumbnail-detail`) and
// `DIdg36-I.js` (the poll choice list). Class names are copied verbatim; only
// the data is ours. `tools/oracle/cards-parity.mjs` renders these against
// `assets/vendor/upstream/styles.css` exactly like the captured pages.

/** `thumbnail-detail`: square 90 px thumbnail, domain, title, no description. */
export function summaryCard({ domain, title, image }) {
  const cleanDomain = String(domain ?? "").replace(/^www\./i, "");
  const img = image
    ? `<div style="aspect-ratio:fill" class="h-full w-full"><img class="object-cover h-full w-full" src="${image}"/></div>`
    : `<div class="bg-secondary flex h-full w-full items-center justify-center"><svg class="text-secondary h-8 w-8" viewBox="0 0 24 24"><use href="#icon-link"></use></svg></div>`;
  return `<div class="flex flex-col gap-3 empty:hidden"><div class="flex flex-col gap-3 empty:hidden">
    <a class="border-normal bg-secondary flex cursor-pointer overflow-hidden rounded-md border">
      <div class="border-normal relative aspect-square w-[90px] shrink-0 overflow-hidden border-e sm:w-[130px]">${img}</div>
      <div class="flex min-w-0 flex-1 flex-col justify-center gap-0.5 p-3">
        <div class="max-w-full text-subtext2 font-normal text-secondary line-clamp-1">${cleanDomain}</div>
        <div class="max-w-full text-body font-normal text-primary line-clamp-2 sm:line-clamp-1">${title}</div>
      </div>
    </a>
  </div></div>`;
}

/** `summary_large_image`: a 1.91 image with the title pill over it, `From …` below. */
export function largeCard({ title, domain, image, width, height }) {
  const cleanDomain = String(domain ?? "").replace(/^www\./i, "");
  const url = "https://example.com/a";
  return `<div class="flex flex-col gap-3 empty:hidden"><div class="flex flex-col gap-3 empty:hidden"><div class="flex flex-col gap-1">
    <a href="${url}" target="_blank" rel="noopener noreferrer" class="x-link disabled:cursor-not-allowed disabled:opacity-70 max-w-full border-normal bg-secondary relative block cursor-pointer overflow-hidden rounded-md border">
      <div class="relative w-full overflow-hidden" style="aspect-ratio:1.91">
        <img height="${height}" width="${width}" alt="" class="h-full w-full object-cover" decoding="async" loading="lazy" src="${image}"/>
      </div>
      <div class="absolute inset-s-3 inset-e-3 bottom-3">
        <div class="inline-flex h-5 max-w-full items-center rounded-xs bg-black/75 px-2">
          <div class="max-w-full text-subtext2 font-normal line-clamp-1 text-ellipsis text-white">${title}</div>
        </div>
      </div>
    </a>
    <a href="${url}" target="_blank" rel="noopener noreferrer" class="rounded-xs x-link disabled:cursor-not-allowed disabled:opacity-70 hover:underline max-w-full text-secondary block w-fit">
      <div class="max-w-full text-subtext2 font-normal text-secondary line-clamp-1">From ${cleanDomain}</div>
    </a>
  </div></div></div>`;
}

/**
 * The poll results view: one pill per choice, `min-h-12`, a result bar behind
 * the label, the percentage right-aligned.
 */
export function pollResults({ choices, votes }) {
  const total = votes.reduce((a, b) => a + b, 0) || 1;
  const rows = choices
    .map((label, i) => {
      const share = votes[i] / total;
      return `<div class="outline-focus flex items-center gap-2 rounded-xl">
        <div class="text-body relative grid rounded-full min-h-12 min-w-0 flex-1" style="--poll-choice-share:${share}">
          <span aria-hidden="true" class="border-normal pointer-events-none absolute inset-0 rounded-full border"></span>
          <span aria-hidden="true" class="pointer-events-none absolute inset-y-0 start-0 w-[calc(var(--poll-choice-share)*100%)] rounded-full bg-(--x-border-active)"></span>
          <span class="relative grid items-center px-4 py-2 wrap-anywhere grid-cols-[1fr_fit-content(calc(100%-5rem))_0rem_1fr] text-center">
            <span class="grid min-w-0">
              <span class="col-start-1 row-start-1 self-center font-bold text-primary">${label}</span>
            </span>
            <span class="justify-self-end ps-3">${(share * 100).toFixed(0)}%</span>
          </span>
        </div>
      </div>`;
    })
    .join("");
  return `<div class="flex flex-col gap-3 empty:hidden"><div class="flex flex-col gap-3 empty:hidden">
    <div class="relative grid"><div class="col-start-1 row-start-1 flex flex-col gap-2 self-start" role="list">${rows}</div></div>
  </div></div>`;
}

// ----------------------------------------------- the nested quote preview --
//
// Classes copied verbatim from X's client (`assets/vendor/upstream/js/dfWSwB9n.js`,
// the i18n module `nested-quote-preview-SIs_tkfq`, component `ve`) and from the
// captured quote card it is placed in (`assets/vendor/corpus/XDevelopers.html`).
// The corpus has no post that quotes a quote, so these fixtures are the only
// way to render the component with X's own stylesheet.

const AVATAR = "https://pbs.twimg.com/profile_images/1683501992314798080/xl1POYLw_normal.jpg";
const PHOTO = "https://pbs.twimg.com/media/HUaH8KXaIAAU5Jc?format=webp&name=small";

function avatar(size) {
  return `<a href="/u" class="x-link max-w-full rounded-none"><div class="x-avatar rounded-full ${size} transition duration-200 hover:brightness-90"><img draggable="false" alt="" class="size-full object-cover brightness-100" decoding="async" loading="lazy" src="${AVATAR}"/></div></a>`;
}

function check() {
  return `<div class="max-w-full text-body font-normal text-primary flex shrink-0 items-center gap-1"><span aria-label="Verified account" class="flex cursor-pointer items-center" role="button"><svg fill="none" viewBox="0 0 24 24" display="flex" role="img" width="1em" height="1em" aria-hidden="true" class="size-[1em] shrink-0"><use href="#icon-verified-premium-color"></use></svg></span></div>`;
}

/** The `user-name` + `timestamp` header row, at `size-6` (quote card) or `size-4` (preview). */
function userRow({ name, handle, stamp, avatarSize = "size-6" }) {
  return `<div class="flex min-w-0 items-center gap-1">
    ${avatar(avatarSize)}
    <div class="x-middot-group max-w-full text-body font-normal text-secondary min-w-0">
      <span class="max-w-full min-w-0 flex shrink-0 items-center gap-1">
        <a href="/u" class="x-link max-w-full min-w-0"><div class="max-w-full text-body font-bold text-primary line-clamp-1 break-all min-w-0">${name}</div></a>
        ${check()}
      </span>
      <span class="flex max-w-full min-w-0 items-center gap-2"><a href="/u" class="x-link max-w-full min-w-0"><span class="max-w-full text-body font-normal text-secondary line-clamp-1 wrap-break-word">@${handle}</span></a></span>
      <span class="inline-flex w-fit shrink-0 whitespace-nowrap"><a href="/u/status/1" class="x-link max-w-full text-body text-secondary inline-flex w-fit">${stamp}</a></span>
    </div>
  </div>`;
}

/** A two-line `subtext1` body; entities stay `primary`, as `render-entity-as-text` does. */
function body(text, size = "text-subtext1", lines = "line-clamp-2") {
  return `<div class="max-w-full ${size} font-normal text-primary ${lines} whitespace-pre-wrap wrap-anywhere" dir="auto">${text}</div>`;
}

/** The 64×64 thumbnail, with `+N` when the post has more than one photo, else the play circle for a video. */
function thumb({ count = 1, video = false }) {
  const overlay =
    count > 1
      ? `<div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40"><span class="text-white font-bold text-subtext1">+${count - 1}</span></div>`
      : video
        ? `<div class="pointer-events-none absolute inset-0 flex items-center justify-center"><span class="flex size-6 items-center justify-center rounded-full bg-black/60 text-white"><svg fill="currentColor" viewBox="0 0 24 24" display="flex" role="img" width="1em" height="1em" aria-hidden="true" class="size-3.5"><path d="M6 17.93V6.07a2 2 0 0 1 3.05-1.7l9.67 5.92a2 2 0 0 1 0 3.42l-9.67 5.92A2 2 0 0 1 6 17.93"></path></svg></span></div>`
        : "";
  return `<div class="border-normal bg-secondary relative size-16 shrink-0 overflow-hidden rounded-sm border"><img class="h-full w-full object-cover" decoding="async" loading="lazy" src="${PHOTO}"/>${overlay}</div>`;
}

/**
 * `ve`: the nested quote preview. `media` is `{ count, video }` or null.
 * The hover wrapper's `-mx-1.5 -my-1 px-1.5 py-1` cancel out, so it adds no box.
 */
export function nestedPreview({ name, handle, stamp, text, media = null }) {
  const withMedia = media
    ? `<div class="flex min-w-0 items-center gap-2">${thumb(media)}<div class="min-w-0 flex-1">${body(text)}</div></div>`
    : body(text);
  return `<div class="-mx-1.5 -my-1 rounded-[9px] px-1.5 py-1"><span class="sr-only">Quote</span><div class="flex">
    <div aria-hidden="true" class="bg-tertiary w-[3px] shrink-0 rounded-full"></div>
    <div class="flex min-w-0 flex-1 flex-col gap-2 py-1 ps-3">
      ${userRow({ name, handle, stamp, avatarSize: "size-4" })}
      ${withMedia}
    </div>
  </div></div>`;
}

/**
 * The quote card itself (X's `embedded-tweet-frame`): `p-3` header/text block,
 * optional flush media, then the nested preview in `p-3 [:first-child+&]:pt-0`.
 */
export function quoteCard({ name, handle, stamp, text, media = null, nested = null }) {
  const mediaHtml = media
    ? `<div class="mx-auto relative overflow-hidden" style="aspect-ratio:${media.ar}"><div class="relative h-full w-full"><img class="h-full w-full object-cover" decoding="async" loading="lazy" src="${PHOTO}"/></div></div>`
    : "";
  const nestedHtml = nested ? `<div class="p-3 [:first-child+&]:pt-0">${nested}</div>` : "";
  return `<div class="flex flex-col gap-3 empty:hidden"><div class="flex flex-col gap-3 empty:hidden">
    <div class="outline-focus transition-colors [--media-overhang-end:0px] [--media-overhang-start:0px] border-normal overflow-hidden rounded-2xl border relative">
      <a aria-hidden="true" class="absolute inset-0 pointer-events-none" href="/u/status/1" tabindex="-1"></a>
      <article>
        <div class="flex flex-col gap-1 p-3">
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            ${userRow({ name, handle, stamp })}
            ${body(text, "text-body", "line-clamp-5")}
          </div>
        </div>
        ${mediaHtml}
        ${nestedHtml}
      </article>
    </div>
  </div></div>`;
}

// --------------------------------------- the "Post video" / "Post photo" pill --
//
// Classes copied verbatim from the captured post
// (`assets/vendor/corpus/ESPN.html`, 2120005259485425936, @espn posting @NFL's
// video) and from the photo badge component in
// `assets/vendor/upstream/js/BNn3ozGQ.js` (`ie`, `photo_attribution_label`).

const NFL_AVATAR = "https://pbs.twimg.com/profile_images/1619895559334273028/PHKS_mjX_normal.jpg";

function attributionInner({ name, verified, square = true }) {
  const check =
    verified === "none"
      ? ""
      : `<div class="max-w-full text-subtext2 font-normal text-primary flex shrink-0 items-center gap-1"><span aria-label="Verified account" class="flex cursor-pointer items-center" role="button" tabindex="0"><svg fill="none" viewBox="0 0 24 24" display="flex" role="img" width="1em" height="1em" aria-hidden="true" aria-label="Verified account" class="size-[1em] shrink-0"><use href="#icon-verified-${verified}-color"></use></svg></span></div>`;
  return `<span class="inline-flex min-w-0 items-center gap-1 align-middle">
    <span class="inline-flex size-[13px] shrink-0"><div class="x-avatar ${square ? "rounded-[10%]" : "rounded-full"} size-full" aria-hidden="true"><img draggable="false" alt="" class="size-full object-cover brightness-100" decoding="async" loading="lazy" src="${NFL_AVATAR}"/></div></span>
    <div class="flex items-center gap-1 min-w-0">
      <span class="max-w-full min-w-0 flex shrink-0 items-center gap-1">
        <div class="max-w-full text-subtext2 font-normal text-white line-clamp-1 break-all min-w-0">${name}</div>
        ${check}
      </span>
    </div>
  </span>`;
}

/** The duration pill, with the attribution span after `ms-2` (ESPN, verbatim). */
export function videoPill({ clock = "00:24", name, verified = "business", square = true } = {}) {
  const attr = name
    ? `<span class="inline-flex min-w-0 items-center gap-1 align-middle ms-2">${attributionInner({ name, verified, square })}</span>`
    : "";
  return `<div class="flex min-w-0 items-center gap-0.5">
    <div class="inline-flex h-5 items-center gap-1 rounded-sm px-2 font-medium [&amp;_svg]:size-[1em] bg-black-80 text-on-color text-subtext2 min-w-0 shrink">
      <span aria-hidden="true">${clock}</span>${attr}
    </div>
  </div>`;
}

/** The photo form (`ie`): `rounded-[6px] bg-black/70 py-1 ps-1 pe-2`. */
export function photoBadge({ name, verified = "blue", square = false } = {}) {
  return `<span class="text-subtext2 inline-flex max-w-full min-w-0 items-center rounded-[6px] bg-black/70 py-1 ps-1 pe-2 group-hover:bg-[rgba(45,45,45,0.85)]">${attributionInner({ name, verified, square })}</span>`;
}

/** A video media slot (ESPN's wrapper) with the attributed pill. */
export function videoAttributed({ ar = "1.7777777777777777", clock = "00:24", name, verified, square } = {}) {
  return `<div class="flex flex-col gap-3 empty:hidden"><div class="flex flex-col gap-3 empty:hidden">
    <div class="relative overflow-hidden after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-[inherit] after:border after:border-normal after:[corner-shape:inherit] rounded-md" style="aspect-ratio:${ar}">
      <div class="relative isolate z-0 flex h-full w-full overflow-hidden bg-black tabular-nums">
        <img alt="" class="absolute inset-0 z-0 h-full w-full object-cover" decoding="async" loading="lazy" src="${PHOTO}"/>
        <div class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center" style="opacity:1">
          <div class="z-10 flex" style="transform:none">
            <button data-slot="xds-button" aria-label="Play" type="button" class="group x-button transition-colors h-12 text-headline2 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-6 bg-black-40 text-on-color backdrop-blur-lg hover:bg-black-50 active:bg-black-60 w-12 min-w-12 px-0 pointer-events-auto">
              <span class="x-button-slot" style="opacity:1"><svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" data-icon="icon-player-play" viewBox="0 0 24 24" display="flex" role="img" width="1em" height="1em" aria-hidden="true"><path d="M6 17.93V6.07a2 2 0 0 1 3.05-1.7l9.67 5.92a2 2 0 0 1 0 3.42l-9.67 5.92A2 2 0 0 1 6 17.93"></path></svg></span>
            </button>
          </div>
        </div>
        <div class="pointer-events-none absolute z-1 flex bottom-3 start-3" style="opacity:1">
          <div class="pointer-events-auto flex min-w-0">${videoPill({ clock, name, verified, square })}</div>
        </div>
      </div>
    </div>
  </div></div>`;
}

/** A photo media slot (Polygon's wrapper) with the attributed badge, after any ALT badge. */
export function photoAttributed({ ar = "1.910828025477707", name, verified, square, alt = false } = {}) {
  const altHtml = alt
    ? `<button type="button" class="group x-button transition-colors h-6 text-subtext1 bg-black-40 text-on-color px-3 max-w-full overflow-clip" style="border-radius:9999px"><span class="min-w-0 overflow-x-clip text-ellipsis whitespace-nowrap">ALT</span></button>`
    : "";
  return `<div class="flex flex-col gap-3 empty:hidden"><div class="flex flex-col gap-3 empty:hidden">
    <div class="relative overflow-hidden after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-[inherit] after:border after:border-normal after:[corner-shape:inherit] rounded-md" style="aspect-ratio:${ar}">
      <div class="relative h-full w-full"><img class="w-full h-full object-cover" decoding="async" loading="lazy" src="${PHOTO}"/></div>
      <div class="absolute inset-s-3 bottom-3 z-10 flex max-w-[calc(100%-24px)] items-center gap-1">
        ${altHtml}${photoBadge({ name, verified, square })}
      </div>
    </div>
  </div></div>`;
}
