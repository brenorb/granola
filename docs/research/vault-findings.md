# Private-vault synthesis

This is a public-safe synthesis of an owner-authorized review of Breno's private
Obsidian vault, performed on 2026-07-23. Exact private note titles and paths are
intentionally omitted from this public repository; these owner-derived
conclusions are not independently verifiable from public sources.

## Historical design recovered

The private material agrees with the public 2024 sketch: a maker advertises an
order with historical Nostr kind `8338`; the taker responds privately; both
legs use one hash; spending the first received HTLC reveals a preimage used to
claim the other. A later academic direction substitutes adaptor signatures for
the HTLC construction. The two mechanisms are alternatives, not interchangeable
descriptions of one protocol.

## Derived engineering requirements

The following requirements synthesize and generalize the internal notes for
this implementation:

- use a distinct ephemeral identity for each private swap session;
- bind every private message to protocol version, network, session ID, expiry,
  and a running transcript hash;
- persist sufficient local state to recover after interruption;
- include a deterministic full transcript and negative test vectors;
- reject replay, expired messages, invalid signatures, and changed terms;
- never commit funds until the recovery/refund path is valid;
- if either party claims, the other must gain everything required to claim;
- treat Sybil/spam resistance and maker liquidity as explicit open questions.

Privacy analysis warns that unusual amounts, timing, reused relays, IP
addresses, and counterparties' own logs can correlate the two legs. Ephemeral
session keys, standard amount buckets, short-lived offers, careful relay
selection, and Tor can reduce but not eliminate these leaks. The requested
30-day default order lifetime therefore has a privacy tradeoff for the order ADR.

## Order-book presentation

The vault's liquidity research emphasizes book depth, bid/ask spread, available
size, traded volume, and slippage. For this MVP: separate bids and asks, make
best bid and best ask unmistakable, show spread and cumulative depth, and label
partial-fill availability.

## Nostr operations and key safety

The private operational guidance prefers `nak` for raw event construction,
signing, publication, querying, signature verification, NIP debugging, and
local relay fixtures. A local relay is for development only. The public-safe
rules carried into this repository are:

- use test identities by default and verify the active identity before publish;
- never put an `nsec` in a shell argument;
- keep read, draft, sign, and publish operations visibly distinct;
- record relay URLs, acknowledgements, and event IDs for published fixtures;
- use reproducible raw events for protocol tests.

## Gaps and contradictions

1. **Two mints are drawn as one.** A valid inter-mint test must use distinct
   mint URLs and keysets and make both mint trust domains visible.
2. **Witness retrieval is optional in practice.** The original sketch assumes
   preimage observation. The selected mints must advertise and correctly
   implement both [NUT-07](https://github.com/cashubtc/nuts/blob/main/07.md)
   state/witness retrieval and [NUT-14](https://github.com/cashubtc/nuts/blob/main/14.md)
   HTLC spending conditions.
3. **HTLC versus adaptor signature is unresolved.** A settlement ADR must choose
   and test one construction rather than blend them.
4. **Ephemeral identity conflicts with durable orders.** Cancellation,
   replacement, and reputation require durable authorization, while private
   sessions benefit from unlinkable keys. Their roles must be separated.
5. **Failure behavior is missing.** Invalid/already-spent proofs, mint outage,
   expiry during settlement, replay, disconnect, and abandonment need tests.
6. **The order is underspecified.** Units, mints/keysets, exact price encoding,
   remaining amount, partial fills, reservation expiry, and replacement are new
   work rather than recovered requirements.
7. **Bearer secrets cannot enter evidence.** Auditable records may contain
   hashes, event IDs, units, amounts, mint/keyset IDs, timestamps, and redacted
   transitions—never spendable proofs, private keys, wallet backups, or an
   unreleased preimage.
