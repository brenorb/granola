# Browser agent API

The static app exposes the same wallet used by the human interface as
`window.granola`. It is intentionally small. Read methods return summaries;
bearer secrets are returned only by the explicitly dangerous backup method.

## Isolated test actors

Choose a local wallet profile with the URL query parameter:

```text
https://brenorb.github.io/granola/?wallet=maker
https://brenorb.github.io/granola/?wallet=taker
```

Profile names are 1–32 lowercase letters, numbers, or hyphens. Each profile
gets a separate IndexedDB database. Mutations sharing a profile are serialized
with the Web Locks API.

## Methods

```ts
const state = await window.granola.getState();
const mint = await window.granola.inspectMint("https://testnut.cashu.space");
const token = window.granola.inspectToken("cashuB...");

const quote = await window.granola.requestMint({
  mintUrl: "https://testnut.cashu.space",
  unit: "sat",
  amount: "100"
});
const next = await window.granola.claimMint(quote.ref);

await window.granola.receiveToken("cashuB...");
await window.granola.receiveToken("cashuB...", { acceptMint: true });

const backup = await window.granola.createBackup();
await window.granola.clearWallet("DELETE TEST WALLET");
```

Amounts are canonical integer strings in the Cashu unit’s minor denomination:
`sat` is satoshis, `usd` and `eur` are cents, and `btc` has eight decimals.
Never convert these strings through JavaScript `number` when exactness matters.

`getState()` reports totals by unit and pockets by mint/unit, including proof
counts, denominations, and keyset IDs. It never returns proof secrets, curve
points, encoded tokens, or mint quote IDs. A returned quote has a local `ref`;
use that reference with `claimMint`.

`createBackup()` is the deliberate exception: its encoded tokens are spendable
bearer instruments. Do not log, paste, publish, or commit its return value.

## Fake mint behavior

The default Testnut mints automatically mark fake BOLT11 quotes paid. Call
`claimMint(ref)` until the public quote state is `ISSUED`; one-second polling
with a bounded timeout is sufficient for tests. An unpaid result changes no
wallet balance.

The app trusts the two configured Testnut hosts by default. Receiving from any
other mint requires `{ acceptMint: true }` so automation cannot silently add a
new issuer liability.
