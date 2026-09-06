# Manual Testnut validation — 2026-09-06

Follow-up: the confirmed pending-state classification bug was fixed in `122083a`.
See the [investigation and evidence limits](2026-09-06-pending-state-fix.md) and
[production profiling results](2026-09-06-production-profile.md). The observations
below describe the earlier revision.

Tested the pushed `b043b6259775e46e15faa92d171ea0c51d70eb0f` source in a clean
checkout served locally on port 5180. Compared its tracked source, index and
package manifest against HEAD: no differences. Browser actions used the real
UI and fresh `verify-maker-0906` / `verify-taker-0906` wallet profiles.

## Result: settlement and recovery pass; automatic settlement needs follow-up

Funded the first wallet with 10,000 Testnut SAT and the second with 10,000
Testnut USD cents. Settlement used distinct mints:
`https://testnut.cashu.space` and `https://nofee.testnut.cashu.space`.

| Check | Observation |
| --- | --- |
| Sell-side order | Posted 20 SAT at 50,000 USD/BTC; three public relay acknowledgements. Appeared in the other wallet without Refresh Orders. |
| Sell-side settlement | Both wallets reached Filled with three accepted private messages. The maker reported `Cashu HTLC invariant failed: proof-not-spent` at Quote locked. One Refresh Swaps retry resumed the saved state and completed settlement. The taker reported 170 verified actions. |
| Buy-side order | Second wallet posted the matching 20 SAT bid. It appeared in the first wallet's live book; expanded bids with See more and clicked Sell into bid. |
| Buy-side settlement | Both wallets reached Filled with three accepted private messages. The SAT-selling wallet again reported `proof-not-spent` at Quote locked. One Refresh Swaps retry completed the saved swap. |
| Book removal | Both completed test orders disappeared from the public book. |
| Persistence | Reloaded both wallets; balances and both Filled sessions persisted. |

| Wallet | Initial | After sell-side swap | After buy-side swap |
| --- | --- | --- | --- |
| First (SAT-funded) | 10,000 SAT | 9,978 SAT + USD 0.01 | 9,956 SAT + USD 0.02 |
| Second (USD-funded) | USD 100.00 | 20 SAT + USD 99.99 | 40 SAT + USD 99.98 |

## Unresolved findings

The automatic-settlement error reproduced in both directions. Do not describe
this revision as passing unattended manual E2E. Recovery succeeded without
recreating an order or importing/exporting bearer material.

Source inspection found that `CashuTradeClient.observeSpentInternal` returns
UNSPENT only when every proof is UNSPENT; otherwise it calls
`extractSpentPreimage`, which requires every proof to be SPENT. A pending or
mixed mint response can therefore raise the observed error. The live UI does
not expose the exact proof-state vector, so the underlying mint response and
causal connection to the recent optimizations remain unconfirmed. Investigate
pending-state handling with a focused regression test before changing settlement
logic; retain the requirement for verified spent witnesses.

The Filled cards also retain the subtitle “Waiting for verified mint state.”
This is inconsistent presentation; the Filled state and persisted wallet
balances independently confirmed completion.

No private keys, proofs, preimages, invoices, tokens or wallet backups were
extracted. No speedup is inferred from these two runs.
