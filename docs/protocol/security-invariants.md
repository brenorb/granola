# Security invariants

These invariants define what the testnet proof of concept must demonstrate.
They are acceptance criteria, not claims about the current implementation.

1. **Mint topology.** A settlement may use one mint or two. An inter-mint test
   uses two distinct mint URLs and keysets; two wallets at one mint do not
   prove the inter-mint case.
2. **Term binding.** Signatures and private messages bind protocol version,
   network, order ID, session ID, the mint/keyset identity for each settlement
   leg, units, amounts, exact price representation, expiry, and the prior
   transcript hash.
3. **What-you-see-is-what-you-sign.** The wallet never signs terms different
   from the final human/agent-readable confirmation.
4. **Validate before commit.** A participant validates mint, unit, amount,
   lock, signature, and spend state before making its own leg claimable.
5. **Claim symmetry.** If one party successfully claims, that action gives the
   honest counterparty everything required to claim the other leg.
6. **Eventual recovery.** Before funds are committed, a valid timeout/refund
   path exists. Peer disconnect or mint recovery cannot create an indefinite
   lock without an explicit, bounded operational assumption.
7. **Replay isolation.** Reusing an order message, reservation, swap message,
   signature, proof, or transcript in another session is rejected.
8. **Explicit expiry.** Boundary behavior is deterministic; an expired order or
   reservation cannot start or complete a new settlement.
9. **Single allocation.** Concurrent reservations and partial fills cannot
   allocate more than the order's remaining amount.
10. **Bearer-secret containment.** Public events, logs, errors, screenshots,
    fixtures, analytics, and audit documents never expose spendable proofs,
    private keys, wallet backups, or an unreleased preimage.
11. **Verifiable evidence.** A completed test records public event IDs,
    signatures, relay acknowledgements, mint/keyset IDs, units, amounts,
    timestamps, hashes, and redacted state transitions without recording bearer
    secrets.

Minimum negative tests cover invalid and already-spent proofs, wrong mint/unit,
changed amount, replay, duplicate reservation, expiry boundaries, peer
disconnect, mint outage, and mid-swap abort.
