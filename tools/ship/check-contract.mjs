#!/usr/bin/env node
// Keeps the published contract honest: the JSON Schema agents read, the limits
// the HTTP function advertises, and the Rust model must agree.
//
//   node tools/ship/check-contract.mjs
//
// Three checks:
//   1. Every field of `Post` and `RenderOptions` in model.rs is in the schema,
//      and nothing is in the schema that the model does not have.
//   2. The numeric limits in api/_lib/limits.mjs equal `Limits::standard()`
//      in limits.rs.
//   3. The MCP tool definitions are well-formed and their input schemas name
//      the required fields.
//
// It is a text-level check on purpose: it needs no Rust build, so it runs in
// the first CI job, in under a second, and cannot be skipped by a compile
// failure in another stream.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { postSchema, optionsSchema, sheetSchema } from "../../packages/xeet/src/schemas.js";
import { LIMITS } from "../../packages/xeet/src/limits.js";
import { mcpTools } from "../../packages/xeet/src/mcp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const problems = [];
const modelRs = readFileSync(join(ROOT, "crates", "xeet-core", "src", "model.rs"), "utf8");
const limitsRs = readFileSync(join(ROOT, "crates", "xeet-core", "src", "limits.rs"), "utf8");

/** The `pub` field names of a struct, in snake_case. */
function structFields(source, name) {
  const start = source.indexOf(`pub struct ${name} {`);
  if (start < 0) return null;
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end);
  const fields = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s{4}pub ([a-z_0-9]+):/);
    if (m) fields.push(m[1]);
  }
  return fields;
}

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function compareFields(structName, schema, schemaName) {
  const fields = structFields(modelRs, structName);
  if (!fields) {
    problems.push(`model.rs: could not find \`pub struct ${structName}\``);
    return;
  }
  const model = new Set(fields.map(camel));
  const published = new Set(Object.keys(schema.properties ?? {}));
  for (const f of model) {
    if (!published.has(f)) problems.push(`${schemaName}: missing \`${f}\`, which ${structName} has`);
  }
  for (const f of published) {
    if (!model.has(f)) problems.push(`${schemaName}: publishes \`${f}\`, which ${structName} does not have`);
  }
}

compareFields("Post", postSchema, "postSchema");
compareFields("RenderOptions", optionsSchema, "optionsSchema");

// Media and Author are nested; check them too.
const mediaSchema = postSchema.properties?.media?.items;
if (mediaSchema) {
  const fields = new Set(structFields(modelRs, "Media")?.map(camel) ?? []);
  for (const f of fields) if (!(f in (mediaSchema.properties ?? {}))) problems.push(`postSchema.media[]: missing \`${f}\``);
}
const authorSchema = postSchema.properties?.author;
if (authorSchema) {
  const fields = new Set(structFields(modelRs, "Author")?.map(camel) ?? []);
  for (const f of fields) if (!(f in (authorSchema.properties ?? {}))) problems.push(`postSchema.author: missing \`${f}\``);
  const affiliate = new Set(structFields(modelRs, "Affiliate")?.map(camel) ?? []);
  const published = new Set(Object.keys(authorSchema.properties?.affiliate?.properties ?? {}));
  for (const f of affiliate) {
    if (!published.has(f)) problems.push(`postSchema.author.affiliate: missing \`${f}\``);
  }
}

// --- Limits -----------------------------------------------------------------
// `Limits::standard()` is the one place the policy is written for the core.
const standard = limitsRs.slice(limitsRs.indexOf("pub const fn standard()"));
const standardBody = standard.slice(0, standard.indexOf("\n    }"));
const rustLimits = {};
for (const line of standardBody.split("\n")) {
  const m = line.match(/^\s{12}([a-z_0-9]+): (.*),$/);
  if (!m) continue;
  const value = m[2].replaceAll("_", "").replace(/usize::MAX|u64::MAX|u32::MAX/g, "Infinity");
  if (!/^[0-9+\-*/(). \t]+$|^Infinity$/.test(value)) continue;
  try {
    rustLimits[m[1]] = Function(`"use strict"; return (${value});`)();
  } catch {
    problems.push(`limits.rs: could not evaluate \`${m[1]}: ${m[2]}\``);
  }
}

const pairs = [
  ["max_text_chars", "text_chars"],
  ["max_text_bytes", "text_bytes"],
  ["long_post_chars", "long_post_chars"],
  ["max_media", "media"],
  ["max_image_bytes", "image_bytes"],
  ["max_image_bytes_total", "image_bytes_total"],
  ["max_image_dimension", "image_dimension"],
  ["max_image_pixels", "image_pixels"],
  ["max_image_pixels_total", "image_pixels_total"],
  ["max_quote_depth", "quote_depth"],
  ["max_sheet_cells", "sheet_cells"],
  ["max_sheet_dimension", "sheet_dimension"],
  ["max_output_width", "output_width"],
  ["max_output_height", "output_height"],
  ["max_output_pixels", "output_pixels"],
  ["min_width", "width_min"],
  ["max_width", "width_max"],
];
for (const [rustName, apiName] of pairs) {
  const r = rustLimits[rustName];
  const a = LIMITS[apiName];
  if (r === undefined) {
    problems.push(`limits.rs: \`${rustName}\` not found in Limits::standard()`);
  } else if (r !== a) {
    problems.push(`limits: api/_lib/limits.mjs says ${apiName}=${a}, limits.rs says ${rustName}=${r}`);
  }
}

// --- Quote depth ------------------------------------------------------------
// X renders two levels of quoting (`post.quote`, then `post.quote.quote`) and
// refuses a third. Three things have to agree on that number: the Rust policy,
// the published limits, and the schema — where depth 3 must be *invalid*, not
// merely undocumented.
const QUOTE_DEPTH = 2;
if (rustLimits.max_quote_depth !== QUOTE_DEPTH) {
  problems.push(
    `limits.rs: max_quote_depth is ${rustLimits.max_quote_depth}; the renderer supports ${QUOTE_DEPTH} levels of quoting`,
  );
}
const quote1 = postSchema.properties?.quote;
const quote2 = quote1?.properties?.quote;
if (!quote1) {
  problems.push("postSchema: no `quote` field; a quoted post would not validate");
} else {
  if (!quote1.properties?.text) problems.push("postSchema.quote: has no post fields of its own");
  if (!quote2) {
    problems.push("postSchema.quote.quote: missing; depth 2 must be expressible in the schema");
  } else {
    if (!quote2.properties?.text || !quote2.properties?.media) {
      problems.push("postSchema.quote.quote: does not repeat the post fields");
    }
    const refused = quote2.properties?.quote;
    if (!refused || refused.type !== "null") {
      problems.push(
        "postSchema.quote.quote.quote: must be typed `null`; X refuses a third level of quoting",
      );
    }
  }
}

// The MCP schema advertises the width range from the same policy.
const width = optionsSchema.properties?.width;
if (width && (width.minimum !== LIMITS.width_min || width.maximum !== LIMITS.width_max)) {
  problems.push(`optionsSchema.width: ${width.minimum}..${width.maximum} does not match the limits ${LIMITS.width_min}..${LIMITS.width_max}`);
}
const sheetMax = sheetSchema.properties?.widths?.maxItems;
if (sheetMax && sheetMax * 2 !== LIMITS.sheet_cells) {
  problems.push(`sheetSchema.widths.maxItems is ${sheetMax}; with two themes that is ${sheetMax * 2} cells, but the limit is ${LIMITS.sheet_cells}`);
}

// --- MCP tools --------------------------------------------------------------
const tools = mcpTools();
if (!Array.isArray(tools) || tools.length < 3) problems.push("mcp: expected at least three tools");
for (const t of tools) {
  if (!t.name || !t.description) problems.push(`mcp: tool ${t.name ?? "(unnamed)"} needs a name and a description`);
  if (!t.inputSchema || t.inputSchema.type !== "object") problems.push(`mcp: tool ${t.name} needs an object inputSchema`);
  const props = Object.keys(t.inputSchema?.properties ?? {});
  for (const req of t.inputSchema?.required ?? []) {
    if (!props.includes(req)) problems.push(`mcp: tool ${t.name} requires \`${req}\`, which it does not define`);
  }
}
const names = new Set(tools.map((t) => t.name));
for (const expected of ["xeet_explain", "xeet_render", "xeet_sheet"]) {
  if (!names.has(expected)) problems.push(`mcp: missing tool \`${expected}\``);
}

for (const p of problems) console.error(`contract: FAIL: ${p}`);
if (problems.length) {
  console.error(`contract: ${problems.length} mismatch(es)`);
  process.exit(1);
}
console.log(
  `contract: model, schema, limits and ${tools.length} MCP tools agree (text ${rustLimits.max_text_chars} chars, ${rustLimits.max_media} media, quote depth ${rustLimits.max_quote_depth}, ${rustLimits.max_output_pixels} output pixels)`,
);
