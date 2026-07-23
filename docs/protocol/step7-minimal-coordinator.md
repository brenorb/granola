# Step 7 minimal testnet coordinator

This document describes the first functional Granola swap coordinator. It is a
testnet implementation boundary, not a claim that the protocol is ready to hold
production value.

## Scope

The coordinator's current acceptance target is one real
maker-sells-SAT-for-USD swap between two isolated browser profiles. It keeps the
authenticated NIP-17 inbox subscription open while the page is active. Existing
timeout/refund safeguards remain available, but further recovery hardening is
not a prerequisite for this happy-path demonstration.

The implementation accepts only the exact signer, recipient, session,
reservation, order address, current order head, message type, sequence,
predecessor, and transcript hash required by the current choreography. A valid
Nostr signature alone is not enough.

## One-action loop

`advance(sessionId)` chooses at most one action from persisted state.

1. Acquire the per-session browser lock.
2. Load and validate the current revision.
3. Persist the exact artifact for the next external effect.
4. Release the storage lock before using a relay or mint.
5. Perform that one effect.
6. Reacquire the lock, compare the same artifact and revision, and persist the
   exact result.
7. Return the new public session view. A later call plans the next action.

If the page closes between steps 3 and 6, the next call retries the same signed
Nostr event, gift wrap, or prepared Cashu operation. It never creates a
replacement artifact just because the previous result is unknown.

## Persisted checkpoints

| Effect | Before | After |
| --- | --- | --- |
| Inbox registration | exact signed kind 10050 and target relay | relay receipt and exact readback |
| Private delivery | exact kind 1059 wrapper, rumor/transcript IDs, recipient relays | authenticated relay receipts; the next private message must bind its predecessor |
| Public order transition | exact signed transition/projection and expected prior head | receipts for the current publication stage, then committed head |
| Cashu lock, claim, or refund | prepared operation, exact expected HTLC, selected proof secrets reserved to the session | immutable mint result, wallet reconciliation, then reservation release |
| Incoming private message | raw wrapper and receive time | authenticated opened message and deterministic next choreography |

Bearer tokens, proofs, private keys, preimages, witnesses, mint quote IDs, and
private raw event IDs remain inside encrypted local state. The public API and
test trace expose commitments, public order events, phases, amounts, units,
mints, timestamps, and relay/mint outcomes only.

## Happy-path choreography

1. Taker sends `reserve_propose` to the maker order key.
2. Maker publishes the public reserve transition and sends `reserve_accept`.
3. Taker sends `session_ack` to the maker session key.
4. Maker creates and sends the base SAT HTLC.
5. Taker validates it and sends `base_lock_ack`.
6. Taker creates and sends the quote USD HTLC using the same hash.
7. Maker validates it, claims the USD leg, and sends `claim_notice`.
8. Taker independently observes that spend, recovers the preimage, claims the
   SAT leg, and sends `fill_request`.
9. Maker independently observes both spends, publishes the public fill, and
   sends `settlement_ack`.
10. Taker accepts the exact settlement acknowledgement. Both public views become
    filled only when the authoritative fill and the two mint observations agree.

## Existing timeout and refund boundary

No new claim starts at or after its claim cutoff. After a leg's locktime plus
the 60-second guard, its original sender first observes the exact locked proofs.
If they are still unspent, the coordinator prepares and checkpoints the refund,
executes it idempotently, reconciles the returned proofs into the wallet, sends
the bound `refund` message when possible, and stages the authoritative public
reservation release. A peer message never substitutes for a mint observation.
This section documents the already-implemented safety boundary; Step 7 does not
expand it unless the live happy path exposes a funds-loss blocker.

## Browser runtime

Each `?wallet=` profile constructs one isolated IndexedDB wallet, encrypted
trade-session journal, proof-reservation journal, order outbox, and Web Lock
namespace. Before advertising the private inbox, the page performs a disposable
recipient-only live probe against `wss://auth.nostr1.com`; all probe keys are
zeroized afterward.

The maker explicitly enables its order-key inbox. A valid `reserve_propose`
opens a maker session through the same exact-order and exact-funding preflight
used by the agent API. Once either role's per-session kind `10050` registration
is committed, the page opens a persistent subscription using that session key.
A live event is only a wakeup: the coordinator queries the stored wrapper,
authenticates and decrypts it through the persisted state machine, and advances
at most one action. Gift-wrap reads and subscriptions use the protocol's
172,800-second randomized-timestamp lookback.

## Deferred production hardening

The first testnet swap does not block on:

- exhaustive crash injection at every journal field transition;
- every malicious nested-storage corruption case;
- generalized multi-device coordination;
- long-running reconnect/backoff and relay failover policy;
- production relay quorum policy beyond the configured test relay evidence;
- every abort/equivocation permutation; or
- production monitoring, rate limiting, and key-erasure policy.

These remain follow-up work. A deferred case must be promoted to a blocker if it
can break the implemented happy path or lose the testnet proofs used by the
demonstration.
