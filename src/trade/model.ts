import { quoteAmountForSettlement } from "../order/model.js";

export interface SettlementPlan {
  anchor: number;
  shortLocktime: number;
  makerClaimCutoff: number;
  longLocktime: number;
  takerClaimCutoff: number;
  reservationExpiresAt: number;
  refundGuardSeconds: 60;
}

export interface SettlementPlanInput {
  localNow: number;
  baseMintNow: number;
  quoteMintNow: number;
  orderExpiresAt: number;
}

const SHORT_LOCK_SECONDS = 10 * 60;
const LONG_LOCK_SECONDS = 20 * 60;
const RESERVATION_SECONDS = 30 * 60;

function unixTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a Unix timestamp`);
  }
  return value;
}

export function createSettlementPlan(input: SettlementPlanInput): SettlementPlan {
  const local = unixTime(input.localNow, "Local clock");
  const base = unixTime(input.baseMintNow, "Base mint clock");
  const quote = unixTime(input.quoteMintNow, "Quote mint clock");
  const orderExpiresAt = unixTime(input.orderExpiresAt, "Order expiry");

  for (const [label, mint] of [["Base mint", base], ["Quote mint", quote]] as const) {
    if (Math.abs(mint - local) > 30) {
      throw new Error(`${label} clock differs from the local clock by more than 30 seconds`);
    }
  }

  const anchor = Math.max(local, base, quote);
  const reservationExpiresAt = anchor + RESERVATION_SECONDS;
  if (orderExpiresAt < reservationExpiresAt) {
    throw new Error("The order expires before the settlement recovery window");
  }

  return {
    anchor,
    shortLocktime: anchor + SHORT_LOCK_SECONDS,
    makerClaimCutoff: anchor + SHORT_LOCK_SECONDS - 120,
    longLocktime: anchor + LONG_LOCK_SECONDS,
    takerClaimCutoff: anchor + LONG_LOCK_SECONDS - 120,
    reservationExpiresAt,
    refundGuardSeconds: 60
  };
}

function positiveInteger(value: string, label: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${label} must be a canonical positive integer`);
  }
  return BigInt(value);
}

export interface SettlementAmountInput {
  remainingBaseAmount: string;
  fillBaseAmount: string;
  priceCentsPerBtc: string;
  execution: "all_or_none" | "partial";
  minimumFillAmount: string;
}

export function settlementAmounts(input: SettlementAmountInput): { base: string; quote: string } {
  const remaining = positiveInteger(input.remainingBaseAmount, "Remaining base amount");
  const fill = positiveInteger(input.fillBaseAmount, "Fill base amount");
  const minimum = positiveInteger(input.minimumFillAmount, "Minimum fill amount");
  positiveInteger(input.priceCentsPerBtc, "Price cents per BTC");

  if (fill > remaining) throw new Error("Fill amount exceeds the remaining order amount");
  if (input.execution === "all_or_none" && fill !== remaining) {
    throw new Error("An all-or-none order must fill its entire remaining amount");
  }
  if (input.execution === "partial" && fill < minimum) {
    throw new Error("Partial fill amount is below the order minimum");
  }
  if (input.execution !== "all_or_none" && input.execution !== "partial") {
    throw new Error("Unknown execution condition");
  }

  return {
    base: fill.toString(),
    quote: quoteAmountForSettlement(fill.toString(), input.priceCentsPerBtc)
  };
}

export type TradePhase =
  | "negotiating"
  | "reserved"
  | "base_locked"
  | "quote_locked"
  | "quote_claimed"
  | "base_claimed"
  | "filled"
  | "waiting_quote_refund"
  | "waiting_base_refund"
  | "waiting_base_claim"
  | "released"
  | "frozen";

/** Maps a protocol lock slot to its market leg for either order side. */
export function slotLeg(
  session: { orderSide?: "buy" | "sell" },
  slot: "base" | "quote"
): "base" | "quote" {
  return session.orderSide !== "buy" ? slot : slot === "base" ? "quote" : "base";
}
