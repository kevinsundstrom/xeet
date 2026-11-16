//! Punycode (RFC 3492) encoding, the piece of the IDNA path twitter-text leans
//! on when it measures a URL.
//!
//! twitter-text's `idna.toAscii` does not validate a domain: it punycode-encodes
//! each label and rejects the domain only when an encoded label is empty or
//! longer than 63 characters. That length is what feeds the 4096-character URL
//! cap, and it is also why a long internationalized domain can be rejected
//! before it is ever extracted. Nothing here guesses at IDNA2008 mapping rules;
//! it reproduces the encoder `punycode@1.4.1` exactly.

const BASE: u32 = 36;
const T_MIN: u32 = 1;
const T_MAX: u32 = 26;
const SKEW: u32 = 38;
const DAMP: u32 = 700;
const INITIAL_BIAS: u32 = 72;
const INITIAL_N: u32 = 128;

fn adapt(mut delta: u32, num_points: u32, first_time: bool) -> u32 {
    delta = if first_time { delta / DAMP } else { delta / 2 };
    delta += delta / num_points;
    let mut k = 0;
    while delta > ((BASE - T_MIN) * T_MAX) / 2 {
        delta /= BASE - T_MIN;
        k += BASE;
    }
    k + (((BASE - T_MIN + 1) * delta) / (delta + SKEW))
}

fn digit_to_char(d: u32) -> char {
    // 0-25 -> a-z, 26-35 -> 0-9
    if d < 26 {
        (b'a' + d as u8) as char
    } else {
        (b'0' + (d - 26) as u8) as char
    }
}

/// Encode one domain label. Pure ASCII labels are returned unchanged (with the
/// `xn--` prefix only if the input already carries one, as `toASCII` does).
pub fn encode_label(label: &str) -> Option<String> {
    let code_points: Vec<u32> = label.chars().map(|c| c as u32).collect();
    let mut output = String::new();
    let basic: Vec<char> = label.chars().filter(|c| c.is_ascii()).collect();
    for c in &basic {
        output.push(*c);
    }
    let basic_len = basic.len() as u32;
    let mut handled = basic_len;
    if basic_len > 0 {
        output.push('-');
    }
    let mut n = INITIAL_N;
    let mut delta: u32 = 0;
    let mut bias = INITIAL_BIAS;
    let total = code_points.len() as u32;
    while handled < total {
        let m = code_points.iter().copied().filter(|&c| c >= n).min()?;
        delta = delta.checked_add((m - n).checked_mul(handled + 1)?)?;
        n = m;
        for &c in &code_points {
            if c < n {
                delta = delta.checked_add(1)?;
            } else if c == n {
                let mut q = delta;
                let mut k = BASE;
                loop {
                    let t = if k <= bias {
                        T_MIN
                    } else if k >= bias + T_MAX {
                        T_MAX
                    } else {
                        k - bias
                    };
                    if q < t {
                        break;
                    }
                    output.push(digit_to_char(t + (q - t) % (BASE - t)));
                    q = (q - t) / (BASE - t);
                    k += BASE;
                }
                output.push(digit_to_char(q));
                bias = adapt(delta, handled + 1, handled == basic_len);
                delta = 0;
                handled += 1;
            }
        }
        delta += 1;
        n += 1;
    }
    Some(output)
}

/// `idna.toAscii`: the ASCII length of a domain, or `None` when a label cannot
/// be encoded within DNS limits.
///
/// Separator normalization (`.` full stop variants) and the email-address split
/// on `@` are reproduced because they change the label boundaries.
pub fn ascii_len(domain: &str) -> Option<usize> {
    let (local, rest) = match domain.split_once('@') {
        Some((local, rest)) => (Some(local), rest),
        None => (None, domain),
    };
    let normalized: String = rest
        .chars()
        .map(|c| match c {
            '\u{3002}' | '\u{FF0E}' | '\u{FF61}' => '.',
            c => c,
        })
        .collect();
    let mut total = 0usize;
    if let Some(local) = local {
        total += local.len() + 1;
    }
    for label in normalized.split('.') {
        let encoded = if label.is_ascii() {
            label.to_string()
        } else {
            let mut s = String::from("xn--");
            s.push_str(&encode_label(label)?);
            s
        };
        let len = encoded.chars().count();
        if !(1..=63).contains(&len) {
            return None;
        }
        total += len + 1;
    }
    // `split` produces one extra separator that is not in the joined string.
    Some(total.saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3492_samples() {
        // From RFC 3492 section 7.1.
        // Vector values cross-checked against Python's RFC 3492 codec.
        let cases = [
            (
                "\u{0644}\u{064A}\u{0647}\u{0645}\u{0627}\u{0628}\u{062A}\u{0643}\u{0644}\u{0645}\u{0648}\u{0634}\u{0639}\u{0631}\u{0628}\u{064A}",
                "mgbcah9ar9a4efegftvvn",
            ),
            ("\u{4ED6}\u{4EEC}\u{4E3A}\u{4EC0}\u{4E48}\u{4E0D}\u{8BF4}\u{4E2D}\u{6587}", "ihqwcrb4cv8a8dqg056pqjye"),
            (
                "\u{5B83}\u{4EEC}\u{4E3A}\u{4EC0}\u{4E48}\u{4E0D}\u{8BF4}\u{4E2D}\u{6587}",
                "ihqwcrb4cv8agiu91fiksq72f",
            ),
            ("Pro\u{010D}prost\u{011B}n\u{011B}mluv\u{00ED}\u{010D}esky", "Proprostnmluvesky-pvb11dla10ab"),
            ("m\u{00FC}nchen", "mnchen-3ya"),
            ("\u{00FC}", "tda"),
        ];
        for (input, expected) in cases {
            assert_eq!(encode_label(input).as_deref(), Some(expected), "{input}");
        }
    }

    #[test]
    fn ascii_passthrough_and_lengths() {
        assert_eq!(ascii_len("example.com"), Some(11));
        assert_eq!(ascii_len("m\u{00FC}nchen.de"), Some(17));
        // A label that cannot fit in 63 characters is rejected.
        let long = "\u{00FC}".repeat(63);
        assert_eq!(ascii_len(&long), None);
    }
}
