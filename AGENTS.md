# Granola agent notes

- Historical event kind `8338` is context, not a standard. Protocol choices
  require an ADR and executable vectors.
- A cross-mint test is invalid unless mint URLs and keysets are distinct. For
  HTLC settlement, both mints must advertise and correctly implement NUT-07 and
  NUT-14, including retrieval of the spent proof's preimage witness.
- Treat order authorization and private-session identity lifetimes as an open
  design decision; resolve them in an ADR before implementation.
- Bind each private message to protocol version, network, order ID, session ID,
  expiry, both mint/keyset identities, negotiated terms, and transcript hash.
- Never expose an `nsec`, private key, spendable proof, wallet backup, or
  unreleased preimage in commands, fixtures, logs, screenshots, or docs.
- Publish with test keys only; verify the signer first, then record relay URLs,
  acknowledgements, and event IDs.
- Negative tests must cover replay, expiry, wrong mint/unit, already-spent proof,
  duplicate reservation, disconnect, mint outage, and mid-swap abort.
