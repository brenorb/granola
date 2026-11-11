---
name: verify-granola-orders
description: "Check Granola's orders model when changing order status, signed publication, order heads, visibility, order authority, or refusal replies."
---

# Verify Granola orders

Once a verified order revision has been observed, an older response must not move the remembered head backwards. A stale relay response could bring a canceled or filled order back into the book.

## Run

From the repository root, set `TLA2TOOLS` to the absolute path of the [TLC 1.7.4 release jar](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). Use Java 17 or set `JAVA` to its absolute path. The runner checks the jar checksum.

```sh
bash scripts/verification/check-model.sh .cursor/skills/verify-granola-orders/model/Orders.tla
```

TLC checks `HeadNeverRegresses` over the bounded reachable states. Add `--mutant` to require a counterexample for the deliberately broken model. Use pstack `/statechart` to inspect the graph or failing trace.

## Compare with the implementation

- `src/order/model.ts` · reserveOrder, fillOrder, releaseOrder, cancelOrder, expireOrder, buildOrderBook. Order status and visibility.
- `src/storage/order-outbox.ts` · ensureStaged, recordProgress, clearAcknowledged, stageReply, acknowledgeReply. Publication and refusal journals.
- `src/order/service.ts` · rememberProjection, replaceableOrder, loadBook. Public head selection.
- `src/api/order-api.ts` · publishNextStage. Acknowledgement and terminal key cleanup.
- `src/browser/trade-runtime.ts` · flushReplies. Refusal retry and expiry.

Source sync commit `0fc2d4a5a23837654e23bff16383880efffb7eb1`.

One address, at most five signed snapshots, one publication in flight, one expiry bit, and one refusal record. The model distinguishes local staging, relay acceptance, and local commit. Signatures, amounts, same-revision tie-breaks, cache capacity, and the number of relays are outside the bound.

## Recheck after changes

Read the changes to the covered functions since the sync commit. Replay counterexamples on the implementation and repair model drift when a step cannot occur. Record deliberate property changes with source evidence. Move the sync commit after confirming the model describes the new code.

Run the implementation test on clean source and on a disposable copy with the guard broken. Read retained heads only when the relay returns zero events. The test observes the older open order reappearing after cancellation.

```sh
npm test -- src/order/service.test.ts -t "keeps verified snapshots through relay loss and accepts cancellation after reconnect"
```

Restore the scratch source and rerun the implementation test and unmodified model. Use pstack `/maintain-formal-verification-skill` to resync after later changes.
