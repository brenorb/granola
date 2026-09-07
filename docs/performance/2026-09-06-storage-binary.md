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
reader only accepts `number[]`. The driver now opens IndexedDB database version
`2`. When a new tab upgrades an existing version-1 profile, the old tab receives
`versionchange`, invalidates and closes; the upgrade then proceeds without
deleting records. An old tab must be reloaded before it can continue using the
profile. Opening the upgraded database with version `1` fails with
`VersionError`, which prevents a number-array-only rollback from silently
touching binary data. If another tab does not release its connection, the new
open rejects with an instruction to close or reload the other profile tabs;
records are not deleted.

The version-2 cutover is the smallest safe rollout for the native writer. A
rollback must use a dual reader that also opens database version `2`; a build
that opens version `1` cannot roll back after the cutover. The browser benchmark
below exercises this path with a legacy envelope, an open old connection,
record preservation, binary rewrite/readback, and the version-1 rejection.

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
benchmark databases, the real `IndexedDbStorageDriver`, alternating native and
legacy operations, and a real version-1-to-version-2 cutover check. It performs
no network requests and prints one JSON result in the page. The timing databases
are reset before each run; the cutover database uses a fresh name and is not
deleted after the check.
