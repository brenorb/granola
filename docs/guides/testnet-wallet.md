# Testnet wallet notes

Granola’s browser wallet is a test harness, not a production wallet.

- `https://testnut.cashu.space` is the default fake mint and advertises BOLT11
  issuance for `sat` and `usd`.
- `https://nofee.testnut.cashu.space` is the no-fee test alternative.
- The public build rejects every other mint before network access; this fixed
  allowlist matches its Content Security Policy.
- Tokens are unbacked and have no monetary value.
- `eur` balances can be displayed and imported when a token uses that unit,
  but neither configured faucet advertised EUR issuance during the live check.
- A mint’s active keysets do not prove that a unit is mintable. Granola reads
  the NUT-04 method/unit list and its minimum/maximum amounts.
- Browser data is local. Clearing site data destroys any proofs not copied into
  a bearer backup.
- When Web Locks is unavailable, Granola uses a single-tab fallback so wallet
  actions still work. Do not open the same wallet profile in another tab until
  Web Locks is available; cross-tab serialization cannot be provided by the
  fallback.
- A crash after a mint accepts outputs but before IndexedDB saves them can lose
  fake proofs. This prototype does not claim crash-safe issuance.

Use `?wallet=maker` and `?wallet=taker` for two isolated actors. Use a browser
with Web Locks for workflows that open the same profile in multiple tabs.
