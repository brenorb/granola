# ADR 0002: Ephemeral per-order Nostr signing keys

- Status: Accepted
- Date: 2026-07-23

## Context

An order projection is public and replaceable, so its author key is visible to
relays and order-book readers. Reusing one profile key would link every order
and every lifecycle update. A social Nostr key would additionally link trading
to a person's public identity.

## Decision

Granola generates one random secp256k1 key for each order ID. The key is stored
in the profile's private IndexedDB store only while that order is active. Every
projection update and the maker's `reserve_accept`/`reserve_reject` message is
signed with that order's key. A new order always gets a new key.

After a terminal projection (`filled`, `canceled`, or `expired`) has been
persisted and acknowledged by at least one configured public relay, Granola
deletes that order's private Nostr key. If the key is absent, operations for
that order fail closed rather than silently creating a new authority.

Cashu wallet and refund keys are independent and continue using their existing
lifetimes; rotating a Nostr order key never changes Cashu keys. Legacy
profile-level Nostr identity records are deleted on migration and are not used
to sign new orders.

## Consequences

- Orders from one profile are unlinkable by Nostr author key.
- Reloads retain authority for active orders through encrypted private storage.
- Completing an order has a cryptographic erasure point for its Nostr key.
- Losing the profile loses control of active orders; Cashu recovery remains a
  separate concern.
- The browser threat boundary still includes the private IndexedDB store.

## Rejected alternatives

1. A persistent profile key, because it links orders.
2. A social Nostr key, because it links trading to social identity.
3. A memory-only key, because reloads would orphan active orders.
4. Deriving Nostr keys from Cashu secrets, because the security domains and
   lifetimes must remain independent.
