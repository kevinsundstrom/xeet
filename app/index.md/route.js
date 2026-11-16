import { readFileSync } from "node:fs";

export const dynamic = "force-static";

const REPO = "https://github.com/rauchg/xeet/blob/main/";
const RAW_README = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

export function buildReadmeMarkdown() {
  const readme = RAW_README
    .replace(/\]\((?!https?:|#|mailto:)(?:\.\/)?([^)\s]+)\)/g, (_, p) => `](${REPO}${p})`)
    .replace(/\b(href|src|srcset)="(?!https?:|#|mailto:)(?:\.\/)?([^"\s]+)"/g, (_, attr, p) => `${attr}="${REPO}${p}"`);
  return `${readme.trimEnd()}\n\n---\n\nLive demo: https://xeet-rs.vercel.app · Index for LLMs: /llms.txt\n`;
}

export function GET() {
  return new Response(buildReadmeMarkdown(), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
