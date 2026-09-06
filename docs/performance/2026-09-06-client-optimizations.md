# Client orchestration optimizations

## Profile storage

The IndexedDB driver shares one open connection and waits for transaction commit,
including writes, before resolving. Reset, versionchange from another tab and an
unexpected close invalidate the driver and close the connection. Further accesses
fail until the profile is reloaded; this prevents stale clients recreating erased
state. Failed opens can be retried.

Encrypted trade-session storage coalesces loading/creation of its profile AES-GCM
CryptoKey and retains the validated, non-extractable handle per driver/namespace.
The existing shared creation lock remains. Reset/versionchange drops the cached
reference and disables further key use. No private key bytes, proofs or decrypted
wallet state are cached by this change. Browser garbage collection controls physical
memory reclamation; dropping a reference is not a promise of immediate zeroization.
The existing threat model is unchanged: this protects storage dumps, not malicious
JavaScript already executing in the wallet origin.

Regression tests cover concurrent reuse, non-exportability, namespace isolation,
failed key loads, invalidation, transaction aborts and reset. Native Chrome validation
also checks two-tab deletion/invalidation and fresh-profile recovery.
