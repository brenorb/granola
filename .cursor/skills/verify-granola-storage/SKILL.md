---
name: verify-granola-storage
description: "Check Granola's storage model when changing session persistence, compare-and-swap, concurrent announcements, profile reset, or session admission."
---

# Verify Granola storage

A result computed before a conflicting financial update must not merge into the current session. A stale effect could overwrite newer financial state during reconciliation.

## Run

From the repository root, set `TLA2TOOLS` to the absolute path of the [TLC 1.7.4 release jar](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). Use Java 17 or set `JAVA` to its absolute path. The runner checks the jar checksum.

```sh
bash scripts/verification/check-model.sh .cursor/skills/verify-granola-storage/model/Storage.tla
```

TLC checks `NoStaleFinancialMerge` over the bounded reachable states. Add `--mutant` to require a counterexample for the deliberately broken model. Use pstack `/statechart` to inspect the graph or failing trace.

## Compare with the implementation

- `src/trade/coordinator.ts` · advanceOnce, settlementSnapshot, startAnnouncements. External snapshot and concurrent announcement merge.
- `src/storage/trade-session.ts` · save, loadStore, createTakerForRequest, createMakerForOrder. Revisions, migration, request binding, and maker occupancy.
- `src/storage/wallet-repository.ts` · IndexedDbStorageDriver.open, request, resetDatabase. Database readiness, invalidation, and commit.
- `src/storage/encrypted-storage.ts` · encryptionKey. Lazy profile key loading.

Source sync commit `0fc2d4a5a23837654e23bff16383880efffb7eb1`.

One profile, one pending external snapshot, a competing financial writer, one announcement update, and at most four journal revisions. A financial version represents the non-announcement data. Exact lock queues, transaction errors, cryptography, and browser scheduling beyond these interleavings are outside the bound.

## Recheck after changes

Read the changes to the covered functions since the sync commit. Replay counterexamples on the implementation and repair model drift when a step cannot occur. Record deliberate property changes with source evidence. Move the sync commit after confirming the model describes the new code.

Run the implementation test on clean source and on a disposable copy with the guard broken. Bypass the external merge compatibility checks. The test requires rejection of the conflicting result before save.

```sh
npm test -- src/trade/coordinator.test.ts -t "fails closed when concurrent state conflicts with the external result"
```

Restore the scratch source and rerun the implementation test and unmodified model. Use pstack `/maintain-formal-verification-skill` to resync after later changes.
