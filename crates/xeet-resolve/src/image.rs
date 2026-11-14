//! Image dimensions from the encoded header — no decode, no pixels.
//!
//! The resolver needs dimensions to size the card box and to enforce X's
//! minimum (`docs/LINK-CARDS.md`: 144×144). Decoding a 2400×1256 JPEG to learn
//! that would cost milliseconds and megabytes; every format states its size in
//! the first bytes, so this reads the header and stops.

/// `(width, height)`, or `None` if the bytes are not a JPEG/PNG/GIF/WebP.
pub fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 10 {
        return None;
    }
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        if bytes.len() < 24 {
            return None;
        }
        return Some((be_u32(&bytes[16..20])?, be_u32(&bytes[20..24])?));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some((le_u16(&bytes[6..8])? as u32, le_u16(&bytes[8..10])? as u32));
    }
    if bytes.len() >= 16 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        let chunk = &bytes[12..16];
        if chunk == b"VP8X" && bytes.len() >= 30 {
            let width = 1 + le_u24(&bytes[24..27])?;
            let height = 1 + le_u24(&bytes[27..30])?;
            return Some((width, height));
        }
        if chunk == b"VP8 " && bytes.len() >= 30 {
            return Some((
                (le_u16(&bytes[26..28])? & 0x3fff) as u32,
                (le_u16(&bytes[28..30])? & 0x3fff) as u32,
            ));
        }
        if chunk == b"VP8L" && bytes.len() >= 25 {
            let bits = le_u32(&bytes[21..25])?;
            return Some((((bits & 0x3fff) + 1), (((bits >> 14) & 0x3fff) + 1)));
        }
        return None;
    }
    if bytes[0] == 0xff && bytes[1] == 0xd8 {
        let mut offset = 2;
        while offset + 9 < bytes.len() {
            if bytes[offset] != 0xff {
                offset += 1;
                continue;
            }
            let marker = bytes[offset + 1];
            if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
                offset += 2;
                continue;
            }
            let length = be_u16(&bytes[offset + 2..offset + 4])? as usize;
            let is_sof = (0xc0..=0xcf).contains(&marker)
                && marker != 0xc4
                && marker != 0xc8
                && marker != 0xcc;
            if is_sof {
                let height = be_u16(&bytes[offset + 5..offset + 7])? as u32;
                let width = be_u16(&bytes[offset + 7..offset + 9])? as u32;
                return Some((width, height));
            }
            if length == 0 {
                return None;
            }
            offset += 2 + length;
        }
    }
    None
}

/// The content-type → file extension, for the cache and for the model's rules.
pub fn extension_for(content_type: &str) -> Option<&'static str> {
    match content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn be_u16(bytes: &[u8]) -> Option<u16> {
    Some(u16::from_be_bytes([*bytes.first()?, *bytes.get(1)?]))
}

fn be_u32(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes([
        *bytes.first()?,
        *bytes.get(1)?,
        *bytes.get(2)?,
        *bytes.get(3)?,
    ]))
}

fn le_u16(bytes: &[u8]) -> Option<u16> {
    Some(u16::from_le_bytes([*bytes.first()?, *bytes.get(1)?]))
}

fn le_u24(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes([
        *bytes.first()?,
        *bytes.get(1)?,
        *bytes.get(2)?,
        0,
    ]))
}

fn le_u32(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes([
        *bytes.first()?,
        *bytes.get(1)?,
        *bytes.get(2)?,
        *bytes.get(3)?,
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes
    }

    #[test]
    fn png_gif_jpeg_webp() {
        assert_eq!(dimensions(&png(1200, 630)), Some((1200, 630)));

        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&320u16.to_le_bytes());
        gif.extend_from_slice(&302u16.to_le_bytes());
        assert_eq!(dimensions(&gif), Some((320, 302)));

        let jpeg = [
            0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x76, 0x03, 0xe8, 0x03, 0x01, 0x22,
            0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
        ];
        assert_eq!(dimensions(&jpeg), Some((1000, 630)));

        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBPVP8X");
        webp.extend_from_slice(&[0; 8]);
        webp.extend_from_slice(&[0x7f, 0x02, 0x00]); // width - 1 = 639
        webp.extend_from_slice(&[0x8f, 0x01, 0x00]); // height - 1 = 399
        assert_eq!(dimensions(&webp), Some((640, 400)));
    }

    #[test]
    fn garbage_has_no_dimensions() {
        assert!(dimensions(b"not an image at all").is_none());
        assert!(dimensions(&[]).is_none());
    }

    #[test]
    fn content_types_map_to_extensions() {
        assert_eq!(extension_for("image/jpeg"), Some("jpg"));
        assert_eq!(extension_for("image/png; charset=binary"), Some("png"));
        assert_eq!(extension_for("image/svg+xml"), None);
    }
}
