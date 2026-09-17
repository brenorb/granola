# Granola documentation

## Protocol reference

- [Protocol specification v0.1](protocol%20spec%20v0.1.md)
- [Security invariants](protocol/security-invariants.md)

## SDK

- [SDK boundary and browser facade](guides/sdk.md)

## Testnet implementation

- [Manual shared-page testnet swap](guides/manual-testnet-swap.md)
- [Browser agent API](guides/agent-api.md)
- [Testnet wallet notes](guides/testnet-wallet.md)
- [NIP-17 coordination latency](performance/nip17-latency.md)
- [Consolidated performance decisions and experiment disposition](performance/consolidation.md)
- [Asynchronous settlement and durable announcements](protocol/async-settlement.md)

## Architecture decisions

The ADRs are background rationale; the normative implementation contract is the
[protocol specification v0.1](protocol%20spec%20v0.1.md).
Current-facing ADRs and guides were reviewed against main on 2026-09-17.
Date-stamped performance and maintenance reports describe their recorded builds;
use the consolidated performance decisions for their current disposition.

- [ADR 0001: Nostr events for the Granola order book](adr/0001-nostr-order-events.md)
- [ADR 0002: Ephemeral per-order Nostr signing keys](adr/0002-maker-signing-identity.md)
- [ADR 0003: Nostr private swap messages](adr/0003-nostr-private-swap-messages.md)
- [ADR 0004: One- or two-mint settlement with staggered Cashu HTLCs](adr/0004-cashu-htlc-settlement.md)
- [ADR 0005: Integer cents-per-BTC pricing and truncated settlement](adr/0005-quote-minor-unit-settlement.md)
