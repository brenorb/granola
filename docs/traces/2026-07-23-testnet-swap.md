# Real two-profile testnet swap trace

- Result: **filled on maker and taker**
- Completed: 2026-07-23T12:18Z
- Deployed revision: `30c1cde`
- GitHub Actions run: `30006153888`
- Session prefix: `da1540038c49…`
- Browser profiles: isolated `maker` and `taker` IndexedDB stores

## Negotiated trade

| Field | Value |
| --- | --- |
| Side | Maker sells SAT |
| Base | 20 SAT from `https://testnut.cashu.space` |
| Quote | 1 USD minor unit (USD 0.01) from `https://nofee.testnut.cashu.space` |
| Limit price | USD 50,000.00/BTC (`1/20` quote minor units per SAT) |
| Execution | All or none |
| Order lifetime | 30 days |
| Quote HTLC | 4-day short lock |
| Base HTLC | 7-day long lock |
| Reservation recovery horizon | 8 days |

The order projection reached 3/3 configured relay acknowledgements before the
taker reserved it.

## Redacted executor evidence

The agent-only `runUntilSettled` executor was started for the same persisted
session in both profiles. It returned only public role, phase, and revision
checkpoints:

| Role | First observed revision | Final revision | Checkpoints returned | Final phase |
| --- | ---: | ---: | ---: | --- |
| Maker | 25 | 51 | 27 | `filled` |
| Taker | 20 | 45 | 26 | `filled` |

Both traces passed through `base_locked`, `quote_locked`, `quote_claimed`,
`base_claimed`, and `filled`. The differing first revisions reflect resuming
the same durable session after deploying two happy-path fixes; they are not
separate swaps.

Before the quote was locked, the live run exposed and fixed two deterministic
happy-path blockers:

1. Slow authenticated WebSocket startup blocked the executor after an otherwise
   successful coordinator action. The live subscription now starts and remains
   retained in the background while durable relay polling continues.
2. Quote-leg validation compared its refund horizon with the base leg's later
   deadline. It now compares the refund horizon with that leg's own signed
   locktime.

Transient relay failures (`connection failed`, relay closed, and unavailable
inbox discovery) stopped individual executor invocations. Restarting the same
URL-bound session reused its persisted signed messages and Cashu operation
artifacts. No replacement session or second base lock was created.

## Balance evidence

| Profile | Before | After |
| --- | --- | --- |
| Maker | 56 SAT | 34 SAT + USD 0.01 |
| Taker | USD 0.10 | 20 SAT + USD 0.09 |

The maker's additional 2 SAT reduction is the fee-bearing SAT mint path. The
USD mint is the configured no-fee test mint. After both runners reported
`filled`, refreshing the public order book no longer returned the exercised
order.

## Redactions

This trace deliberately omits bearer tokens, proofs, curve points, preimages,
witnesses, private keys, mint quote IDs, private NIP-17 event IDs, and raw
encrypted messages. The executor's browser result contained only the session
ID, terminal phase, and redacted revision/phase/role checkpoints; only a
session prefix is reproduced here.
