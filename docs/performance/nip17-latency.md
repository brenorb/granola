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

These controlled numbers are not representative of current public relay and
mint performance. The live benchmark below completed correctly but missed the
one-second non-mint target by a wide margin.

## Live Testnut E2E

With explicit approval, a headless Chromium run on 2026-08-30 UTC created two
fresh IndexedDB wallet profiles, funded them independently, published a one-day
20 SAT sell order, clicked it from the USD wallet, and waited until both public
wallet views reached `filled`. The signed settlement profile used 10-minute and
20-minute HTLC locks with a 30-minute recovery horizon.

| Measure | Result |
| --- | ---: |
| Click to both wallet views filled | 12,143 ms |
| Mint critical-path union | 4,645 ms |
| Non-mint remainder | 7,498 ms |
| Relay critical-path union | 11,428 ms |
| Cumulative mint HTTP spans | 11,351 ms |
| Cumulative relay request/ack/delivery spans | 42,409 ms |
| Coordinator actions observed | 64 |

Critical-path union merges overlapping network intervals; cumulative spans add
concurrent work and therefore are diagnostic totals, not components that sum to
click latency. Non-mint remainder is click latency minus the union of Testnut
HTTP intervals.

The action timeline shows why the controlled result did not survive the public
network. Three private deliveries took 871 ms, 776 ms, and 761 ms. Five empty
inbox polls took 734–780 ms each before later polls received the peer messages.
The four Cashu executions took 686 ms, 777 ms, 450 ms, and 417 ms, while repeated
NUT-07 observations added further mint calls. Public reserve and fill projections
took 348 ms and 340 ms. These steps are sequential protocol checkpoints, so a
complete atomic two-mint swap cannot currently approach one second even when
mint time is subtracted.

The aggregate balances prove settlement rather than message delivery alone:

| Wallet | Before | After |
| --- | --- | --- |
| Maker | 10,000 SAT | 9,978 SAT + USD 0.01 |
| Taker | USD 100.00 | 20 SAT + USD 99.99 |

All captured signatures verified. No keys, tokens, proofs, preimages, witnesses,
invoices, raw messages, or bearer backups were logged.

### Relay evidence

The public order publication was acknowledged by `wss://nos.lol`,
`wss://relay.primal.net`, and `wss://offchain.pub`; the unavailable local relay
`ws://localhost:4870` returned no acknowledgement. Every private gift wrap was
acknowledged by `wss://auth.nostr1.com`.

| Kind | Purpose | Event ID | Acknowledged relays |
| ---: | --- | --- | --- |
| 1059 | disposable capability probe | `b320ffca9cc9d9af9e9b81589bf72040e40a0ad883c25398465eb68cf45383bb` | `wss://auth.nostr1.com` |
| 30078 | open order | `278c1f22f07dc8258997ff10a3877aa42c35af2f1e11f8370b960e178430e7c7` | all three public relays |
| 10050 | maker order inbox | `e50c0ce58f501978c9cb48aec6c2b2bddef01552803a1b46e2c85c4211781728` | `wss://nos.lol`, `wss://relay.primal.net` |
| 10050 | taker session inbox | `6913f0ab12e1262b046d6d3d49eaa1d7204a32822dd94bdddce1a73666752208` | `wss://nos.lol`, `wss://relay.primal.net` |
| 1059 | reserve proposal | `0ae9c9d51660fb5609bd41a70f0aace27eb80e1874d0b70efe87c0a1a28c08fb` | private inbox relay |
| 10050 | maker session inbox | `b9309fdfc91cf9db4b608aa4366c0d7687e501ae40c005567286a6e6e07778de` | `wss://nos.lol`, `wss://relay.primal.net` |
| 30078 | reserved order | `8ef21bc227453905f486096aaa9eb52edeb631211f43e679190aaa73bf67a6f6` | all three public relays |
| 1059 | reserve acceptance | `50f7ea05cc17225ee06522fadee8378e0043a1a2de5911e51ca58ecc8b0ece6e` | private inbox relay |
| 1059 | quote lock | `0e5bb37f37e948a00b5e59f864517787c1ea181e010a4c8fcaa09d37014209e9` | private inbox relay |
| 30078 | filled order | `7b9de1f1e08fd0324b5b9199114effab06942c965495f401cab62add1edded74` | all three public relays |

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
The live relay command is a dry run unless `--publish` is passed explicitly.
After approval, run `npm run benchmark:nip17-live -- --publish`; it uses fresh
test keys and records only relay URLs, public keys, event IDs,
acknowledgements, and timings.

For a full browser action timeline, add `debug=performance` to each wallet URL.
The normal interface is unchanged. Read the secret-free measurements in the
developer console with:

```js
performance.getEntriesByName("granola:coordinator-action").map((entry) => ({
  startTime: entry.startTime,
  duration: entry.duration,
  ...entry.detail
}))
```

## Remaining ceiling

The accepted duplicate-registration fix remains valid, but the live swap shows
that inbox polling and sequential private/public relay checkpoints now dominate
the non-mint path. The next experiment should eliminate empty `poll_inbox`
requests when a live subscription has not signaled a new event, without
weakening persisted message validation or retry evidence. Connection pooling is
still unjustified until that avoidable polling cost is removed and remeasured.
