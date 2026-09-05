# Granola simplification and validation — 2026-09-05

Removed the unused transcript implementation, disconnected phase/event reducer,
and startup wrapper. Required per-order maker key access, consolidated transcript
record updates, and shared buy/sell settlement-leg mapping. The browser
`advanceTrade(sessionId)` API and durable settlement validation remain in place.
The in-progress SDK entry point no longer exports the disconnected reducer.

## Automated validation

- Production build and typecheck passed (existing large-chunk warning).
- Full suite: 48 files passed, 378 tests passed, 7 previously skipped tests.
- E2E benchmark: all 10 scenarios passed in each of three runs, including
  cross-mint sell, cross-mint buy, one-mint settlement, reserve, release,
  cancellation/expiry, retry, and stale-operation rejection.
- Deterministic E2E settlement medians: sell 695.85 ms, buy 602.88 ms,
  one-mint 595.15 ms. These are fixture timings, not Internet latency.

## Real manual Testnut validation

Used the local application at http://127.0.0.1:5178 with two fresh browser
profiles, `audit-maker-0905` and `audit-taker-0905`. All funding, publication,
and taking actions were performed through the UI with real Testnut mints
and Nostr relays. No bearer material was exported.

Sell: 20 SAT for one USD cent, price USD 50,000/BTC, all-or-none.
The SAT leg used https://testnut.cashu.space and the USD leg used
https://nofee.testnut.cashu.space. Public order publication received three
relay acknowledgements; the maker listener registered on wss://auth.nostr1.com.
Both sides reached Filled and displayed three accepted private messages;
the taker reported 23 verified actions.

| Wallet | Before | After |
| --- | --- | --- |
| Original maker | 10,000 SAT | 9,978 SAT + USD 0.01 |
| Original taker | USD 100.00 | 20 SAT + USD 99.99 |

The 2 SAT beyond the trade amount was the SAT mint fee. The filled ask
left the refreshed order book; the maker's Filled session survived reload.

Buy-side: the original taker then posted a 20 SAT bid at the same price,
acknowledged by three relays. The original maker took it through the UI,
reversing the wallets' maker/taker roles. Both sides reached Filled again,
each showing three accepted private messages. The taking wallet reported
25 verified actions. Final balances:

| Wallet | After both swaps |
| --- | --- |
| Original maker | 9,956 SAT + USD 0.02 |
| Original taker | 40 SAT + USD 99.98 |

Both wallets were reloaded after the buy-side swap; balances and both Filled
sessions persisted. The test bid was absent from the refreshed order book.
The browser tabs remain available for inspection. The sessions used distinct
per-reservation identities; no existing wallet profiles were modified.
The test used the actual local working tree, including the pre-existing SDK
facade extraction; that unrelated extraction is not included in the refactor commit.

## Branch consolidation

Fast-forwarded the old working branch and local main to origin/main, incorporating
already-merged NIP-17 and coordinator improvements. Resolved the README conflict
by retaining both sets of documentation links. Preserved existing SDK/docs work.

Archived 35 retired local branches as `archive/2026-09-05/<original-branch>` tags.
Their commits also exist in the verified local bundle
`.git/branches-before-cleanup-2026-09-05.bundle`; exact original refs and worktree
status are recorded in `.git/branch-cleanup-2026-09-05.json`.
Clean linked worktrees were detached at their existing commits and retained.
Restore an archived branch with `git branch <original-branch> archive/2026-09-05/<original-branch>`.

Two side branches were retained explicitly:

- `feat/order-state-badges`: uncommitted UI work in its linked worktree.
- `fix/first-valid-ack-readback`: unmerged relay ACK/readback behavior.

Historical experiments were archived, not merged into the application. Remote
cleanup was subsequently completed with user approval. The main workspace's pre-existing documentation, SDK,
publication configuration, and performance artifacts remain uncommitted.

## Completed remote cleanup

The following 26 remote branches are merged, patch-equivalent, or (for
`fix/pending-publication-below-order`) incorporated by squash PR #14.
The user approved deletion. A fresh remote listing showed 21 were already
absent and five remained. Deleted those five atomically with exact-SHA leases,
then pruned stale local tracking refs. Verified that only `main` and
`fix/first-valid-ack-readback` remain on GitHub.

- `agent/orderbook-performance-audit`
- `experiment/nip17-profiling-base`
- `feat/issue-3-compact-mint-action`
- `feat/issue-4-shared-maker-taker-page`
- `feat/readable-dm-transcript`
- `feat/three-message-swap`
- `fix/aon-label`
- `fix/auto-accept-maker`
- `fix/button-feedback`
- `fix/buy-order-htlc-deadlines`
- `fix/compact-expandable-orderbook`
- `fix/demo-delete-one-click`
- `fix/inbox-relay-reconnect`
- `fix/issue-5-bid-taking`
- `fix/mobile-fund-buttons`
- `fix/one-click-settlement`
- `fix/one-relay-acknowledgement`
- `fix/order-reservation-outbox`
- `fix/orderbook-best-ask`
- `fix/pending-publication-below-order`
- `fix/protocol-trace-from-main`
- `fix/remove-market-metadata`
- `fix/resume-stalled-settlement`
- `fix/same-second-mint-observations`
- `fix/take-order-one-click`
- `perf/reduce-coordinator-checkpoints`

For future cleanup, enumerate full refs and exclude symbolic refs explicitly;
Git can shorten `origin/HEAD` to `origin`. Use `ls-remote --heads` to distinguish
actual remote branches from stale tracking refs. Local and remote tips can
differ, so remote recovery tags use `archive/2026-09-05/remote/<branch>`.
The verified remote backup is `.git/remote-branches-before-cleanup-2026-09-05.bundle`.
