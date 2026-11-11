---
name: verify-granola-cashu
description: "Check Granola's cashu model when changing prepared mint operations, proof reservations, wallet reconciliation, mint notifications, or funding."
---

# Verify Granola cashu

Replaying the same completed swap operation can apply its wallet result at most once. Reconciliation after reload could apply a second wallet write for the same already recorded proofs.

A new funding quote's local credit marker and wallet write commit together. This keeps an interrupted issuance recoverable and prevents a false success report.

## Run

From the repository root, set `TLA2TOOLS` to the absolute path of the [TLC 1.7.4 release jar](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). Use Java 17 or set `JAVA` to its absolute path. The runner checks the jar checksum.

```sh
bash scripts/verification/check-model.sh .cursor/skills/verify-granola-cashu/model/Cashu.tla
```

TLC checks `WalletResultAppliedOnce` and `FundingCommitIsAtomic` over the bounded reachable states. Add `--mutant` to exercise a duplicate swap wallet write. To exercise a split funding commit, copy the model and config to a scratch directory and set `BreakFunding = TRUE` in that copy. The check must find a credit marker without a wallet write. Use pstack `/statechart` to inspect the graph or failing trace.

## Compare with the implementation

- `src/trade/effects.ts` · prepareCashu, reserveCashuInputs, executeCashu, reconcileWallet. Operation journal and separate reservation, mint, and wallet writes.
- `src/core/proof-reservations.ts` · reserveProofs, releaseProofReservations. Proof ownership.
- `src/trade/wallet-reconcile.ts` · reconcileProofReplacement, reconcileExactProofOutputs. Reconciliation and exact retries.
- `src/cashu/trade-client.ts` · completeOutgoingLock, completeClaim, completeRefund, observeSpentInternal. Mint results and evidence.
- `src/cashu/proof-subscription.ts` · waitForProofsSpent. Notification or timeout wakeup.
- `src/cashu/client.ts` · checkAndMint, completeFundingIssuance, restoreMintProofs. Prepared outputs are saved before issuance. An issued quote can restore those outputs.
- `src/api/granola-api.ts` · claimMint, saveWithWallet. Credit commits once and the saved outputs are removed in the same write.
- `src/storage/wallet-repository.ts` · saveAlongside, setMany, transact. Both writes share one IndexedDB transaction.

Source sync commit `f918068913456ec9c9732f5596127e91513b11cf`.

One operation or funding quote, one proof batch and reservation owner, one notification wait, and up to two wallet writes. Signatures, proof contents, amounts, legacy issued quotes without recovery data, concurrent wallets, and multi-input ownership conflicts are outside the bound. See the [funding chart](../../../docs/verification/flows/fund-wallet/report.md) for the user-facing flow.

## Recheck after changes

Read the changes to the covered functions since the sync commit. Replay counterexamples on the implementation and repair model drift when a step cannot occur. Record deliberate property changes with source evidence. Move the sync commit after confirming the model describes the new code.

Run the implementation test on clean source and on a disposable copy with the guard broken. Make the exact-output retry return a changed wallet revision. The test requires the same wallet object for an already-applied result.

```sh
npm test -- src/trade/wallet-reconcile.test.ts -t "adds exact claim or refund outputs once and treats an exact replay as a no-op"
```

For funding, write the quote marker separately before the combined commit in a disposable copy. The commit-abort case must catch the premature marker.

```sh
npm test -- src/api/granola-api.test.ts -t "credits a saved funding quote once after an interruption"
```

Restore the scratch source and rerun the implementation test and unmodified model. Use pstack `/maintain-formal-verification-skill` to resync after later changes.
