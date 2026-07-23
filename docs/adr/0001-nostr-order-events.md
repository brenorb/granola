# ADR 0001: Ephemeral Nostr order projections

- Status: Accepted
- Date: 2026-07-23

## Context

Granola needs a public order book that is cheap to query and safe to consume
without replaying an append-only history. An earlier design treated public
history as authoritative and made the current order a derived cache. That
created a two-event publication protocol, partial-publication states, lineage
validation, and permanent public records for short-lived trading intent.

Orders are ephemeral offers. The public protocol should expose only the
maker's latest signed state. Durable recovery belongs in the maker's private
local journal.

## Decision

Each order is represented solely by one parameterized replaceable Nostr event:

- kind `30078`;
- one stable `d` tag: `granola:order:v1:<order-id>`;
- the maker's order key as the event author;
- the complete canonical `granola/order/v1` state in `content`; and
- query tags for protocol version, side, status, market, and expiry.

Create, reserve, release, fill, cancel, and expire all sign a replacement at
the same address. Each replacement increments the state's canonical decimal
`revision`. It has a new event ID and contains no public predecessor reference.
The newest valid replaceable event is the order.

This is a rewrite of protocol v1, not a second public protocol version. There
is no compatibility mode and no event-sequence fallback.

## Canonical event

```json
{
  "kind": 30078,
  "created_at": 1800000000,
  "tags": [
    ["d", "granola:order:v1:11111111-1111-4111-8111-111111111111"],
    ["t", "granola-order"],
    ["v", "1"],
    ["s", "open"],
    ["side", "sell"],
    ["m", "<issuer-specific-market-id>"],
    ["expires_at", "1802592000"],
    ["expiration", "1802592000"]
  ],
  "content": "{\"schema\":\"granola/order/v1\",...}"
}
```

`content` contains the complete current `OrderState`, including immutable
terms and the mutable fields:

- `revision`;
- `remaining_amount`;
- `reserved_amount`;
- `status`;
- `reservation`.

No public event contains settlement commitments, private message IDs, Cashu
tokens, proofs, preimages, or a predecessor event ID.

## Replaceable-event selection

Consumers group events by `(kind, pubkey, d)`. They verify the signature,
canonical schema, address, market tags, exact rational price, and state
invariants before considering an event. NIP-01 replacement ordering applies:
greater `created_at` wins; equal timestamps use lexicographically smaller event
ID.

A private operation must name both the exact current projection event ID and
its state revision. Before signing a successor, the maker loads the current
replaceable event and rejects an ID or revision mismatch. A stale taker cannot
reserve or fill a superseded order even if it retained a valid old event.

## State changes

- `create`: revision `0`, status `open`.
- `reserve`: increments revision, sets an opaque reservation and
  `reserved_amount`.
- `release`: increments revision and clears the reservation.
- `fill`: increments revision, reduces `remaining_amount`, and clears the
  reservation.
- `cancel`: increments revision and produces terminal `canceled`.
- `expire`: increments revision at or after `expires_at` and produces terminal
  `expired`.

Immutable order terms cannot change at the same address. Replacement with new
terms is a new order ID and therefore a new `d` tag.

## Durable publication

Signing happens inside the local order outbox transaction. The exact signed
projection is persisted before any relay write. Publication retries reuse
those exact bytes and event ID; failure never causes re-signing.

One successful acknowledgement from any configured public relay is sufficient.
The outbox then records `acknowledged` and retains the artifact until an
explicit idempotent local commit. Failed and successful per-relay receipts are
merged monotonically. Duplicate or forged receipts fail closed.

The user interface exposes a single action, **Retry same signed projection**,
for a pending order update.

## Private swap binding

Every `granola/dm/v1` message contains:

```json
{
  "order_address": "30078:<maker>:granola:order:v1:<order-id>",
  "order_projection_id": "<exact-current-event-id>",
  "order_revision": "1"
}
```

The reserve acceptance body repeats the reserve projection ID and revision.
The settlement acknowledgement body repeats the fill projection ID and
revision. The duplicate binding is deliberate: envelope and typed body must
agree before the choreography advances.

## Local evidence

Removing event-sequence replay does not remove durable safety evidence. Encrypted
trade sessions retain swap checkpoints, idempotency keys, mint observations,
settlement commitments, refund operations, accepted private transcript hashes,
and the projection IDs and revisions relevant to that session.

## Consequences

- Public storage is bounded to the latest order state per address.
- Each logical order update needs one signature and one relay
  acknowledgement.
- There is no public audit trail of reservations or fills.
- A relay can serve a stale replaceable event; exact ID-plus-revision binding
  prevents it from silently changing an active private session, while clients
  should query more than one relay for availability.
- Maker local storage is authoritative for retries and recovery.
- Protocol implementations are smaller because there is no public lineage,
  receipt pairing, or partial two-event publication state.

## Rejected alternatives

1. **Append-only public order history.** Rejected because short-lived intent
   does not justify permanent publication and because consumers then need
   lineage replay.
2. **A current projection plus a public audit event.** Rejected because it
   recreates split publication and makes one update depend on two relay
   outcomes.
3. **Re-sign after publication failure.** Rejected because it creates multiple
   event IDs for one local intent and weakens idempotency.
4. **Bind private messages by address only.** Rejected because an address
   intentionally survives replacement and therefore cannot detect stale
   state.
