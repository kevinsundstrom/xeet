# Vendored upstream sources

Data files only, used to regenerate the tables in `src/gentables/`. Nothing here
is compiled directly, and no X (Twitter, Inc.) service code or asset is included.

## `twitter-text/`

<https://github.com/twitter/twitter-text>, commit
`30e2430d90cff3b46393ea54caf511441983c260` (2021-10-21), library version 3.1.0.
Apache-2.0, see `LICENSE`.

- `regexp/*.js` — the character classes, TLD lists and grammar fragments the
  extractor is a port of. `tools/gen_tables.py` parses them into
  `src/gentables/unicode.rs` and `src/gentables/tlds.rs`.
- `TwitterTextEmojiRegex.java` — the generated emoji matcher the Java
  implementation counts with. `tools/gen_tables.py` compiles it into
  `src/gentables/emoji.rs`. This is the table the weighted-length conformance
  data encodes, which is why it is the one ported.
- `configs.js`, `getCharacterWeight.js` — the weighted-length configuration
  (v1/v2/v3) and the per-code-point weight lookup. v3 is what the code
  implements; `src/length.rs` transcribes it, and `Config::V2` exists because
  part of the conformance suite pins the older emoji rule.

The *behavior* files (`extractUrlsWithIndices.js`, `parseTweet.js`, ...) are
deliberately not vendored: this crate is a clean-room Rust port of the same
grammar, and vendoring code we do not compile would only invite confusion about
what is derived from what. The conformance suite in `/tests/conformance` is the
authority on behavior, and `tests/parity.rs` can diff against the published
JavaScript package.

## `unicode/`

`emoji-data-17.0.txt`, from <https://www.unicode.org/Public/17.0.0/ucd/emoji/>
(Unicode License v3, included in the file's header). Only the
`Extended_Pictographic` and `Emoji_Modifier` ranges are read, into
`src/gentables/emoji_props.rs`. These are the properties X's shipped client uses
in its own emoji regex, and the table was checked range-for-range against a V8
that reports Unicode 17.0 (`tests/x_client.rs`).

Version note: Unicode 17.0 *narrowed* `Extended_Pictographic` — Unicode 16.0
also listed 689 reserved or non-emoji symbol code points (U+2605 BLACK STAR and
friends). That only changes the weight of such a code point when it is followed
by a variation selector, a skin tone or a ZWJ, and no assigned emoji is affected.

### The other emoji table

The JavaScript build of twitter-text tokenizes emoji with `twemoji-parser@11.0.2`
(MIT, Twemoji 11 / Unicode 11), not with the Java table. The two disagree: the
Java table groups the ZWJ sequences it lists explicitly but does not apply
skin-tone modifiers or variation selectors generically, so `👍🏽` and `❤️` weigh
2 + 2 there and 2 with twemoji, while twemoji 11 lacks some ZWJ sequences the
Java table has. On the differential corpus that is 124 of 3,029 texts, in both
directions. That package is not vendored because the conformance suite pins the
Java behavior; if the project decides the current server follows twemoji instead,
vendor `https://registry.npmjs.org/twemoji-parser/-/twemoji-parser-11.0.2.tgz`
and point `tools/gen_tables.py` at its `dist/lib/regex.js`.

## Regenerating

```sh
python3 crates/xeet-text/tools/gen_tables.py
```

`SOURCES.lock` records an FNV-1a hash of every vendored input the tables were
built from, and `tests/conformance.rs` recomputes them, so a stale or edited
table fails the test suite instead of silently drifting.
