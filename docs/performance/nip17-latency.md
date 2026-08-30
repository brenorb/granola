# NIP-17 coordination latency

This report records the August 2026 investigation into Granola's private trade
coordination path. The result is deliberately small: remove one duplicated
inbox-list publication/readback cycle and keep the rest of the security model.

## Result

The click-path profiler starts immediately before the taker session is created
and stops after both sessions have reached `filled` with both Cashu legs marked
spent. It reports Cashu-classified coordinator work separately from the rest of
the path.

The accepted change reduced the click path from 53 to 51 coordinator actions
and from four to two inbox-registration operations. With a deterministic 25 ms
delay on every simulated relay operation, three-run medians were:

| Scenario | Before total | Before non-mint | After total | After non-mint |
| --- | ---: | ---: | ---: | ---: |
| Two-mint sell | 1168.77 ms | 1012.41 ms | 1087.91 ms | 931.31 ms |
| Two-mint buy | 1077.01 ms | 929.04 ms | 1016.10 ms | 869.07 ms |
| One-mint sell | 1077.03 ms | 930.67 ms | 993.64 ms | 849.11 ms |

All controlled non-mint medians are below the one-second target. The standard
in-process E2E benchmark, which has no relay delay, reported medians of 793.69
ms for sell, 729.02 ms for buy, and 685.63 ms for one-mint settlement.

These numbers are reproducible local evidence, not a claim about current public
relay performance. A live run would publish disposable kind `10050` and `1059`
events and therefore requires explicit approval.

## Root-cause experiments

Each hypothesis was tested in its own branch or worktree.

| Hypothesis | Evidence | Decision |
| --- | --- | --- |
| Slowest-relay acknowledgement waiting | `cb33f37` proves public and private fan-out remains pending until the slow failure returns. | Do not return early: Granola's durable retry state currently needs every relay receipt. |
| Fresh NIP-42 connections | `74fa5ab` reduced a controlled publish/query/publish sequence from about 167 ms and two connections to 126 ms and one connection. Safe identity isolation and cleanup required roughly 166 production lines plus 150 test lines. `1fa3384` reverted it. | Reject as disproportionate. Revisit only after live profiles show connection setup dominates. |
| Subscription readiness race | `eafab81` emits an event before `subscribe()` resolves; delivery succeeds. Existing startup single-flight, reconnect guards, and persistent post-EOSE subscription behavior also passed. | No production change. |
| Same inbox relay for both parties | `78bc907` measured the same eight relay operations and 320 ms deterministic latency for shared and split topologies. A shared-relay outage broke both directions; split relays preserved one direction. | Reject: no latency win, greater correlated failure and metadata concentration. |
| Repeated inbox discovery | `8531a60` measured three discoveries, nine relay queries, and 75 ms at 25 ms per discovery. The three targets are distinct ephemeral recipients. | Reject caching: it would conceal signed kind `10050` replacement and live-probe freshness. |

The profiler exposed a sixth, simpler cause: `publish_inbox_registration` and
`verify_inbox_registration` both called the same transport operation even
though `publishInboxList` already requires a relay acknowledgement and an exact
signed readback. Commit `5e5df40` advances the staged checkpoint directly to
`registered` using that returned evidence. If the process crashes before the
checkpoint is saved, it retries the same signed replaceable event. Legacy
`acknowledged` sessions retain their retry path.

## White Noise and MDK

The useful White Noise lesson is connection and subscription ownership, not a
requirement to put both parties on one relay.

At MDK commit `053c7c5`, `MarmotRelayPlane` owns a shared Nostr SDK client, a
long-lived notification forwarder, bounded per-account delivery queues, and
account/group subscriptions. Its publish path races relay tasks, stops after a
configured acknowledgement goal, drains aborted tasks, and reuses scoped relay
connections for batches.

Granola cannot copy those mechanics blindly:

- NIP-17 requires publishing only to relays in the recipient's signed kind
  `10050` list. It does not require the sender and recipient to choose the same
  relay.
- NIP-42 authentication lasts for a connection and may authenticate multiple
  pubkeys. Granola uses fresh per-reservation identities, so a shared connection
  must not accidentally carry authentication or subscriptions across sessions.
- MDK's acknowledgement goal is coupled to its own outcome and reconciliation
  model. Granola currently persists a complete per-relay receipt set for exact
  retries, so aborting slow tasks would change crash and ambiguity handling.
- NIP-65 outbox lists are not a substitute for the recipient kind `10050` lookup
  required by Granola's NIP-17 delivery path.

Primary references:

- [NIP-17 at the audited revision](https://github.com/nostr-protocol/nips/blob/24b2ae9fdfeb4e5c0d3be854df5977b81afe1983/17.md)
- [NIP-42 at the audited revision](https://github.com/nostr-protocol/nips/blob/24b2ae9fdfeb4e5c0d3be854df5977b81afe1983/42.md)
- [MDK relay plane at the audited revision](https://github.com/marmot-protocol/mdk/blob/053c7c556d1b33f92471afeae224cfdcac8eb128/crates/marmot-app/src/relay_plane/mod.rs)
- [MDK Nostr SDK client at the audited revision](https://github.com/marmot-protocol/mdk/blob/053c7c556d1b33f92471afeae224cfdcac8eb128/crates/transport-nostr-adapter/src/sdk_client.rs)

## Reproduce

The after-state is commit `d1245ef`. Commit `2104918` is the equivalent profiler
before duplicate registration was removed.

```bash
npm ci
npm test
npm run build
npm run benchmark:e2e
npm run benchmark:nip17-profile
GRANOLA_FAKE_RELAY_MS=25 npm run benchmark:nip17-profile
npm run benchmark:nip17-live
```

Run the last command three times on each commit and take the median for each
scenario. The profiler logs action names, durations, and operation counts only;
it never prints private keys, messages, proofs, preimages, or wallet backups.
The live command is a dry run unless `--publish` is passed explicitly. After
approval, run `npm run benchmark:nip17-live -- --publish`; it uses fresh test
keys and records only relay URLs, public keys, event IDs, acknowledgements, and
timings.

## Remaining ceiling

The accepted fix removes redundant work but does not make websocket setup free.
The next justified change depends on a live profile showing which cost dominates:
connection/AUTH setup, discovery fan-out, relay acknowledgement variance, or
relay-side storage/readback. Until then, a custom identity-aware pool or a new
quorum durability model would be speculative complexity.
