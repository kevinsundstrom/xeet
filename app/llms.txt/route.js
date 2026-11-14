import { readFileSync } from "node:fs";

export const dynamic = "force-static";

const LLMS_TXT = readFileSync(new URL("../_assets/llms.txt", import.meta.url), "utf8");

export function GET() {
  return new Response(LLMS_TXT, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
