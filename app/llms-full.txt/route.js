import { buildReadmeMarkdown } from "../index.md/route.js";

export const dynamic = "force-static";

export function GET() {
  return new Response(buildReadmeMarkdown(), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
