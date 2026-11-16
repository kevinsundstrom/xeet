// Compile-only check that the published types fit real usage:
//   pnpm --package=typescript dlx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext packages/xeet/test/types-check.ts
import {
  loadXeet,
  type Attachment,
  type BatchItem,
  type MediaAsset,
  type Post,
  type RenderOptions,
  type RenderResult,
  type Resolved,
  type ResolvedLink,
  type RgbaResult,
} from "@xeet/core/node";
import { memoryCache } from "@xeet/core/resolve";

const xeet = await loadXeet();

const post: Post = {
  text: "We just shipped the thing.",
  author: { name: "Vercel", handle: "vercel", verified: "business", squareAvatar: true },
  counts: { replies: 12, reposts: 148, likes: 2043 },
};
const options: RenderOptions = { surface: "web-timeline", width: 390, theme: "dark", dpr: 2 };

const rendered: RenderResult = xeet.render(post, options);
const { png, report } = rendered;
const pngBytes: Uint8Array = png;
const weighted: number = report.length.weighted;
const cssWidth: number = report.size.width;
const attachment: Attachment | null = report.attachment;
const cut: "inline" | "clamped" | null = report.text.showMore;
const rgba: RgbaResult = xeet.renderRgba(post, options);
const batch: BatchItem[] = xeet.renderMany(post, [options]);
const canExpand: boolean = xeet.hasShowMore(post, options);
if (canExpand) {
  xeet.render(post, { ...options, expanded: true });
}

const host = xeet.whatwgHost({ fetch, ...memoryCache() });
const resolved: Resolved = await xeet.resolve("https://x.com/NASAGoddard/status/928356699043491842", { media: true }, host);
const linkCard: ResolvedLink = await xeet.resolveLinks("https://t.co/jO01BMGwXr", { media: false }, host);
const firstAsset: MediaAsset | undefined = Object.values(resolved.media)[0];
xeet.render(resolved.post, { width: 600 });
xeet.render(resolved.post, { surface: "ios-timeline", width: 382, dpr: 3 });
xeet.render(resolved.post, { surface: "ios-detail", width: 382, dpr: 3 });

// @ts-expect-error: theme is "light" or "dark"
xeet.render(post, { theme: "dim" });

export { pngBytes, weighted, cssWidth, attachment, cut, rgba, batch, linkCard, firstAsset };
