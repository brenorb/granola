# ADR 0001: Nostr events for the Granola order book

- Status: accepted for the testnet prototype
- Date: 2026-07-23
- Decision owners: Granola implementers

## Context

Granola needs a public, relay-replicated limit-order book for Cashu liabilities.
An order can offer one asset from one mint and request another asset from one or
more acceptable mints. It must support all-or-none and partial execution,
explicit expiry, reservations, fills, cancellation, and economic replacement.

Nostr relays can replicate signed events, but they are not a matching engine or
a consensus database. The wire format must not imply atomic compare-and-set or
globally consistent state where none exists.

The current Nostr specifications use the terms `regular` and `addressable`
events in [NIP-01]. NIP-16 and NIP-33 now point to NIP-01 rather than defining
separate behavior.

## Decision

For the prototype, use a namespaced [NIP-78] pair:

- kind `78`, a regular event, for immutable accepted order transitions;
- kind `30078`, an addressable event, for the current order-book projection;
- [NIP-40] `expiration` on projections for relay retention;
- NIP-01 event IDs, author keys, timestamps, references, and signatures.

NIP-78 is a carrier, not the Granola protocol specification. Every event is
versioned and namespaced. Once the format has independent implementations, it
should move to dedicated regular and addressable kinds registered in the
[Nostr kind registry]. That migration requires a new ADR and wire version.

Do not use [NIP-69] kind `38383` as Granola's source of truth. A client may emit
an optional NIP-69 projection only when the order is truthfully Bitcoin versus
ISO-4217 fiat and every mandatory NIP-69 field has its specified meaning.
Generic Cashu pairs such as USD/EUR must never be disguised as NIP-69 orders.

## Why NIP-78 for this prototype

- Granola currently has one implementation. NIP-78 explicitly provides
  app-specific regular and addressable storage without pretending the data is
  already an interoperable Nostr standard.
- Kind `78` preserves a signed transition history. Kind `30078` gives order-book
  clients an efficient latest-state view.
- Namespacing avoids collisions with unrelated NIP-78 application data.
- A provisional pair avoids claiming unregistered custom kinds as stable.
- The two-event model separates economic causality from relay replacement
  policy. The transition chain is authoritative; the projection is a cache.

## Why not NIP-69 as the base format

NIP-69 is a useful draft order-announcement format with deployed precedent. It
defines addressable kind `38383`, but its mandatory vocabulary is specifically
Bitcoin versus ISO-4217 fiat:

- `amt` is Bitcoin in satoshis;
- `fa` is a fiat amount or range;
- `premium` is a percentage against an unspecified external price;
- `pm` describes off-protocol payment methods;
- its statuses are `pending`, `canceled`, `in-progress`, `success`, `expired`.

It does not define Cashu mint URLs, acceptable mint sets, exact rational limit
prices, remaining quantity, minimum fills, all-or-none, partial fills, revisions,
or reservation/fill conflict rules. Adding all of these while populating its
mandatory Bitcoin/fiat fields would create a profile that legacy NIP-69 clients
could misread. Restricting Granola to Bitcoin/fiat would contradict the protocol's
multi-currency purpose.

## Why not only an addressable event

An addressable event is selected by `(kind, pubkey, d)` and relays normally keep
the event with the greatest `created_at`; equal timestamps choose the lowest
event ID. Those are storage rules, not economic ordering rules. A malicious or
buggy maker can sign two successors, relays can see different updates, and a
future timestamp can pin a bad projection.

The immutable transition chain supplies explicit revision, predecessor, and
operation identifiers. Clients can detect rollback and equivocation instead of
letting relay timestamp selection decide ownership of value.

## Why not NIP-09 deletion for cancellation

Deletion is a request, can be missed or ignored, and communicates no terminal
order state to clients that retained an older event. Cancellation is a signed
transition followed by a `canceled` projection. Deletion may be used later for
best-effort cleanup, never as the cancellation authority.

## Event identity

The stable order address is:

```text
30078:<maker-pubkey>:granola:order:v1:<order-id>
```

`order-id` is a random UUID. The bare UUID is not globally unique without the
maker public key. The current projection event ID is a revision ID and changes
on every update.

The Nostr event supplies:

- maker public key in `pubkey`;
- update publication time in `created_at`;
- revision event ID in `id`;
- maker signature in `sig`.

The original order creation time remains in the signed state because Nostr's
`created_at` changes when the addressable projection is replaced.

## Projection event

The current projection has kind `30078` and these tags:

```json
[
  ["d", "granola:order:v1:019..."] ,
  ["t", "granola-order"],
  ["v", "1"],
  ["s", "open"],
  ["side", "sell"],
  ["m", "79da04f634a843c37c7a5ffb4aa29742a2551d238d9a443b39338c52b8fd1d5b"],
  ["m", "8b232677c9edc17ccae45cf226fda181d314a83426212ee0ffada7f92d10dbad"],
  ["expires_at", "1780000000"],
  ["expiration", "1780604800"],
  ["e", "<current-transition-id>"]
]
```

Each single-letter `m` tag identifies one exact issuer-specific market. Its
value is lowercase hex SHA-256 of this UTF-8 string with no final newline:

```text
granola-market-v1\n<base-unit>\n<base-mint>\n<quote-unit>\n<quote-mint>
```

The tag is repeated for every exact mint pair in which the order is eligible to
appear. NIP-01 requires relays to index single-letter tags and filters on their
second value, which makes an exact market subscription possible:

```json
{"kinds":[30078],"#t":["granola-order"],"#m":["79da04f634a843c37c7a5ffb4aa29742a2551d238d9a443b39338c52b8fd1d5b"]}
```

Clients recompute all `m` values from signed content and reject mismatches. An
order requesting several acceptable mints can appear in several issuer-specific
books. Clients must not aggregate different mint liabilities into one
top-of-book price unless the user explicitly chooses that view.

The `content` is a JSON object:

```json
{
  "schema": "granola/order/v1",
  "order_id": "019...",
  "revision": "0",
  "head": "<current-transition-id>",
  "created_at": 1777408000,
  "expires_at": 1780000000,
  "side": "sell",
  "base_unit": "sat",
  "quote_unit": "usd",
  "offered": { "unit": "sat", "mint": "https://testnut.cashu.space" },
  "requested": {
    "unit": "usd",
    "acceptable_mints": [
      "https://nofee.testnut.cashu.space",
      "https://testnut.cashu.space"
    ]
  },
  "original_amount": "1000",
  "remaining_amount": "1000",
  "reserved_amount": "0",
  "limit_price": { "numerator": "5", "denominator": "1" },
  "minimum_fill_amount": "1000",
  "execution": "all_or_none",
  "status": "open",
  "reservation": null,
  "replaces": null,
  "replaced_by": null
}
```

A complete bid uses the same cardinality without reversing the schema:

```json
{
  "schema": "granola/order/v1",
  "order_id": "019...bid",
  "revision": "0",
  "head": "<current-transition-id>",
  "created_at": 1777408000,
  "expires_at": 1780000000,
  "side": "buy",
  "base_unit": "sat",
  "quote_unit": "usd",
  "offered": { "unit": "usd", "mint": "https://nofee.testnut.cashu.space" },
  "requested": {
    "unit": "sat",
    "acceptable_mints": [
      "https://nofee.testnut.cashu.space",
      "https://testnut.cashu.space"
    ]
  },
  "original_amount": "1000",
  "remaining_amount": "1000",
  "reserved_amount": "0",
  "limit_price": { "numerator": "5", "denominator": "1" },
  "minimum_fill_amount": "100",
  "execution": "partial",
  "status": "open",
  "reservation": null,
  "replaces": null,
  "replaced_by": null
}
```

Its `m` tags are
`af826c2cddbdba30d2fa196180ce8a0111618e002eec2a1e644cbddd9935797e`
and `79da04f634a843c37c7a5ffb4aa29742a2551d238d9a443b39338c52b8fd1d5b`.

All amounts are canonical non-negative integer strings in the base asset's
minor unit; original amount and minimum fill are positive. Price is the reduced
positive rational number of quote minor units per base minor unit.
Implementations must not use binary floating point. A fill is valid only when
`base_fill * numerator` is exactly divisible by `denominator`, so both
settlement amounts remain integers.

`base_unit` and `quote_unit` are side-neutral and do not carry mint cardinality.
`side` is `sell` for an ask and `buy` for a bid. For a sell, `offered.unit` must
equal `base_unit` and `requested.unit` must equal `quote_unit`. For a buy,
`offered.unit` must equal `quote_unit` and `requested.unit` must equal
`base_unit`. Offered always has exactly one mint; requested always has a
non-empty acceptable-mint set.

Mint URLs are normalized HTTPS URLs without queries, fragments, or trailing
slashes. Units are lowercase. Acceptable mints are normalized, sorted, and
deduplicated before signing.

## Transition event

An accepted transition is a regular kind `78` event signed by the maker. Its
tags include the projection address, operation, and predecessor:

```json
[
  ["d", "granola:order-transition:v1:019..."],
  ["t", "granola-order-transition"],
  ["v", "1"],
  ["a", "30078:<maker-pubkey>:granola:order:v1:019..."],
  ["op", "fill"],
  ["e", "<previous-transition-id>"]
]
```

Its content contains `schema`, `operation_id`, `operation`, `revision`,
`previous`, and the complete resulting economic state except `head`. The event
cannot contain its own ID without a circular hash dependency. After signing the
transition, the maker copies that state into the projection and sets `head` to
the transition event ID. This makes the chain rebuildable without replaying
private settlement messages.

The initial `create` transition has revision `0` and `previous: null`. Every
later transition has `revision = previous.revision + 1` and names the exact
previous transition event ID. Event IDs and operation IDs are deduplicated.

If a maker signs two valid successors of one head, the maker has equivocated.
Clients freeze the order as disputed; they do not pick a winner by Nostr
timestamp, relay count, or lexicographic event ID.

## Lifecycle

The public effective states are:

- `open`: no fill and no live reservation;
- `partially_filled`: some quantity filled, remainder available;
- `reserved`: one live maker-accepted reservation exists;
- `filled`: terminal, `remaining_amount` is zero;
- `canceled`: terminal maker cancellation;
- `expired`: terminal at local time `>= expires_at` unless already filled or
  canceled.

State is derived in this priority order: `filled`, `canceled`, `expired`, live
`reserved`, `partially_filled`, `open`. A signed snapshot can still contain a
just-expired reservation; the effective state then derives to `open` or
`partially_filled` until the maker publishes a release transition. Relays may
retain expired events, so clients enforce time locally.

The wire always carries an explicit `expires_at`. If the maker does not choose
one, the creating client sets it to creation time plus 2,592,000 seconds
(30 days). The NIP-40 `expiration` tag controls relay retention and is seven
days later by default. These timestamps have different purposes.

## Operations

### Create

Publish revision `0` with `remaining_amount = original_amount`, no reservation,
and status `open`. All-or-none is the default UI choice, but `execution` is
always explicit on the wire.

### Reserve

A taker sends a signed private proposal referencing the exact transition head,
terms, requested base amount, and a unique reservation ID. A reservation exists
only after a maker-signed acceptance transition. A proposal alone has no effect.

Version 1 permits one live reservation per order. The default reservation is
120 seconds. Its state object is:

```json
{
  "id": "<random-reservation-id>",
  "amount": "1000",
  "accepted_at": 1777408120,
  "expires_at": 1777408240,
  "proposal_event_id": "<sender-signed-kind-13-seal-id>",
  "taker_commitment": "<32-byte-lowercase-hex>"
}
```

The amount is positive and no greater than remaining; `accepted_at` equals the
reserve transition's Nostr `created_at`; expiry is later than acceptance and no
later than order expiry; proposal ID is the verified sender-signed kind `13`
seal carrying the NIP-17 proposal;
the commitment is opaque and does not reveal the taker. `reserved_amount` must
equal `reservation.amount` when reservation is non-null and must be zero when
it is null. Reservation does not reduce `remaining_amount`.

Effective available amount is `remaining_amount - reserved_amount` while the
reservation is live, and `remaining_amount` after local reservation expiry.

All-or-none requires the reservation and fill to equal the entire remaining
amount. Partial execution requires each fill to meet `minimum_fill_amount`,
except a final fill may equal the smaller entire remainder. A non-final fill
must not leave positive dust below the minimum.

Reservation expiry is derived locally, but clearing signed state requires an
internal `release` transition. Release clears `reservation` and
`reserved_amount`, then publishes an exact projection of that transition state.
Its reason is either `expired`, valid only at or after reservation expiry, or
`abort`, which references the taker's signed private abort event. A maker must
publish release before accepting another reservation. A cancel operation is
rejected while a reservation is live unless it first consumes a signed abort;
otherwise the maker waits for expiry and releases it.

### Fill

Fill references a live reservation ID and the exact accepted head. It decreases
`remaining_amount`, clears the reservation, and results in `filled` at zero or
`partially_filled` otherwise. The public event contains settlement transcript
hashes, never Cashu proofs, preimages, quote IDs, or DM ciphertext.

### Cancel

Cancel creates a terminal transition and `canceled` projection. A terminal
order cannot reopen.

### Replace

Economic replacement is cancel-and-create, not merely Nostr's addressable-event
replacement. Price, total quantity, side, asset, mint, execution condition, or
expiry changes create a new order ID.

One logical Replace produces two maker-signed transition events with the same
random `operation_id`: a `replace` successor on the old chain that makes it
terminal and records `replaced_by`, and revision-zero `create` on the new chain
that records `replaces`. Cross-links use stable order addresses, not the two
transition IDs, avoiding a circular hash dependency. The old and new projections
point to their respective transition IDs. Relays cannot publish the pair
atomically, so clients use author, operation ID, and signed cross-links to
recognize temporary divergence. A new order is displayed only after its paired
old transition is available or with an explicit unverified-replacement warning.

Ordinary lifecycle snapshots keep the same order ID and are technical Nostr
replacements, not the economic Replace operation.

## Ordering and matching

An exchange view selects an exact base `(unit, mint)` and quote `(unit, mint)`.
It includes only orders compatible with both issuer liabilities.

- asks sort by lowest exact rational price, then stable order address;
- bids sort by highest exact rational price, then stable order address;
- reserved quantity is excluded from displayed available depth;
- terminal and locally expired orders are excluded.

Neither maker-asserted creation time nor Nostr publication time grants economic
priority. They are informational because a maker can backdate an event and
relays do not establish global order. The stable-address tie-break only makes UI
output deterministic and grants no execution right; a maker can also choose
that address. Competing reservations are resolved solely by a maker-signed
acceptance against one exact head.

## Consistency and replay rules

- Validate event ID, Schnorr signature, maker author, schema, and invariants.
- Reject an unknown version instead of guessing.
- Reject a stale predecessor or non-monotonic revision.
- Require original `created_at` to equal the create transition timestamp, but
  never use it as a fairness or priority oracle.
- Reject transitions after a terminal state.
- Reject far-future timestamps outside the client's clock-skew policy.
- Treat the addressable projection as unverified if its `head` transition is
  missing. It may still be displayed with a warning for discovery.
- Query multiple relays. NIP-67 `finish` can prove one relay exhausted its
  stored result; absence of the hint requires pagination and does not prove
  completeness.
- Publish NIP-40 projections only to relays advertising NIP-40. Do not strip
  `expiration` per relay, because that would create different signed event IDs.
- A live reservation acceptance is the maker's signed private response tied to
  one exact head. Public relay state alone never proves exclusive reservation.

## Privacy and security consequences

Order terms, maker key, timestamps, and transition timing are public. Reserve
and fill requests travel privately. Public transitions use opaque reservation
IDs and settlement hashes so they do not identify the taker or reveal bearer
material.

An ephemeral maker key can reduce cross-order linkage, but key rotation cannot
take over an existing addressable order. A new key creates a new order authority.

The event model detects maker equivocation; it cannot prevent it or create
cross-relay consensus. Atomicity belongs to the Cashu settlement protocol, not
the Nostr order book.

## Consequences

### Positive

- The prototype can publish immediately without occupying an unregistered kind.
- Current state is cheap to query while transitions remain auditable.
- Arbitrary Cashu units and issuer liabilities remain truthful.
- Explicit revisions expose conflicts hidden by addressable replacement.
- The schema maps directly to an exchange-style top-of-book view.

### Negative

- Generic Nostr clients will not understand Granola's NIP-78 content.
- Two events are published for every accepted transition.
- Relays can temporarily show stale or incomplete projections.
- A later registered-kind migration will require dual-read or explicit cutover.
- NIP-69 interoperability is limited to an optional compatible projection.

## Rejected alternatives

1. **Only NIP-69.** Rejected because its mandatory Bitcoin/fiat model cannot
   represent arbitrary Cashu pairs without misleading existing clients.
2. **Only kind 30078.** Rejected because relay replacement rules hide forks and
   cannot express economic causality.
3. **Unregistered custom kinds now.** Rejected for the prototype because kind
   collision is avoidable while the schema has one implementation.
4. **NIP-09 cancellation.** Rejected because deletion is best-effort cleanup.
5. **Relay timestamps as sequence.** Rejected because clocks and relay views are
   neither trusted nor globally consistent.
6. **Public taker-signed reservations as authority.** Rejected because competing
   proposals do not create exclusivity; only maker acceptance can reserve.

## Migration trigger

Propose and register dedicated kinds after:

- two independent clients implement the same order vectors;
- at least one public relay successfully carries both event classes;
- create, reserve, fill, cancel, replace, expiry, stale-head, and equivocation
  vectors are interoperable;
- the DM and settlement ADRs are accepted.

[NIP-01]: https://github.com/nostr-protocol/nips/blob/db5fe3de8c5d1443b634c9bbf66ecb004f337057/01.md
[NIP-09]: https://github.com/nostr-protocol/nips/blob/db5fe3de8c5d1443b634c9bbf66ecb004f337057/09.md
[NIP-40]: https://github.com/nostr-protocol/nips/blob/db5fe3de8c5d1443b634c9bbf66ecb004f337057/40.md
[NIP-67]: https://github.com/nostr-protocol/nips/blob/db5fe3de8c5d1443b634c9bbf66ecb004f337057/67.md
[NIP-69]: https://github.com/nostr-protocol/nips/blob/db5fe3de8c5d1443b634c9bbf66ecb004f337057/69.md
[NIP-78]: https://github.com/nostr-protocol/nips/blob/db5fe3de8c5d1443b634c9bbf66ecb004f337057/78.md
[Nostr kind registry]: https://github.com/nostr-protocol/registry-of-kinds
