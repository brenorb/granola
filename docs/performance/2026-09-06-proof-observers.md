# Proof observer optimization review

This review did not change production code. The concrete observation path is:

1. `GranolaCoordinatorEffects.performExternal` dispatches `observe_base` or
   `observe_quote` to `observeLeg`.
2. `observeLeg` calls `CashuTradeClient.observeSpentInternal` for the exact
   persisted leg token and commitment.
3. `observeSpentInternal` waits for a NUT-17 proof-state notification through
   `waitForProofsSpent`, then calls `snapshot`, which performs a fresh NUT-07
   check before the existing static-lock, state, DLEQ, and preimage-witness
   validation.

The measured swap shape contains four successful proof WebSocket waits: two
wallets and two settlement legs. The legs use distinct proof sets, so those
four subscriptions are required observers rather than duplicate same-input
work. Coordinator actions are serialized, and no reachable call site was found
that starts two concurrent waits for the same mint, unit, and complete proof
identity set.

An exact-input in-flight registry was prototyped and removed. Without a real
same-input overlap it would add shared lifecycle state and cancellation rules
around a WebSocket whose notifications are only wakeup hints. It would also
create no reduction in the required fresh NUT-07 requests or witness checks.

The existing tests passed after the review:

- `npm test -- --run src/cashu/proof-subscription.test.ts src/cashu/trade-client.test.ts` — 18 passed
- `npm run typecheck` — passed
- `git diff --check` — passed

No live mint or relay profiling was performed for this review. A future change
needs a paired redacted measurement of observation keys and overlap duration,
without recording proof identifiers, secrets, witnesses, or preimages. Add
coalescing only if identical in-flight proof sets are observed, while retaining
the fresh NUT-07 and full witness validation path.
