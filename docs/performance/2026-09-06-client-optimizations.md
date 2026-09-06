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

## Deployed measurements

Runtime commits `0d5b00e`, `4de4618`, `8361d67` shipped in
[Pages run 34049387899](https://github.com/brenorb/granola/actions/runs/34049387899).
A clean HEAD snapshot built `index-C40Ig8Uc.js`; both live wallets loaded that exact
asset. The unrelated SDK/documentation work in the checkout was not included.

The same Chrome/CDP profiling runner exercised three real Testnut UI swaps against
the deployed site, with reloads between samples. No Refresh Swaps/manual recovery.
The baseline below is the **already metadata-optimized** version from the wallet
boundaries report, not the older 81–84-metadata-request version.

| Measurement | Previous sell / buy / sell | Updated sell / buy / sell |
| --- | --- | --- |
| Both wallets Filled | 24.277 / 31.723 / 24.987 s | 20.351 / 22.018 / 23.262 s |
| New relay connections | 20 / 21 / 20 | 16 / 16 / 16 |
| Relay handshake interval union | 5.541 / 6.480 / 5.969 s | 4.351 / 4.523 / 4.471 s |
| IndexedDB transactions, both wallets | 641 / 634 / 646 | 375 / 367 / 381 |
| IndexedDB transaction interval union | 1.009 / 1.246 / 1.835 s | 0.289 / 0.382 / 0.524 s |
| Web Lock acquisitions | 421 / 423 / 432 | 160 / 158 / 165 |
| Metadata HTTP requests | 12 / 12 / 12 | 12 / 12 / 12 |
| Proof-state POST requests | 10 / 10 / 11 | 10 / 10 / 12 |
| Actual mint swaps / restore checks per run | 4 / 4 | 4 / 4 |

Median duration fell from **24.987 s to 22.018 s**: **2.968 s / 11.9% lower**.
IndexedDB transaction counts fell 41.5% on average. CPU improvement was modest;
JavaScript estimates per wallet were 0.618–1.092 s after the change. The main gain
comes from less I/O and overlapping discovery, not removing cryptographic checks.
The three message-staging actions now took 19–36 ms each, versus roughly one second
or more when each awaited discovery serially. The discovery itself still happens.

There were four successful proof WS waits in run 1; run 2 had three successes and
one unavailable result; run 3 had two successes and four unavailable results.
Fallback HTTP completed settlement safely. These remote/transport variations mean
three sequential samples cannot establish a guaranteed speedup or tail latency.
Intervals overlap and are not additive contributions to total duration.

Both wallets retained three Filled sessions before reload and expected balances
after reload: A with 9,934 SAT + USD 0.03, B with 60 SAT + USD 99.97. Funding used
only the fake-token buttons in isolated browser profiles. Safe local timing artifacts
are `work/profiling-boundaries/capture-after.json` and `summary-after.json`.

A separate manual sell swap in the in-app browser completed in **20.212 s**, with
all four proof WS waits receiving SPENT. Both Filled states and the balances
(9,978 SAT + USD 0.01; 20 SAT + USD 99.99) persisted after reload. The UI reported
three public relay acknowledgements. Profiles: `client-maker-0906` and
`client-taker-0906`; public relays: nos.lol, relay.primal.net, offchain.pub; private
inbox: auth.nostr1.com. These are aggregate UI ACK counts, not per-relay receipts.

The manual reverse-direction buy swap completed in **20.660 s**, also with all four
proof WS waits receiving SPENT and three public publication ACKs. Public order event:
`bc6f3bc1bbf17d6aeae48bb729af79ca0548b906cf2a446e2b542d675461c62f`.
After the two manual swaps, reload preserved 9,956 SAT + USD 0.02 in A and
40 SAT + USD 99.98 in B. Both manual sessions reached Filled on both sides.
