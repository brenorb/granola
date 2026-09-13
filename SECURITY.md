# Security policy

Granola is testnet-only software. Do not use real funds or real long-lived
identities with this repository.

## Reporting

Report a suspected vulnerability privately to the repository maintainer before
opening a public issue. Include the affected commit, impact, reproduction
steps, and whether any bearer material was exposed. Do not include spendable
tokens, proof secrets, private keys, wallet backups, or unreleased preimages in
the report.

## Security boundaries

The protocol depends on honest Cashu mints, NUT-07 witness retrieval, NUT-14
enforcement, relay availability, and a secure browser/runtime. It does not claim
formal forward secrecy, endpoint compromise resistance, or production custody
safety. See the [security invariants](docs/protocol/security-invariants.md) and
[protocol specification](docs/protocol%20spec%20v0.1.md).
