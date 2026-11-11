# Granola user flows

These four charts were generated with pstack `/statechart` from bounded TLA+ models. Each report records the checked rules and any shortest counterexample.

## Take an order and settle

The maker and taker can finish in either order. The chart hides relay publication and terminal stuttering. The model covers the direct three-message route and abstracts exact mint observations, messages in flight, partial fills, and the publication retry loop.

[Mermaid source](take-order/chart.mmd) · [TLC report](take-order/report.md) · [TLA+ model](take-order/TakeOrder.tla)

```mermaid
---
title: "Take an order and settle"
---
stateDiagram-v2
  s0: Choose a bid or ask
  s1: Waiting for maker
  s2: Maker offer verified
  s3: Order busy or changed
  s4: Swap needs recovery
  s5: Both sides locked
  s6: Maker claimed payment
  s7: Both mint spends verified
  s8: Taker shows filled
  s9: Maker shows filled
  s10: Both browsers show filled
  [*] --> s0
  s0 --> s1: Take the order
  s1 --> s2: Maker accepts with the locked offer
  s1 --> s3: Maker replies that order changed or is busy
  s1 --> s4: Peer wait or settlement window runs out
  s2 --> s4: Peer wait or settlement window runs out
  s2 --> s5: Taker sends the locked payment
  s5 --> s4: Peer wait or settlement window runs out
  s5 --> s6: Payment mint exposes the spend witness
  s6 --> s4: Peer wait or settlement window runs out
  s6 --> s7: Taker claims the offer and both spends are verified
  s7 --> s8: Taker finishes
  s7 --> s9: Maker finishes after staging the fill
  s9 --> s10: Taker finishes
  s8 --> s10: Maker finishes after staging the fill
```

## Post and cancel an order

A failed publication leaves an exact signed event to retry. The chart hides terminal stuttering. The model covers one order, one aggregate relay ACK, and clock-based hiding at expiry.

[Mermaid source](post-order/chart.mmd) · [TLC report](post-order/report.md) · [TLA+ model](post-order/PostOrder.tla)

```mermaid
---
title: "Post and cancel an order"
---
stateDiagram-v2
  s0: Order ticket
  s1: Posting order
  s2: Pending publication
  s3: Order acknowledged
  s4: Canceling order
  s5: Order disappears at expiry
  s6: Cancellation acknowledged
  s7: Pending cancellation
  [*] --> s0
  s0 --> s1: Post a funded order
  s1 --> s2: No relay acknowledges
  s1 --> s3: A relay acknowledges the order
  s2 --> s1: Retry pending publication
  s3 --> s4: Cancel the order
  s3 --> s5: Order lifetime ends
  s4 --> s6: A relay acknowledges cancellation
  s4 --> s7: No relay acknowledges cancellation
  s7 --> s4: Retry pending cancellation
```

## Resume or recover an interrupted swap

A successful maker refund can be followed by an acknowledged order release. Payment returned to the taker describes wallet credit, since the public trade phase has no separate refunded value. The chart hides clock ticks, evidence acquisition that keeps the same label, and terminal stuttering. The model assumes a recoverable checkpoint and abstracts mint outages and proof contents.

[Mermaid source](recover-swap/chart.mmd) · [TLC report](recover-swap/report.md) · [TLA+ model](recover-swap/RecoverSwap.tla)

```mermaid
---
title: "Resume or recover an interrupted swap"
---
stateDiagram-v2
  s0: Swap interrupted
  s1: Resume from saved checkpoint
  s2: Swap frozen
  s3: Wait for refund window
  s4: Swap filled
  s5: Refund eligible
  s6: Offer returned to maker
  s7: Payment returned to taker
  s8: Order released
  [*] --> s0
  s0 --> s1: Reopen the profile
  s1 --> s2: Recovery finds no local lock to refund
  s1 --> s3: Safe claim window ends
  s1 --> s4: Both spends are verified
  s3 --> s5: Mint confirms unspent after the refund guard
  s5 --> s6: Refund reaches the wallet
  s5 --> s7: Refund reaches the wallet
  s6 --> s8: Reservation expires and release is acknowledged
```

## Fund the test wallet

Granola saves the exact issuance outputs before asking the mint for tokens. After an interruption, retrying a paid quote uses the saved outputs. Retrying an issued quote restores the signatures for those outputs. The wallet balance and quote credit marker update together. The chart hides terminal stuttering and models one quote with repeatable interruptions.

[Mermaid source](fund-wallet/chart.mmd) · [TLC report](fund-wallet/report.md) · [TLA+ model](fund-wallet/FundWallet.tla)

```mermaid
---
title: "Fund the test wallet"
---
stateDiagram-v2
  s0: Wallet ready to fund
  s1: Waiting for mint payment
  s2: Funding wait timed out
  s3: Funding attempt saved
  s4: Saved funding attempt can resume
  s5: Mint issued tokens
  s6: Tokens ready to save
  s7: Wallet credited
  [*] --> s0
  s0 --> s1: Request test tokens
  s1 --> s2: Polling limit is reached
  s1 --> s3: Payment clears and the wallet saves the attempt
  s3 --> s4: Browser closes or local save fails
  s3 --> s5: Mint issues tokens
  s4 --> s3: Retry the paid quote with the same outputs
  s5 --> s4: Browser closes or local save fails
  s5 --> s6: Wallet receives the tokens
  s4 --> s6: Recover the issued tokens from the mint
  s6 --> s4: Browser closes or local save fails
  s6 --> s7: Save the tokens and mark the quote credited together
```

## Regenerate

The charts were generated with the official pstack statechart at Cursor plugins commit `5866df557357d005b3c0c9d3da0d9e739b4bdde3` and TLC 1.7.4. Set `PSTACK_STATECHART` to the absolute path to the skill's `scripts/statechart.ts`. Use Node 24 and set `TLA2TOOLS` and `JAVA` to the checker jar and Java binary. Start from the repository root.

```sh
scratch=$(mktemp -d)
cp docs/verification/flows/take-order/{TakeOrder.tla,TakeOrder.cfg,view.mjs} "$scratch/"
node "$PSTACK_STATECHART" "$scratch/TakeOrder.tla" \
  --view "$scratch/view.mjs" --out "$scratch/result"
```

Use the matching module and folder for each flow. The command writes `chart.mmd` and `report.md`.
