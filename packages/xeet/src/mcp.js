// MCP tool definitions (PLAN.md §2 point 1: a WASM/Node package for embedding
// in agents; §7: the MCP tool definition).
//
// Served at GET /mcp as `{ "tools": [...] }`, the shape a client needs to
// register tools; a server that speaks MCP itself would return the same array
// from `tools/list`. Keeping the definitions in the function means an agent
// discovers the exact contract of the deployment it is talking to, including
// the limits that deployment enforces.

import { optionsSchema, postSchema, sheetSchema } from "./schemas.js";
import { limitsPolicy } from "./limits.js";

export function mcpTools() {
  const limits = limitsPolicy();
  const post = {
    ...postSchema,
    description: "The post to preview. Only `text` is required.",
  };
  return [
    {
      name: "xeet_explain",
      title: "Explain a post preview",
      description:
        "Returns the decision report for a post without rendering pixels: weighted length, the visible text after URL shortening and removed ranges, the Show more cut, which attachment wins and why, and warnings. Fast; use it while drafting.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["post"],
        properties: { post, options: optionsSchema },
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      outputSchema: {
        type: "object",
        description: "The Report from crates/xeet-core/src/model.rs",
        additionalProperties: true,
        properties: {
          ruleset: { type: "string" },
          size: { type: "object", properties: { width: { type: "number" }, height: { type: "number" } } },
          length: { type: "object", properties: { weighted: { type: "integer" }, limit: { type: "integer" }, valid: { type: "boolean" } } },
          warnings: { type: "array", items: { type: "string" } },
        },
      },
    },
    {
      name: "xeet_render",
      title: "Render a post to PNG",
      description:
        "Renders the post as X shows it and returns an image content block (PNG) plus the decision report as structured content. Text, links and link cards are supported; media renders as a labeled placeholder unless you supply bytes.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["post"],
        properties: { post, options: optionsSchema },
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "xeet_sheet",
      title: "Render a sheet of viewports and themes",
      description: `Renders one post at several widths and both themes into a single labeled PNG: the artifact a review wants. At most ${limits.sheet_cells} cells.`,
      inputSchema: sheetSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ];
}
