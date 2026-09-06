# Granola production profile — 2026-09-06

Follow-up: [mint metadata reuse and proof subscriptions](2026-09-06-mint-optimization.md)
are now deployed, with a new three-run live comparison. The measurements below
are the baseline before those changes.

## Scope and method

Profiled real 20 SAT / USD 0.01 Testnut swaps through the browser UI, using the
production Vite bundle served on localhost. Settlement code is `122083a`; the
only additional source change identifies mint metadata endpoints in the existing
opt-in profiler. No temporary state-count instrumentation is in this build.
Used distinct `testnut.cashu.space` and `nofee.testnut.cashu.space` mints.

Each wallet URL includes `debug=performance`. The existing
`#granola-performance` DOM element contains redacted action, resource and inbox
wait measurements. Joined both wallets' timestamps using
`timeOrigin + startTime`. The measured window starts at `granola:take-order-click`
and ends at the later `granola:trade-filled` mark for the same session; both
maker and taker marks are required. Funding and order creation precede this
window. Reloaded the wallets before each run.

Mint union merges overlapping Testnut HTTP intervals inside the click window.
Non-mint remainder is total wall time minus that union. Individual operation
unions overlap each other, and cumulative action/request durations overlap
across wallets: neither should be added as a partition of total latency.
HTTP resource timing and coordinator spans are not a CPU sampling profile.

## Measurements

All three production swaps completed automatically on both wallets, with no
Refresh Swaps or recovery action. Median click-to-both-Filled was **30.69 s**;
range **29.96–69.74 s**. Three samples characterize this session, not a p95 or
a controlled before/after speedup.

| Production run | Direction | Both Filled | Mint HTTP union | Metadata requests | Metadata union | Proof-state requests |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Sell | 29.96 s | 14.25 s | 81 | 7.01 s | 15 |
| 2 | Buy | 30.69 s | 15.28 s | 84 | 8.11 s | 16 |
| 3 | Sell | 69.74 s | 53.68 s | 81 | 46.48 s | 15 |

Metadata requests split evenly among info, keysets and keys: 27–28 of each per
swap across the two wallets. Every run also made four swap and four restore
requests. Proof-state request unions were 5.96, 7.26 and 6.16 seconds.

The third run had four overlapping requests to `nofee.testnut.cashu.space`
lasting approximately 40 seconds: one swap (39.97 s), and info/keysets/keys
(39.87 s each) from the other wallet. They began within 16 ms of each other.
The extra delay coincides with this shared HTTP stall. Cross-origin timing
exposed neither requestStart nor responseStart, so this trace cannot separate
server processing, network transport and browser scheduling. It is not evidence
that metadata processing itself consumed 40 seconds, nor that caching metadata
would eliminate a concurrently stalled swap request.

Across the three runs, cumulative coordinator spans were:

| Work | Count per swap | Cumulative duration range |
| --- | ---: | ---: |
| Inbox registration | 2 | 3.97–4.46 s |
| Private-message delivery | 3 | 3.12–3.54 s |
| Cashu execution | 4 | 7.28–46.67 s |
| Input reservation + wallet reconciliation | 8 | 0.13–0.16 s |
| Inbox watchdog waits | 2 | 10.01 s |

These spans overlap each other and the resource timings. In particular, the
watchdog total is not ten seconds of proven avoidable delay. Non-mint remainder
was 15.41–16.06 seconds; it includes relay work, scheduling and other gaps, not
just CPU execution.

## Findings

The strongest next optimization is eliminating repeated mint metadata loading.
`CashuTradeClient.defaultDependencies.wallet` creates a new cashu-ts Wallet and
calls `loadMint()` on every use. The installed cashu-ts implementation loads mint
info and initializes its keychain; the traces show repeated `/v1/info`,
`/v1/keysets`, and `/v1/keys` requests. Operations such as opening a token,
validating a lock, claiming, restoring and observing repeatedly pay this cost.

Priorities:

1. Reuse public mint metadata or appropriately scoped Cashu Wallet instances by
   normalized mint URL and unit. Preserve live active-keyset/fee refresh where
   required, isolate operation state, and always fetch proof state fresh. Measure
   request counts before/after; do not assume all metadata union time is removable.
2. Reduce the work around repeated state observations. Keep NUT-07 checks and
   witness verification, but avoid rebuilding the wallet around every check.
   Consider pacing unchanged observations after measuring it. The existing
   200-action limit can still stop unusually long waits; the pending fix does
   not remove that bound.
3. Investigate inbox subscription readiness versus the five-second watchdog.
   Watchdog intervals overlap peer-side work, so they are not automatically
   wasted time. Correlate delivery, subscription readiness and buffered events
   before shortening the timeout or adding polls.
4. Measure connection/AUTH/query subspans within inbox registration and private
   delivery. They remain significant after first-quorum/early-readback changes.
   This is a measurement recommendation, not a decision to introduce a shared
   private connection pool or weaken per-reservation identity isolation.

For tail latency, repeat the same measurements against another compatible mint
and collect server-side timing where available. The observed shared 40-second
stall deserves separate diagnosis from Granola's repeated metadata requests.

Keep restore-before-retry and exact signed readback: they provide crash recovery
and publication evidence. Their costs are visible, but deleting those checks is
not the optimization proposed here.

Local wallet reconciliation and input-reservation actions are much smaller than
the network-bearing operations. The production JS bundle is 596.58 kB, 177.09 kB
gzip. This run does not measure a cold internet download of that bundle, so it
does not establish startup performance or justify a bundle rewrite.

## Correctness context

The [pending-state report](2026-09-06-pending-state-fix.md) separates the proven
classification bug from the unavailable historical mint response. A pending
batch now remains in flight; only verified spent witnesses establish settlement.
Regression tests exercise the formerly failing response and both coordinator
directions through pending observations.

The profiler's unsuccessful `poll_inbox` actions are recoverable empty reads;
they are not failed swaps. No retry button is used during production profiles.
No proof IDs, keys, tokens, witnesses, preimages or invoices are captured.

Validation: 392 tests passed, 7 skipped; TypeScript and production build passed.
The deterministic E2E benchmark passed all 12 scenarios in each of three runs,
including pending-state settlement in both directions. Two additional manual
swaps on the fixed development build completed before these production runs.
After all five fixed swaps, reload preserved balances of 9,890 SAT + USD 0.05
and 100 SAT + USD 99.95, consistent with five 20 SAT transfers and mint fees.

To repeat: build and serve the production bundle, fund two isolated test wallets
at distinct NUT-07/NUT-14-compatible mints, add `debug=performance` to both URLs,
reload both, and take a 20 SAT / USD 0.01 order through the UI. Collect only the
redacted timeline, match session IDs across both wallets, and use the later
Filled mark. Keep funding, order publication and reload outside the measured
window. Retain slow samples and report overlapping timings separately.
