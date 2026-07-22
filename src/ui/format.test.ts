import { describe, expect, it } from "vitest";

import { formatUnitAmount } from "./format.js";

describe("Cashu unit formatting", () => {
  it.each([
    ["12345", "sat", "12,345 sat"],
    ["1", "btc", "0.00000001 BTC"],
    ["500", "usd", "5.00 USD"],
    ["250", "eur", "2.50 EUR"],
    ["42", "widgets", "42 WIDGETS"]
  ])("formats %s minor units of %s without currency conversion", (amount, unit, expected) => {
    expect(formatUnitAmount(amount, unit)).toBe(expected);
  });

  it("formats integer strings larger than Number.MAX_SAFE_INTEGER exactly", () => {
    expect(formatUnitAmount("9007199254740993", "usd")).toBe(
      "90,071,992,547,409.93 USD"
    );
  });
});

