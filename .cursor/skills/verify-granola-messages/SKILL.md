---
name: verify-granola-messages
description: "Check Granola's messages model when changing private message transcripts, inbox and outbox checkpoints, relay routing, or retry."
---

# Verify Granola messages

After a direct delivery fails and discovery succeeds, the staged outbox must retain the discovered route before the next send. A retry can keep using a failed route and stall a swap with locked funds.

## Run

From the repository root, set `TLA2TOOLS` to the absolute path of the [TLC 1.7.4 release jar](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). Use Java 17 or set `JAVA` to its absolute path. The runner checks the jar checksum.

```sh
bash scripts/verification/check-model.sh .cursor/skills/verify-granola-messages/model/Messages.tla
```

TLC checks `DiscoveredRouteIsSaved` over the bounded reachable states. Add `--mutant` to require a counterexample for the deliberately broken model. Use pstack `/statechart` to inspect the graph or failing trace.

## Compare with the implementation

- `src/trade/atomic-messages.ts` · advanceAtomicSwapChoreography. Message order and role checks.
- `src/trade/session-factory.ts` · createMakerSession. Maker starts with the verified proposal committed.
- `src/trade/effects.ts` · stageOutgoing, deliverOutbox, commitOutbox, pollInbox, validateIncoming, commitIncoming, publishInbox. Journal transitions and combined ACK/readback or validation/commit saves.
- `src/nostr/trade-transport.ts` · discoverInbox. Direct and discovered routes.

Source sync commit `0fc2d4a5a23837654e23bff16383880efffb7eb1`.

One local journal, either role, three normal sequence numbers, one recipient route, and one in-flight send. A sequence number stands for the exact staged artifact. A verified input abstracts envelope authentication and transcript validation. The model includes direct and registration-gated scheduling. It leaves loaded extended wire phases and actual relay delivery outside the bound.

## Recheck after changes

Read the changes to the covered functions since the sync commit. Replay counterexamples on the implementation and repair model drift when a step cannot occur. Record deliberate property changes with source evidence. Move the sync commit after confirming the model describes the new code.

Run the implementation test on clean source and on a disposable copy with the guard broken. Leave the original relay list in the outbox after fallback discovery. The test checks for the discovered route and the same wrapper.

```sh
npm test -- src/trade/effects.test.ts -t "checkpoints discovered fallback before retrying an unchanged direct-route wrapper"
```

Restore the scratch source and rerun the implementation test and unmodified model. Use pstack `/maintain-formal-verification-skill` to resync after later changes.
