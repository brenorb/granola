# Browser agent API

The static app exposes the same wallet used by the human interface as
`window.granola`. It is intentionally small. Read methods return summaries;
bearer secrets are returned only by the explicitly dangerous backup method.

## Isolated test actors

Choose a local wallet profile with the URL query parameter:

```text
https://brenorb.com/granola/?wallet=maker
https://brenorb.com/granola/?wallet=taker
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

const identity = await window.granola.getMakerIdentity();
const { book, rejected } = await window.granola.getOrderBook();
const publication = await window.granola.publishOrder({
  side: "sell",
  amount: "2000", // base SAT
  price: { numerator: "101", denominator: "2000" }, // USD cents / SAT
  execution: "all_or_none"
});

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

`getMakerIdentity()` returns only the profile's public protocol key. The secret
signing key remains in the private IndexedDB store and is never exposed by this
API. `publishOrder()` signs an immutable kind `78` transition before a kind
`30078` current projection and requires two relay acknowledgements at each
stage. Its return value contains public event IDs and per-relay receipts, never
key material. `getOrderBook()` verifies signatures and schema, rejects
conflicting projections, and returns exact rational prices.

The prototype market is issuer-specific: SAT from
`https://testnut.cashu.space` against USD cents from
`https://nofee.testnut.cashu.space`. `amount` is always base SAT. For a buy,
the offered asset is USD; for a sell, it is SAT. The human form accepts USD/BTC
and converts it to the exact cents/SAT ratio used by the agent API.

## Fake mint behavior

The default Testnut mints automatically mark fake BOLT11 quotes paid. Call
`claimMint(ref)` until the public quote state is `ISSUED`; one-second polling
with a bounded timeout is sufficient for tests. An unpaid result changes no
wallet balance.

The public app has a fixed network allowlist matching its Content Security
Policy: `https://testnut.cashu.space` and
`https://nofee.testnut.cashu.space`. `inspectMint`, `requestMint`, and
`receiveToken` reject every other issuer before making a network request.
Nostr connections are likewise limited to `wss://nos.lol`,
`wss://relay.primal.net`, and `wss://offchain.pub`. All three advertise NIP-40
retention support; the client still validates both NIP-78 event classes through
acknowledgement and readback because relay capability metadata can be incomplete.
