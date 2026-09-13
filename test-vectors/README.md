# Test vectors

Committed vectors are deterministic, redacted, and safe to publish. They must
never contain spendable Cashu tokens, proof secrets, private keys, wallet
backups, or an unreleased HTLC preimage.

Each vector records `vector_id`, `protocol_version`, `kind` (`positive` or
`negative`), canonical input, and either the expected output or the expected
validation error. Required coverage is defined in [the protocol spec](../docs/protocol%20spec%20v0.1.md).

The first checked-in vector is [`pricing-v1.json`](pricing-v1.json). Cryptographic
envelope vectors should be added from deterministic synthetic fixtures before a
mainnet release.
