import type { RationalPrice } from "./model.js";

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
