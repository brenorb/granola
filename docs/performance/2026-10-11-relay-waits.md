# Relay waits and real swap measurements — 2026-10-11

No additional relay speed change is retained. Returning a public publication's
first successful ACK produced small, inconsistent differences in complete swaps.
The waits it moved are already background work. The private sends are on the
financial path, but today's browser config uses one verified inbox relay, so
there is no second private-publication attempt to stop awaiting.

The production JavaScript after removing the prototype is byte-identical to the
previous validated implementation: `index-C4A0chHS.js`, SHA-256
`a3ca6191105e072cf028d55edd2c8bbeb3e2f0392cdb1709d266d85aed7cf0f7`.
The previously accepted fresh NUT-07 observation and monotonic SPENT wakeups
remain. An unmeasured claim-preparation draft was set aside before this experiment
and is absent from the retained production source.

## Which waits matter

| Path | Effect on Take → both Filled | Decision |
| --- | --- | --- |
| `publishGiftWrap` → `NostrTradeTransport.send` → `deliver_outbox` | Each of the three outgoing private messages requires at least one authenticated inbox ACK. The implementation awaits all configured inbox attempts. The current runtime advertises and probes only `wss://auth.nostr1.com`. | A potential multi-inbox opportunity, with no redundant wait in the present configuration. No private transport change or unverified extra inbox was introduced. |
| `RelayClient.publish` → order publication | One public ACK suffices, while all configured publication attempts are awaited. Direct-routing reserve/fill announcements run independently of financial completion. | Tested first-ACK return with continued replication and durable completion, then rejected as a trading-speed change. |
| `publishInboxList` | Already returns after the required ACK **and exact validated signed-event readback** quorum. Other relay attempts continue with their own key copies. With authenticated direct routes, registration is background work. | Preserve the existing early-return behavior and full validation. An ACK with a stale or substituted readback is insufficient. |
| `TradeApi.loadExactOrder` → `loadBook` → `queryProjections` | The taker's action-time book refresh is timed. An early open projection can be superseded by a delayed cancellation or reservation. | Preserve pooled collection, signature/market validation, replacement ordering, retained cancellation heads and expiry checks. |
| `currentProjection` → `queryOrder` | Protects exact current heads and successor publication, including retry after restart. Some calls run during financial staging and others during background publication. | Preserve response reconciliation. Finding the expected old event on a fast relay does not establish that it is current. |
| Inbox discovery and fallback inbox queries | Direct routes and already-buffered live messages avoid these waits in the measured swaps. Latest-list discovery reconciles signed responses; fallback gift-wrap queries validate outer envelopes before the separate full message-validation pipeline. | No first-empty-response or first-outer-wrapper shortcut. A valid wrapper alone does not validate the contained protocol message. |
| `RelayClient.readback` | Used by the test-order publication script, not by browser financial completion. | Unchanged. This generic helper must not be confused with the strict signed inbox-registration readback. |

The private `deliver_outbox` actions had median durations of approximately
0.40–0.42 seconds. These include authentication and publication waits; receiving
and mint work in the other wallet can overlap them. Adding three such durations
does not measure three independent critical-path savings.

## Prototype and recovery contract

The isolated candidate snapshots and verifies the signed public event, starts
every configured publication attempt and returns the first successful receipt.
Rejections do not satisfy the minimum; if all attempts fail, it returns all
failure receipts and leaves the exact staged event available for retry.

Remaining attempts continue in the background. The exact order-outbox entry is
persisted as acknowledged before awaiting replication, and is committed only
after those attempts finish and their receipts merge. After a restart, it checks
the current head before replaying the same signed artifact; a stale event cannot
overwrite a cancellation. No new public event, receipt ledger, private message,
key reuse, or bearer disclosure was added. These prototype changes were removed
from production after the comparison.

The rejected source, tests and patch remain outside the repository at
`/private/tmp/granola-relay-first-ack-candidate`. Its cross-mint bundle is
`index-BK8aiOCC.js`, SHA-256
`3b4037dfa6f7d3d7a40c0e9facffea66e2ba804e81375983e54bff80a2f15ce2`.
The one-mint candidate is `index-Bptu8OwC.js`, SHA-256
`bbd96c221bb9c5a2c983de695b8eb54ca74efc728baa238453a0834b7a485082`.
The one-mint baseline is `index-Cwkm8a7Z.js`, SHA-256
`4c378e2ba39bb80dfadb6d10793b7924a7f8577419e1cc112966f9b2596407e4`.

## Contemporaneous real results

Each topology used four matched pairs, alternating baseline/candidate order
AB, BA, AB, BA and maker direction sell, buy, sell, buy. Swaps did not overlap.
Fresh isolated test wallets were funded before timing, and both variants used
the same five-second pre-click warmup. The timed window starts at the actual
Take click and ends at the later of the two Filled marks.

| Topology | Baseline median | Candidate median | Observed median difference | Faster candidate pairs |
| --- | ---: | ---: | ---: | ---: |
| Distinct SAT/USD mints | 9.690 s | 9.613 s | 76 ms / 0.8% | 2 of 4 |
| One mint, distinct SAT/USD keysets | 10.205 s | 9.972 s | 233 ms / 2.3% | 2 of 4 |

These are observed differences, **not demonstrated causal speed gains**. The
paired savings in milliseconds were:

| Pair / direction | Cross-mint | One mint |
| --- | ---: | ---: |
| 1 / sell | −57.3 | −378.1 |
| 2 / buy | −659.8 | +840.5 |
| 3 / sell | +246.6 | +548.6 |
| 4 / buy | +798.9 | −255.2 |

The cross-mint baseline/candidate HTTP interval unions were 6.788/6.840 seconds;
relay-response unions were 2.711/2.513 seconds. The one-mint equivalents were
7.617/7.544 and 3.330/2.814 seconds. These intervals overlap across operations
and wallets and include background relay work. They cannot be summed, subtracted
from wall time to infer CPU, or used as a causal estimate of critical relay waits.
For example, one-mint pair 3's 549 ms wall-time difference accompanies a 540 ms
difference in measured mint HTTP intervals.

All 16 swaps retained three messages (`reserve_propose`, `reserve_accept`,
`quote_lock`), both SPENT legs with runtime-validated preimage witnesses, exact
SAT/USD credit assertions, fee-aware debits, equal balances after reload, both
Filled states after reload, and absence from the validated open book. Each
variant received real spent WebSocket notifications from every participating
mint under its production page CSP. Cross-mint settlement used distinct URLs
and keysets. Mint requests stayed at 12 metadata requests, 12 NUT-07 checks,
four restore calls and four swaps per measured swap in both variants.

Raw evidence:
[cross-mint comparison](2026-10-11-relay-cross-mint-comparison.json) and
[one-mint comparison](2026-10-11-relay-one-mint-comparison.json).
The measured windows were 03:12–03:16 UTC and 03:16–03:21 UTC on October 11;
they must not be compared to historical measurements as if contemporaneous.

## Relay acknowledgements

Every measured swap recorded exactly three actual kind-1059 ACKs from
`wss://auth.nostr1.com`: 48 private ACKs across 16 swaps. Private wrapper IDs,
authors, contents and bearer material are excluded from saved observations.

| Topology / variant | Private inbox ACKs | `nos.lol` public ACKs | `relay.primal.net` public ACKs | `offchain.pub` public ACKs |
| --- | ---: | ---: | ---: | ---: |
| Cross / baseline | 12 | 8 | 8 | 4 |
| Cross / candidate | 12 | 8 | 8 | 0 |
| One / baseline | 12 | 11 | 12 | 6 |
| One / candidate | 12 | 12 | 12 | 0 |

These are **observed** ACK counts, not a promise that all replicas succeeded.
The JSON records signed public order event IDs, public test signers, relay URLs
and ACKs. Cross-mint public observations were captured before final background
drain, so their replica counts are incomplete. The one-mint harness explicitly
waited for pending public announcements to drain after Filled, before reload,
and verified every observed outgoing EVENT/AUTH signature with zero invalid
signatures. No ACK was observed from the configured local mesh relay. An
unobserved ACK is not classified as an explicit negative server response.

## Regression coverage and retained profiling fixes

The candidate fault tests passed for first sufficient ACK with a still-pending
slow replica, a disconnected replica, all-rejected publication, invalid signed
publication, durable acknowledged state before replication completion, exact
replay after restart without re-signing, and rejection of a stale replay after
cancellation. Prototype-specific tests were archived with the removed prototype.

Retained regressions verify that a fast ACK with a stale, correctly signed inbox
list cannot end publication before a slow exact readback; conflicting signed
same-time lists use deterministic replacement ordering and cannot invent a
higher quorum; and a delayed, genuinely signed cancellation prevents a fast old
order from satisfying both book and exact-current-order checks. Existing tests
retain malformed same-ID readback rejection, scoped relay cleanup and key-copy
zeroization.

The production-CSP browser reconnect check passed against both baseline and
candidate: retain the book on disconnect, preserve it beyond 61 seconds, accept
cancellation after reconnect, and prevent a delayed old event from reopening it.
This is controlled browser fault injection, separate from the real mint swaps.

Existing regression coverage also includes replay, expiry, wrong mint/unit,
already-spent or pending proofs, duplicate reservations, mint outage, lost mint
response with exact restore, and bound mid-swap error/abort and refund cutoffs.
An authenticated mid-swap error is terminal for subsequent happy-path messages;
abort seals require the counterparty signature. Faults were not induced in live
mint swaps. Seven existing skipped tests, including a legacy reservation/abort
transcript-binding case, are not counted as passing coverage.

Final retained source: **458 tests passed, seven skipped, 52 files**; production
typecheck/build and `git diff --check` passed. The harness now checks all outgoing
signatures, checks background public drain outside timing, records safe private
ACK counts, correctly attributes buy-side subscription slots to actual mints,
and rejects incomplete or duplicated-run comparisons. Correcting the earlier
buy-side subscription labels did not change any recorded times or outcomes.

## Other rejected observation experiments in this profiling round

An additional NUT-07 request racing a WebSocket wakeup was tested separately,
with fresh full validation retained. Neither variant improved complete swaps:

| Extra observation | Cross-mint baseline median | Candidate median | Decision |
| --- | ---: | ---: | --- |
| Fixed 500 ms delay | 9.289 s | 9.782 s | Reject; extra request and slower E2E |
| Delay based on 3× measured fresh-state RTT, bounded to 800–2000 ms | 9.063 s | 9.387 s | Reject; shorter observation did not produce faster E2E |

Each row has its own four interleaved real pairs, both maker directions and
complete validation. Evidence:
[fixed-delay race](2026-10-11-rejected-proof-race-500ms.json) and
[paced race](2026-10-11-rejected-proof-race-paced.json).
Incomplete attempts were excluded. The extra poll/cancellation machinery was
removed; these experiments did not contaminate the isolated relay candidate.

## Reproduction

Use `scripts/profile-live-trades.mjs` with the appropriate preserved production
builds, `GRANOLA_PROFILE_RUNS=4`, `GRANOLA_PROFILE_REQUIRE_WEBSOCKETS=1`, baseline
and comparison URLs, and an installed Playwright module. For one-mint settlement,
both builds must configure the same HTTPS/WSS origin pair and USD/SAT market,
and the harness quote mint must agree. Funding stays outside the timed window.
Do not enable raw-frame logging, HAR, screenshots or tracing.

Summarize a completed JSON file with `scripts/summarize-live-profile.mjs`.
Run `npm test`, `npm run build`, and the controlled
`scripts/check-orderbook-reconnect.mjs` against each preview. Temporary preview
servers were stopped after validation; the measured bundles remain in the
temporary fixture directories and production retains the validated baseline.
