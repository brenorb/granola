# ADR 0002: Local maker signing identity

- Status: Accepted
- Date: 2026-07-23

## Context

Every public order transition is authorized by its Nostr event key. The same
key must remain available to reserve, fill, cancel, or replace that order after
a page reload. Reusing a person's social Nostr identity would unnecessarily
link trading activity to their public profile, while a memory-only key would
orphan every open order when the tab closes.

## Decision

Granola creates one random secp256k1 signing key for each local wallet profile.
It stores that key in the profile's private IndexedDB store and reuses it until
the user explicitly destroys the maker identity.

The key is a protocol identity, not a social identity:

- the UI and default agent API expose only its public key;
- logs, traces, fixtures, exports, screenshots, and Nostr events never contain
  the secret key;
- creating the key is serialized by the profile's existing Web Lock;
- clearing Cashu tokens does not clear the maker identity, because doing so
  would remove the authority needed to close open orders;
- destroying an identity is a separate, explicit operation which must warn that
  its open orders will become unmanageable; and
- a new wallet profile receives an unlinkable key and separate token storage.

The prototype does not accept a browser extension signer or a user's existing
Nostr key. A future signer interface may add those choices without changing the
event schema, but it must make the linkage and availability trade-offs explicit.

## Why

This is the smallest design that preserves order authority across reloads while
avoiding automatic linkage to a person's broader Nostr activity. IndexedDB has
the same XSS trust boundary as the Cashu bearer proofs already held by the app,
so a separate social identity would not improve the prototype's browser threat
model.

The identity is per profile rather than per order so the browser can reliably
manage all orders it created without maintaining an additional secret-key index.
Users who need unlinkability can use separate profiles.

## Consequences

- A lost browser profile loses control of its still-open orders.
- XSS can steal both tokens and the maker key; the strict CSP and dependency
  pinning therefore remain security controls, not cosmetic hardening.
- Public orders from one wallet profile are linkable by maker public key.
- Cashu wallet backups do not silently become Nostr secret-key exports.

## Rejected alternatives

1. **Reuse a social Nostr key.** Rejected because it links trading and social
   identities and requires a signer-extension dependency for the basic demo.
2. **One memory-only key per page load.** Rejected because reloads orphan open
   orders and make cancel or replace impossible.
3. **One key per order.** Rejected for the prototype because securely indexing,
   retaining, and backing up many authorities adds complexity without improving
   the default single-profile workflow.
4. **Derive the key from Cashu proofs.** Rejected because proofs rotate and are
   bearer secrets; derivation would couple unrelated security domains.
