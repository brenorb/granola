# Contributing

1. Read the [protocol specification](docs/protocol%20spec%20v0.1.md) and
   [security invariants](docs/protocol/security-invariants.md).
2. Keep protocol changes minimal, typed, and covered by a focused test or safe
   deterministic vector.
3. Never commit private keys, spendable proofs/tokens, wallet backups,
   unreleased preimages, relay credentials, or raw private message payloads.
4. Run `npm test` and `npm run build` before opening a change.
5. If a wire field, tag, hash domain, message type, or settlement rule changes,
   update the normative spec, schemas, vectors, and changelog together.

Architecture decisions belong in `docs/adr/` as rationale. The normative
contract belongs in the protocol specification.
