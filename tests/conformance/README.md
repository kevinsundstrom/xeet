# twitter-text conformance suite (vendored)

Unmodified test data from the official open-source `twitter-text` library.

- Upstream: <https://github.com/twitter/twitter-text>
- Commit: `30e2430d90cff3b46393ea54caf511441983c260` (2021-10-21)
- Path: `conformance/*.yml`
- License: Apache-2.0 (`LICENSE` in this directory)

| File | Cases | Consumed by |
|---|---|---|
| `extract.yml` | 238 | `crates/xeet-text/tests/conformance.rs` — entity extraction |
| `autolink.yml` | 196 | same — `xeet_text::autolink` |
| `validate.yml` | 97 | same — validators and `parse()` weighted length |
| `tlds.yml` | 1574 | same — URL extraction over the TLD lists |
| `hit_highlighting.yml` | 14 | same — `xeet_text::hit_highlight` |
| `tld_lib.yml` | — | the TLD lists themselves, cross-checked against `tlds.yml` |

These files are test data only: no X/Twitter service code and no X assets are
vendored here. `tld_lib.yml` is a plain list of TLDs, not a test case list, so
it is used as a second source of truth for the generated TLD tables.

Do not edit these files. To refresh them, re-clone upstream at a newer commit
and update this README's commit id; the crate's tests fail loudly on any change
in case counts.
