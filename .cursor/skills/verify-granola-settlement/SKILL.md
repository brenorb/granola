---
name: verify-granola-settlement
description: "Check Granola's settlement model when changing swap action priority, mint evidence, deadlines, settlement completion, or refund and release."
---

# Verify Granola settlement

A session can show filled only after independent spend evidence for both protocol legs. A trader could be told a swap finished while one side is still locked.

## Run

From the repository root, set `TLA2TOOLS` to the absolute path of the [TLC 1.7.4 release jar](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). Use Java 17 or set `JAVA` to its absolute path. The runner checks the jar checksum.

```sh
bash scripts/verification/check-model.sh .cursor/skills/verify-granola-settlement/model/Settlement.tla
```

TLC checks `FilledNeedsEvidence` over the bounded reachable states. Add `--mutant` to require a counterexample for the deliberately broken model. Use pstack `/statechart` to inspect the graph or failing trace.

## Compare with the implementation

- `src/trade/coordinator-plan.ts` · nextCoordinatorAction, bothLegsSpent, recoveryAction, terminal. Role, routing, action priority, and mint evidence.
- `src/trade/effects.ts` · rootPhase, applyLocal, observeLeg, commitOrderPublication. Public phase, observations, settlement and release writes.
- `src/trade/model.ts` · createSettlementPlan, slotLeg. Cutoff ordering and offer/payment mapping.
- `src/storage/trade-session.ts` · assertMonotonicUpdate. Persisted phase and observation constraints.

Source sync commit `0fc2d4a5a23837654e23bff16383880efffb7eb1`.

One session view, either role and route, two HTLC slots, three normal wire commits, and six ordered clock buckets. A verified spend stands for a mint read with a valid witness. The model abstracts peer progress, polling, cryptography, mint internals, detailed journal priority, and extended transcript compatibility. It checks safety without a fairness or eventual refund guarantee.

## Recheck after changes

Read the changes to the covered functions since the sync commit. Replay counterexamples on the implementation and repair model drift when a step cannot occur. Record deliberate property changes with source evidence. Move the sync commit after confirming the model describes the new code.

Run the implementation test on clean source and on a disposable copy with the guard broken. Skip the offered-leg evidence branch in the settling planner. The test expects observation to continue while that leg is unconfirmed.

```sh
npm test -- src/trade/coordinator-plan.test.ts -t "plans claim, observation, fill, and settlement only from mint evidence"
```

Restore the scratch source and rerun the implementation test and unmodified model. Use pstack `/maintain-formal-verification-skill` to resync after later changes.
