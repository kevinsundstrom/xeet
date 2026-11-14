//! Hit highlighting: twitter-text's `HitHighlighter`.
//!
//! Given a text and UTF-16 offsets to highlight, wrap the hits in `<em>` (or
//! another tag). The offsets count visible characters only: text inside an
//! existing tag is skipped, which is what lets the search UI highlight a
//! rendered, already-autolinked post without knowing the markup.
//!
//! The walk is a direct port of `hitHighlight.js`, including its handling of
//! hits that fall on a tag boundary or at the very end of the text.

/// Wrap each hit in `<em>`.
pub fn hit_highlight(text: &str, hits: &[(usize, usize)]) -> String {
    hit_highlight_with_tag(text, hits, "em")
}

/// `hitHighlight(text, hits, {tag})`.
pub fn hit_highlight_with_tag(text: &str, hits: &[(usize, usize)], tag: &str) -> String {
    if hits.is_empty() {
        return text.to_string();
    }
    let open: Vec<char> = format!("<{tag}>").chars().collect();
    let close: Vec<char> = format!("</{tag}>").chars().collect();

    // `text.split(/<|>/)`: even chunks are text, odd chunks are tag names.
    let chunks: Vec<Vec<char>> = text
        .split(['<', '>'])
        .map(|c| c.chars().collect())
        .collect();

    // Hits are flattened open, close, open, close, ...
    let flat: Vec<usize> = hits.iter().flat_map(|&(a, b)| [a, b]).collect();

    let mut out: Vec<char> = Vec::with_capacity(text.len() + 8);
    let mut chunk_index = 0usize;
    let mut chunk: Option<&Vec<char>> = chunks.first();
    let mut prev_len = 0usize;
    let mut cursor = 0usize;
    let mut start_in_chunk = false;

    for (index, &hit) in flat.iter().enumerate() {
        let tag = if index % 2 == 0 { &open } else { &close };
        let mut placed = false;

        while let Some(current) = chunk {
            if hit < prev_len + current.len() {
                break;
            }
            out.extend_from_slice(&current[cursor..]);
            if start_in_chunk && hit == prev_len + current.len() {
                out.extend_from_slice(tag);
                placed = true;
            }
            if let Some(next) = chunks.get(chunk_index + 1) {
                out.push('<');
                out.extend_from_slice(next);
                out.push('>');
            }
            prev_len += current.len();
            cursor = 0;
            chunk_index += 2;
            chunk = chunks.get(chunk_index);
            start_in_chunk = false;
        }

        match chunk {
            Some(current) if !placed => {
                let spot = (hit.saturating_sub(prev_len)).min(current.len());
                if spot > cursor {
                    out.extend_from_slice(&current[cursor..spot]);
                }
                cursor = spot;
                out.extend_from_slice(tag);
                start_in_chunk = index % 2 == 0;
            }
            _ if !placed => {
                out.extend_from_slice(tag);
            }
            _ => {}
        }
    }

    if let Some(current) = chunk {
        out.extend_from_slice(&current[cursor..]);
        for (offset, index) in (chunk_index + 1..chunks.len()).enumerate() {
            let is_tag = (chunk_index + 1 + offset) % 2 == 1;
            if is_tag {
                out.push('<');
                out.extend_from_slice(&chunks[index]);
                out.push('>');
            } else {
                out.extend_from_slice(&chunks[index]);
            }
        }
    }

    out.into_iter().collect()
}
