import {
  quoteAmountForSettlement,
  type RationalPrice
} from "./model.js";

export interface SettlementQuoteGuidance {
  exactQuoteNumerator: string;
  exactQuoteDenominator: string;
  settlementQuoteAmount: string;
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

export function settlementQuoteGuidance(
  baseAmount: string,
  price: RationalPrice
): SettlementQuoteGuidance | null {
  if (!/^[1-9]\d*$/.test(baseAmount)) return null;
  const amount = BigInt(baseAmount);
  const numerator = BigInt(price.numerator);
  const denominator = BigInt(price.denominator);
  if (numerator <= 0n || denominator <= 0n) return null;
  const divisor = gcd(numerator, denominator);
  const reducedNumerator = numerator / divisor;
  const reducedDenominator = denominator / divisor;
  if ((amount * reducedNumerator) % reducedDenominator === 0n) return null;
  const exactQuoteNumerator = amount * reducedNumerator;
  const exactQuoteDenominator = reducedDenominator;
  const exactQuoteDivisor = gcd(exactQuoteNumerator, exactQuoteDenominator);
  return {
    exactQuoteNumerator: (exactQuoteNumerator / exactQuoteDivisor).toString(),
    exactQuoteDenominator: (exactQuoteDenominator / exactQuoteDivisor).toString(),
    settlementQuoteAmount: quoteAmountForSettlement(baseAmount, price)
  };
}
