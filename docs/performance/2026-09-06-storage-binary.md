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

## Offline benchmark

Run from the repository root with:

```sh
npx tsx scripts/storage-binary-benchmark.ts
```

The benchmark uses the production `EncryptedStorageDriver` and a
`MemoryStorageDriver` whose structured clone models the serialization work but
does not include IndexedDB or disk I/O. Its payload is synthetic: 500 entries,
no keys, proofs, tokens, preimages, or wallet backups, and 92,140 JSON bytes.
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
