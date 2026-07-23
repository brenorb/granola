import { describe, expect, it } from "vitest";

import {
  fiatPerBtcPrice,
  settlementQuoteGuidance
} from "./human-price.js";

describe("human fiat/BTC price", () => {
  it("converts decimal fiat per BTC into integer cents per BTC", () => {
    expect(fiatPerBtcPrice("50500.00")).toBe("5050000");
    expect(fiatPerBtcPrice("49500")).toBe("4950000");
    expect(fiatPerBtcPrice("0.01")).toBe("1");
  });

  it("rejects ambiguous, negative, and over-precise prices", () => {
    for (const value of ["50,500", "-1", "0", "1.001", "1e5", ""])
      expect(() => fiatPerBtcPrice(value)).toThrow("Price must");
  });

  it("preserves the SAT amount and reports the truncated cent settlement", () => {
    expect(settlementQuoteGuidance("200", fiatPerBtcPrice("49500.00")))
      .toEqual({
        exactQuoteNumerator: "990000000",
        exactQuoteDenominator: "100000000",
        settlementQuoteAmount: "9"
      });
    expect(settlementQuoteGuidance("2000", fiatPerBtcPrice("50000.00")))
      .toBeNull();
  });
});
