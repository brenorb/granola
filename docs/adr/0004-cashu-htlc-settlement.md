# ADR 0004: One- or two-mint settlement with staggered Cashu HTLCs

- Status: accepted for the testnet prototype
- Date: 2026-07-23
- Depends on: [ADR 0001](0001-nostr-order-events.md), [ADR 0003](0003-nostr-private-swap-messages.md)

## Context

Granola swaps ecash issued by one or two Cashu mints. Two mints are the
general inter-mint case, while one mint is also valid when both legs use the
same issuer. A maker offering the base asset must not learn the requested
quote asset without enabling the taker to claim the base asset. Either party
also needs a bounded recovery path when its counterparty disappears.

Cashu NUT-14 HTLC spending conditions bind a proof to a SHA-256 hash and can additionally require a receiver public key. A refund public key becomes usable after a locktime. NUT-07 reports proof state and, after a spend, its witness. Each selected test mint currently advertises NUT-07, NUT-11, NUT-12, and NUT-14, but the protocol verifies capabilities immediately before every trade.

This is atomic only under explicit assumptions: each participating mint enforces the advertised NUTs honestly, retains the spend witness, has a sufficiently aligned clock, and remains reachable across the settlement and refund windows. It does not remove mint risk or guarantee unconditional fairness.

## Decision

Use receiver-bound NUT-14 HTLC legs with one fresh 32-byte preimage and SHA-256
hash per reservation. The base and quote legs may use the same mint or two
distinct mints; when two mints are selected, each mint is preflighted and
observed independently.

For a maker selling base for quote:

1. Maker creates fresh, independent Nostr session, Cashu settlement, and Cashu refund keys. Maker generates and durably stores the preimage and hash before accepting the reservation.
2. Taker creates its own fresh Nostr session, Cashu settlement, and Cashu refund keys.
3. Maker locks the base proofs first. The base leg uses the shared hash, the taker's Cashu settlement key as receiver, the maker refund key, and the later deadline `T_long`.
4. Taker validates that leg and acknowledges an exact commitment to the validated terms.
5. Taker locks the quote proofs second. The quote leg uses the same hash, the maker's Cashu settlement key as receiver, the taker refund key, and the earlier deadline `T_short`.
6. Maker validates and acknowledges that leg, then claims it with the preimage and maker settlement key before the maker claim cutoff.
7. Taker observes every quote proof as `SPENT` through NUT-07, extracts one identical witness preimage, verifies its hash, and claims the base leg with that preimage and the taker settlement key.
8. Maker verifies both legs as `SPENT` before replacing the order with its
   public `filled` projection. The reservation remains public until fill or
   confirmed recovery.

The wire choreography names these positions `base_lock` and `quote_lock`, but
they are protocol slots: maker offer first with `T_long`, then taker payment
with `T_short`. For a buy-side maker the market assets reverse—quote occupies
the long-lock maker-offer slot and base occupies the short-lock taker-payment
slot. Cashu validation binds the exact accepted deadline without inferring the
protocol slot from the market asset name.

For the testnet demonstration, after confirming each participating mint clock is within 30 seconds of local time, use:

- `anchor = max(local clock, participating mint clocks)`;
- `T_short = anchor + 4 days`;
- maker claim cutoff `= T_short - 120 seconds`;
- `T_long = anchor + 7 days`;
- taker claim cutoff `= T_long - 120 seconds`;
- reservation expiry at `anchor + 8 days` and no later than order expiry;
- refund attempts only after the relevant mint confirms expiry plus 60 seconds.

Receiver spending remains possible after a NUT-14 locktime, so expiry creates a receiver/refunder race rather than revoking receiver authority. Implementations stop initiating claims at the cutoffs and enter recovery mode. They do not treat equality with a locktime as safe.

New sessions use this 4/7-day profile. Every accepted deadline is signed,
validated as a complete profile, and persisted before either Cashu leg is
created.

## Exact validation before acknowledging a lock

Fail closed unless all of the following hold:

- mint URL, unit, leg direction, and order/reservation/session identifiers match the signed terms;
- the selected keyset is active and remains valid beyond the refund horizon;
- every proof has a valid NUT-12 DLEQ proof when the mint advertises NUT-12;
- there are no duplicate proof secrets or curve points;
- all proofs use the expected hash, receiver key, refund key, locktime, signature flag, and signature threshold;
- every NUT-07 state is `UNSPENT`, never `PENDING` or `SPENT`;
- all proofs use the same canonical lock profile;
- `net = sum(proof amounts) - ceil(sum(input_fee_ppk) / 1000)` exactly equals the signed leg amount;
- deadlines are ordered and retain the required safety gap;
- message, token, capability snapshot, and validation commitments agree with the canonical transcript.

A `SPENT` state only discloses the preimage when every quote proof has a non-empty, well-formed witness containing the same preimage and that preimage hashes to the negotiated value. `PENDING`, a missing witness, mixed witnesses, or a hash mismatch is a terminal protocol error that enters recovery; it never authorizes a claim or public fill.

## Private message sequence

Use ADR 0003's canonical NIP-17 envelope and acknowledgement rules for:

1. `reserve_propose`
2. `reserve_accept`
3. `session_ack`
4. `base_lock`
5. `base_lock_ack`
6. `quote_lock`
7. `quote_lock_ack`
8. `claim_notice`
9. `fill_request`
10. `settlement_ack`

The lock messages carry the encrypted bearer token and exact validation data. Acknowledgements commit to their message and the validated transcript. `claim_notice` is only a liveness hint: NUT-07 is authoritative and no private message is trusted as evidence that a leg was spent.

## Recovery

- Before either leg is locked: exchange a signed abort and release the reservation.
- After only the base leg is locked: maker waits for `T_long` and refunds it.
- After both legs are locked but before maker claim: taker refunds quote after `T_short`; maker refunds base after `T_long`.
- After maker claim: taker continues polling the quote witness and claims base before its cutoff. If the witness is unavailable or invalid, preserve the trace and enter terminal recovery rather than declaring success.
- A public fill or reservation release is forbidden until the corresponding mint states are independently verified.

Persist the exact signed message, lock token, keys, commitments, acknowledgements, mint observations, and state transition before performing the next irreversible action. Retries are idempotent and reuse the persisted artifact rather than creating a new proof or message.

## Why this design

- The maker's quote claim necessarily discloses the one value the taker needs for the base claim.
- Staggered deadlines give the taker time to react after disclosure while preserving eventual refunds when disclosure never occurs.
- Receiver and refund keys prevent an unrelated bearer-token holder from spending either leg.
- Mint proof-state observations, rather than cooperative DMs, determine progression and completion.
- Exact validation prevents amount, keyset, fee, tag, replay, and substitution attacks before the counter-leg is funded.

## Alternatives not chosen

### Simultaneous bearer-token exchange

It has no atomicity: either party can receive a spendable token and withhold its own.

### Same deadline on both legs

It provides no safe reaction window after the preimage is disclosed and creates a symmetric refund race.

### Unkeyed HTLCs

Anyone learning the preimage could spend the proofs. Receiver-bound conditions constrain the claim to the negotiated counterparty key.

### Trust a DM claim notice

A peer can lie, replay a notice, or send it before the mint accepts a spend. NUT-07 proof state and witness are authoritative.

### Publish the preimage on Nostr

It leaks settlement material more broadly than necessary and creates avoidable races. The taker learns it from the quote mint witness.

### Use one mint for both assets

This is a supported topology. It exercises atomic settlement and recovery
without exercising the additional inter-mint failure boundary. The
demonstration currently uses SAT at `https://testnut.cashu.space` and USD at
`https://nofee.testnut.cashu.space`, which is the two-mint topology.

## Consequences

The browser must add durable trade sessions, Cashu HTLC
creation/validation/claim/refund operations, strict NIP-17 transport, NUT-07
witness polling, and public reserve/fill projections. The user- and
agent-facing API exposes only high-level operations and redacted observations;
it never returns bearer tokens, proofs, witnesses, preimages, private keys,
quote IDs, or raw encrypted private messages.

The public verification trace may include event IDs, relay acknowledgements, mints, units, keyset IDs, amounts, price, capability snapshots, deadlines, proof counts, fees, commitments, state sequences, settlement hash, and before/after aggregate balances. It omits raw proofs, curve points, bearer tokens, preimages, witnesses, private keys, and private NIP-17 event identifiers.

## Sources

- [NUT-07: Proof state check](https://github.com/cashubtc/nuts/blob/main/07.md)
- [NUT-10: Spending conditions](https://github.com/cashubtc/nuts/blob/main/10.md)
- [NUT-11: Pay to public key](https://github.com/cashubtc/nuts/blob/main/11.md)
- [NUT-12: Offline ecash signature validation](https://github.com/cashubtc/nuts/blob/main/12.md)
- [NUT-14: Hashed timelock contracts](https://github.com/cashubtc/nuts/blob/main/14.md)
- [cashu-ts 4.7.1](https://github.com/cashubtc/cashu-ts/tree/v4.7.1)
