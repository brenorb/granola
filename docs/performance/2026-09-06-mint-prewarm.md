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

Changing preflight to trust the warm cache would remove those calls only by
weakening the deliberate capability, active-keyset and rotation revalidation.
That tradeoff is not acceptable for settlement. Browser profiling and live mint
requests are left to the serialized validation pass.

## Validation

The existing mocked checks in `src/cashu/mint-wallet.test.ts` cover cache
isolation, expiry, failed-load eviction, explicit refresh and request coalescing.
No background-loop or startup module was added because it would add duplicate
metadata traffic without removing a critical request.

Run with:

```sh
npx vitest run src/cashu/mint-wallet.test.ts
```
