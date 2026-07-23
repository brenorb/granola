# Manually reproduce the Granola testnet swap

This tutorial reproduces the demonstrated happy path: one browser wallet sells
20 fake testnet SAT for one USD cent while a second browser wallet takes the
order. The result has no monetary value.

Allow 10–20 minutes. Use a desktop browser with IndexedDB, Web Locks, WebSocket,
and developer tools enabled. Keep both pages open throughout the swap.

## Before you start

Open the shared site in two tabs or windows when testing two local wallets:

- Maker wallet: <https://brenorb.com/granola/?wallet=maker-tutorial>
- Taker wallet: <https://brenorb.com/granola/?wallet=taker-tutorial>

The `wallet` query is only an optional local storage namespace for this
two-wallet fixture. It does not put the page into a maker or taker mode. On one
page, the user can publish orders and take other orders at the same time.

If you already used these workspaces, choose a new lowercase suffix in both URLs,
such as `maker-tutorial-2` and `taker-tutorial-2`. Absolute balances depend on
what each local wallet already holds, so a fresh pair is easier to verify.

The quick funding actions at the top issue 10,000 minor units: 10,000 SAT or
100.00 USD. Never publish a bearer backup, encoded Cashu token, proof, private
key, preimage, or witness.

## 1. Fund the maker with SAT

On the maker wallet tab, press **Fund SAT**. Granola requests the fake invoice
and polls the mint automatically. Wait for the success notice, then confirm
**Balances & liabilities** shows 10,000 SAT. This can take up to one minute.

## 2. Fund the taker with USD

On the taker wallet tab, press **Fund USD**. Wait for the success notice and
confirm **Balances & liabilities** shows 100.00 USD.

## 3. Publish the 20 SAT ask

On the maker wallet tab, expand **Publish a test limit order** and enter:

| Control | Value |
| --- | --- |
| Side | `Sell SAT` |
| Size (SAT) | `20` |
| Limit price (USD / BTC) | `50000.00` |
| Good for (days) | `30` |
| Execution | `AON` (all or none) |

The browser form publishes all-or-none orders. Press **Send order**.

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
- `AON`; and
- an expiry about 30 days from now.

It will normally be at the top ask price, although other public test orders can
tie it.

## 4. Let the maker listener start automatically

After the order is published, the same page automatically registers and listens
with the order's ephemeral Nostr key. The listener starts automatically; no
manual sync action, page reload, or role switch is required. If startup fails,
the page retries with bounded backoff until the relay is available.

## 5. Take the ask

On the taker wallet tab, press **Refresh book**. In the matching row, leave the action
amount at `20` and press **Take ask**. Granola now runs the verified coordinator
actions automatically; do not click the button again.

Wait for:


- the status `Order taken; settling automatically`;
- the status `Swap filled after … verified checkpoints`; and
- both session cards eventually showing **Filled**.

Every coordinator checkpoint still runs and is recorded in the protocol trace.

## 6. Verify the result

The visible happy-path phases are:

```text
Negotiating → Reserved → Base locked → Quote locked
→ Quote claimed → Base claimed → Filled
```

The pages can briefly show adjacent phases. Stop only after both cards say
**Filled**.

Under the signed settlement plan, the quote HTLC uses a 4-day short lock, the
base HTLC uses a 7-day long lock, and the reservation recovery horizon is
8 days.

Press **Refresh** in both wallets and **Refresh book** on the taker.

For fresh workspaces funded exactly as above, expect approximately:

| Wallet | Before | Expected after |
| --- | --- | --- |
| Maker | 10,000 SAT | approximately 9,980 SAT + USD 0.01 |
| Taker | USD 100.00 | 20 SAT + USD 99.99 |

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
3. Keep or reopen the same `?wallet=` workspace.
4. If the maker tab reloaded, wait for the automatic maker listener startup.
5. Keep the same workspace open while the automatic executor resumes every
   active persisted session.

Granola reuses the persisted signed Nostr projection and prepared Cashu operations.
A reload or incoming DM wakes the full settlement loop from its durable phase;
it does not require stepping through checkpoints. A simple peer-wait message is
not a failure: keep both workspaces open and let the automatic executor retry
after a short pause.

## What to record

A useful secret-free manual trace contains:

- UTC start and completion times;
- deployed commit, if known;
- only a truncated session or reservation prefix;
- both workspace names;
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
