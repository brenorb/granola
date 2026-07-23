import { quoteAmountForSettlement } from "./model.js";

export interface SettlementQuoteGuidance {
  exactQuoteNumerator: string;
  exactQuoteDenominator: string;
  settlementQuoteAmount: string;
}

export function fiatPerBtcPrice(value: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    throw new Error("Price must be a positive decimal with at most two places");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const minorUnitsPerBtc = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (minorUnitsPerBtc <= 0n) {
    throw new Error("Price must be greater than zero");
  }
  return minorUnitsPerBtc.toString();
}

/**
 * Describe the exact fractional quote and the integer amount the mint settles.
 * The base amount is never changed.
 */
export function settlementQuoteGuidance(
  baseAmount: string,
  priceCentsPerBtc: string
): SettlementQuoteGuidance | null {
  if (!/^[1-9]\d*$/.test(baseAmount)) return null;
  const amount = BigInt(baseAmount);
  if (!/^[1-9]\d*$/.test(priceCentsPerBtc)) return null;
  const exactQuoteNumerator = amount * BigInt(priceCentsPerBtc);
  const exactQuoteDenominator = 100_000_000n;
  if (exactQuoteNumerator % exactQuoteDenominator === 0n) return null;
  return {
    exactQuoteNumerator: exactQuoteNumerator.toString(),
    exactQuoteDenominator: exactQuoteDenominator.toString(),
    settlementQuoteAmount: quoteAmountForSettlement(baseAmount, priceCentsPerBtc)
  };
}
