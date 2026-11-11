---
name: verify-granola-transport
description: "Check Granola's transport model when changing relay connections, AUTH, subscription reconnect, live inbox buffering, or probe expiry."
---

# Verify Granola transport

A subscription that finishes starting after its controller generation has stopped must not become active. An abandoned listener can be installed after shutdown and continue delivering callbacks.

## Run

From the repository root, set `TLA2TOOLS` to the absolute path of the [TLC 1.7.4 release jar](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). Use Java 17 or set `JAVA` to its absolute path. The runner checks the jar checksum.

```sh
bash scripts/verification/check-model.sh .cursor/skills/verify-granola-transport/model/Transport.tla
```

TLC checks `StoppedGenerationStaysStopped` over the bounded reachable states. Add `--mutant` to require a counterexample for the deliberately broken model. Use pstack `/statechart` to inspect the graph or failing trace.

## Compare with the implementation

- `src/browser/trade-controller.ts` · startSubscriptionOnce, reconnectSubscription, stop. Listener generation and reconnect.
- `src/nostr/trade-subscription.ts` · startTradeSubscription. Retained key, deduplication, callbacks, and cleanup.
- `src/nostr/inbox-relay.ts` · warmConnections, takeConnection, open, queryConnection, subscribe. Spare connections, AUTH, and query completion.
- `src/nostr/trade-transport.ts` · bufferLiveEvent, read, assertFreshProbeEvidence. Buffer, backfill, and route eligibility.

Source sync commit `0fc2d4a5a23837654e23bff16383880efffb7eb1`.

One subscription key, one representative socket, two shutdown generations, two event IDs, and one read. AUTH and relay outcomes are nondeterministic. Exact backoff, credentials, independent warm slots, and multiple relays are outside the bound.

## Recheck after changes

Read the changes to the covered functions since the sync commit. Replay counterexamples on the implementation and repair model drift when a step cannot occur. Record deliberate property changes with source evidence. Move the sync commit after confirming the model describes the new code.

Run the implementation test on clean source and on a disposable copy with the guard broken. Drop the generation comparison when installing a new subscription. The test requires the late connection to close after shutdown.

```sh
npm test -- src/browser/trade-controller.test.ts -t "discards a reconnect that completes after the controller stops"
```

Restore the scratch source and rerun the implementation test and unmodified model. Use pstack `/maintain-formal-verification-skill` to resync after later changes.
