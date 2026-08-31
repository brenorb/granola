# Granola E2E performance report

Date: 2026-08-20

## Scope

Command:

```sh
npm run benchmark:e2e
```

The benchmark runs three isolated Vitest processes and measures the real Granola coordinator, order API, Nostr event signing, NIP-17-style wrapping, session persistence, and deterministic relay/counterparty/Cashu fixtures. It covers buy settlement, sell settlement, one-mint settlement, reservation, release, cancellation, expiry, retry recovery, and stale-operation failure.

It does not measure public relay WebSocket latency, relay authentication, Internet routing, mint HTTP latency, or two independent application processes. The earlier 143.5x order-book result was also not an E2E relay/DM measurement: it measured local order-book construction for 1,000 records and 8 acceptable mints.

## Before and after

Before: commit `0ae604e` (same order-book optimization, before the event-validation cache and event-ID binding fix).

After: current worktree with the bounded event-validation cache and hash binding.

| Scenario | Before samples (ms) | Before median | After samples (ms) | After median | Median change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sell settlement | 4017.91, 4758.37, 4286.58 | 4286.58 | 1210.18, 1516.79, 1379.86 | 1379.86 | 3.11x faster |
| Buy settlement | 4258.64, 4267.16, 4314.01 | 4267.16 | 1210.69, 1198.73, 1191.93 | 1198.73 | 3.56x faster |
| One-mint settlement | 3707.78, 4722.35, 3990.93 | 3990.93 | 1193.01, 1140.26, 1153.67 | 1153.67 | 3.46x faster |

First-round short lifecycle medians were: reserve 6.50 ms, cancel/expire 8.18 ms, release 9.09 ms, stale failure 4.67 ms, and retry recovery 4.84 ms. These are dominated by test/runtime noise rather than network latency.

## Second round

The second-round baseline was commit `99ac0da`; the after state was commit `4019aa4`. Each state was run five times, with three isolated samples per scenario (15 samples per settlement). Aggregating all samples gave:

| Scenario | Baseline median | Second-round median | Change |
| --- | ---: | ---: | ---: |
| Sell settlement | 1395.76 ms | 1365.55 ms | 2.2% faster |
| Buy settlement | 1272.05 ms | 1196.70 ms | 5.9% faster |
| One-mint settlement | 1212.43 ms | 1186.42 ms | 2.1% faster |

The change reuses the already validated local session participant public key for later trade effects. Initial sessions without that checkpoint still derive the key from the private key. The repository now rejects a checkpointed participant that does not match the private key. Two other candidates were measured and discarded: caching the AES `CryptoKey`, and caching public keys by a private-key digest; neither produced a reliable E2E improvement.

## Bottleneck and change

CPU profiling and the session code showed repeated validation of the same signed Nostr checkpoints while encrypted trade-session state was loaded and saved during coordinator advancement. The change adds a FIFO-bounded cache of 512 successful validations for events no larger than 8 KiB of content/tag data.

The cache key contains the signed/unsigned mode, id, pubkey, timestamp, kind, tags, content, and signature. It is never keyed only by event id, and oversized events are not retained. Cache entries are added only after validation succeeds.

During the security check, a pre-existing validation gap was found and fixed: signed events now have their event id recomputed from the complete event before signature verification is accepted. An event whose content or tags are changed while retaining its old id/signature is rejected. This is covered by a regression test.

## Verification

- Full test suite: 49 files passed; 383 tests passed; 7 skipped.
- Focused session/security tests: 23 passed; 7 skipped.
- Typecheck: passed.
- Production build: passed; existing Vite warning remains for the 589.94 kB JS chunk.
- No bearer material, private keys, proofs, or preimages were added to benchmark output or the report.

## ContextVM decision

ContextVM is a Nostr transport for MCP JSON-RPC, not a drop-in replacement for Granola's transaction choreography. Its encrypted profile still uses NIP-17/NIP-59-like wrapping, while its stream profile is additive and does not replace Granola's transcript, expiry, replay, reservation, or settlement binding. It was not added without a live compatible transport and a latency benchmark. A future adapter is only justified if it can keep the same privacy and validation guarantees and demonstrate lower round-trip latency against a real relay/mint environment.
