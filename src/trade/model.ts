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

const DAY_SECONDS = 86_400;
const SHORT_LOCK_SECONDS = 4 * DAY_SECONDS;
const LONG_LOCK_SECONDS = 7 * DAY_SECONDS;
const RESERVATION_SECONDS = 8 * DAY_SECONDS;

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
  price: { numerator: string; denominator: string };
  execution: "all_or_none" | "partial";
  minimumFillAmount: string;
}

export function settlementAmounts(input: SettlementAmountInput): { base: string; quote: string } {
  const remaining = positiveInteger(input.remainingBaseAmount, "Remaining base amount");
  const fill = positiveInteger(input.fillBaseAmount, "Fill base amount");
  const minimum = positiveInteger(input.minimumFillAmount, "Minimum fill amount");
  positiveInteger(input.price.numerator, "Price numerator");
  positiveInteger(input.price.denominator, "Price denominator");

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
    quote: quoteAmountForSettlement(fill.toString(), input.price)
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

export type TradeEvent =
  | "reserve_confirmed"
  | "base_lock_validated"
  | "quote_lock_validated"
  | "quote_spent_with_preimage"
  | "base_spent"
  | "fill_confirmed"
  | "abort_confirmed"
  | "settlement_cutoff_reached"
  | "quote_refund_confirmed"
  | "base_refund_confirmed"
  | "release_confirmed"
  | "contradiction_detected";

const transitions = new Map<string, TradePhase>([
  ["negotiating:reserve_confirmed", "reserved"],
  ["reserved:base_lock_validated", "base_locked"],
  ["base_locked:quote_lock_validated", "quote_locked"],
  ["quote_locked:quote_spent_with_preimage", "quote_claimed"],
  ["quote_claimed:base_spent", "base_claimed"],
  ["waiting_base_claim:base_spent", "base_claimed"],
  ["base_claimed:fill_confirmed", "filled"],
  ["reserved:abort_confirmed", "released"],
  ["base_locked:settlement_cutoff_reached", "waiting_base_refund"],
  ["quote_locked:settlement_cutoff_reached", "waiting_quote_refund"],
  ["quote_claimed:settlement_cutoff_reached", "waiting_base_claim"],
  ["waiting_quote_refund:quote_refund_confirmed", "waiting_base_refund"],
  ["waiting_base_refund:base_refund_confirmed", "released"]
]);

export function advanceTrade(phase: TradePhase, event: TradeEvent): TradePhase {
  if (event === "contradiction_detected" && phase !== "filled" && phase !== "released") {
    return "frozen";
  }
  const next = transitions.get(`${phase}:${event}`);
  if (!next) throw new Error(`Invalid trade transition: ${phase} + ${event}`);
  return next;
}
