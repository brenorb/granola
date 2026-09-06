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

Final deployment and live subscription results follow after revalidation.

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
