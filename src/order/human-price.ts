import type { RationalPrice } from "./model.js";

export interface SettlementAmountGuidance {
  baseMultiple: string;
  currentQuoteNumerator: string;
  currentQuoteDenominator: string;
  lowerCompatibleAmount: string;
  lowerQuoteAmount: string;
  higherCompatibleAmount: string;
  higherQuoteAmount: string;
}

export interface SettlementAmountRounding {
  direction: "down" | "up";
  originalAmount: string;
  roundedAmount: string;
  quoteAmount: string;
  deltaAmount: string;
}

function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}

export function fiatPerBtcPrice(value: string): RationalPrice {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    throw new Error("Price must be a positive decimal with at most two places");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const minorUnitsPerBtc = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (minorUnitsPerBtc <= 0n) {
    throw new Error("Price must be greater than zero");
  }
  const satoshisPerBtc = 100_000_000n;
  const divisor = gcd(minorUnitsPerBtc, satoshisPerBtc);
  return {
    numerator: (minorUnitsPerBtc / divisor).toString(),
    denominator: (satoshisPerBtc / divisor).toString()
  };
}

/**
 * Return exact compatible base sizes when a rational price cannot settle the
 * requested base amount in integer quote minor units. A null result means the
 * amount already produces an integer quote amount.
 */
export function settlementAmountGuidance(
  baseAmount: string,
  price: RationalPrice
): SettlementAmountGuidance | null {
  if (!/^[1-9]\d*$/.test(baseAmount)) return null;
  const amount = BigInt(baseAmount);
  const numerator = BigInt(price.numerator);
  const denominator = BigInt(price.denominator);
  if (numerator <= 0n || denominator <= 0n) return null;
  const divisor = gcd(numerator, denominator);
  const reducedNumerator = numerator / divisor;
  const reducedDenominator = denominator / divisor;
  if ((amount * reducedNumerator) % reducedDenominator === 0n) return null;
  const lower = (amount / reducedDenominator) * reducedDenominator;
  const higher = lower + reducedDenominator;
  const currentQuoteNumerator = amount * reducedNumerator;
  const currentQuoteDenominator = reducedDenominator;
  const currentQuoteDivisor = gcd(currentQuoteNumerator, currentQuoteDenominator);
  const lowerQuoteAmount = (lower * reducedNumerator) / reducedDenominator;
  const higherQuoteAmount = (higher * reducedNumerator) / reducedDenominator;
  return {
    baseMultiple: reducedDenominator.toString(),
    currentQuoteNumerator: (currentQuoteNumerator / currentQuoteDivisor).toString(),
    currentQuoteDenominator: (currentQuoteDenominator / currentQuoteDivisor).toString(),
    lowerCompatibleAmount: lower > 0n ? lower.toString() : "",
    lowerQuoteAmount: lowerQuoteAmount.toString(),
    higherCompatibleAmount: higher.toString(),
    higherQuoteAmount: higherQuoteAmount.toString()
  };
}

/**
 * Pick the settlement-safe size to apply in the human order form. Prefer
 * rounding down so an order never commits more than the user entered. If the
 * amount is smaller than one compatible multiple, round up so it remains a
 * valid non-zero order rather than silently becoming zero.
 */
export function settlementAmountRounding(
  baseAmount: string,
  price: RationalPrice
): SettlementAmountRounding | null {
  const guidance = settlementAmountGuidance(baseAmount, price);
  if (guidance === null) return null;
  const amount = BigInt(baseAmount);
  const roundedAmount = guidance.lowerCompatibleAmount.length > 0
    ? BigInt(guidance.lowerCompatibleAmount)
    : BigInt(guidance.higherCompatibleAmount);
  const quoteAmount = guidance.lowerCompatibleAmount.length > 0
    ? guidance.lowerQuoteAmount
    : guidance.higherQuoteAmount;
  return {
    direction: guidance.lowerCompatibleAmount.length > 0 ? "down" : "up",
    originalAmount: baseAmount,
    roundedAmount: roundedAmount.toString(),
    quoteAmount,
    deltaAmount: (roundedAmount - amount).toString()
  };
}
