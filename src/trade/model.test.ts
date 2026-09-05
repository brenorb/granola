import { describe, expect, it } from "vitest";

import {
  createSettlementPlan,
  settlementAmounts
} from "./model.js";

describe("Granola settlement model", () => {
  it("derives asymmetric deadlines from the slowest accepted clock", () => {
    expect(createSettlementPlan({
      localNow: 1_700_000_000,
      baseMintNow: 1_700_000_012,
      quoteMintNow: 1_699_999_990,
      orderExpiresAt: 1_700_086_400
    })).toEqual({
      anchor: 1_700_000_012,
      shortLocktime: 1_700_000_612,
      makerClaimCutoff: 1_700_000_492,
      longLocktime: 1_700_001_212,
      takerClaimCutoff: 1_700_001_092,
      reservationExpiresAt: 1_700_001_812,
      refundGuardSeconds: 60
    });
  });

  it("fails closed on unsafe clocks or an order that expires too soon", () => {
    expect(() => createSettlementPlan({
      localNow: 100,
      baseMintNow: 131,
      quoteMintNow: 100,
      orderExpiresAt: 2_000
    })).toThrow("clock differs");

    expect(() => createSettlementPlan({
      localNow: 100,
      baseMintNow: 100,
      quoteMintNow: 100,
      orderExpiresAt: 1_899
    })).toThrow("order expires before");
  });

  it("computes truncated integer quote amounts without floating point", () => {
    expect(settlementAmounts({
      remainingBaseAmount: "20",
      fillBaseAmount: "20",
      priceCentsPerBtc: "5000000",
      execution: "all_or_none",
      minimumFillAmount: "20"
    })).toEqual({ base: "20", quote: "1" });

    expect(() => settlementAmounts({
      remainingBaseAmount: "20",
      fillBaseAmount: "19",
      priceCentsPerBtc: "5000000",
      execution: "all_or_none",
      minimumFillAmount: "20"
    })).toThrow("all-or-none");

    expect(settlementAmounts({
      remainingBaseAmount: "20",
      fillBaseAmount: "10",
      priceCentsPerBtc: "15000000",
      execution: "partial",
      minimumFillAmount: "5"
    })).toEqual({ base: "10", quote: "1" });

    expect(settlementAmounts({
      remainingBaseAmount: "200",
      fillBaseAmount: "200",
      priceCentsPerBtc: "4950000",
      execution: "all_or_none",
      minimumFillAmount: "200"
    })).toEqual({ base: "200", quote: "9" });
  });

});
