// Compile-only check that the published types fit real usage:
//   pnpm dlx -p typescript tsc --noEmit --strict --module nodenext --moduleResolution nodenext packages/xeet/test/types-check.ts
import { writeFileSync } from "node:fs";
import { loadXeet, type Post, type RenderOptions } from "@xeet/core/node";
import { memoryCache } from "@xeet/core/resolve";

const xeet = await loadXeet();

const post: Post = {
  text: "We just shipped the thing.",
  author: { name: "Vercel", handle: "vercel", verified: "business", squareAvatar: true },
  counts: { replies: 12, reposts: 148, likes: 2043 },
};
const options: RenderOptions = { surface: "web-timeline", width: 390, theme: "dark", dpr: 2 };

const { png, report } = xeet.render(post, options);
writeFileSync("post.png", png);
const weighted: number = report.length.weighted;
const cut: "inline" | "clamped" | null = report.text.showMore;
const canExpand: boolean = xeet.hasShowMore(post, options);
if (canExpand) {
  xeet.render(post, { ...options, expanded: true });
}

const host = xeet.whatwgHost({ fetch, ...memoryCache() });
const resolved = await xeet.resolve("https://x.com/NASAGoddard/status/928356699043491842", { media: true }, host);
xeet.render(resolved.post, { width: 600 });
xeet.render(resolved.post, { surface: "ios-timeline", width: 382, dpr: 3 });
xeet.render(resolved.post, { surface: "ios-detail", width: 382, dpr: 3 });

// @ts-expect-error: theme is "light" or "dark"
xeet.render(post, { theme: "dim" });

export { weighted, cut };
