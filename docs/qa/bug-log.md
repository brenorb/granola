# Granola QA bug log — 2026-11-05

Found by running the production build (`npm run build`) as a real user in
Chromium against the local production-like stack described in
[the QA run record](2026-11-05-run.md). Inventory IDs refer to
[inventory.md](inventory.md). Every repro uses throwaway test keys and
local test mints. No public relay or mint was contacted.

Severity: **H** funds, privacy or market correctness; **M** workflow stalls or
misleads; **L** cosmetic, copy or docs.

## Shared causes

| Cause | Bugs | Fix |
| --- | --- | --- |
| C1 Failures cached, never retried | B12, B14 | Drop a failed trade-runtime promise; resume settlement automatically with backoff |
| C2 Partial or failed network outcomes reported as success | B10, B11, B17 | Status reflects the acknowledgement count, query reachability and the mint that failed |
| C3 Inbox privacy probe rejects a spec-compliant denial | B02 | Treat `CLOSED "restricted:"`/`"auth-required:"` for the other key as exclusion |
| C4 Book built for small data | B03, B20 | Page each relay backwards with `until` until exhausted (bounded) |
| C5 Trade card rendering ignores units, phase and funds context | B05, B06, B08, B13 | Format minor units, phase-specific explanations, plain-language terminal outcome |
| C6 Missing guards on user intent | B07, B04, B16 (B09 by design) | Disable/reject self-take; boot-time error page; field-specific validation copy |
| C7 CSS/CSP drift | B01, B15 | External redirect script; mobile rules after base rules |
| C8 Docs drift | B18, B19 | Align tutorial/README/copy with the UI; relay count from receipts |

## Bugs

### B01 · M · R3 — HTTPS redirect script is blocked by the page CSP

- Repro: load `https://brenorb.com/granola/`. Console: `Executing inline script
  violates the following Content Security Policy directive 'script-src 'self''`.
- Expected: no CSP violations; the `http:` → `https:` redirect actually runs.
- Cause: inline `<script>` under `script-src 'self'`.

### B02 · H · F9 — Maker listener and trading fail on relays that deny unauthorized reads with `CLOSED`

- Repro: inbox relay answers a gift-wrap read by a non-recipient key with
  `["CLOSED", sub, "restricted: …"]` (NIP-01/NIP-42 behavior). Status shows
  `Inbox relay closed query: restricted: gift wraps can only be read by their
  recipient`; the trade runtime never starts.
- Evidence: frame capture: AUTH as key B, `REQ` for `#p` = key A → `CLOSED restricted`.
- Expected: a denial is the strongest form of recipient-only exclusion and
  must pass the probe.

### B03 · H · F2 AC1 — Order book drops old orders; wrong best ask and bid at scale

- Repro: seed 1,200 open orders (300 makers), 400 canceled orders and 5 hostile
  events; the best ask (49,500.00) and best bid (49,200.00) are 25 days old.
  Open the page.
- Actual: book shows 71 asks + 75 bids; best ask 50,035.92, best bid 48,941.14.
  `getOrderBook().rejected` = 500.
- Expected: all 1,200 open orders; best ask 49,500.00; best bid 49,200.00.
- Cause: one `REQ` with `limit: 500` per relay; recent canceled projections
  fill the window.

### B04 · M · R2 — Invalid `?wallet=` leaves an inert, blank page

- Repro: open `?wallet=Maker` (also 40 chars, `bad%20name`).
- Actual: profile label stays `Wallet profile: …`, nothing loads, no buttons
  work; only a console `pageerror`.
- Expected: a visible explanation with a link to a valid workspace.

### B05 · M · F6 AC2 — Trade cards show cents as dollars

- Repro: settle 100 SAT at 50,000 USD/BTC. Card shows `QUOTE 5 USD`; wallet
  shows `0.05 USD`.
- Expected: `0.05 USD` and `100 sat`, matching wallet formatting.

### B06 · L · F6 AC3 — Filled and stopped trades say "Waiting for verified mint state"

- Repro: any Filled card.
- Expected: phase-appropriate text, e.g. "Both legs settled at the mints".

### B07 · M · F2 AC4 — Users can take their own order

- Repro: publish an ask, click **Buy** on the own row (Cancel is also shown).
- Actual: `Maker proposal is bound to a conflicting trade session`; a taker
  session sits in Negotiating, later Frozen.
- Expected: own rows have no take action; the API rejects self-takes.

### B08 · M · F6 AC4 — Taking an order from an offline maker spins for ~10 minutes

- Repro: take any seeded order (its maker is offline).
- Actual: button `SETTLING…` for 300 s+ with no explanation (with a
  fast-forwarded clock it ends at +10 min as `Frozen`).
- Expected: after a short wait, explain that the maker has not answered, that
  no funds moved, and when the request expires.

### B09 · H · F7 AC2 — One click erases spendable funds without confirmation

- Repro: fund 10,000 sat, open **Danger zone**, click **Erase local wallet**.
- Actual: no dialog; balance gone immediately (`Local wallet erased`). Same
  for **Erase everything & restart**.
- Expected: a confirmation naming the balance at risk and recommending a
  backup; Cancel leaves the wallet intact.

### B10 · M · F4 AC4 — Order with zero relay acknowledgements reported as published

- Repro: all discovery relays down; post an order.
- Actual: `Order published with 0 relay acknowledgements` (success style).
- Expected: error-style "not public yet" message pointing at the Retry panel.

### B11 · M · F2 AC5 — Refresh orders claims success when no relay answered

- Repro: all discovery relays down; click **Refresh orders**.
- Actual: `Order book refreshed from public relays`; stale book shown as fresh.
- Expected: an error stating no relay answered; the last book is kept.

### B12 · H · F9, F6 — One failed trade-runtime start disables trading until reload

- Repro: inbox relay down at page load; restore it.
- Actual: `Maker listener reconnecting … Failed to fetch` forever (60–90 s
  observed after recovery); swap refresh and take reuse the same rejection.
- Expected: the next retry starts a fresh runtime and the listener becomes ready.
- Cause: `tradeControllerPromise ??=` caches a rejected promise.

### B13 · M · F6 AC3 — Race loser and expired requests see "terminal phase frozen"

- Repro: two takers click the same order. Loser sees
  `Trade stopped in terminal phase frozen` twice and a **Frozen** card; the
  stale row remains takeable.
- Expected: "Another trader took this order (or it expired). No funds moved."
  and a refreshed book.

### B14 · H · F6 AC5 — Mint outage mid-swap stalls settlement until a manual refresh

- Repro: stretch settlement with 1.5 s mint latency, take an order, cut both
  mints at **Base locked** for 20 s, restore them.
- Actual: both pages stay at Base locked for 150 s+ (`ERR Failed to fetch`);
  the taker's Buy button is enabled again. **Refresh swaps** resumes to Filled.
- Expected: automatic resume with bounded backoff.

### B15 · M · F10 — Trust-boundary notes are unreadable on phones

- Repro: 375 × 812 viewport. Notes render in two 58 px columns; page scrolls
  horizontally (scrollWidth 425 px).
- Cause: `.protocol-notes`/`.protocol-notes__grid` base rules come after the
  `max-width: 700px` overrides and win the cascade.

### B16 · L · F4 AC1 — Generic validation messages

- Repro: size `0`/`1.5`/`abc` or price `50,000.00` → `Please match the
  requested format.`
- Expected: "Enter a whole number of SAT (1 or more)", "Use digits and an
  optional decimal point, e.g. 50000.00".

### B17 · L · F3 — Funding failure says only "Failed to fetch"

- Repro: SAT mint unreachable, click **Fund SAT**.
- Expected: "Could not reach testnut.cashu.space. Check the connection and try again."

### B18 · L · docs — Tutorial and copy describe controls that do not exist

- `docs/guides/manual-testnet-swap.md` names **Publish a test limit order**,
  **Send order**, **Execution**, **Refresh book**, **Take ask**,
  **Balances & liabilities**; the page has **Post an order**, **Sign & post
  order**, **Refresh orders**, **Buy**/**Sell**, **Your Cashu balance**.
- Dashboard empty state says "receive a Cashu token"; the page has no receive
  control (only `window.granola.receiveToken`).
- Mermaid source says "Fetches 8338 events"; orders are kind 30078.

### B19 · L · F4 AC4 — Pending panel shows "x/3 relay acknowledgements" with 4 relays configured

- Repro: all relays down; the panel shows `0/3` while four receipts exist
  (three public relays plus `ws://localhost:4870`).
- Expected: denominator = number of receipts.

### B20 · M · F2 AC4 — At scale a maker's own order is hidden behind "See more"

- Repro: with 600 asks, post an ask at 51,111.00. The own row (the only one
  with **Cancel order**) is collapsed behind **See more**; finding it means
  expanding 600 rows. Found by the rerun's F4-publish check.
- Expected: own orders stay visible in the collapsed view.

## Fix status

| Bug | Status | Change | Regression test |
| --- | --- | --- | --- |
| B01 | Fixed | Redirect moved to `public/https-redirect.js` | `src/styles.test.ts` (no inline scripts under `script-src 'self'`) |
| B02 | Fixed | `probeInboxRelayLive` treats `CLOSED restricted:`/`auth-required:` as exclusion | `src/nostr/inbox.test.ts` (2 cases) |
| B03 | Fixed | `RelayClient.queryProjections` pages each relay with `until` (≤20 pages) | `src/nostr/relay.test.ts` (1,250 events, ignored `until`) |
| B04 | Fixed | `renderBootError` shows an alert with a link to the default wallet | `src/ui/guards.test.ts` |
| B05 | Fixed | Trade liabilities use `formatUnitAmount` | `src/ui/trades.test.ts` (old test asserted `1 USD`) |
| B06 | Fixed | `phaseExplanation` gives per-phase text | `src/ui/trades.test.ts` |
| B07 | Fixed | Own rows disabled; `BrowserTradeController.takeOrder` rejects own order keys | `src/ui/orderbook.test.ts`, `src/browser/trade-controller.test.ts` |
| B08 | Fixed | 20 s notice and negotiating card state the wait, no locked funds and expiry | `src/ui/trades.test.ts`; browser check B08 |
| B09 | Not changed (by design) | One-click demo deletion is enforced by `src/manual-tutorial.test.ts` ("keeps demo wallet deletion to one click"). Left for the maintainer to decide | — |
| B10 | Fixed | Zero acknowledgements → error status pointing at Retry; trace says "awaiting relays" | browser check F4-relays-down |
| B11 | Fixed | No answering relay throws `No order relay answered`; UI keeps the last book and says so | `src/nostr/relay.test.ts` (outage, partial outage) |
| B12 | Fixed | `singleFlightUntilSuccess` forgets a failed runtime start; failed start closes its sockets | `src/browser/refresh.test.ts` |
| B13 | Fixed | Plain-language failure ("No funds moved from this wallet"), frozen card text, book refresh after any take | `src/ui/trades.test.ts`; browser check B13-race |
| B14 | Fixed | Settlement retries transient network errors with 1–30 s backoff (bounded) | `src/browser/trade-controller.test.ts`, `src/browser/transient-error.test.ts` |
| B15 | Fixed | Mobile media block moved after base rules (8 shadowed rules) | `src/styles.test.ts` (cascade + brace balance) |
| B16 | Fixed | `sizeValidationMessage` / `priceValidationMessage` custom validity | `src/ui/guards.test.ts` |
| B17 | Fixed | `describeNetworkFailure` names the mint host | `src/browser/transient-error.test.ts` |
| B18 | Fixed | Tutorial, empty-state copy and Mermaid source aligned | `src/manual-tutorial.test.ts` (stale names banned) |
| B20 | Fixed | Collapsed sides keep own rows visible; count reflects visible rows | `src/ui/orderbook.test.ts` |
| B19 | Fixed | Denominator = receipt count | `src/ui/order-outbox.test.ts` (old test asserted `1/3` for 2 receipts) |

## Observations (not defects)

- Book refresh cost at scale (local stand-ins, 1,615 projections over 3
  relays): ~6.7 s per **Refresh orders** in Chromium, of which ~3 s is
  khatru/Badger answering four 500-event pages per relay and ~3.7 s (Node
  measurement) is re-verifying every signature. The old single-page query was
  faster only because it dropped most orders. The previous book stays visible
  and the button shows its busy state meanwhile. A per-event-ID signature
  cache would remove most of the verify cost; not done here because it needs
  its own measurement on real relays (see `docs/performance/consolidation.md`).

- A second tab of the same workspace shows a stale balance until **Refresh
  balances**; writes are serialized correctly (concurrent funding → 20,000 sat).
- Backing up an empty wallet downloads a file with zero tokens.
