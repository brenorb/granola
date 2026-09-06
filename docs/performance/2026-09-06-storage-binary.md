# Encrypted storage binary envelope

The encrypted IndexedDB envelope now stores `iv` and `ciphertext` as native
`Uint8Array` values. This avoids expanding every byte into a JavaScript number
array during structured cloning. `EncryptedStorageDriver.get()` still accepts
the old `number[]` envelope, validates every element, and copies it before
AES-GCM decryption. Native typed arrays are accepted only when they are actual
`Uint8Array` views; other typed arrays and malformed arrays fail closed.

The AES-GCM key remains non-extractable and the namespace plus storage key stays
in the same additional authenticated data. There is no startup migration or
decrypted cache. A later write naturally replaces a legacy envelope with the
native representation.

## Rollout and rollback compatibility

The envelope keeps `version: 1` for data compatibility, but an older build's
reader only accepts `number[]`. If a new build writes a typed envelope while an
older tab still uses the same profile, that tab fails closed when it reads the
encrypted journal. The current IndexedDB driver opens database version `1` and
its existing `versionchange` invalidation protects reset and upgrade events; it
does not negotiate envelope formats between application builds.

The smallest safe rollout is two releases: ship the reader that accepts both
representations while it continues writing `number[]`, then enable the typed
array writer after old builds are retired or reloaded. Once typed envelopes are
written, rollback must land on the dual reader; a direct rollback to an old
number-array-only build is incompatible with those records. An IndexedDB
schema-version bump would provide a harder cutoff, but it would also require an
upgrade and blocked-tab flow and is larger than this storage-only change.

## Offline benchmark

Run from the repository root with:

```sh
npx tsx scripts/storage-binary-benchmark.ts
```

The benchmark uses the production `EncryptedStorageDriver` and a
`MemoryStorageDriver` whose structured clone models the serialization work but
does not include IndexedDB or disk I/O. Its payload is synthetic: 500 entries,
no private keys, proofs, tokens, preimages, or wallet backups, and 92,140 JSON
bytes.
It also measures `structuredClone()` directly to separate representation cost
from WebCrypto work.

Two warm runs on this checkout produced these medians (milliseconds):

| Path | Native `Uint8Array` | Legacy `number[]` |
| --- | ---: | ---: |
| Driver `set` | 0.36–0.46 | 5.36–5.95 |
| Driver `get` | 0.33–0.64 | 11.44–11.91 |
| Envelope `structuredClone` | 0.012–0.017 | 1.57–1.88 |

These are CPU and clone measurements only. They indicate a large synthetic
serialization improvement, while the end to end IndexedDB I/O effect still
needs a serial browser profile with the deployed app.

For that profile, start the local Vite server and open
`/scripts/storage-binary-browser-benchmark.html`. It uses two dedicated
benchmark databases, the real `IndexedDbStorageDriver`, and alternating native
and legacy operations. It performs no network requests and prints one JSON
result in the page. The dedicated databases are reset before each run.
