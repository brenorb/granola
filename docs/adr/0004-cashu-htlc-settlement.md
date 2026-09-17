# ADR 0004: One- or two-mint settlement with staggered Cashu HTLCs

- Status: accepted for the testnet prototype
- Date: 2026-07-23
- Updated: 2026-09-17
- Depends on: [ADR 0001](0001-nostr-order-events.md), [ADR 0003](0003-nostr-private-swap-messages.md)

## Context

Granola swaps ecash issued by one or two Cashu mints. Two mints are the
general inter-mint case, while one mint is also valid when both legs use the
same issuer. A maker offering the base asset must not learn the requested
quote asset without enabling the taker to claim the base asset. Either party
also needs a bounded recovery path when its counterparty disappears.

Cashu NUT-14 HTLC spending conditions bind a proof to a SHA-256 hash and can additionally require a receiver public key. A refund public key becomes usable after a locktime. NUT-07 reports proof state and, after a spend, its witness. The client checks each selected mint's required capabilities and active keysets during trade preflight; this document is not a live capability report.

This is atomic only under explicit assumptions: each participating mint enforces the advertised NUTs honestly, retains the spend witness, has a sufficiently aligned clock, and remains reachable across the settlement and refund windows. It does not remove mint risk or guarantee unconditional fairness.

## Decision

Use receiver-bound NUT-14 HTLC legs with one fresh 32-byte preimage and SHA-256
hash per reservation. The base and quote legs may use the same mint or two
distinct mints; when two mints are selected, each mint is preflighted and
observed independently.

For a maker selling base for quote:

1. Maker creates fresh, independent Nostr session, Cashu settlement, and Cashu refund keys. Maker generates and durably stores the preimage and hash before accepting the reservation.
2. Taker creates its own fresh Nostr session, Cashu settlement, and Cashu refund keys.
3. Maker locks the base proofs first and includes that lock in
   `reserve_accept`. The base leg uses the shared hash, the taker's Cashu
   settlement key as receiver, the maker refund key, and the later deadline
   `T_long`.
4. Taker validates that leg before funding the counter-leg.
5. Taker locks the quote proofs second. The quote leg uses the same hash, the maker's Cashu settlement key as receiver, the taker refund key, and the earlier deadline `T_short`.
6. Maker validates that leg, then claims it with the preimage and maker settlement key before the maker claim cutoff.
7. Taker observes every quote proof as `SPENT` through NUT-07, extracts one identical witness preimage, verifies its hash, and claims the base leg with that preimage and the taker settlement key.
8. Both participants verify both legs as `SPENT` before financial completion.
   Maker stages the `filled` (or `partially_filled`) projection in the durable
   outbox. With direct routes, reserve/fill publication runs asynchronously;
   public visibility can lag the locally persisted reservation and settlement.

The wire choreography names these positions `base_lock` and `quote_lock`, but
they are protocol slots: `reserve_accept` embeds the maker offer with `T_long`,
then `quote_lock` carries the taker payment with `T_short`. For a buy-side maker
the market assets reverse—quote occupies the long-lock maker-offer slot and
base occupies the short-lock taker-payment slot. Cashu validation binds the
exact accepted deadline without inferring the protocol slot from the market
asset name.

For the testnet demonstration, after confirming each participating mint clock is within 30 seconds of local time, use:

- `anchor = max(local clock, participating mint clocks)`;
- `T_short = anchor + 10 minutes`;
- maker claim cutoff `= T_short - 120 seconds`;
- `T_long = anchor + 20 minutes`;
- taker claim cutoff `= T_long - 120 seconds`;
- reservation expiry at `anchor + 30 minutes` and no later than order expiry;
- refund attempts only after the relevant mint confirms expiry plus 60 seconds.

Receiver spending remains possible after a NUT-14 locktime, so expiry creates a receiver/refunder race rather than revoking receiver authority. Implementations stop initiating claims at the cutoffs and enter recovery mode. They do not treat equality with a locktime as safe.

New sessions use this 10/20/30-minute profile. Maker persists the plan before
locking its offer. The signed acceptance carries that exact plan and lock;
taker validates and persists both before creating its payment leg.

## Exact validation before funding the counter-leg

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

A `SPENT` state supplies usable claim evidence only when every payment proof
has a well-formed witness containing the same preimage and that preimage hashes
to the negotiated value. `PENDING` is not spend evidence: while observing a
previously submitted operation, the client waits and rechecks within the deadline.
Missing, mixed or mismatched spend witnesses fail validation and cannot authorize
a claim or public fill. Before funding, selected input proofs must be `UNSPENT`.

## Private message sequence

Use ADR 0003's canonical NIP-17 envelope rules for:

1. `reserve_propose`
2. `reserve_accept`, including the offer-side HTLC
3. `quote_lock`, including the payment-side HTLC

After the third message, both parties advance from independently verified mint
state. The maker claims the payment leg, the taker learns the preimage from the
mint and claims the offer leg, and the maker publishes the signed fill
projection. No private verification, claim, or receipt messages are required.

## Recovery

- Before either leg is locked: release through the durable recovery path. There
  is no supported `abort` message body; do not wait for an invented peer ACK.
- After only the base leg is locked: maker waits for `T_long` and refunds it.
- After both legs are locked but before maker claim: taker refunds quote after `T_short`; maker refunds base after `T_long`.
- After maker claim: taker continues polling the quote witness and claims base before its cutoff. If the witness is unavailable or invalid, preserve the trace and enter terminal recovery rather than declaring success.
- A public fill or reservation release is forbidden until the corresponding mint states are independently verified.

Persist the exact signed message, lock token, keys, commitments, relay receipts,
mint observations, and state transition before performing the next
irreversible action. Retries are idempotent and reuse the persisted artifact
rather than creating a new proof or message.

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

The browser implements durable trade sessions, Cashu HTLC
creation/validation/claim/refund operations, strict NIP-17 transport, NUT-07
witness polling, and public reserve/fill projections. The user- and
agent-facing API exposes only high-level operations and redacted observations;
trade read methods never return bearer tokens, proofs, witnesses, preimages,
private keys, mint quote IDs, or raw encrypted private messages. The wallet's
explicit `createBackup()` method is the deliberate bearer-token exception.

Local redacted diagnostic reports may include public event IDs, relay outcomes,
mint/keyset identities, amounts, deadlines, commitments and aggregate balances.
They are not additional public Nostr events. Do not add receipt histories or
settlement evidence to the public order book, and never include bearer material
or private message bodies in diagnostics.

## Sources

- [NUT-07: Proof state check](https://github.com/cashubtc/nuts/blob/main/07.md)
- [NUT-10: Spending conditions](https://github.com/cashubtc/nuts/blob/main/10.md)
- [NUT-11: Pay to public key](https://github.com/cashubtc/nuts/blob/main/11.md)
- [NUT-12: Offline ecash signature validation](https://github.com/cashubtc/nuts/blob/main/12.md)
- [NUT-14: Hashed timelock contracts](https://github.com/cashubtc/nuts/blob/main/14.md)
- [cashu-ts 4.7.1](https://github.com/cashubtc/cashu-ts/tree/v4.7.1)
