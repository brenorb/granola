# Granola user-facing inventory and acceptance criteria

Scope: every user-facing route, role, control, input, dialog, state and
workflow of the static testnet page (`index.html` + `src/main.ts`) and its
`window.granola` agent facade. Each item has acceptance criteria (AC) and a
finite, risk-ranked list of edge cases (EC). IDs are referenced by the
[bug log](bug-log.md) and the [QA run record](2026-11-05-run.md).

Risk: **H** = funds, privacy or market correctness; **M** = a workflow can
stall or mislead; **L** = cosmetic or copy.

## Roles

| Role | How a user gets it | Can do |
| --- | --- | --- |
| Visitor | Opens the page; no funds yet | Read book, fund test ecash, read protocol |
| Maker | Publishes an order from the form | Post, cancel, auto-accept takers, settle |
| Taker | Clicks Buy/Sell on another maker's row | Reserve, lock payment, settle |
| Workspace user | `?wallet=<name>` | Separate local wallet namespace in the same browser |
| Agent | `window.granola`, DOM event, `?runUntilSettled=` | Same operations without UI, redacted output |

One page carries maker and taker roles at once; there is no role switch.

## Routes and URL parameters

| ID | Route | AC | EC (risk) |
| --- | --- | --- | --- |
| R1 | `/granola/` | Loads under the deployed CSP with no CSP violations; default wallet label "Local browser wallet" | Cold load with relays down (M) |
| R2 | `?wallet=<name>` | Valid name (1–32 of `a-z 0-9 -`) opens that workspace and labels it | Uppercase, too long, URL-encoded space: page must explain the error, not go blank (M) |
| R3 | `http://` on a non-local host | Redirects to `https://` before the wallet loads | Redirect must not violate CSP (M) |
| R4 | `?debug=performance` | Enables the timing overlay only; no behavior change | — |
| R5 | `?runUntilSettled=<session>` | Sets `data-granola-run-status` to `running` → `filled`/`error` | Non-hex ID and unknown ID set a clear error (L) |
| R6 | Unknown path | 404 from the host | — |

## Features, controls and states

### F1 Masthead and status toast

- AC: wordmark links home; testnet badge always visible; profile label shows
  the active workspace. Every async action ends in exactly one truthful status:
  success styling only for success, error styling for failures.
- EC: status replaced by an unrelated later message (M); success text for a
  failed or partial outcome (M).

### F2 Public order book (`#orderbook`)

Controls: **Refresh orders**, per-row take amount input, **Buy**/**Sell**,
order info `i` popover (execution, expiry, order ID, **Cancel order** on own
orders), **See more/See less** per side.
States: loading, error (no book yet), empty, ready, stale-after-failure.

- AC1: shows every open, unexpired, verified order for the SAT/USD issuer
  pair; best ask is the lowest ask, best bid the highest bid, spread = ask − bid.
- AC2: canceled, filled, expired, malformed, forged and other-market events
  never appear and never break rendering; event content is never rendered as HTML.
- AC3: rows show limit price (USD/BTC, 2 decimals), remaining SAT; the take
  amount defaults to the remaining amount and validates AON/partial rules.
- AC4: a user cannot take their own order; their own rows offer Cancel.
- AC5: Refresh reports failure when no relay answered and keeps the last book
  marked as such; it never claims a fresh book it did not get.
- AC6: expanding a side survives background refreshes; keyboard reachable.
- EC: >500 historical projections per relay with old best prices (H);
  1,200 open orders from 300 makers (H); hostile content incl. HTML (H);
  all relays down during refresh (M); own order take (M); AON fill ≠ remaining (M);
  non-integer take amount (L).

### F3 Wallet strip and funding

Controls: **Fund SAT** (10,000 sat from testnut.cashu.space), **Fund USD**
(100.00 USD from testnut.cashudevkit.org), **Refresh balances**. Summary cells
for SAT and USD.

- AC: funding requests a quote, polls until issued (≤60 s), updates balances
  and logs without quote IDs; the button shows busy state and re-enables.
- EC: mint unreachable (M: actionable message naming the mint); slow mint
  ≥8 s/request (M); concurrent funding from two tabs of one workspace (H: no
  double-spend or lost proofs); repeated clicks while busy (L).

### F4 Order entry form

Inputs: Side (Sell/Buy SAT), Size (SAT, positive integer), Limit price
(USD/BTC, ≤2 decimals), Good for (1–30 days). Live settlement hint. Submit
**Sign & post order**. Pending relay publication panel with **Retry same
signed projection**.

- AC1: invalid inputs block submission with a specific message; nothing is
  signed or published.
- AC2: funding is checked before publication with an exact, readable message.
- AC3: the hint explains truncation when the price yields a fractional cent.
- AC4: on ≥1 relay acknowledgement the order appears in the book with Cancel;
  on 0 acknowledgements the user is told it is not public yet and the pending
  panel offers Retry; the count matches the configured relay count.
- AC5: double submit publishes one order.
- EC: `0`, `-5`, `1.5`, `abc`, empty, 23-digit size (M); `0`, `50,000.00`,
  `50000.123`, `1e5` price (L); days `0`, `31`, `1.5`, empty (L); size that
  settles to <1 cent (M); insufficient SAT/USD (H); all relays down (M).

### F5 Wallet dashboard (`#dashboard`)

- AC: empty state when no proofs; otherwise balance cards per unit and a proof
  inventory per mint/unit with proof counts and denominations. Copy only
  promises actions the page offers.
- EC: two units, two mints (L); erased in another tab (L).

### F6 Swap settlement (`#trades`)

Controls: **Refresh swaps**, per-trade **DMs** button opening a modal dialog
(Close, Escape, backdrop click), per-message **Read technical envelope**.

- AC1: a take settles automatically through Negotiating → Reserved → Base
  locked → Quote locked → … → Filled on both pages, then balances update.
- AC2: amounts render in user units ("0.05 USD", "100 sat"), never raw minor
  units with a major-unit label.
- AC3: each phase has truthful helper text; terminal non-fills state whether
  funds moved.
- AC4: while waiting for a peer, the user sees what is pending and when it
  expires; the button does not appear frozen without explanation.
- AC5: transient relay/mint failures retry automatically; reloads resume.
- AC6: the DM dialog lists only redacted metadata; focus returns on close.
- EC: two takers race for one order (H); maker offline (M); taker reload mid
  swap (H); mint outage mid swap (H); maker tab closed mid swap (H); expired
  reservation (M).

### F7 Custody panel

Controls: **Download bearer backup**; **Danger zone** disclosure with **Erase
local wallet** and **Erase everything & restart**.

- AC1: backup downloads `granola-<profile>-bearer-backup.json` containing the
  spendable tokens and a warning; nothing is logged.
- AC2: destructive actions require explicit confirmation that states what is
  lost, and are cancellable; cancel changes nothing.
- EC: erase with non-zero balance (H); erase during an active swap (H);
  backup of an empty wallet (L).

### F8 Activity log

- AC: newest first, ≤100 entries, never shows tokens, proofs, preimages,
  private keys or quote IDs; protocol entries show only public identifiers.

### F9 Maker listener (background)

- AC: after publishing (or on load with open orders) the page authenticates
  to the inbox relay and logs "Maker listener ready"; on failure it retries
  with bounded backoff and recovers on its own once the relay returns.
- EC: inbox relay down at load then restored (H); relay that answers
  unauthorized reads with `CLOSED "restricted: …"` (H); relay that silently
  filters them (H).

### F10 Static content

Hero, warning, agent strip (two external links), protocol diagram (SVG),
**View Mermaid source**, **Three private messages** disclosure, trust-boundary
notes.

- AC: readable at 375 px with no horizontal page scroll; copy matches the
  implementation (event kinds, message names).

### F11 Agent facade (`window.granola`)

Methods: `getState`, `inspectMint`, `inspectToken`, `requestMint`,
`claimMint`, `receiveToken`, `createBackup`, `clearWallet`, `resetProfile`,
`getMakerPublicKeys`, `getOrderBook`, `publishOrder`,
`getPendingOrderPublications`, `retryOrderPublication`, `cancelOrder`,
`listTrades`, `getTrade`, `takeOrder`, `advanceTrade`, `runUntilSettled`,
`enableMaker`; DOM event `granola:run-until-settled`.

- AC: same validation and funding checks as the UI; destructive methods
  require their typed confirmation; redacted outputs.
- EC: self-take through the API (M); wrong confirmation string (H).

### F12 Multi-tab and storage

- AC: one workspace in two tabs serializes wallet writes (Web Locks); no lost
  or duplicated proofs; single-tab fallback is announced when Web Locks are
  unavailable.

## Workflows

| ID | Workflow | Steps |
| --- | --- | --- |
| W1 | Fund | Fund SAT, Fund USD, Refresh balances |
| W2 | Make | Fill form, Sign & post, see own row, listener ready |
| W3 | Take and settle | Refresh orders, Buy/Sell, both pages reach Filled, balances move by the exact terms minus mint fees |
| W4 | Cancel | Own row `i` → Cancel order, row disappears for everyone |
| W5 | Recover | Reload mid swap; relay/mint outage and restore |
| W6 | Custody | Backup, erase wallet, erase everything |
| W7 | Agent | Publish, take and settle through `window.granola` |
