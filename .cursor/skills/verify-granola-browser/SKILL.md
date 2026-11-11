---
name: verify-granola-browser
description: "Check Granola's browser model when changing page startup, maker resync, settlement runs, order book refresh, or user-facing progress."
---

# Verify Granola browser

A refresh request that arrives during a successful read must schedule a follow-up pass. A change arriving mid-read could be missed and leave the book or trade list stale.

## Run

From the repository root, set `TLA2TOOLS` to the absolute path of the [TLC 1.7.4 release jar](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). Use Java 17 or set `JAVA` to its absolute path. The runner checks the jar checksum.

```sh
bash scripts/verification/check-model.sh .cursor/skills/verify-granola-browser/model/Browser.tla
```

TLC checks `DirtyRefreshSchedulesRead` over the bounded reachable states. Add `--mutant` to require a counterexample for the deliberately broken model. Use pstack `/statechart` to inspect the graph or failing trace.

## Compare with the implementation

- `src/browser/refresh.ts` · coalesceRefresh. Scheduled, reading, and dirty states.
- `src/main.ts` · tradeController, startMakerInbox, takeOrderFromBook. Startup, resync, and temporary request identity.
- `src/browser/trade-controller.ts` · runUntilSettled, makerSettlementWinners, waitForSettlementSignal. Runner ownership, progress, and wakeup.
- `src/main.ts` · runAgentSettlement. Completion or error reported to a browser agent.
- `src/ui/button-feedback.ts` · withButtonFeedback. Pending action feedback.

Source sync commit `0fc2d4a5a23837654e23bff16383880efffb7eb1`.

One page, up to three refresh requests, two representative backoff increments, one runner slot, and two roles. The model folds maker winner selection into the slot and models failure or filled at the runner boundary. DOM notices, expansion and dialog toggles, request UUID values, and exact retry counters are outside the bound.

## Recheck after changes

Read the changes to the covered functions since the sync commit. Replay counterexamples on the implementation and repair model drift when a step cannot occur. Record deliberate property changes with source evidence. Move the sync commit after confirming the model describes the new code.

Run the implementation test on clean source and on a disposable copy with the guard broken. Disable the dirty loop. The test schedules changes during a blocked read and requires the next read.

```sh
npm test -- src/browser/refresh.test.ts -t "coalesces bursts and repeats once for changes during a read"
```

Restore the scratch source and rerun the implementation test and unmodified model. Use pstack `/maintain-formal-verification-skill` to resync after later changes.
