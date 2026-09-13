# Granola protocol specification v0.1

Status: implementer draft for the `cashu-testnet-v1` deployment.

This document is the normative protocol reference. The ADRs in `docs/adr/`
remain design history and rationale; they do not override this specification.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be
interpreted as described in RFC 2119/8174.

## 1. Scope and wire identity

Granola coordinates a two-party exchange of Cashu ecash. Nostr provides public
order discovery and authenticated private delivery. Cashu mints remain the
issuers and authorities for proof state. Granola adds no custodian or escrow
party.

This specification covers:

- public order projections;
- private reservation and settlement messages;
- one-mint and two-mint Cashu settlement;
- deterministic validation, recovery, and evidence; and
- the SDK boundary used by the browser demo.

The current wire identifiers are:

| Item | Value |
| --- | --- |
| deployment | `cashu-testnet-v1` |
| order schema | `granola/order/v1` |
| private message schema | `granola/dm/v1` |
| atomic body schema | `granola/atomic-swap-body/v1` |
| order event | Nostr kind `30078` |
| private rumor | Nostr kind `14` |
| private seal | Nostr kind `13` |
| private wrapper | Nostr kind `1059` |
| inbox registration | Nostr kind `10050` |
| protocol version tag | `1` |

The document version is `0.1`; it is not a wire version. Implementations MUST
reject a different deployment or wire version unless an explicit compatibility
profile says otherwise.

## 2. Terminology and actors

- **Maker**: the owner of an order and its ephemeral order-authority key.
- **Taker**: the peer requesting a particular order fill.
- **Order authority key**: a fresh Nostr signing key for one order. It is used
  for public projections, rendezvous, and the signed reservation acceptance.
- **Session key**: a fresh Nostr key for one reservation. After acceptance,
  settlement messages use session keys, not a social identity.
- **Settlement key**: a fresh Cashu receiver key for one reservation.
- **Refund key**: a fresh Cashu refund key for one reservation and leg.
- **Leg**: one Cashu HTLC, identified by mint, unit, keyset, amount, receiver,
  refund key, hash, and locktime.
- **Base**: the market's base asset and amount. In the current market this is
  SAT.
- **Quote**: the market's quote asset and amount. In the current market this is
  USD minor units.
- **Projection**: a signed, complete public order state event.
- **Terms**: the exact economic and issuer identity values being exchanged.
- **Transcript hash**: the hash-chain value binding the accepted private
  message sequence.
- **Bearer material**: spendable Cashu proofs/tokens, private keys, or an
  unreleased HTLC preimage. Bearer material is never public protocol data.

The protocol assumes honest participating mints enforce the advertised Cashu
conditions, return the spent proof witness through NUT-07, and remain reachable
long enough for settlement or refund. This is a mint trust and availability
assumption, not a claim that the protocol removes mint risk.

## 3. Encoding rules

1. JSON objects MUST use RFC 8785 JSON Canonicalization Scheme (JCS) before
   hashing, signing, or encrypting. Unknown fields MUST be rejected in protocol
   objects and message bodies.
2. JSON integers that can exceed JavaScript's safe integer range MUST be decimal
   strings. Amounts, prices, revisions, sequence numbers, IDs, and hashes use
   their specified string forms.
3. Amounts MUST be canonical positive decimal strings: no sign, leading zero,
   decimal point, or exponent. `0` is allowed only where a field explicitly
   permits it, such as an order revision or remaining amount.
4. Unix times are non-negative safe integer seconds.
5. Mint URLs MUST be normalized HTTPS URLs without credentials, query, fragment,
   or trailing slash.
6. Nostr public keys, event IDs, commitments, hashes, and signatures MUST be
   lowercase hexadecimal of the required size. Cashu public keys MUST be
   compressed secp256k1 public keys.
7. Implementations MUST compare exact strings after canonicalization and MUST
   use integer arithmetic for settlement. Floating-point conversion is
   forbidden for signed economic values.

### 3.1 Terms and pricing

`terms` contains exactly these fields, with an optional `maker_side` field:

```json
{
  "maker_side": "sell",
  "base_unit": "sat",
  "base_mint": "https://testnut.cashu.space",
  "base_keyset": "<keyset-id>",
  "quote_unit": "usd",
  "quote_mint": "https://nofee.testnut.cashu.space",
  "quote_keyset": "<keyset-id>",
  "base_amount": "2000",
  "quote_amount": "100",
  "price_cents_per_btc": "5000000"
}
```

The quote amount MUST equal:

```text
quote_amount = (base_amount * price_cents_per_btc) / 100000000
```

Division truncates toward zero. A zero result is invalid. The base amount is
never changed to compensate for a fractional quote unit. Each partial fill
recomputes this formula independently.

The terms hash is:

```text
SHA256(UTF8("granola-terms-v1\n") || UTF8(JCS(terms)))
```

## 4. Actors and public order lifecycle

### 4.1 Order projection

The maker MUST publish a complete signed kind `30078` projection. Its address is:

```text
30078:<maker-order-pubkey>:granola:order:v1:<order-id>
```

The event MUST contain exactly the protocol tags required by the implementation:

```text
["d", "granola:order:v1:<order-id>"]
["t", "granola-order"]
["v", "1"]
["s", "<status>"]
["side", "buy" | "sell"]
["m", "<eligible-market-id>"]  // one per eligible market, sorted
["expires_at", "<order-expiry>"]
["expiration", "<order-expiry>"]
```

The content is the canonical `granola/order/v1` state. It MUST include order
ID, revision, creation and expiry times, side, units, offered and requested
mint identities, original/remaining/reserved amounts, integer price, execution
condition, and reservation state. The event signature, tags, content, and
replaceable address MUST agree.

The order state transitions are:

```text
open -> reserved -> partially_filled -> reserved -> ... -> filled
open -> canceled
open -> expired
reserved -> open       (release/abort)
partially_filled -> canceled | expired
```

Terminal states are `filled`, `canceled`, and `expired`. A reserved order MUST
be released before cancellation or expiry. A reservation is valid only for the
exact order address, projection ID, revision, amount, proposal ID, and bounded
expiry that created it.

Concurrent reservations MUST be serialized so allocated amount never exceeds
the order's remaining amount. A taker MUST provide the exact current projection
ID and revision; stale projections fail closed.

### 4.2 Public data boundary

Public events MAY contain order terms, status, amounts, commitments, timestamps,
and redacted settlement evidence required to verify a fill. They MUST NOT contain
proofs, encoded Cashu tokens, preimages, witnesses, private keys, wallet
backups, private message bodies, or unnecessary identity metadata.

The order book is rendezvous data, not a transaction ledger. A public fill is
authoritative only after both relevant mints independently report the required
spends and the signed fill projection is verified.

## 5. Private message transport

Private delivery uses NIP-17 semantics: NIP-44 v2 encryption inside NIP-59
gift-wrapped events. NIP-04 and custom unwrapped fallback are forbidden.

### 5.1 Inbox registration

Before a peer sends a private message, the recipient MUST publish and read back
a valid kind `10050` registration authored by the exact receiving key. It MUST
have empty content and one to three exact `relay` tags containing normalized
`wss` URLs. The list is sorted and deduplicated. Each relay MUST pass the
deployment's authenticated capability and recipient-only delivery probe.

A registration MUST be fresh, with no more than 300 seconds of future skew and
no more than seven days of age. Missing, stale, unsupported, unauthenticated,
or unread-back inbox state fails closed. A kind `10050` ACK is transport
evidence only; it does not validate a private message.

### 5.2 Envelope

The exact inner objects are:

- kind `14` rumor: one `p` tag for the recipient; later rumors also have one
  `e` tag for the previous rumor and the literal marker `reply`;
- kind `13` seal: empty tags, signed by the rumor author; and
- kind `1059` wrapper: one `p` tag for the recipient and one canonical
  `expiration` tag.

The wrapper MUST be size-limited before decryption. The current limit is 32 KiB
for the encoded outer payload. A receiver MUST validate outer ID/signature/kind,
tags, expiration, recipient, seal ID/signature/kind/tags, rumor ID/kind/tags,
seal-author equals rumor-author, and all recipient and signer relationships.
The pinned `nostr-tools` unwrap helper is decryption only; its result is
untrusted until these checks complete.

Seal and wrapper timestamps MAY be randomized only within 172800 seconds before
the rumor timestamp. The rumor timestamp MUST equal `sent_at`, be no more than
300 seconds in the future, and be strictly before encrypted expiry. Local time
MUST be strictly before both encrypted and outer expiry.

### 5.3 Common message object

The inner plaintext is canonical JSON with schema `granola/dm/v1` and these
required fields:

```text
schema, deployment, type, message_id, session_id, reservation_id,
order_address, order_projection_id, order_revision, maker_order_pubkey,
author_pubkey, recipient_pubkey, sequence, previous_message_id,
previous_transcript_hash, sent_at, expires_at, terms_hash, body
```

`terms` is additionally required on `reserve_propose` and `reserve_accept`, and
MUST be absent on later messages. `message_id` is a lowercase UUIDv4 and an
application idempotency key. `session_id` is 32 random bytes in lowercase hex.
The first sequence is `"0"` and has null predecessors. Later messages MUST
increment monotonically and carry both the immediate predecessor message ID and
transcript hash.

The transcript hash after a rumor is:

```text
SHA256(
  UTF8("granola-transcript-v1\n") ||
  (previous_transcript_hash == null ? 32 zero bytes : HEX(previous_transcript_hash)) ||
  HEX(rumor_id)
)
```

An exact replay MAY return the already accepted result. A changed message under
an existing message, rumor, or seal ID MUST be rejected. Two valid successors
of the same transcript head are equivocation and MUST freeze the session.

## 6. Message registry and choreography

The registry of message `type` values is:

| Type | Direction / purpose | Bearer material permitted |
| --- | --- | --- |
| `reserve_propose` | taker session -> maker order key; request exact fill | keys and terms, no token |
| `reserve_accept` | maker order key -> taker session; accept and offer base/quote leg | one locked Cashu token in `base_lock` |
| `reserve_reject` | reserved control type; not accepted by the current atomic body validator | none |
| `session_ack` | taker session -> maker session; acknowledge accepted handoff | none |
| `base_lock` | sender -> counterparty; standalone base leg when used by choreography | one locked token |
| `base_lock_ack` | recipient -> sender; validate base leg | commitments only |
| `quote_lock` | taker session -> maker session; payment leg | one locked token |
| `quote_lock_ack` | recipient -> sender; validate quote leg | commitments only |
| `claim_notice` | maker session -> taker session; report quote claim | commitments only |
| `fill_request` | taker session -> maker session; report both verified spends | commitments only |
| `settlement_ack` | maker session -> taker session; acknowledge fill projection | commitments only |
| `ack` | reserved control type; transport ACKs are represented by relay/application receipts | none |
| `abort` | reserved control type; use the versioned recovery path below | none |
| `refund` | post-expiry recovery evidence | commitments only |
| `error` | terminal or retryable protocol error | code and IDs only |

The atomic body schema is exact: it MUST contain the schema field plus only the
fields defined for its message type. A Cashu token may appear only in a lock
body, remains encrypted in the private envelope, and MUST never enter logs or
public evidence.

The common DM type vocabulary retains `reserve_reject`, `ack`, and `abort` for
future versioned control bodies because they exist in historical ADRs and type
definitions. They are not in the current `ATOMIC_SWAP_MESSAGE_TYPES` registry
and a `cashu-testnet-v1` implementation MUST reject them as unsupported rather
than guessing a body shape. Use `error` for a typed protocol failure and the
durable order/recovery operations for release or abort evidence. A future
version MUST assign exact bodies before enabling these names.

The default v1 choreography is:

1. Taker validates the current public order and sends `reserve_propose` to the
   maker order key.
2. Maker validates the proposal, preflights both mints, reserves the exact
   amount in a new public projection, generates fresh session/Cashu/refund
   keys and an HTLC preimage, locks the maker-offered leg, then sends
   `reserve_accept`.
3. Taker validates the accepted projection, terms, deadline profile, keysets,
   and embedded maker lock before funding the counter-leg. It sends
   `quote_lock`.
4. Maker validates the quote lock and claims it with the preimage before its
   claim cutoff. It sends `claim_notice` when the claim evidence is committed.
5. Taker observes every quote proof through NUT-07, requires one identical
   witness preimage, verifies its SHA-256 hash, and claims the maker-offered
   leg with its settlement key. It sends `fill_request` after both spends are
   independently evidenced.
6. Maker verifies both legs and publishes the signed `filled` projection. It
   sends `settlement_ack` with the public fill projection and redacted
   commitments.

The registry also supports explicit `session_ack`, `base_lock`,
`base_lock_ack`, and `quote_lock_ack` stages for a choreography that persists
each acknowledgement separately. If that variant is selected, its exact
predecessor and choreography state MUST be persisted and validated; a receiver
MUST NOT accept an acknowledgement merely because it is well formed. The
current browser coordinator embeds the maker-offered lock in `reserve_accept`
and uses the shorter default path above. No private claim notice or peer
assertion substitutes for a mint observation.

## 7. Cashu settlement

Every reservation uses one fresh 32-byte preimage `P` and
`settlement_hash = SHA256(P)`. Each leg is a receiver-bound NUT-14 HTLC with:

- exact mint URL and active keyset ID;
- exact Cashu unit and positive amount;
- the shared settlement hash;
- the counterparty settlement public key as receiver;
- the sender's fresh refund public key;
- the accepted locktime and signature conditions.

One mint is valid when both legs use the same issuer. A cross-mint settlement
MUST use two distinct mint URLs and keysets, and each mint MUST independently
advertise and correctly implement NUT-07 and NUT-14, including retrieval of the
spent proof's preimage witness. Two wallets at one mint do not prove the
cross-mint case.

Before funding the counter-leg, the receiver MUST validate the first lock's
mint, unit, keyset, amount, hash, receiver/refund keys, locktime, DLEQ state when
advertised, duplicate proofs, fee-adjusted amount, and transcript commitments.
Every selected proof MUST be `UNSPENT`; `PENDING` or `SPENT` is not claimable.

After a spend, the observing party MUST verify every proof is `SPENT`, every
witness is present and well formed, all witnesses contain the same preimage,
and `SHA256(P)` equals the negotiated hash. Missing, mixed, malformed, or
mismatched witnesses are recovery failures, never authorization to claim or
publish fill.

### 7.1 Deadline profile

For the current testnet profile, after checking every participating mint clock
is within 30 seconds of local time:

```text
anchor                 = max(local, base-mint, quote-mint)
short_locktime         = anchor + 4 days
maker_claim_cutoff     = short_locktime - 120 seconds
long_locktime          = anchor + 7 days
taker_claim_cutoff     = long_locktime - 120 seconds
reservation_expires_at = anchor + 8 days
refund guard           = 60 seconds after locktime
```

The order expiry MUST cover the reservation recovery horizon. New claims MUST
not start at or after the relevant cutoff. Refunds MUST wait for a post-locktime
NUT-07 `UNSPENT` observation and the 60-second guard. Equality with a locktime
is not safe.

## 8. Lifecycle, persistence, and recovery

An implementation MUST persist the exact artifact before each external effect:

| Effect | Persist before effect | Commit after effect |
| --- | --- | --- |
| Nostr publication | exact signed event, target relays, IDs | receipts/readback |
| private delivery | exact wrapper, rumor/seal IDs, expiry, relays | relay receipts / app ACK |
| Cashu lock/claim/refund | prepared operation, exact expected HTLC, proof reservation | immutable mint result and wallet reconciliation |
| incoming message | raw wrapper and receive time | authenticated opened message and next state |

Retries MUST reuse the persisted artifact. A timeout or unknown network result
MUST NOT create a replacement event, token, key, or operation. A coordinator
step MUST perform at most one external effect between durable checkpoints.

Recovery rules:

- before either leg is locked: abort and release the reservation;
- after only the maker-offered leg is locked: maker refunds after the long
  locktime and guard;
- after both legs are locked without maker claim: taker refunds the quote after
  the short locktime and maker refunds the offer after the long locktime;
- after maker claim: taker keeps observing the quote witness and claims the
  offer before its cutoff; otherwise freeze/recover, never declare success; and
- a public fill or release is forbidden until the corresponding mint evidence is
  independently verified.

Disconnect, relay outage, mint outage, duplicate reservation, stale state,
expired message, or malformed evidence MUST fail closed. A session with a
contradiction or unresolvable evidence MUST enter `frozen`/terminal recovery,
not silently choose a winner.

## 9. Validation and security invariants

Every implementation MUST preserve these invariants:

1. Bind protocol/deployment version, network, order ID/address, projection ID
   and revision, reservation ID, session ID, expiry, exact terms, mint/keyset
   identities, and transcript predecessor to every private state transition.
2. Validate before commit: mint, unit, amount, keyset, lock, signature, proof
   state, witness, and exact public projection are checked before the next
   irreversible action.
3. Use fresh persisted per-reservation keys for bearer-material messages;
   order-authority keys are rendezvous/acceptance keys only.
4. Never expose an `nsec`, private key, spendable proof, encoded token, wallet
   backup, unreleased preimage, or raw private message in public events, logs,
   errors, fixtures, screenshots, analytics, or test traces.
5. Enforce exact idempotency and replay isolation for orders, reservations,
   messages, signatures, proofs, witnesses, and transcript heads.
6. Enforce single allocation and deterministic expiry boundaries.
7. Treat Nostr relay ACKs as delivery evidence only; treat mint state and
   witnesses as settlement authority.
8. Ensure every pre-commit path has a bounded refund/recovery path under the
   stated mint and clock assumptions.

## 10. Versioning and compatibility

The wire version is carried in order `v` tags, the `granola/order/v1` schema,
the `granola/dm/v1` schema, the deployment field, and the `v1` domain
separators. These identifiers MUST agree.

Patch releases MAY fix validation or implementation defects without changing
the canonical wire form. A protocol revision that changes field names, tag
sets, hashing domains, message choreography, settlement semantics, or security
assumptions MUST use a new versioned schema/address/domain and MUST NOT be
negotiated by ignoring unknown fields.

Implementations MUST reject unknown message types, body fields, tags, schemas,
deployments, mint units, and version values. There is no downgrade path to
NIP-04 or unwrapped private messages. A future protocol version may coexist in
the same relay network only if its address, tags, schema, and validation rules
are independently distinguishable.

## 11. SDK and browser boundary

`src/index.ts` is the public TypeScript entry point. It exports protocol models,
canonical pricing and hashing helpers, message/choreography validators, and the
high-level API ports/classes. Storage drivers, raw proof repositories, private
keys, UI components, and relay internals are not public SDK surface.

The browser demo exposes the same high-level surface as `window.granola` through
the `GranolaBrowserFacade` type in `src/sdk.ts`. Read methods return redacted
views. `createBackup()` is the sole deliberate bearer-material exception and
MUST be treated as a dangerous operation by callers. `advanceTrade()` performs
one durable coordinator action; callers MUST inspect its result and retry the
same session rather than constructing a new one.

## 12. Conformance and test vectors

A conforming implementation MUST provide deterministic vectors for:

- JCS serialization, terms hash, transcript hash, and order address;
- quote truncation, including 200 SAT at 4,950,000 cents/BTC = 9 cents;
- valid order projections and every invalid tag/state/revision case;
- valid and invalid NIP-17 outer wrapper, seal, rumor, recipient, signer,
  timestamp, expiry, size, and replay cases;
- every message body with unknown/missing fields rejected;
- one-mint and two-distinct-mint settlement terms and keysets;
- NUT-14 lock validation, duplicate proofs, wrong mint/unit/keyset/amount,
  pending/spent state, mixed witness, and wrong hash;
- deadline boundaries, refund guard, disconnect, relay/mint outage, duplicate
  reservation, and mid-swap abort; and
- crash/retry behavior proving the exact event/token/operation artifact is
  reused and no bearer material appears in the resulting trace.

Vectors MUST use placeholders or synthetic cryptographic values that cannot
spend real or testnet funds. A vector containing an encoded token, proof secret,
private key, or unreleased preimage is non-conforming unless it is deliberately
isolated as an encrypted local test fixture and never committed, logged, or
published. Each vector records its input, expected result or error code, wire
version, and whether it is positive or negative. See [`test-vectors/`](../test-vectors/)
and the JSON schemas in [`schemas/`](../schemas/).

## 13. Non-goals and background

This protocol does not provide formal forward secrecy, post-compromise
security, post-quantum security, relay availability, censorship resistance,
endpoint/XSS protection, mint honesty, or guaranteed deletion of relay data.
NIP-17 metadata is reduced, not eliminated.

The rationale and rejected alternatives remain in:

- ADR 0001: public Nostr order events;
- ADR 0002: ephemeral maker signing identity;
- ADR 0003: NIP-17 private swap messages;
- ADR 0004: one- or two-mint Cashu HTLC settlement; and
- ADR 0005: integer minor-unit pricing and truncated settlement.

When an ADR conflicts with this document, this document is the implementation
contract and the ADR is historical context.
