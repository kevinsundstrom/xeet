//! A random-access view over a string, indexed by `char` position.
//!
//! The extractors below are ports of regular expressions that scan
//! left-to-right with backtracking, so they want cheap indexed access, cheap
//! look-behind and cheap slicing. Building the tables once per parse is much
//! cheaper than re-walking the string at every match attempt.

/// A string with precomputed character and byte tables.
pub(crate) struct Text<'a> {
    #[allow(dead_code)] // Kept so slices borrow from the original string.
    raw: &'a str,
    chars: Vec<char>,
    /// `byte_of[i]` is the byte offset of character `i`; `byte_of[len] == raw.len()`.
    byte_of: Vec<u32>,
    /// `utf16_of[i]` is the UTF-16 offset of character `i`.
    utf16_of: Vec<u32>,
}

impl<'a> Text<'a> {
    pub(crate) fn new(raw: &'a str) -> Self {
        let n = raw.chars().count();
        let mut chars = Vec::with_capacity(n);
        let mut byte_of = Vec::with_capacity(n + 1);
        let mut utf16_of = Vec::with_capacity(n + 1);
        let mut b = 0u32;
        let mut u = 0u32;
        for c in raw.chars() {
            chars.push(c);
            byte_of.push(b);
            utf16_of.push(u);
            b += c.len_utf8() as u32;
            u += c.len_utf16() as u32;
        }
        byte_of.push(b);
        utf16_of.push(u);
        Self {
            raw,
            chars,
            byte_of,
            utf16_of,
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.chars.len()
    }

    /// The character at `i`, or `None` past the end.
    pub(crate) fn at(&self, i: usize) -> Option<char> {
        self.chars.get(i).copied()
    }

    /// The character at `i`, with `\0` past the end (callers bound-check).
    pub(crate) fn ch(&self, i: usize) -> char {
        self.chars.get(i).copied().unwrap_or('\0')
    }

    pub(crate) fn byte(&self, i: usize) -> usize {
        self.byte_of[i.min(self.chars.len())] as usize
    }

    pub(crate) fn utf16(&self, i: usize) -> usize {
        self.utf16_of[i.min(self.chars.len())] as usize
    }

    /// The source text between character positions `a` and `b`.
    pub(crate) fn slice(&self, a: usize, b: usize) -> &'a str {
        &self.raw[self.byte(a)..self.byte(b)]
    }

    /// Whether the text at `i` starts with `pat`, ignoring ASCII case.
    pub(crate) fn starts_with_ci(&self, i: usize, pat: &str) -> bool {
        let mut j = i;
        for p in pat.chars() {
            match self.at(j) {
                Some(c) if c.eq_ignore_ascii_case(&p) => j += 1,
                _ => return false,
            }
        }
        true
    }
}

/// The number of UTF-16 code units in `s`.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// Convert a UTF-16 code unit offset into a byte offset.
///
/// An offset in the middle of a surrogate pair rounds down to the start of the
/// character, and an offset past the end clamps to `s.len()`.
pub fn utf16_to_byte(s: &str, utf16: usize) -> usize {
    let mut seen = 0;
    for (byte, c) in s.char_indices() {
        if seen >= utf16 {
            return byte;
        }
        seen += c.len_utf16();
    }
    s.len()
}

/// Convert a byte offset into a UTF-16 code unit offset.
///
/// A byte offset that is not on a character boundary rounds down.
pub fn byte_to_utf16(s: &str, byte: usize) -> usize {
    let byte = byte.min(s.len());
    let mut seen = 0;
    for (b, c) in s.char_indices() {
        if b + c.len_utf8() > byte {
            break;
        }
        seen += c.len_utf16();
    }
    seen
}
