# Granola agent notes

- Historical event kind `8338` is context, not a standard. Protocol choices
  require an ADR and executable vectors.
- A cross-mint test is invalid unless mint URLs and keysets are distinct. For
  HTLC settlement, both mints must advertise and correctly implement NUT-07 and
  NUT-14, including retrieval of the spent proof's preimage witness.
- Use the order-authority key only for rendezvous and acceptance; use fresh,
  persisted per-reservation keys for bearer-material messages (ADR 0003).
- Bind each private message to protocol version, network, order ID, session ID,
  expiry, both mint/keyset identities, negotiated terms, and transcript hash.
- Never expose an `nsec`, private key, spendable proof, wallet backup, or
  unreleased preimage in commands, fixtures, logs, screenshots, or docs.
- Publish with test keys only; verify the signer first, then record relay URLs,
  acknowledgements, and event IDs.
- Negative tests must cover replay, expiry, wrong mint/unit, already-spent proof,
  duplicate reservation, disconnect, mint outage, and mid-swap abort.
- `nostr-tools@2.23.3` NIP-17 unwrap only decrypts; validate both signatures,
  both kinds, tags, rumor hash, recipient, and seal/rumor author match yourself.
