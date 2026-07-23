# NIP-17 inbox capability probe — 2026-07-23

This trace records a disposable two-key probe of the private relay selected for the Granola testnet demonstration. All keys were generated for the probe and discarded when the process exited. No Cashu token, proof, witness, preimage, private key, or private trade message is recorded here.

## Relay advertisement

- Relay: `wss://auth.nostr1.com`
- NIP-11 fetched from: `https://auth.nostr1.com`
- Software: `strfry v315-3cff8c9`
- Advertised NIPs relevant to Granola: 17, 40, 42
- `limitation.auth_required`: `true`
- Payment required: `false`

## Probe attempts

Two initial attempts failed closed before any result was accepted:

1. Publishing immediately after setting `onauth` was rejected with `auth-required`. The relay's challenge arrived during connection establishment, before the callback was installed.
2. Calling `Relay.auth()` immediately after connection returned `no challenge was received`. The connection promise can settle before the challenge frame arrives.

The adapter was changed under a regression test to wait for a delayed challenge, sign NIP-42 with the exact protocol key, await the AUTH acknowledgement, and only then publish or query.

## Passing probe

- Checked at: `2026-07-23T02:43:47Z`
- Ephemeral recipient public key: `0248df5f5081de1ce5f15f8fe288db0e54cf66eb76deb416196276fea9e5abc8`
- Kind 10050 event: `5acd9036d75759d493862aedcb35f52c26fbd6b12e093c6d4e053eca2c2510a9`
- Kind 1059 gift-wrap event: `13c9218ba4e0d3d342d822a90f733dd187860d2abb64adeeffe2d0c9efff6482`
- Inbox-list exact-ID readback with recipient AUTH: pass
- Gift-wrap exact-ID readback with recipient AUTH: pass
- Same gift-wrap query using a different authenticated key returned no event: pass

The relay therefore passed the ADR 0003 recipient-only live check at the stated time. This is a time-bounded capability observation, not a guarantee of future availability, deletion, privacy, or correct behavior.

## Reproduction

Run `npm run probe:inbox`. The command creates new disposable keys and events on every run and prints only public IDs and boolean results.
