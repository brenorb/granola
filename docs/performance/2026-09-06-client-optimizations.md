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

## Inbox registration relay connection

The nostr-tools adapter scopes one connection to the publish/validated-readback
operation. AUTH runs for that scope; the same socket sends the registration and
queries its exact event. Connections close on success, publish failure, timeout,
subscription failure and disconnect. Separate operations/identities receive separate
connections. Custom InboxRelayPort implementations without this optional capability
continue using their existing publish/query methods.

ACK and exact validated readback requirements, signature checks and quorum behavior
are preserved. Tests cover two distinct signing identities, tampered candidates,
synchronous delivery and every cleanup path.

## Inbox discovery overlap

The taker starts recipient inbox discovery during its own registration. Outgoing
Cashu lock execution starts discovery for the next lock/acceptance message. These
read-only requests never delay saving the independent registration/Cashu result.
Message creation consumes the hint once, or performs normal discovery if absent,
failed, invalid or started more than ten coordinator-clock seconds ago.

Hints are bounded to 32 entries and scoped by session, actual AUTH public key,
recipient and message type. Only public inbox data is retained; discovery key copies
are cleared when the request settles. Cached events are validated again before use.
Discovery still observes all configured relays and chooses the newest valid list;
there is no first-response-wins change. Send-time relay capability evidence checks,
financial checkpoints and message ordering remain intact.

Regression tests cover non-blocking discovery, single consumption, expiration,
failed discovery, session isolation and signing-identity isolation. Existing two-party
integration tests exercise sell, buy and one-mint settlement flows.

## Pre-deployment validation

TypeScript passed. Full suite: 413 passed, 7 skipped. Native Chrome storage checks
passed, including cross-tab reset, stale-write rejection and non-exportability.
