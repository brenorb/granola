# Granola documentation

## Recovered project context

- [Public history and academic follow-up](research/public-history.md)
- [Private-vault synthesis](research/vault-findings.md)
- [Interpretive expansion of the 2024 sequence](protocol/original-granola-sequence.md)
- [Security invariants for the new proof of concept](protocol/security-invariants.md)

## Testnet implementation

- [Browser agent API](guides/agent-api.md)
- [Testnet wallet notes](guides/testnet-wallet.md)

## Architecture decisions

- [ADR 0001: Nostr events for the Granola order book](adr/0001-nostr-order-events.md)

## Reading rule

The historical material is evidence of intent, not evidence that atomicity or
interoperability works. Normative decisions belong in ADRs and executable test
vectors. In particular, event kind `8338`, selected-mint support and behavior
for NUT-07/NUT-14, identity lifetimes, order replacement, partial fills, and DM
encryption remain open until their respective ADRs and tests are accepted.
