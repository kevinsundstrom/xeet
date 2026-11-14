// The limits this deployment enforces, as data.
//
// The numbers are the `Limits::standard()` policy in
// `crates/xeet-core/src/limits.rs` (PLAN.md §13) plus the wrapper's body cap.
// They are published at GET /health and in the MCP tool descriptions so an
// agent can size a request before sending it.
//
// `tools/ship/check-schema.mjs` fails CI if the two drift apart.

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export const LIMITS = {
  text_chars: 100000,
  text_bytes: 256 * 1024,
  long_post_chars: 25000,
  media: 20,
  image_bytes: 8 * 1024 * 1024,
  image_bytes_total: 64 * 1024 * 1024,
  image_dimension: 8192,
  image_pixels: 67108864,
  image_pixels_total: 536870912,
  quote_depth: 2,
  sheet_cells: 12,
  sheet_dimension: 8192,
  output_width: 8192,
  output_height: 32768,
  output_pixels: 64000000,
  width_min: 100,
  width_max: 1200,
  body_bytes: MAX_BODY_BYTES,
};

/** The policy as the JSON a caller sees. */
export function limitsPolicy() {
  return {
    text: { chars: LIMITS.text_chars, bytes: LIMITS.text_bytes },
    media: LIMITS.media,
    image: {
      bytes: LIMITS.image_bytes,
      bytes_total: LIMITS.image_bytes_total,
      dimension: LIMITS.image_dimension,
      pixels: LIMITS.image_pixels,
    },
    output: { pixels: LIMITS.output_pixels, width: LIMITS.output_width, height: LIMITS.output_height },
    sheet: { cells: LIMITS.sheet_cells },
    width: { min: LIMITS.width_min, max: LIMITS.width_max },
    request_bytes: LIMITS.body_bytes,
    on_exceed: "the request is refused with a 4xx and an error code; it is never truncated or partially rendered",
  };
}
