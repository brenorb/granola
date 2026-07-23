# Granola

Granola is an experimental protocol for peer-to-peer atomic swaps of Cashu
ecash issued by one or two mints. Two mints are the general inter-mint case;
one mint is also valid. Nostr provides discovery and private coordination;
Cashu mints provide issuance and settlement.

This repository starts from the 2024 SatsHack design, but does not treat that
prototype as a production-ready protocol. The recovered design, unresolved
security assumptions, and research sources are indexed in [docs/](docs/).

> **Status:** research and testnet proof of concept. Do not use real funds.

## Testnet wallet

The static wallet runs entirely in the browser with `@cashu/cashu-ts`. It can
mint fake Testnut `sat` and `usd` tokens, receive encoded Cashu tokens, show
balances by unit and mint, download explicit bearer backups, and expose the same
operations to agents through `window.granola`.

The page also verifies and displays a public, issuer-specific SAT/USD Nostr
order book with an exchange-style best bid, best ask, and spread. Test makers
can sign and publish exact-rational limit orders through the UI or agent API.

```bash
npm ci
npm test
npm run dev
```

Open `http://localhost:5173/`. One page supports both sides of the exchange:
publishing an order creates an ephemeral maker role for that order, while
taking an order creates an ephemeral taker session. The same browser wallet can
hold both roles concurrently without a reload. The optional `?wallet=<name>`
query is only a local storage namespace for isolated test fixtures; it does not
select a maker or taker role. Follow the
[manual shared-page testnet tutorial](docs/guides/manual-testnet-swap.md) to
reproduce the demonstrated swap. The
[agent API](docs/guides/agent-api.md) documents exact amounts, trust prompts,
and the methods that can return bearer material.

Production builds use `npm run build` and write the static site to `dist/`.
