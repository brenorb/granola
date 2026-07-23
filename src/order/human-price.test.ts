import { describe, expect, it } from "vitest";

import { fiatPerBtcPrice } from "./human-price.js";

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
});
