import { describe, expect, it } from "vitest";

import type { WalletView } from "../core/wallet.js";
import { assertOrderFunding, availableOrderBalance } from "./funding.js";

const wallet: WalletView = {
  revision: 1,
  balances: [
    { unit: "sat", amount: "100", mintCount: 1, proofCount: 3 },
    { unit: "usd", amount: "20", mintCount: 1, proofCount: 1 }
  ],
  pockets: [
    {
      mintUrl: "https://testnut.cashu.space",
      unit: "sat",
      amount: "100",
      proofCount: 3,
      denominations: ["4", "32", "64"],
      keysetIds: ["sat-keyset"]
    },
    {
      mintUrl: "https://nofee.testnut.cashu.space",
      unit: "usd",
      amount: "20",
      proofCount: 1,
      denominations: ["20"],
      keysetIds: ["usd-keyset"]
    }
  ]
};

describe("order funding guard", () => {
  it("uses the exact offered mint and unit balance", () => {
    expect(availableOrderBalance(wallet, "sell")).toBe("100");
    expect(availableOrderBalance(wallet, "buy")).toBe("20");
  });

  it("rejects a sell order larger than the SAT balance", () => {
    expect(() => assertOrderFunding(wallet, "sell", "1875", { numerator: "1", denominator: "1" }))
      .toThrow("requested 1,875 SAT, available 100 SAT");
  });

  it("allows an order within balance and rejects an oversized buy", () => {
    expect(() => assertOrderFunding(wallet, "sell", "100", { numerator: "1", denominator: "1" })).not.toThrow();
    expect(() => assertOrderFunding(wallet, "buy", "42", { numerator: "1", denominator: "2" }))
      .toThrow("requested 21 USD, available 20 USD");
  });

  it("checks a buy against the truncated integer quote amount", () => {
    expect(() => assertOrderFunding(wallet, "buy", "200", {
      numerator: "99",
      denominator: "2000"
    })).not.toThrow();
    expect(() => assertOrderFunding(wallet, "buy", "500", {
      numerator: "99",
      denominator: "2000"
    })).toThrow("requested 24 USD, available 20 USD");
  });
});
