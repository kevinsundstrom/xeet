import resolver from "../../_lib/playground-resolve-server.js";

export const runtime = "nodejs";
export const maxDuration = 25;

export async function POST(request) {
  return resolver.fetch(request);
}

export async function GET(request) {
  return resolver.fetch(request);
}
