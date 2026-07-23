import { describe, expect, it } from "vitest";

import {
  fiatPerBtcPrice,
  settlementAmountGuidance
} from "./human-price.js";

describe("human fiat/BTC price", () => {
  it("converts decimal fiat per BTC into exact minor-unit per SAT", () => {
    expect(fiatPerBtcPrice("50500.00")).toEqual({ numerator: "101", denominator: "2000" });
    expect(fiatPerBtcPrice("49500")).toEqual({ numerator: "99", denominator: "2000" });
    expect(fiatPerBtcPrice("0.01")).toEqual({ numerator: "1", denominator: "100000000" });
  });

  it("rejects ambiguous, negative, and over-precise prices", () => {
    for (const value of ["50,500", "-1", "0", "1.001", "1e5", ""])
      expect(() => fiatPerBtcPrice(value)).toThrow("Price must");
  });

  it("explains compatible SAT sizes when a price produces fractional cents", () => {
    expect(settlementAmountGuidance("2000", fiatPerBtcPrice("49600.00")))
      .toEqual({
        baseMultiple: "625",
        currentQuoteNumerator: "496",
        currentQuoteDenominator: "5",
        lowerCompatibleAmount: "1875",
        lowerQuoteAmount: "93",
        higherCompatibleAmount: "2500",
        higherQuoteAmount: "124"
      });
    expect(settlementAmountGuidance("1875", fiatPerBtcPrice("49600.00")))
      .toBeNull();
    expect(settlementAmountGuidance("2000", fiatPerBtcPrice("50500.00")))
      .toBeNull();
  });

});
