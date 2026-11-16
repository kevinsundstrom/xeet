// The WHATWG host adapter stops reading a body at `maxBytes`. It used to buffer
// the whole response first and cut afterwards, so an oversized upstream body
// cost its full size in memory before the limit meant anything.
import { test } from "node:test";
import assert from "node:assert/strict";

import { whatwgHost } from "../src/resolve.js";

const CHUNK = 64 * 1024;

function streamingResponse(chunks, pulled, headers = {}) {
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i >= chunks) {
        controller.close();
        return;
      }
      pulled.count += 1;
      i += 1;
      controller.enqueue(new Uint8Array(CHUNK).fill(0x61));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } });
}

test("a declared length past the cap still delivers the first maxBytes", async () => {
  // The library reads a cut page's head for its card tags, so a body that
  // announces 4 MiB must still arrive as its first 100,000 bytes, truncated.
  const pulled = { count: 0 };
  const host = whatwgHost({
    fetch: async () => streamingResponse(64, pulled, { "content-length": String(64 * CHUNK) }),
  });
  const response = await host.fetch({ url: "https://example.test/page", maxBytes: 100_000 });
  assert.equal(response.truncated, true);
  assert.equal(response.body.byteLength, 100_000);
  assert.ok(pulled.count <= 3, `pulled ${pulled.count} chunks of 64`);
});

test("the host reads up to maxBytes and stops, not the whole body", async () => {
  const pulled = { count: 0 };
  const host = whatwgHost({ fetch: async () => streamingResponse(64, pulled) });
  const response = await host.fetch({ url: "https://example.test/page", maxBytes: 100_000 });
  assert.equal(response.truncated, true);
  assert.equal(response.body.byteLength, 100_000);
  // 100,000 bytes is one full 64 KiB chunk and part of a second; a whole-body
  // read would have pulled all 64 (4 MiB).
  assert.ok(pulled.count <= 3, `pulled ${pulled.count} chunks of 64`);
});

test("a body under maxBytes is read whole and not marked truncated", async () => {
  const pulled = { count: 0 };
  const host = whatwgHost({ fetch: async () => streamingResponse(2, pulled) });
  const response = await host.fetch({ url: "https://example.test/page", maxBytes: 1_000_000 });
  assert.equal(response.truncated, false);
  assert.equal(response.body.byteLength, 2 * CHUNK);
});
