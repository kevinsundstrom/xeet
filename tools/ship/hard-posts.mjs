// The site's hard-tweet examples (app/_lib/hard.js) as complete posts, with
// their avatars, badges, card images and media inlined from app/_assets/.
// Shared by readme-gallery.mjs and promo-video.mjs so both render exactly the
// pixels the site shows.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARD } from "../../app/_lib/hard.js";
import { vercelAvatarBase64 } from "../../app/_lib/vercel-avatar.js";

export { HARD };
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ASSETS = join(ROOT, "app/_assets");

const asset = (rel) => readFileSync(join(ASSETS, rel.replace(/^\.\//, ""))).toString("base64");

/** `@handle` → avatar file, for every avatar the examples ship with. */
function avatarFor(handle) {
  if (handle === "vercel") return vercelAvatarBase64();
  for (const ext of ["jpg", "png"]) {
    const rel = `avatars/${handle}.${ext}`;
    if (existsSync(join(ASSETS, rel))) return asset(rel);
  }
  return null;
}

function withAvatars(post) {
  if (!post) return post;
  const out = { ...post };
  const handle = out.author?.handle;
  if (handle && !out.author.avatar) {
    const avatar = avatarFor(handle);
    if (avatar) out.author = { ...out.author, avatar };
  }
  if (Array.isArray(out.media)) {
    out.media = out.media.map((m) => {
      const sh = m.sourceAuthor?.handle;
      const avatar = sh && !m.sourceAuthor.avatar ? avatarFor(sh) : null;
      return avatar ? { ...m, sourceAuthor: { ...m.sourceAuthor, avatar } } : m;
    });
  }
  if (out.quote) out.quote = withAvatars(out.quote);
  return out;
}

/** One example from `HARD`, with every image it needs inlined as base64. */
export function buildPost(item) {
  const post = withAvatars({ ...item.post, links: { ...item.post.links } });
  for (const [url, path] of Object.entries(item.assets?.cards ?? {})) {
    if (post.links[url]?.image) {
      post.links[url] = { ...post.links[url], image: { ...post.links[url].image, data: asset(path) } };
    }
  }
  if (item.assets?.media?.length && post.media?.length) {
    post.media = post.media.map((m, i) => (item.assets.media[i] ? { ...m, data: asset(item.assets.media[i]) } : m));
  }
  if (item.assets?.quoteMedia?.length && post.quote?.media?.length) {
    post.quote = {
      ...post.quote,
      media: post.quote.media.map((m, i) =>
        item.assets.quoteMedia[i] ? { ...m, data: asset(item.assets.quoteMedia[i]) } : m,
      ),
    };
  }
  if (item.assets?.affiliateBadge && post.author?.affiliate) {
    post.author = { ...post.author, affiliate: { ...post.author.affiliate, badge: asset(item.assets.affiliateBadge) } };
  }
  if (item.assets?.quoteAffiliateBadge && post.quote?.author?.affiliate) {
    post.quote = {
      ...post.quote,
      author: {
        ...post.quote.author,
        affiliate: { ...post.quote.author.affiliate, badge: asset(item.assets.quoteAffiliateBadge) },
      },
    };
  }
  return post;
}
