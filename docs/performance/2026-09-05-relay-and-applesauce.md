# Relay fix and Applesauce review — 2026-09-05

## Branch decision

Bring `e6acd2f` (first valid inbox confirmation), with its redundant post-loop
wait removed and a regression check for delayed authentication after return.
Each discovery relay now publishes and reads back independently. Return when
the configured number of relays has acknowledged and returned the exact,
validated signed event. The default remains one. Other attempts finish in the
background with their own copied signing keys, erased on completion.

This is an inbox-registration change. Its durable evidence permits quorum-sized
receipt/readback sets. It does not change public order or private message outbox
receipt requirements. The August report's blanket rejection of early return
was too broad for this particular operation.

Leave `1b2a508` (copy: clarify Cashu exchange positioning) out. It changes UI
wording, not transport. Main already includes “Public orders. Private
settlement.” and Testnut funding messages. Other hunks target older controls
that main removed or redesigned. There is no separate performance fix to gain
from merging that commit; any still-desired wording should be reapplied to the
current UI individually. Preserve the branch because this commit remains
unmerged in ancestry.

## What Applesauce actually does

Reviewed official documentation and source at
`ec51f7d4ecfd3db6099e786e8eec0062255588d4` using the read-github workflow.

- Its [RelayPool](https://github.com/hzrd149/applesauce/blob/ec51f7d4ecfd3db6099e786e8eec0062255588d4/packages/relay/src/pool.ts)
  normalizes URLs and reuses a Relay object per URL. Pool removal can close its
  connection; closing the pool tears down all connections and timers.
- Its [RelayGroup](https://github.com/hzrd149/applesauce/blob/ec51f7d4ecfd3db6099e786e8eec0062255588d4/packages/relay/src/group.ts)
  shares upstream subscriptions, deduplicates returned events by default, and
  supports configurable completion. Its default request completes after all
  relays finish or five seconds after the first EOSE, subject to its operation
  timeout/auth handling. Ordinary `publish()` still gathers all responses.
- Its [loaders](https://applesauce.build/typedoc/modules/applesauce-loaders.html)
  batch and deduplicate address/ID requests, optionally consult a cache, and
  feed an event store. They accept a custom request method, including a
  nostr-tools adapter. The documented default batching window is 1,000 ms.

These are reusable design ideas, not evidence that replacing nostr-tools would
make Granola faster. No dependency was added.

## Ranked opportunities in Granola

| Priority | Concrete opportunity | Expected benefit and boundary |
| --- | --- | --- |
| 1 | Coalesce overlapping `refreshOrderBook` calls and trade-list renders in `src/main.ts`. | Share only in-flight presentation work; avoid duplicate relay queries and encrypted session reads. Schedule a trailing refresh when a mutation happens during the request, so a newly published/canceled order is not missed. Keep action-time order revalidation. |
| 2 | Render validated public order projections incrementally instead of fetching from `since=0` and rebuilding the whole book on every refresh (`OrderService.loadBook`). | Faster visible book updates and less repeated parsing. Reuse the existing public SimplePool. Keep latest-event replacement ordering, expiry, bounded memory, and reconnect backfill; cached open orders cannot authorize a trade. Measure request counts before adding a persistent store. |
| 3 | Finish exact-ID readbacks on a verified matching event, rather than waiting for EOSE (`NostrToolsInboxRelayPort.query`). | Removes event-to-EOSE waiting where only one exact artifact is needed. Requires a narrowly scoped completion predicate and cleanup. Do not apply first-event completion to latest kind-10050 discovery or whole-book queries. Measure that interval first. |
| 4 | Coalesce concurrent NIP-11 metadata requests (`NostrToolsInboxRelayPort.info`). | The existing cache stores completed results but concurrent cold callers can duplicate HTTP requests. Share an in-flight promise and evict failures if traces show duplicate cold loads. This does not replace capability probing. |
| 5 | Reuse authenticated connections within one reservation identity. | Could remove repeated connect/AUTH cycles. Only reconsider if fresh live profiles show those dominate; scope by relay and reservation pubkey, with bounded cleanup. A previous experiment saved roughly 41 ms synthetically but added about 316 production/test lines and was reverted. A global pool risks linking identities. |

Separate from Nostr, both Cashu adapters create wallets and call `loadMint()`.
Inspect repeated metadata HTTP calls before adding a cache for immutable public
key material. Never cache proof-spent observations or assume active keysets and
fees cannot change. The build's 593.58 kB JS chunk (176.06 kB gzip) also warrants
measuring cold startup before considering lazy imports; code splitting alone
does not make settlement faster.

Do not add Applesauce's one-second loader buffering to sequential swap steps.
Do not add another public connection pool: `RelayClient` already owns a
nostr-tools SimplePool. Private delivery already consumes a bounded live-event
buffer before polling. Prior discovery profiling found three distinct ephemeral
recipients, so a generic recipient cache would not eliminate those three reads.

## Validation of this patch

### Implemented follow-up

The approved first three opportunities are now implemented:

- Browser order-book and trade refresh bursts share outstanding work, with a
  trailing refresh when another update arrives during a read.
- The browser book subscribes through the existing public SimplePool. It
  validates incoming projections, keeps the latest event per address, retains
  canceled/filled tombstones, and renders changed books as events arrive after
  EOSE. Unchanged rows retain their inputs, focus and busy buttons. Order and
  reservation deadlines schedule local availability updates.
- Explicit refresh and a 60-second backfill reopen the subscription and reload
  its backlog, including recovery from initial connection failures. The feed
  is bounded to 2,000 queued events and 2,000 addresses; full backfill retains
  the existing 500-event limit per relay. This is a bounded live book, not a
  complete historical index. Action-time latest-projection queries are unchanged.
- Inbox registration supplies an exact validated-event completion predicate.
  Query cleanup closes both the subscription and connection immediately after
  a match, even when callbacks fire synchronously. Other queries still wait
  for EOSE, and malformed candidates cannot cause early completion.

The follow-up adds no library or private connection pooling. A clean snapshot
of the selected commit files passed the build and all 384 active tests in 50
files (7 skipped). The deterministic E2E benchmark passed all 10 scenarios in
three runs. A public-network feed check received eight book updates and ended
with two asks and five bids, then closed the subscription and pool.

A fresh disposable-event inbox check also passed: registration 2,243.34 ms,
discovery 999.66 ms, send 550.19 ms, read 611.26 ms. No paired speedup claim is
made. Kind 10050 `d493f6ac1d9f2286ad9f6a51cc91d75034c84095c0f228de12421776c09461bb`
had an ACK and exact readback from `wss://nos.lol`; kind 1059
`fcc0abf1939a0daeca25774e8f34fe7e1cc5a2a596977bb3425c8fc86fe60623`
had an ACK and recipient readback from `wss://auth.nostr1.com`.
Disposable signer public keys were recipient
`e8c55b5db383b7e5c8b7e8b38036fef2f5e719579ec1354fda499763cd347fe8`,
sender `1b09f4e3a561cc261e344eb5aeb63b2c7a69ce3ebdf3a9b863b7e04018c08093`,
and wrapper `ce89e9a7a2f7b746b0170814ac469c099722d78f282499e6555a86766d8d3013`.
Manual Testnut UI validation remains pending because the Mac is still locked.

### Earlier quorum-only validation

- `npm test`: 48 files passed; 379 tests passed, 7 skipped.
- `npm run build`: passed; existing large-chunk warning remains.
- `npm run benchmark:e2e`: all 10 deterministic scenarios passed in each of
  three runs, including buy, sell, one-mint settlement, retry, stale operations,
  reservation, release, cancellation and expiry. These are in-process fixtures.
- The gated relay regression proves completion while two relays remain blocked,
  then releases them and verifies their publish/query authentication identities
  and the returned evidence's unchanged size. Existing tests reject malformed
  readback and insufficient quorum and verify immutable evidence.
- A fresh public-network disposable-event probe succeeded. Registration took
  2,264.80 ms, discovery 1,415.78 ms, send 605.35 ms, read 589.12 ms. This single
  run has no paired baseline and establishes correctness, not a speedup.
- Manual Testnut UI validation of this exact patch remains pending: computer
  automation reported that the Mac was locked and automatic unlock failed.
  Earlier buy/sell Testnut validation predates this patch and is not substituted
  for a new run.

### Live relay evidence

Fresh disposable signers only; no wallet secrets or bearer material recorded.

- Recipient public key: `cbfe9e0625b03048b86c3f509c1730e941fc2ba164bfe049dd711044705fea9d`.
- Sender public key: `f513cf16145c97893b149dbe2c3346faf34161db87ed2e741ff1a7bac1864567`.
- Wrapper signer: `8b0d022693d54acbac841a1a94b3ea60bc2cd146f0a8aed96d6ff60c063b218f`.
- Kind 10050: `c1bbc2f69d998c5995f275a5f4886c297470dc4cdce466e8f0158cf0a0e5ea42`.
  ACK and exact readback: `wss://nos.lol`. Completed attempts also included
  failures from `wss://offchain.pub` and `ws://localhost:4870`.
  `wss://relay.primal.net` was also attempted; its outcome was not required in
  the returned quorum evidence.
- Disposable kind 1059: `6ad4f322e2e6fd8e12778e226d204704fcd6159606c0db52d75f91c340669096`.
  ACK and recipient readback: `wss://auth.nostr1.com`.
