# Trading speed: fresh mint evidence and terminal spend hints

Measured October 10, 2026 in São Paulo (October 11 UTC). The goal is faster
complete swaps while retaining the three-message protocol, fresh persisted
reservation identities, private bearer material, exact term/transcript binding,
mint-authoritative settlement, durable retries and bounded recovery.

## Measured result

| Topology | Baseline median (range) | Candidate median (range) | Median reduction |
| --- | --- | --- | --- |
| One mint: Testnut SAT/USD | 14.35 s (14.28–14.84) | 9.94 s (9.77–10.26) | 4.41 s / 30.7% |
| Distinct mints: Testnut SAT / CDK Testnut USD | 11.64 s (10.26–13.14) | 9.45 s (9.21–9.93) | 2.18 s / 18.8% |

Matched cross-mint pairs:

| Pair / maker side | Baseline | Candidate | Saved |
| --- | --- | --- | --- |
| 1 / sell | 10.94 s | 9.51 s | 1.43 s (13.1%) |
| 2 / buy | 13.14 s | 9.40 s | 3.75 s (28.5%) |
| 3 / sell | 10.26 s | 9.93 s | 0.33 s (3.2%) |
| 4 / buy | 12.34 s | 9.21 s | 3.12 s (25.3%) |

These are small contemporaneous samples, not a production latency SLA or a p95
estimate. Each topology has four matched baseline/candidate pairs, two maker
sells and two maker buys. Every candidate was faster than its matched baseline.
The one-mint experiment's first pair overlapped the separate cross-mint
capability investigation; the final cross-mint comparison ran without another
benchmark. The new default market uses the distinct-mint topology.

Raw, sanitized evidence:

- [One-mint comparison](2026-10-10-one-mint-comparison.json).
- [Cross-mint comparison](2026-10-10-cross-mint-comparison.json).
- [Mint discovery and rejected alternative](2026-10-10-mint-validation.json).

## What changed and why

Two application behaviors delayed observation:

1. An already-spent leg opened a subscription before checking NUT-07. It waited
   roughly another socket round trip for a state transition that had already
   happened. The client now checks fresh state first, verifies the lock and
   spent preimage witness, and returns immediately if the entire leg is spent.
2. The notification accumulator erased an earlier SPENT update when a delayed
   PENDING update arrived for that proof. In the one-mint baseline, all eight
   waits for counterparty spends hit the five-second deadline despite receiving
   the expected SPENT updates; each recorded one regressive update. SPENT hints
   are now terminal within that subscription. Notifications only wake the
   client: a subsequent fresh NUT-07 response and verified witnesses still
   determine settlement.

The five-second outage/missing-notification fallback remains. No extra private
message, shared observer registry, identity reuse, cached financial evidence,
weakened metadata freshness or skipped restore-before-retry was introduced.
The candidate deliberately performs two more state requests (12 versus 10 per
swap), but opens two subscriptions instead of four. Request count alone would
have predicted the wrong result.

## Attribution: our work versus external wait

Median observed intervals for the final cross-mint comparison:

| Metric | Baseline | Candidate |
| --- | --- | --- |
| Mint HTTP interval union | 7.215 s | 7.031 s |
| Relay response interval union | 2.640 s | 2.534 s |
| Local coordinator-action interval union | 0.013 s | 0.012 s |

| Responsibility | Interpretation and next opportunity |
| --- | --- |
| Application/protocol | Request count, sequencing, notification handling, five-second fallback, financial checkpoints, exact readbacks and three-message choreography are ours. Both accepted changes remove waiting that our code created. |
| Mint/network | HTTP resource durations include transport, connection/CORS work and mint response time. We cannot separate pure mint server processing from RTT using these browser measurements. Necessary swaps and live evidence checks still wait on participating mints. |
| Relay/network | Measured EVENT/AUTH-to-OK and REQ-to-EOSE/CLOSED spans describe observed responses. We control publishing/query policy and routes; remote response and delivery latency are external. Later acknowledgements can be background work rather than critical-path blockers. |
| Local elapsed work | Actions tagged `local` measure elapsed client/storage work at specific coordinator boundaries, not CPU alone. Crypto and persistence also occur inside externally tagged actions. |
| Unclassified time | Never label total minus mint/relay intervals as local CPU. Notification delivery, inbox waiting, browser scheduling and overlapping work remain mixed. |

Intervals from both wallets are aligned using their performance time origins,
clipped to the measurement window, and merged before reporting each union.
Mint and relay unions overlap each other; they must not be added. Client CLOSE
and socket-close lifetimes are retained as diagnostic spans but excluded from
relay *response* time. Coordinator durations contain nested network work and
must not be added to it either.

Every run retained 12 explicit public metadata requests, four restore requests
and four swaps. The next possible request reduction is a separately validated
freshness-policy change; this work does not assume that cached metadata or
omitted recovery requests are safe substitutes.

## Real end-to-end validation

Production Vite builds ran in Chrome 155 on one Mac, two fresh isolated wallet
namespaces per variant, real public mints and real Nostr relays. No network mocks,
CSP bypass, HAR, screenshots or raw frame logs were used. Funding, page load,
five-second warmup, order publication and discovery are outside the window.
Timing starts at the taker's Take click and ends at the later wallet's first
Filled mark for that exact new session. It includes the fill path taken by the
application. Reload validation is outside the timed window.

The order exchanges 20 SAT for one USD cent at USD 50,000/BTC, all-or-none.
Baseline/candidate order alternates AB, BA, AB, BA with matched directions and
wallet histories. Actual signed public order event IDs, signer public keys,
relay URLs and acknowledgements are in each run's `publicEvents`.

Each run asserts exactly `reserve_propose`, `reserve_accept`, `quote_lock` in
both transcripts; matching sessions; both legs SPENT; buyer credit of exactly
20 SAT and seller credit of exactly one USD cent; fee-aware debits; identical
balances and Filled states after reload; and absence of the filled order from
the refreshed validated book. No financial messages or witnesses were added to
public events.

The final comparison explicitly requires successful SPENT subscription
notifications from **each** mint under the production page CSP. Subscription
measurements are attributed to their containing observe-base/observe-quote
action, recording mint, unit, outcome and counts without proof identifiers.
This checks actual WebSockets rather than treating HTTP fallback as validation.

Base: `https://testnut.cashu.space`, SAT keyset
`017bc604aaa08e9b58804bdd552286f15d75ebdaa3d1bccc2a52fc7406b4040fda`.
Quote: `https://testnut.cashudevkit.org`, USD keyset `0092cc0169b3555a`.
Both advertise NUT-07/NUT-14 and completed witness-validated settlement.

The former configured quote mint no longer resolves. Its replacement is a new
issuer-specific market; HTTPS/WSS CSP origins, the mint allowlist, default
market, funding action and current guides now agree. Historical reports and
canonical serialization test vectors keep their original mint identities.
Mint fees are dynamic; in the validation run the seller paid 22 SAT total and
the buyer paid three USD cents total, including fees.

## Regression checks and reproduction

The suite preserves replay/expiry, wrong mint/unit, spent proof, duplicate
reservation, disconnected relay and refund cutoff checks. Added checks cover
regressive notifications, already-spent fast observation, invalid/missing
witness rejection before waiting, HTTP rejection after a wakeup, mint outage
before/after subscription, terminal mid-swap abort handling, diagnostic
redaction and interval attribution. Existing seven skipped tests remain skipped;
live measurements validate successful settlement, not every failure mode against
an external mint.

Validation: 453 tests passed across 52 files; production build/typecheck and
`git diff --check` passed.

Baseline algorithm: main `a2fa3ac`, with identical new mint configuration and
secret-free counters. Cross-mint baseline bundle `index-Bzp_-Rga.js`, SHA-256
`7034a39b4913ebfbe4c6890723d45ad5b5a2c4b8552d5e6b76b0fadd41a7303d`.
Candidate bundle `index-C4A0chHS.js`, SHA-256
`a3ca6191105e072cf028d55edd2c8bbeb3e2f0392cdb1709d266d85aed7cf0f7`;
this matches the current production build. The comparison holds the mint pair
constant; replacing an unavailable mint is not counted as an algorithm speedup.

Serve the two immutable production build directories on separate local ports.
Use an installed Playwright module and Chrome:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
GRANOLA_PROFILE_URL=http://127.0.0.1:5194/ \
GRANOLA_PROFILE_COMPARE_URL=http://127.0.0.1:5193/ \
GRANOLA_PROFILE_RUNS=4 \
GRANOLA_PROFILE_REQUIRE_WEBSOCKETS=1 \
GRANOLA_PROFILE_OUTPUT=/private/tmp/granola-cross-mint-comparison.json \
npm run benchmark:live

node scripts/summarize-live-profile.mjs /private/tmp/granola-cross-mint-comparison.json
npm run probe:test-mint
```

`GRANOLA_PROFILE_BASE_MINT`/`GRANOLA_PROFILE_QUOTE_MINT` describe the *already
configured* build; they do not change its allowlist or CSP. For one-mint runs,
both build variants must first configure both legs to Testnut. The probe uses
only known FakeWallet test mints and holds invoice, key, proof and witness
material in memory; it prints only the mint, public keyset ID and validation
outcome.
