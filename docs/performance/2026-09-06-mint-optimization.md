# Mint metadata reuse and proof subscriptions

## Change

Both Cashu adapters now use the same public metadata loader. Concurrent requests
for a normalized mint URL/unit share a load; every caller receives a fresh Wallet
initialized with separate copies of mint info and keychain metadata. No proofs,
operation counters, keys belonging to the user, or prepared transactions are cached.
The in-memory cache holds at most 32 entries for 60 seconds. Trade preflight and
unknown incoming keysets force refresh. Failed refreshes fail closed and are evicted.
Mint capabilities, active keysets and fees can be up to 60 seconds old between
refreshes; proof state is never served from this cache.

Settlement observation uses cashu-ts's existing NUT-17 `proofStateUpdates` support
when the mint advertises `proof_state` for the wallet unit. It waits for all
expected proof IDs to report SPENT, then makes a fresh NUT-07 request and applies
the existing mapping, HTLC, DLEQ and preimage-witness validation. Notifications
are wakeup hints, never settlement evidence. UNSPENT/PENDING and duplicate or
foreign notifications cannot establish settlement.

No notification within five seconds, a failed subscription, or unsupported
WebSockets falls back to HTTP observation. Subscriptions and their dedicated
wallet sockets close after each wait, including late connection completion.
The opt-in timeline records only wait outcome, update count and proof count.
The four mint swaps, four restore checks, private identities and relay publication
requirements are unchanged.

Both `testnut.cashu.space` and `nofee.testnut.cashu.space` advertised proof-state
subscriptions for SAT and USD during this investigation. See
[NUT-17](https://github.com/cashubtc/nuts/blob/main/17.md) for capability discovery
and initial-state replay requirements.

## Validation

Tests cover concurrent metadata reuse, state isolation, mint/unit separation,
expiry, explicit refresh and failed-load retry. Subscription tests cover pending
states, duplicate/foreign updates, unsupported mints, disconnects, connection
failure, timeout and cleanup after a late connection. Existing incoming-lock
and spent-witness tests still apply after the wakeup.

Full suite: 398 passed, 7 skipped. TypeScript and clean production build passed.
Pages deployed `677e75b` successfully. The first real sell swap completed in
26.02 seconds, with 12 metadata requests (previously 81–84), but 20 proof checks.
The opt-in trace exposed immediate WebSocket failures: the page CSP allowed
mint HTTPS but omitted mint WSS origins. This was a Granola integration defect,
not a mint failure. The follow-up pairs those exact origins and adds a shell
regression test. Successful fallback does not count as WebSocket validation.

## Deployed E2E

Pages deployed `2cfb390` successfully:
[deployment run](https://github.com/brenorb/granola/actions/runs/34044198743).
CI passed 399 tests (7 skipped) and the production build. Both wallets loaded
`index-C6t8p8eS.js` at `https://brenorb.com/granola/`, with the corrected CSP.
Fresh isolated browser profiles were funded through the real UI with 10,000 SAT
and 10,000 USD cents. One initial USD funding request failed with “Failed to
fetch”; retrying fake funding succeeded before the measured swaps.

Measured from taking the order to the later Filled mark across both wallets,
using the same redacted timeline method as the previous production profile.
Reloaded both wallets before every sample. Orders used 20 SAT / USD 0.01.
Funding and order publication are outside the timing window.

| Corrected run | Direction | Both Filled | Metadata requests | Proof checks | Successful WS waits | Mint HTTP union | Metadata union |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Sell | 23.956 s | 12 | 10 | 4 / 4 | 9.555 s | 0.960 s |
| 2 | Buy | 24.066 s | 12 | 10 | 4 / 4 | 9.377 s | 0.782 s |
| 3 | Sell | 26.396 s | 12 | 10 | 4 / 4 | 9.582 s | 0.848 s |

Median: **24.066 seconds**, down from **30.691 seconds** in the earlier three-run
production profile: **6.625 seconds / 21.6% lower**. Metadata requests decreased
85–86%; proof checks decreased 33–38%. Total mint HTTP requests dropped from
104–108 to 30, excluding the new WebSocket traffic. The baseline and updated
samples were sequential, not a randomized controlled benchmark; three samples
do not establish tail latency or a guaranteed speedup.

All 12 subscription waits across the corrected runs completed on SPENT updates,
with no timeout or unavailable outcome. Mint HTTP union was 9.38–9.58 seconds;
the 14.40–16.81-second remainder includes WebSocket waiting, relay operations,
scheduling and other gaps. These categories overlap coordinator spans and cannot
be added to them. This is not a CPU sampling profile.

Each completed with four mint swaps and four restore checks. The unsuccessful
`poll_inbox` action in each trace was a recoverable empty read, not a failed
swap. No Refresh Swaps or manual settlement retry was used.

After the initial fallback run and these three corrected runs, both wallets had
four Filled sessions. Reload preserved 9,912 SAT + USD 0.04 in the first wallet
and 80 SAT + USD 99.96 in the second, consistent with four transfers and mint
fees. The completed test order disappeared from the live public book.

The two temporary test-wallet profiles were `optimized-maker-0906` and
`optimized-taker-0906`. Orders used fresh app-generated test identities; the UI
reported two public relay acknowledgements per order. Configured public relays:
`wss://nos.lol`, `wss://relay.primal.net`, `wss://offchain.pub`. Private inbox:
`wss://auth.nostr1.com`. The two ACKs are aggregate UI evidence, not a captured
per-relay receipt mapping.

Public order event IDs (no bearer material):

- Sell: `a6b7b73ded38d96b5aa855c1f5acfdba7794b08f54e90e139e6910e471c5cf63`.
- Buy: `abe971eddcf711a30a35f21e17b9a85f8d60748fcad6f913be27e5aa37c9dd2e`.
- Sell repeat: `963226e86cc216beaf2e60b43ad6d675becabe7c9dcfa9775f7b84d8800ca15f`.

## Attribution

The previous 81–84 metadata requests per swap were avoidable Granola overhead.
Repeated observation while waiting was also scheduled by Granola. Network
round-trip latency amplifies both costs; the request count is our responsibility.

Four atomic-swap operations and independent state/witness verification are
protocol work, not evidence of a mint defect. The ~40-second shared HTTP stall
in the earlier profile remains unassigned: browser resource timing did not
separate server processing, transport and browser scheduling. Relay spans mix
our connection/publication workflow with relay response time, so they cannot
be labelled entirely as relay overhead. No defensible percentage of blame can
be derived by adding overlapping spans.
