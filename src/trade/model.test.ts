import { describe, expect, it } from "vitest";

import {
  advanceTrade,
  createSettlementPlan,
  settlementAmounts,
  type TradePhase
} from "./model.js";

describe("Granola settlement model", () => {
  it("derives asymmetric deadlines from the slowest accepted clock", () => {
    expect(createSettlementPlan({
      localNow: 1_700_000_000,
      baseMintNow: 1_700_000_012,
      quoteMintNow: 1_699_999_990,
      orderExpiresAt: 1_700_700_000
    })).toEqual({
      anchor: 1_700_000_012,
      shortLocktime: 1_700_345_612,
      makerClaimCutoff: 1_700_345_492,
      longLocktime: 1_700_604_812,
      takerClaimCutoff: 1_700_604_692,
      reservationExpiresAt: 1_700_691_212,
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
      orderExpiresAt: 691_299
    })).toThrow("order expires before");
  });

  it("computes exact base and quote amounts without floating point", () => {
    expect(settlementAmounts({
      remainingBaseAmount: "20",
      fillBaseAmount: "20",
      price: { numerator: "1", denominator: "20" },
      execution: "all_or_none",
      minimumFillAmount: "20"
    })).toEqual({ base: "20", quote: "1" });

    expect(() => settlementAmounts({
      remainingBaseAmount: "20",
      fillBaseAmount: "19",
      price: { numerator: "1", denominator: "20" },
      execution: "all_or_none",
      minimumFillAmount: "20"
    })).toThrow("all-or-none");

    expect(() => settlementAmounts({
      remainingBaseAmount: "20",
      fillBaseAmount: "10",
      price: { numerator: "1", denominator: "20" },
      execution: "partial",
      minimumFillAmount: "5"
    })).toThrow("integer quote amount");
  });

  it("allows only the persisted happy-path sequence", () => {
    const sequence: Array<[TradePhase, Parameters<typeof advanceTrade>[1], TradePhase]> = [
      ["negotiating", "reserve_confirmed", "reserved"],
      ["reserved", "base_lock_validated", "base_locked"],
      ["base_locked", "quote_lock_validated", "quote_locked"],
      ["quote_locked", "quote_spent_with_preimage", "quote_claimed"],
      ["quote_claimed", "base_spent", "base_claimed"],
      ["base_claimed", "fill_confirmed", "filled"]
    ];

    for (const [from, event, to] of sequence) {
      expect(advanceTrade(from, event)).toBe(to);
    }
  });

  it("does not treat messages, pending proofs, or timeouts as settlement", () => {
    expect(() => advanceTrade("quote_locked", "claim_notice_received" as never))
      .toThrow("Invalid trade transition");
    expect(() => advanceTrade("quote_locked", "base_spent"))
      .toThrow("Invalid trade transition");
    expect(() => advanceTrade("base_claimed", "release_confirmed"))
      .toThrow("Invalid trade transition");
  });

  it("enters explicit recovery without releasing locked value", () => {
    expect(advanceTrade("reserved", "abort_confirmed")).toBe("released");
    expect(advanceTrade("base_locked", "settlement_cutoff_reached")).toBe("waiting_base_refund");
    expect(advanceTrade("quote_locked", "settlement_cutoff_reached")).toBe("waiting_quote_refund");
    expect(advanceTrade("waiting_quote_refund", "quote_refund_confirmed")).toBe("waiting_base_refund");
    expect(advanceTrade("waiting_base_refund", "base_refund_confirmed")).toBe("released");
    expect(advanceTrade("quote_claimed", "settlement_cutoff_reached")).toBe("waiting_base_claim");
    expect(advanceTrade("waiting_base_claim", "base_spent")).toBe("base_claimed");
    expect(advanceTrade("quote_locked", "contradiction_detected")).toBe("frozen");
  });
});
