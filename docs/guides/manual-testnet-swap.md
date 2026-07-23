# Manually reproduce the Granola testnet swap

This tutorial reproduces the demonstrated happy path: one browser profile sells
20 fake testnet SAT for one USD cent held by a second profile. The result has no
monetary value.

Allow 10–20 minutes. Use a desktop browser with IndexedDB, Web Locks, WebSocket,
and developer tools enabled. Keep both pages open throughout the swap.

## Before you start

Open these in two tabs or windows:

- Maker: <https://brenorb.com/granola/?wallet=maker-tutorial>
- Taker: <https://brenorb.com/granola/?wallet=taker-tutorial>

Confirm the header says `Wallet profile: maker-tutorial` in one and
`Wallet profile: taker-tutorial` in the other. Each name selects an isolated
local wallet. Do not open a second tab with either exact profile name.

If you already used these profiles, choose a new lowercase suffix in both URLs,
such as `maker-tutorial-2` and `taker-tutorial-2`. Absolute balances depend on
what that profile already holds, so a fresh pair is easier to verify.

The fake mint quote remains visible after issuance and contains an invoice.
Do not include that panel in screenshots or a public trace. Never publish a
bearer backup, encoded Cashu token, proof, private key, preimage, or witness.

## 1. Give the maker 100 SAT

On the maker page, find **Mint fake tokens** and set:

| Control | Value |
| --- | --- |
| Test mint | `Testnut / fee test` |
| Unit | `SAT` |
| Minor units | `100` |

Press **Request & claim quote**. Granola requests the fake invoice and polls the
mint automatically. Wait for `100 sat · ISSUED`, then confirm **Balances &
liabilities** shows 100 SAT. This can take up to one minute.

## 2. Give the taker USD 0.10

On the taker page, set:

| Control | Value |
| --- | --- |
| Test mint | `Testnut / no fee` |
| Unit | `USD` |
| Minor units | `10` |

Press **Request & claim quote**. For Cashu USD, `10` minor units means USD 0.10.
Wait for `0.10 USD · ISSUED` and confirm the wallet balance.

## 3. Publish the 20 SAT ask

On the maker page, expand **Publish a test limit order** and enter:

| Control | Value |
| --- | --- |
| Side | `Sell SAT` |
| Size (SAT) | `20` |
| Limit price (USD / BTC) | `50000.00` |
| Good for (days) | `30` |
| Execution | `All or none` |

Leave **Minimum fill (SAT)** disabled. Press **Sign & publish order**.

Publication is deliberately durable and staged. If **Pending relay publication**
appears:

1. Press **Retry same signed projection** for this newest order.
2. Wait for at least one relay acknowledgement.
3. Press **Retry same signed projection** once more to commit the acknowledged
   projection locally.

Do not submit a second order. Continue only when the pending entry disappears.
Press **Refresh book** and find the row with all of these values:

- `20 SAT`;
- `50,000.00 USD/BTC`;
- `All or none`; and
- an expiry about 30 days from now.

It will normally be at the top ask price, although other public test orders can
tie it.

## 4. Start the maker inbox

After the order is published, press **Enable maker inbox · offline** on the
maker page. Wait until the button reads **Enable maker inbox · listening**.
Granola now registers and listens with this order's ephemeral Nostr key. Keep
the page open; after a reload, enable it again for each active order.

## 5. Take the ask

On the taker page, press **Refresh book**. In the matching row, leave the action
amount at `20` and press **Take ask**.

Wait for:

- the status `Swap session persisted; advance one verified action at a time`;
  and
- a taker session card starting at **Negotiating**.

The taker still needs to advance once or start the automatic executor before
the maker can receive the reservation proposal. Do not take a second order.

## 6. Settle the same session

### Recommended fast demo

This uses the public, secret-free coordinator API from developer tools. It
still executes every persisted one-action checkpoint; it only removes the need
to click dozens of times.

Open the taker page's developer console and run:

```js
window.granola.listTrades().then((trades) =>
  window.granola.runUntilSettled(trades.at(-1).sessionId)
)
```

Leave that promise running. On the maker page, wait briefly, then press
**Check sessions** until the matching maker card appears. Open the maker
developer console and run the same command:

```js
window.granola.listTrades().then((trades) =>
  window.granola.runUntilSettled(trades.at(-1).sessionId)
)
```

Both calls run concurrently. Each should eventually resolve with
`finalPhase: "filled"` and a redacted list containing only role, phase, and
revision checkpoints.

### UI-only fallback

If you do not want to use developer tools, use **Advance safely** on the two
session cards:

1. Press **Advance safely** on the taker.
2. Wait briefly and press **Check sessions** on the maker until its card
   appears.
3. Press **Advance safely** on the side that can act.
4. If a side reports `No private trade message is available` or
   `No next private trade message is available`, switch to the other page.
5. Periodically press **Check sessions** on both pages.

Each press performs at most one durable coordinator action, and a live private
message can wake another action. There is intentionally no fixed click count.
The visible happy-path phases are:

```text
Negotiating → Reserved → Base locked → Quote locked
→ Quote claimed → Base claimed → Filled
```

The pages can briefly show adjacent phases. Stop only after both cards say
**Filled** and both **Advance safely** buttons are disabled.

Under the signed settlement plan, the quote HTLC uses a 4-day short lock, the
base HTLC uses a 7-day long lock, and the reservation recovery horizon is
8 days.

## 7. Verify the result

Press **Refresh** in both wallets and **Refresh book** on the taker.

For fresh profiles funded exactly as above, expect approximately:

| Profile | Before | Expected after |
| --- | --- | --- |
| Maker | 100 SAT | 78 SAT + USD 0.01 |
| Taker | USD 0.10 | 20 SAT + USD 0.09 |

The SAT total can differ if the test mint changes its input fee or proof
selection. Verify the value movement rather than assuming an absolute total:

- maker gained one USD minor unit and spent 20 SAT plus the SAT mint fee;
- taker spent one USD minor unit and gained 20 SAT;
- both session cards say **Filled**; and
- the exercised 20 SAT order disappears from the refreshed order book.

The recorded demonstration used a pre-funded maker and observed
`56 SAT → 34 SAT + USD 0.01`; the 2 SAT difference beyond the trade amount was
the fee-bearing SAT mint path.

## If a relay fails

The demonstrated run encountered transient errors including `connection
failed`, `relay connection closed`, unavailable inbox relays, and missing inbox
discovery. These do not require a replacement trade.

1. Do not create another order or session.
2. Do not erase either wallet.
3. Keep or reopen the same `?wallet=` profile.
4. If the maker page reloaded, press **Enable maker inbox** again.
5. Press **Check sessions** and resume the same cards.
6. For the fast demo, run the same `runUntilSettled` command again only on the
   side whose promise rejected.

Granola reuses the persisted signed Nostr projection and prepared Cashu operations.
A simple peer-wait message is not a failure: advance the other side and retry
after a short pause.

## What to record

A useful secret-free manual trace contains:

- UTC start and completion times;
- deployed commit, if known;
- only a truncated session or reservation prefix;
- both profile names;
- mint URLs and units;
- 20 SAT, one USD minor unit, USD 50,000/BTC, all-or-none, and 30-day order
  lifetime;
- the 4-day, 7-day, and 8-day timing profile;
- visible phase progression;
- before and after aggregate balances; and
- confirmation that the filled order left the book.

Do not record invoices, bearer tokens or backups, proofs, curve points,
preimages, witnesses, private keys, mint quote IDs, private NIP-17 event IDs,
or raw encrypted messages.

Compare your result with the
[recorded real swap](../traces/2026-07-23-testnet-swap.md).
