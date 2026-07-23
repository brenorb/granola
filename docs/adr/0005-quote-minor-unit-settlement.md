# ADR 0005: Integer cents-per-BTC pricing and truncated settlement

## Status

Accepted for the testnet proof of concept.

## Context

The SAT/USD testnet protocol represented a limit price as a reduced rational
number of quote cents per SAT. Publishing and matching therefore required GCD
reduction, exposed implementation details such as `101/2000` in the interface,
and rejected or changed SAT amounts whenever the quote contained a fractional
cent.

The user-selected base amount is the economic intent. A quote mint can settle
only whole cents, but that does not justify changing the number of SAT being
sold.

## Decision

Public order state and private trade terms carry one positive canonical decimal
string:

```json
{ "price_cents_per_btc": "4950000" }
```

Granola is still a testnet proof of concept, so the protocol `v1` is rewritten in
place. Public order projections, private messages, and the terms-hash domain all
use the canonical integer field; there is no compatibility path for the mistaken
rational representation.

Settlement uses integer arithmetic only:

```text
quote_cents = (base_sats * price_cents_per_btc) / 100_000_000
```

For positive JavaScript `BigInt` values, `/` truncates the remainder. This is
equivalent to Python `//` for these operands. The signed base amount is never
rounded or replaced. A result of zero cents is rejected because no quote token
can represent it.

Examples:

- `200 SAT` at `4_950_000 cents/BTC` settles `9 cents`;
- `2_000 SAT` at `4_960_000 cents/BTC` settles `99 cents`;
- `2_000 SAT` at `5_000_000 cents/BTC` settles `100 cents`.

Each partial fill applies the formula independently. Both parties bind the
actual integer quote amount, exact base amount, and integer price into the
encrypted trade terms before either party locks proofs.

## Consequences

- No binary floating point, GCD, numerator, denominator, or “exact ratio” is
  part of pricing.
- Order-book comparison is direct `BigInt` comparison.
- The user's SAT quantity is never silently changed.
- Any sub-cent remainder is discarded from the quote leg.
- The realized rate can differ materially for very small orders, though the
  absolute difference is always less than one quote minor unit per fill.
- Orders whose truncated quote is zero remain invalid because Cashu cannot
  settle a zero-value quote leg.
- Counterparties can deterministically recompute and validate the settlement
  amount using integer arithmetic.
- Earlier testnet events and persisted sessions containing `limit_price` rational
  objects fail closed and must be republished as canonical `v1` projections.
- This field is specific to the current SAT/fiat-minor-unit deployment. A
  future multi-asset price format requires a separate protocol decision.

## Executable vectors

- `src/order/model.test.ts`: 200 SAT at 4,950,000 cents/BTC settles 9 cents.
- `src/order/human-price.test.ts`: UI guidance preserves 200 SAT and displays
  the 9-cent settlement.
- `src/trade/model.test.ts`: session terms derive the same integer quote.
- `src/trade/messages.test.ts`: encrypted terms reject any other quote amount.
