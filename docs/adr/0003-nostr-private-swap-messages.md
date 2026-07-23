# ADR 0003: Private Nostr transport for swap sessions

- Status: accepted for the testnet prototype
- Date: 2026-07-23
- Decision owners: Granola implementers

## Context

Granola needs asynchronous private messages for reservation and atomic-settlement
coordination. Those messages can contain selected mint and keyset identities,
exact amounts, refund deadlines, locked Cashu tokens, witnesses, and unreleased
preimages. Public order events must never carry that material.

Relays are untrusted stores. They may observe routing metadata, retain ciphertext,
replay, duplicate, reorder, withhold, or reject events. A peer may replay a valid
message in another session, equivocate, stall, or send malformed ciphertext.
Encryption therefore needs a separate application protocol for identity, terms,
ordering, idempotency, expiry, and transcript integrity.

This decision was checked against the Nostr specifications at commit
`db5fe3de8c5d1443b634c9bbf66ecb004f337057` on 2026-07-23. NIP-17 and NIP-42
are drafts, so Granola pins a versioned profile rather than treating their current
text as immutable.

## Decision

Use a strict Granola profile of [NIP-17]:

- a kind `14` private-message rumor whose plaintext is canonical Granola JSON;
- NIP-44 version 2 encryption;
- a sender-signed kind `13` NIP-59 seal;
- a fresh random wrapper key for every recipient copy;
- persistent kind `1059` gift wraps for offline delivery; and
- recipient inbox relays discovered only through the recipient's signed kind
  `10050` event.

Do not offer a NIP-04 fallback. An unavailable NIP-17 inbox fails closed instead
of silently downgrading privacy.

NIP-17 is the messaging protocol. NIP-44 is only its encrypted-payload format,
and NIP-59 is only its metadata-hiding carrier. Neither is a DM protocol alone.

## Why NIP-17

- NIP-04 is explicitly deprecated in favor of NIP-17 and exposes the sender,
  recipient, event kind, and timestamp. Its own specification says it is not
  state-of-the-art encrypted messaging.
- NIP-44 v2 supplies versioned, padded, authenticated encryption and published
  test vectors. Version 2 uses secp256k1 ECDH, HKDF, ChaCha20, and HMAC-SHA256
  and was audited in December 2023.
- NIP-59 hides the real sender, inner kind, inner tags, content, and true message
  time behind a single-use wrapper key. The signed seal still authenticates the
  author after decryption.
- Kind `1059` is intended for asynchronous delivery. Kind `21059` is ephemeral,
  must not be stored by relays, and cannot support a disconnected swap peer.
- Kind `10050` separates DM inbox routing from the general NIP-65 relay list.

## Identity and key lifetime

The maker's persistent order-authority key from ADR 0002 is the initial
rendezvous identity. It receives a terms-only reservation proposal and signs the
reservation acceptance, binding the private session to the exact public order
authority.

The taker generates a fresh Nostr session key for each reservation attempt. Once
it accepts a reservation, the maker also generates a fresh settlement key. The
order-key-signed `reserve_accept` binds both session public keys, the reservation,
the exact public reserve transition, terms, and transcript.

All later bearer-material messages use the two session keys. Session private
keys are stored locally through the terminal settlement or refund horizon and
may be destroyed only after recovery is no longer possible. The test prototype
retains them until an explicit session cleanup.

This limits cross-session exposure after key erasure. It is not a ratchet and
does not provide forward secrecy or post-compromise security during a live
session. Social Nostr keys are never used automatically.

Every receiving key publishes and reads back a signed kind `10050` inbox list
before a counterparty sends to it. A missing, stale, invalid, or empty list means
the recipient is not ready. Publishing an inbox list does not prove the relay
will enforce the privacy behavior it advertises.

## Granola message profile

The rumor is kind `14`. It contains exactly one receiver `p` tag and may contain
one `e` tag referencing the previous rumor. It contains no public subject, order,
reservation, or session tags; those would recreate the correlation NIP-59 is
intended to reduce.

The rumor's plaintext content is canonical JSON. A reservation proposal has this
shape; message-specific `body` schemas are defined with the settlement state
machine and must not weaken these common fields:

```json
{
  "schema": "granola/dm/v1",
  "deployment": "cashu-testnet-v1",
  "type": "reserve_propose",
  "message_id": "11111111-1111-4111-8111-111111111111",
  "session_id": "55b...32-byte-lowercase-hex",
  "reservation_id": "22222222-2222-4222-8222-222222222222",
  "order_address": "30078:<maker>:granola:order:v1:<order-id>",
  "order_head": "<exact-transition-id>",
  "maker_order_pubkey": "<32-byte-lowercase-hex>",
  "sender_session_pubkey": "<32-byte-lowercase-hex>",
  "recipient_pubkey": "<32-byte-lowercase-hex>",
  "sequence": "0",
  "previous_message_id": null,
  "previous_transcript_hash": null,
  "sent_at": 1777408000,
  "expires_at": 1777408120,
  "terms_hash": "<sha256-of-canonical-terms>",
  "terms": {
    "base_unit": "sat",
    "base_mint": "https://testnut.cashu.space",
    "base_keyset": "<keyset-id>",
    "quote_unit": "usd",
    "quote_mint": "https://nofee.testnut.cashu.space",
    "quote_keyset": "<keyset-id>",
    "base_amount": "1000",
    "quote_amount": "50",
    "limit_price": { "numerator": "1", "denominator": "20" }
  },
  "body": {}
}
```

Every message binds the schema and deployment, stable order address, exact
current head, session and reservation IDs, sender and receiver, monotonic
direction-specific sequence, expiry, predecessor, running transcript hash, both
mint URLs and keyset IDs, units, integer amounts, and exact rational price.

The proposal and acceptance include the complete canonical terms. Later messages
include the same `terms_hash`. JSON is canonicalized with [RFC 8785] before it is
encrypted or hashed; unknown fields are rejected. A message ID is a UUIDv4
application idempotency key. A session ID is 32 random bytes. Integer values that
can exceed JavaScript's safe range are canonical decimal strings.

The terms hash is:

```text
SHA256(UTF8("granola-terms-v1\n") || UTF8(JCS(terms)))
```

After computing the rumor ID, the resulting transcript hash is:

```text
SHA256(
  UTF8("granola-transcript-v1\n") ||
  (previous_transcript_hash == null ? 32 zero bytes : HEX(previous_transcript_hash)) ||
  HEX(rumor_id)
)
```

The next message carries that result as `previous_transcript_hash`. Its optional
`e` tag references the same predecessor rumor whose application `message_id` is
in `previous_message_id`.

At minimum, the protocol distinguishes `reserve_propose`, `reserve_accept`,
`reserve_reject`, `session_ack`, settlement-stage messages, `ack`, `abort`, and
`fill_request`. The settlement ADR owns the exact bodies and allowed state
transitions.

Three identifiers have different meanings:

- `message_id` is application-level idempotency;
- the rumor ID hashes the unsigned kind `14` message; and
- the seal ID is signed author evidence.

The outer kind `1059` ID identifies only one encrypted delivery copy. Public
reservation state records the proposal's sender-signed kind `13` seal ID, never
the unsigned rumor ID or random wrapper ID.

## Required validation

Before decrypting an outer payload, a receiver must enforce a small encoded-size
limit. Granola v1 uses 32 KiB. This is below NIP-44's maximum and limits base64
decoding and allocation denial of service.

The receiver then validates in this order:

1. Verify the outer event ID and signature, kind `1059`, one exact recipient
   `p` tag, allowed tags, wrapper timestamp policy, and outer expiry.
2. Decrypt and parse the seal; verify its event ID and signature, kind `13`,
   empty tags, and allowed timestamp policy.
3. Decrypt and parse the rumor; recompute its ID and require kind `14`.
4. Require the seal pubkey to equal the rumor pubkey. NIP-17 makes this check
   mandatory to prevent sender impersonation.
5. Require one exact intended-recipient `p` tag and the expected sender or
   session key.
6. Validate every Granola field, canonical encoding, deployment, order address
   and head, terms hash, economic invariants, deadline, sequence, predecessor,
   and transcript hash before changing state.
7. Deduplicate the message ID, rumor ID, and seal ID. Return the same result for
   an exact replay; reject a changed result under an existing identifier.
8. Treat two valid successors of one transcript hash as equivocation. Never pick
   a winner by timestamp, relay count, or arrival order.

The pinned `nostr-tools@2.23.3` `nip59.unwrapEvent` helper only decrypts. It does
not perform the outer or seal signature checks, kind and tag checks, rumor hash,
recipient check, or required seal/rumor author match, and it discards the seal.
Granola must implement the validating pipeline above around lower-level NIP-44
operations; helper output alone is untrusted.

The same package's `nip17.wrapManyEvents` creates a new one-recipient rumor for
each copy, including the sender copy. Granola instead creates one exact rumor
once, then creates recipient-specific seals and wraps from that rumor so every
delivery copy has the same rumor ID and transcript meaning.

## Delivery and reservation semantics

- Publish only to relays in the recipient's current kind `10050` list. Prefer
  one to three NIP-42 AUTH-protected inbox relays that restrict kind `1059`
  retrieval to the tagged recipient.
- Store the exact signed rumor, seal, and wrapper before network publication.
  Retry the same wrapper ID; do not regenerate ciphertext during ordinary retry.
- Relay `OK` means only that a relay accepted an event. It does not prove the
  peer received, decrypted, validated, or acted on it.
- Retry until an authenticated application `ack` or the encrypted deadline.
  An ACK references the message, rumor, and seal IDs plus the resulting
  transcript hash.
- The maker publishes and reads back the public reserve transition before
  sending `reserve_accept`. The acceptance references that exact new transition
  and binds the maker's fresh settlement key.
- The taker verifies both the private acceptance and authoritative public chain
  before making bearer material claimable.
- A proposal alone never reserves an order. A public transition alone does not
  prove that the intended taker received a valid private acceptance.

Granola uses NIP-17's disappearing-message option and does not publish a sender
copy to relays. It retains the local encrypted outbox and transcript instead.

An outer wrapper may contain a coarse, jittered NIP-40 `expiration` later than
the exact encrypted protocol deadline. The seal keeps empty tags: NIP-59 says
kind `13` tags must be empty, while NIP-17 only recommends putting expiration
there, so the NIP-59 `MUST` wins. Clients enforce encrypted deadlines locally.
Relay deletion is advisory and must never be treated as cryptographic erasure.

The three relays used for the public order book (`nos.lol`,
`relay.primal.net`, and `offchain.pub`) did not advertise NIP-17 or NIP-42 in
their NIP-11 documents on 2026-07-23. They are not the default private inbox
set merely because they accepted public order events. A candidate inbox relay
must pass a two-key test for kind `10050`, gift-wrap publish/readback, NIP-42
authentication, recipient-only retrieval, and offline delivery before use.

## What this does not solve

NIP-17, NIP-44, and NIP-59 do not provide:

- atomic settlement, proof validity, mint honesty, refund correctness, or
  double-spend prevention;
- guaranteed relay delivery, ordering, availability, or censorship resistance;
- reservation consensus or prevention of peer equivocation;
- cryptographic forward secrecy, post-compromise security, or post-quantum
  security;
- protection from endpoint compromise, XSS, malicious extensions, or exposed
  IndexedDB;
- complete metadata hiding: an inbox relay still sees recipient, connection IP,
  AUTH identity, traffic volume, approximate arrival time, and padded size; or
- reliable deletion of expired ciphertext.

NIP-17 calls disappearing messages optional forward secrecy, but NIP-44
explicitly states that its static ECDH conversation key has no forward secrecy.
Granola describes expiry and session-key deletion as retention reduction and
key erasure, not formal forward secrecy. Live observers may still correlate
gift-wrap arrival with nearby public order transitions.

## Rejected alternatives

1. **NIP-04.** Rejected because it is deprecated, leaks substantially more
   metadata, and has an explicit security warning. Supporting it would also
   create a downgrade path.
2. **Raw NIP-44 in a custom event.** Rejected because NIP-44 defines encryption,
   not DM kinds, inbox discovery, routing, or metadata protection, and says it
   should not be a drop-in NIP-04 replacement.
3. **Raw NIP-59.** Rejected because gift wrap deliberately does not define a
   messaging protocol.
4. **Kind `21059`.** Rejected because relays must not store it and Granola must
   recover from peer disconnects.
5. **NIP-65 relay lists for DMs.** Rejected because kind `10002` is general
   read/write routing; NIP-17 defines kind `10050` as the inbox authority.
6. **Persistent maker key for the entire settlement.** Rejected because later
   compromise would expose every retained session encrypted to that key.
7. **Marmot/MLS now.** It offers a path to formal forward secrecy and
   post-compromise security, but its group, key-package, and epoch state adds
   disproportionate interoperability and recovery work for the two-party
   prototype and is not implemented by the pinned client library. Reconsider it
   before mainnet if formal forward secrecy is a release requirement.

## Consequences and test gate

The design adds two encryption layers, inbox publication, application ACKs,
session-key persistence, an exact encrypted outbox, and strict validation around
the library helpers. That complexity buys materially less public correlation and
avoids an obsolete encryption format, but it cannot turn relays into a trusted
transport.

Before a real trade, executable negative vectors must cover tampered outer and
seal signatures, invalid MAC, wrong wrapper kind or recipient, non-empty seal
tags, rumor impersonation, wrong order/head/terms/keyset, duplicate and
cross-session replay, transcript forks, relay reordering and ACK loss, expiry
boundaries, oversized ciphertext, missing or stale kind `10050`, deleted session
recovery, and private acceptance without its authoritative reserve transition.

[NIP-04]: https://github.com/nostr-protocol/nips/blob/db5fe3de8c5d1443b634c9bbf66ecb004f337057/04.md
[NIP-17]: https://github.com/nostr-protocol/nips/blob/db5fe3de8c5d1443b634c9bbf66ecb004f337057/17.md
[NIP-40]: https://github.com/nostr-protocol/nips/blob/db5fe3de8c5d1443b634c9bbf66ecb004f337057/40.md
[NIP-42]: https://github.com/nostr-protocol/nips/blob/db5fe3de8c5d1443b634c9bbf66ecb004f337057/42.md
[NIP-44]: https://github.com/nostr-protocol/nips/blob/db5fe3de8c5d1443b634c9bbf66ecb004f337057/44.md
[NIP-59]: https://github.com/nostr-protocol/nips/blob/db5fe3de8c5d1443b634c9bbf66ecb004f337057/59.md
[NIP-65]: https://github.com/nostr-protocol/nips/blob/db5fe3de8c5d1443b634c9bbf66ecb004f337057/65.md
[RFC 8785]: https://www.rfc-editor.org/rfc/rfc8785
