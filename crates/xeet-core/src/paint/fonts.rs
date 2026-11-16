//! Font handles for painting.
//!
//! Shaping (`fonts::Face`) parses each file through fontations' newer model
//! API; painting wants the classic `skrifa` outline, color and palette APIs,
//! which both read the same bytes. A face's bytes live for the process — either
//! embedded in the module or leaked by the lazy-pack registry — so these
//! `FontRef`s are built once and shared.
//!
//! Faces are matched to files by name rather than by index because a lazy pack
//! may be absent when the table is first used.
//!
//! The table is one slot per [`FACES`](crate::fonts::FACES) entry, and each
//! slot parses on first use: a frame that draws Chirp regular at 15 px must not
//! pay for the forty-odd faces it never touches. A slot for an unregistered
//! pack stays empty, so it can still be filled when the pack arrives.

use crate::fonts::{face_bytes, FaceId, FACES};
use skrifa::FontRef;
use std::sync::OnceLock;

type Slot = OnceLock<FontRef<'static>>;

fn all() -> &'static Vec<Slot> {
    static FONTS: OnceLock<Vec<Slot>> = OnceLock::new();
    FONTS.get_or_init(|| (0..FACES.len()).map(|_| OnceLock::new()).collect())
}

/// Emoji advance in CSS pixels, the same rule layout uses.
pub(crate) use crate::fonts::emoji_advance;

pub(crate) fn font(id: FaceId) -> Option<&'static FontRef<'static>> {
    let slot = all().get(id as usize)?;
    if let Some(font) = slot.get() {
        return Some(font);
    }
    let spec = FACES.get(id as usize)?;
    let data = face_bytes(spec.file)?;
    let font = FontRef::new(data).ok()?;
    Some(slot.get_or_init(|| font))
}
