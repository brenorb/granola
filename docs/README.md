# Granola documentation

## Recovered project context

- [Public history and academic follow-up](research/public-history.md)
- [Private-vault synthesis](research/vault-findings.md)
- [Interpretive expansion of the 2024 sequence](protocol/original-granola-sequence.md)
- [Security invariants for the new proof of concept](protocol/security-invariants.md)

## Testnet implementation

- [Manual two-profile testnet swap](guides/manual-testnet-swap.md)
- [Browser agent API](guides/agent-api.md)
- [Testnet wallet notes](guides/testnet-wallet.md)
- [NIP-17 inbox capability probe](traces/2026-07-23-inbox-probe.md)
- [Real two-profile swap trace](traces/2026-07-23-testnet-swap.md)

## Architecture decisions

- [ADR 0001: Nostr events for the Granola order book](adr/0001-nostr-order-events.md)
- [ADR 0002: Separate maker signing identity](adr/0002-maker-signing-identity.md)
- [ADR 0003: Nostr private swap messages](adr/0003-nostr-private-swap-messages.md)
- [ADR 0004: Two-mint settlement with staggered Cashu HTLCs](adr/0004-cashu-htlc-settlement.md)
- [ADR 0005: Preserve base amount and truncate fractional quote units](adr/0005-quote-minor-unit-settlement.md)

## Reading rule

The historical material is evidence of intent, not evidence that atomicity or
interoperability works. Normative decisions belong in ADRs and executable test
vectors. In particular, event kind `8338`, selected-mint support and behavior
for NUT-07/NUT-14, identity lifetimes, order replacement, partial fills, and DM
encryption remain open until their respective ADRs and tests are accepted.
