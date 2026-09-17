# ADR 0003: Private Nostr transport for swap sessions

- Status: accepted for the testnet prototype
- Date: 2026-07-23
- Updated: 2026-09-17

## Decision

Use the Granola NIP-17 profile: kind `14` rumors, NIP-44 v2 encryption,
sender-signed kind `13` seals, and kind `1059` gift wraps with fresh wrapper
keys. Persistent gift wraps allow a disconnected recipient to retrieve its
messages. No NIP-04 or unwrapped-message fallback is supported.

The [protocol specification](../protocol%20spec%20v0.1.md) owns the wire fields,
validation rules and message registry. This ADR records the reasons for the
transport and identity choices, rather than maintaining another wire spec.

## Three messages and separate identities

| Message | Author | Recipient |
| --- | --- | --- |
| `reserve_propose` | taker session key | maker order key |
| `reserve_accept`, including the maker's locked token | maker order key | taker session key |
| `quote_lock` | taker session key | maker session key |

Acceptance binds the fresh `maker_session_pubkey`, both Cashu keys, reservation,
exact reserve projection ID/revision, terms and transcript. There is no separate
`session_ack` in the default flow. Subsequent financial progress comes from
verified mint observations, not additional private acknowledgements.

The common envelope vocabulary still contains `reserve_reject`, `ack` and
`abort`, but the atomic body validator rejects them as unsupported. A stale or
competing proposal receives an order-authority-signed `error` with the signed
current projection and `preparing`/`changed` availability. The extended message
registry is not a requirement to add messages to the default three-message flow.

Each order has its own authority key; each reservation has independent Nostr,
Cashu receiver and refund keys. Keep session keys persisted through recovery.
After a terminal projection is acknowledged, remove its order key from the
active key store. Browser deletion does not guarantee physical erasure or
forward secrecy.

The September key-reuse experiment did not demonstrate the requested half-second
saving. Isolated warm key preparation saved about nine microseconds, before the
extra storage lookup. Keep reservation isolation; see the
[consolidated performance decisions](../performance/consolidation.md).

## Direct routes and discovery

Proposal and acceptance may include `response_relays`: one to three sorted,
unique normalized WSS URLs, authenticated by the message and bound to its
session/transcript. Valid signed order `inbox` tags supply the initial maker
route. Malformed optional order hints are ignored; malformed private route
fields fail message validation.

Start the receiving subscription as soon as the identity and route exist.
Direct routes take precedence over separate kind `10050` discovery. Their use
still requires authenticated capability and recipient-only relay probes.
Publish/read back inbox registrations in parallel through durable checkpoints.
An unsupported direct route falls back to validated signed-list discovery;
missing or invalid discovery state then fails closed.

A kind `10050` registration is signed by the exact receiving key, has empty
content, and carries one to three sorted, unique normalized `relay` tags.
Discovery checks signature, freshness and relay capabilities. Publication needs
an ACK and exact validated readback from the configured quorum (one by default).
Discovery uses the configured public relay list, not a fixed protocol relay count.

An inbox must advertise NIP-17, NIP-40 and NIP-42, require authentication, and
pass the recipient-only probe. Receiving AUTH uses the exact recipient key.
Sending AUTH normally uses the rumor author's protocol key, never the random
wrapper key or a social identity. Persisted non-financial refusal retries may
use a fresh transport AUTH key after order-key deletion; the sealed author
remains the order authority.

## Delivery and validation

Persist the exact encrypted wrapper, message/rumor/seal IDs, deadline and target
relays before sending. Retry the same artifact after an unknown result; do not
generate replacement keys or ciphertext. Relay receipts commit delivery progress,
not peer acceptance or settlement. The default flow has no application `ack`.

The pinned `nostr-tools@2.23.3` unwrap helper only decrypts. Granola separately
validates outer and seal signatures, kinds, exact tags, rumor hash, author and
recipient relationships, size, expiry, economic terms, sequence and transcript.
Messages use one shared transcript sequence, not independent directional counters.
An exact replay is idempotent; conflicting successors fail closed.

Wrapper expiration adds one to 24 whole hours of random padding to the encrypted
deadline. Clients enforce both deadlines locally. Seals have empty tags. The
client keeps its encrypted outbox/transcript instead of publishing a sender copy.

## Limits and rejected alternatives

Nostr coordinates the peers; mint state and witnesses decide settlement. Relays
can withhold, replay or retain ciphertext. NIP-17 reduces metadata exposure but
does not hide recipient, IP, AUTH identity, timing or message size from the relay.
It provides neither formal forward secrecy nor endpoint-compromise protection.

NIP-04, raw NIP-44/NIP-59, ephemeral kind `21059`, social keys and a shared order
identity across reservations do not satisfy the chosen privacy/recovery boundary.
MLS/Marmot adds group and key-management machinery that this two-party PoC does
not need. Relay expiry is advisory and cannot guarantee deletion.

Required negative coverage includes tampering at every envelope layer, wrong
recipient/author, replay, transcript forks, stale/expired routes, oversized
ciphertext, lost ACKs, wrong order/terms/keyset, and interrupted recovery.
Public events and diagnostics never contain locked tokens or private payloads.
