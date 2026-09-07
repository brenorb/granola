# Mint metadata anticipation

## Finding

No startup warmup was integrated. The existing loader already shares completed
and in-flight public metadata by normalized mint URL and unit, with a 60-second
TTL and a 32-entry bound. It clones info and keychain data for each Wallet, and
evicts failures so the next operation retries after network recovery.

## Request-count result

The mocked request-count checks show why. A hypothetical warmup for the two
configured pairs would load each pair once and let ordinary subsequent loads
reuse those entries. Trade preflight calls `inspectTradeMint(..., true)` for both
pairs on each wallet, so a preflight after a completed warmup still revalidates
both pairs. With two wallets, the existing 12 metadata requests in the swap
window remain 12 post-click requests, while warmup would add six requests per
page before the click (12 across two pages). It anticipates work but does not
reduce total network work or the critical count.

## Requirement versus risk

This is a freshness requirement in the current client, not a claim that the
protocol makes caching impossible. A short-lived cache could reduce preflight
requests while still applying capability and keyset validation at use time.
This review did not implement or validate that freshness-policy change.

The concrete rotation risk is the `active` flag. Cashu NUT-02 says wallets must
respect `active`, and a mint may inactivate an old keyset while activating a new
one. The keyset ID commits to public keys, unit, fee and final expiry, but not
the `active` flag, so an old cached entry can still say `active: true` after
rotation. In this client, `inspectTradeMint` selects that cached keyset, then
`verifyFunding` binds it into the session and `prepareHtlcLock` uses the wallet's
keyset data to construct outputs. The mint must accept inactive-keyset proofs as
inputs but must use an active keyset for new outputs. A stale cache can therefore
choose an output keyset the mint rejects. Rejection before spending is an
availability failure; this finding alone does not establish a financial loss.

NUT-03 describes swaps as invalidating inputs and issuing new promises. A
network error or ambiguous response still needs the existing durable checkpoint
and restore path; treating a mint rejection as a universal no-loss guarantee
would exceed what this review verified. A cache-policy change needs tests for
active-flag rotation, mint failure, ambiguous responses and recovery, including
an operation whose selected keyset changes after preflight. Refreshing again
immediately before locking is one conservative option, but would retain critical
requests; this review does not prove it is the only safe option. These 12 calls
remain a Granola policy choice, not unavoidable mint latency. No such policy
change is made here. See [NUT-02](https://github.com/cashubtc/nuts/blob/main/02.md)
and [NUT-03](https://github.com/cashubtc/nuts/blob/main/03.md).

Browser profiling and live mint requests are left to the serialized validation
pass.

## Validation

The existing mocked checks in `src/cashu/mint-wallet.test.ts` cover cache
isolation, expiry, failed-load eviction, explicit refresh and request coalescing.
No background-loop or startup module was added because it would add duplicate
metadata traffic without removing a critical request.

Run with:

```sh
npx vitest run src/cashu/mint-wallet.test.ts
```
