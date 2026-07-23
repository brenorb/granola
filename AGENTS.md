# Granola agent notes

- Settlements may use one mint or two. A cross-mint test requires distinct mint
  URLs and keysets. Every participating mint must advertise and correctly
  implement NUT-07 and NUT-14, including retrieval of the spent proof's
  preimage witness.
- Use the order-authority key only for rendezvous and acceptance; use fresh,
  persisted per-reservation keys for bearer-material messages (ADR 0003).
- Bind each private message to protocol version, network, order ID, session ID,
  expiry, the mint/keyset identity for each settlement leg, negotiated terms,
  and transcript hash.
- Never expose an `nsec`, private key, spendable proof, wallet backup, or
  unreleased preimage in commands, fixtures, logs, screenshots, or docs.
- Publish with test keys only; verify the signer first, then record relay URLs,
  acknowledgements, and event IDs.
- Negative tests must cover replay, expiry, wrong mint/unit, already-spent proof,
  duplicate reservation, disconnect, mint outage, and mid-swap abort.
- `nostr-tools@2.23.3` NIP-17 unwrap only decrypts; validate both signatures,
  both kinds, tags, rumor hash, recipient, and seal/rumor author match yourself.
- Granola is privacy-first: use ephemeral per-reservation keys and Cashu's
  blinded-signature model so relays and counterparties learn as little as the
  protocol requires.
- Public Nostr data is an ephemeral order-book rendezvous, not a transaction
  ledger. Do not add receipt histories, bearer material, payment proofs,
  preimages, or unnecessary identity/linkability metadata to public events.
