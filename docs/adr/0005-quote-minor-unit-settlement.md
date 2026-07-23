# ADR 0005: Preserve base amount and truncate fractional quote units

## Status

Accepted for the testnet proof of concept.

## Context

Order amounts are expressed in the base mint's integer minor unit and the
SAT/USD quote mint settles in integer cents. A rational price can therefore map
an exact SAT amount to a fractional cent. For example:

```text
200 SAT × 99/2000 cents/SAT = 9.9 cents
```

Changing 200 SAT to a larger "compatible" amount violates the user's signed
quantity. Rejecting the order also makes ordinary small SAT amounts unusable.

## Decision

The signed base amount is final and is never rounded. The rational price remains
in the public order. At settlement, the quote amount is:

```text
floor(base_amount × price_numerator / price_denominator)
```

The result must be at least one quote minor unit. Both parties bind this actual
integer quote amount, the exact base amount, and the rational displayed price
into the encrypted trade terms before either party locks proofs.

For the example above, the order remains exactly 200 SAT and the USD mint
settles 9 cents. The realized integer-minor-unit rate is therefore
$45,000/BTC, not $49,500/BTC. The UI must disclose both 9.9 cents at the
displayed price and the actual 9-cent settlement.

Each partial fill applies the same formula independently.

## Consequences

- The user's SAT quantity is never silently changed.
- Any sub-cent remainder is discarded from the quote leg.
- The realized rate can differ materially for very small orders, though the
  absolute difference is always less than one quote minor unit per fill.
- Orders whose truncated quote is zero remain invalid because Cashu cannot
  settle a zero-value quote leg.
- Counterparties can deterministically recompute and validate the settlement
  amount using integer arithmetic.

## Executable vectors

- `src/order/model.test.ts`: 200 SAT at 99/2000 settles 9 cents.
- `src/order/human-price.test.ts`: UI guidance preserves 200 SAT and displays
  the 9-cent settlement.
- `src/trade/model.test.ts`: session terms derive the same integer quote.
- `src/trade/messages.test.ts`: encrypted terms reject any other quote amount.

