import { normalizeMintUrl } from "../core/wallet.js";

export type OrderSide = "buy" | "sell";
export type ExecutionCondition = "all_or_none" | "partial";
export type OrderStatus =
  | "open"
  | "partially_filled"
  | "reserved"
  | "filled"
  | "canceled"
  | "expired";

export interface OfferedAsset {
  unit: string;
  mint: string;
}

export interface RequestedAsset {
  unit: string;
  acceptable_mints: string[];
}

export interface ReservationState {
  id: string;
  amount: string;
  accepted_at: number;
  expires_at: number;
  proposal_event_id: string;
  taker_commitment: string;
}

export interface OrderState {
  schema: "granola/order/v1";
  order_id: string;
  revision: string;
  created_at: number;
  expires_at: number;
  side: OrderSide;
  base_unit: string;
  quote_unit: string;
  offered: OfferedAsset;
  requested: RequestedAsset;
  original_amount: string;
  remaining_amount: string;
  reserved_amount: string;
  price_cents_per_btc: string;
  minimum_fill_amount: string;
  execution: ExecutionCondition;
  status: OrderStatus;
  reservation: ReservationState | null;
  replaces: string | null;
  replaced_by: string | null;
}

export interface CreateOrderInput {
  orderId: string;
  createdAt: number;
  expiresAt?: number;
  side: OrderSide;
  baseUnit: string;
  quoteUnit: string;
  offered: { unit: string; mint: string };
  requested: { unit: string; acceptableMints: string[] };
  amount: string;
  priceCentsPerBtc: string;
  execution?: ExecutionCondition;
  minimumFillAmount?: string;
}

export interface ReserveOrderInput {
  reservationId: string;
  amount: string;
  acceptedAt: number;
  expiresAt: number;
  proposalEventId: string;
  takerCommitment: string;
}

export interface FillOrderInput {
  reservationId: string;
  amount: string;
}

export interface ReleaseOrderInput {
  reservationId: string;
  reason: "expired" | "abort";
  releasedAt: number;
  abortEventId?: string;
}

export function cancelOrder(state: OrderState): OrderState {
  assertMutable(state);
  if (state.reservation !== null) {
    throw new Error("Reserved orders must be released before cancellation");
  }
  return {
    ...state,
    revision: nextRevision(state),
    reserved_amount: "0",
    status: "canceled",
    reservation: null
  };
}

export function expireOrder(state: OrderState, expiredAt: number): OrderState {
  assertMutable(state);
  if (!Number.isSafeInteger(expiredAt) || expiredAt < state.expires_at) {
    throw new Error("Order is not expired");
  }
  if (state.reservation !== null) {
    throw new Error("Reserved orders must be released before expiry");
  }
  return {
    ...state,
    revision: nextRevision(state),
    reserved_amount: "0",
    status: "expired",
    reservation: null
  };
}

export interface ExactMarket {
  baseUnit: string;
  baseMint: string;
  quoteUnit: string;
  quoteMint: string;
}

export interface OrderRecord {
  address: string;
  eventId: string;
  makerPubkey: string;
  verified: boolean;
  state: OrderState;
}

export interface OrderBook {
  market: ExactMarket;
  marketId: string;
  asks: OrderRecord[];
  bids: OrderRecord[];
  topAsk?: OrderRecord;
  topBid?: OrderRecord;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_32 = /^[0-9a-f]{64}$/;

function canonicalUnit(value: string): string {
  const unit = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(unit)) {
    throw new Error("Cashu unit must be a lowercase identifier");
  }
  return unit;
}

function integer(value: string, label: string, allowZero = false): bigint {
  const pattern = allowZero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  if (!pattern.test(value)) throw new Error(`${label} must be a canonical integer string`);
  return BigInt(value);
}

function canonicalPriceCentsPerBtc(value: string): string {
  return integer(value, "Price cents per BTC").toString();
}

/**
 * Convert SAT and cents-per-BTC integers into whole quote cents. For positive
 * BigInts, `/` truncates the fractional remainder like Python's `//`.
 */
export function quoteAmountForSettlement(
  baseAmount: string,
  priceCentsPerBtc: string
): string {
  const base = integer(baseAmount, "Base amount");
  const price = BigInt(canonicalPriceCentsPerBtc(priceCentsPerBtc));
  const quote = (base * price) / 100_000_000n;
  if (quote === 0n) {
    throw new Error("Order amount and limit price must produce at least one quote unit");
  }
  return quote.toString();
}

export function createOrderState(input: CreateOrderInput): OrderState {
  if (input.side !== "buy" && input.side !== "sell") {
    throw new Error("Order side must be buy or sell");
  }
  if (!UUID_V4.test(input.orderId)) {
    throw new Error("Order ID must be a UUID v4");
  }
  const baseUnit = canonicalUnit(input.baseUnit);
  const quoteUnit = canonicalUnit(input.quoteUnit);
  const offeredUnit = canonicalUnit(input.offered.unit);
  const requestedUnit = canonicalUnit(input.requested.unit);
  if (baseUnit === quoteUnit) throw new Error("Base and quote units must differ");
  if (input.side === "sell" && (offeredUnit !== baseUnit || requestedUnit !== quoteUnit)) {
    throw new Error("Sell orders must offer the base unit and request the quote unit");
  }
  if (input.side === "buy" && (offeredUnit !== quoteUnit || requestedUnit !== baseUnit)) {
    throw new Error("Buy orders must offer the quote unit and request the base unit");
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new Error("Creation time must be a Unix timestamp");
  }

  const expiresAt = input.expiresAt ?? input.createdAt + 2_592_000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= input.createdAt) {
    throw new Error("Order expiry must be after creation");
  }
  const amount = integer(input.amount, "Order amount");
  const priceCentsPerBtc = canonicalPriceCentsPerBtc(input.priceCentsPerBtc);
  quoteAmountForSettlement(amount.toString(), priceCentsPerBtc);

  const execution = input.execution ?? "all_or_none";
  if (execution !== "all_or_none" && execution !== "partial") {
    throw new Error("Execution condition must be all_or_none or partial");
  }
  const minimum = input.minimumFillAmount ?? (execution === "all_or_none" ? input.amount : "");
  const minimumValue = integer(minimum, "Minimum fill amount");
  if (minimumValue > amount) throw new Error("Minimum fill cannot exceed order amount");
  if (execution === "all_or_none" && minimumValue !== amount) {
    throw new Error("All-or-none minimum fill must equal the order amount");
  }

  const acceptableMints = [...new Set(
    input.requested.acceptableMints.map(normalizeMintUrl)
  )].sort();
  if (acceptableMints.length === 0) throw new Error("At least one requested mint is required");

  return {
    schema: "granola/order/v1",
    order_id: input.orderId,
    revision: "0",
    created_at: input.createdAt,
    expires_at: expiresAt,
    side: input.side,
    base_unit: baseUnit,
    quote_unit: quoteUnit,
    offered: { unit: offeredUnit, mint: normalizeMintUrl(input.offered.mint) },
    requested: { unit: requestedUnit, acceptable_mints: acceptableMints },
    original_amount: amount.toString(),
    remaining_amount: amount.toString(),
    reserved_amount: "0",
    price_cents_per_btc: priceCentsPerBtc,
    minimum_fill_amount: minimumValue.toString(),
    execution,
    status: "open",
    reservation: null,
    replaces: null,
    replaced_by: null
  };
}

function nextRevision(state: OrderState): string {
  if (!/^(0|[1-9]\d*)$/.test(state.revision)) throw new Error("Order revision is invalid");
  return (BigInt(state.revision) + 1n).toString();
}

function assertMutable(state: OrderState): void {
  if (["filled", "canceled", "expired"].includes(state.status)) {
    throw new Error("Terminal orders cannot change");
  }
}

function validateFillShape(state: OrderState, amount: bigint, remaining: bigint): void {
  const minimum = integer(state.minimum_fill_amount, "Minimum fill amount");
  if (amount > remaining) throw new Error("Amount exceeds the remaining order amount");
  if (state.execution === "all_or_none" && amount !== remaining) {
    throw new Error("All-or-none execution must reserve and fill the entire remainder");
  }
  if (state.execution === "partial") {
    const remainder = remaining - amount;
    if (amount < minimum && amount !== remaining) {
      throw new Error("Fill amount is below the order minimum");
    }
    if (remainder > 0n && remainder < minimum) {
      throw new Error("Fill would leave dust below the order minimum");
    }
  }
  quoteAmountForSettlement(amount.toString(), state.price_cents_per_btc);
}

export function reserveOrder(state: OrderState, input: ReserveOrderInput): OrderState {
  assertMutable(state);
  if (state.reservation !== null || state.reserved_amount !== "0" || state.status === "reserved") {
    throw new Error("Order already has a live reservation");
  }
  if (!UUID_V4.test(input.reservationId)) throw new Error("Reservation ID must be a UUID v4");
  if (!HEX_32.test(input.proposalEventId)) throw new Error("Proposal event ID must be lowercase hex");
  if (!HEX_32.test(input.takerCommitment)) throw new Error("Taker commitment must be lowercase hex");
  if (!Number.isSafeInteger(input.acceptedAt) || input.acceptedAt < state.created_at) {
    throw new Error("Reservation acceptance time is invalid");
  }
  if (
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= input.acceptedAt ||
    input.expiresAt > state.expires_at
  ) {
    throw new Error("Reservation expiry is invalid");
  }
  const amount = integer(input.amount, "Reservation amount");
  const remaining = integer(state.remaining_amount, "Remaining amount");
  validateFillShape(state, amount, remaining);

  return {
    ...state,
    revision: nextRevision(state),
    reserved_amount: amount.toString(),
    status: "reserved",
    reservation: {
      id: input.reservationId,
      amount: amount.toString(),
      accepted_at: input.acceptedAt,
      expires_at: input.expiresAt,
      proposal_event_id: input.proposalEventId,
      taker_commitment: input.takerCommitment
    }
  };
}

export function fillOrder(state: OrderState, input: FillOrderInput): OrderState {
  assertMutable(state);
  const reservation = state.reservation;
  if (!reservation || state.status !== "reserved") throw new Error("Fill requires a live reservation");
  if (input.reservationId !== reservation.id) throw new Error("Fill reservation ID does not match");
  const amount = integer(input.amount, "Fill amount");
  const reserved = integer(state.reserved_amount, "Reserved amount");
  const remaining = integer(state.remaining_amount, "Remaining amount");
  if (amount !== reserved || input.amount !== reservation.amount) {
    throw new Error("Fill amount must equal the reserved amount");
  }
  validateFillShape(state, amount, remaining);
  const nextRemaining = remaining - amount;

  return {
    ...state,
    revision: nextRevision(state),
    remaining_amount: nextRemaining.toString(),
    reserved_amount: "0",
    status: nextRemaining === 0n ? "filled" : "partially_filled",
    reservation: null
  };
}

export function releaseOrder(state: OrderState, input: ReleaseOrderInput): OrderState {
  assertMutable(state);
  const reservation = state.reservation;
  if (!reservation || state.status !== "reserved") {
    throw new Error("Release requires a live reservation");
  }
  if (input.reservationId !== reservation.id) {
    throw new Error("Release reservation ID does not match");
  }
  if (!Number.isSafeInteger(input.releasedAt) || input.releasedAt < reservation.accepted_at) {
    throw new Error("Reservation release time is invalid");
  }
  if (input.reason === "expired") {
    if (input.releasedAt < reservation.expires_at) {
      throw new Error("Reservation is not expired");
    }
    if (input.abortEventId !== undefined) {
      throw new Error("Expired release cannot reference an abort event");
    }
  } else if (input.reason === "abort") {
    if (!input.abortEventId || !HEX_32.test(input.abortEventId)) {
      throw new Error("Abort release requires a signed abort event ID");
    }
  } else {
    throw new Error("Reservation release reason is invalid");
  }
  const status = state.remaining_amount === state.original_amount
    ? "open"
    : "partially_filled";
  return {
    ...state,
    revision: nextRevision(state),
    reserved_amount: "0",
    status,
    reservation: null
  };
}

function marketPreimage(market: ExactMarket): string {
  return [
    "granola-market-v1",
    canonicalUnit(market.baseUnit),
    normalizeMintUrl(market.baseMint),
    canonicalUnit(market.quoteUnit),
    normalizeMintUrl(market.quoteMint)
  ].join("\n");
}

export async function marketId(market: ExactMarket): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(marketPreimage(market))
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function eligibleMarketIds(state: OrderState): Promise<string[]> {
  const markets: ExactMarket[] = state.requested.acceptable_mints.map((mint) =>
    state.side === "sell"
      ? {
          baseUnit: state.base_unit,
          baseMint: state.offered.mint,
          quoteUnit: state.quote_unit,
          quoteMint: mint
        }
      : {
          baseUnit: state.base_unit,
          baseMint: mint,
          quoteUnit: state.quote_unit,
          quoteMint: state.offered.mint
        }
  );
  return (await Promise.all(markets.map(marketId))).sort();
}

function effectiveAvailable(state: OrderState, now: number): bigint {
  const remaining = integer(state.remaining_amount, "Remaining amount", true);
  if (state.reservation && now < state.reservation.expires_at) {
    return remaining - integer(state.reserved_amount, "Reserved amount", true);
  }
  return remaining;
}

function comparePrice(left: OrderRecord, right: OrderRecord): number {
  const leftPrice = BigInt(left.state.price_cents_per_btc);
  const rightPrice = BigInt(right.state.price_cents_per_btc);
  return leftPrice < rightPrice ? -1 : leftPrice > rightPrice ? 1 : 0;
}

export async function buildOrderBook(
  records: OrderRecord[],
  market: ExactMarket,
  now: number
): Promise<OrderBook> {
  const selectedMarketId = await marketId(market);
  const eligible: OrderRecord[] = [];
  for (const record of records) {
    if (!record.verified) continue;
    if (["filled", "canceled", "expired"].includes(record.state.status)) continue;
    if (now >= record.state.expires_at) continue;
    if (effectiveAvailable(record.state, now) <= 0n) continue;
    if (!(await eligibleMarketIds(record.state)).includes(selectedMarketId)) continue;
    eligible.push(record);
  }

  const tie = (left: OrderRecord, right: OrderRecord): number =>
    left.address.localeCompare(right.address);
  const asks = eligible
    .filter((record) => record.state.side === "sell")
    .sort((left, right) => comparePrice(left, right) || tie(left, right));
  const bids = eligible
    .filter((record) => record.state.side === "buy")
    .sort((left, right) => -comparePrice(left, right) || tie(left, right));

  return {
    market,
    marketId: selectedMarketId,
    asks,
    bids,
    ...(asks[0] ? { topAsk: asks[0] } : {}),
    ...(bids[0] ? { topBid: bids[0] } : {})
  };
}
