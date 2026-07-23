import {
  createOrderState,
  eligibleMarketIds,
  type OrderRecord,
  type OrderState
} from "./model.js";

export interface UnsignedNostrEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface NostrEvent extends UnsignedNostrEvent {
  id: string;
  pubkey: string;
  sig: string;
}

export type OrderOperation =
  | "create"
  | "reserve"
  | "release"
  | "fill"
  | "cancel"
  | "expire";

export interface FillOrderEvidence {
  settlement_hash: string;
  base_token_commitment: string;
  quote_token_commitment: string;
}

export interface ReleaseOrderEvidence {
  release_reason: "expired" | "abort";
  abort_event_id?: string;
}

export type OrderOperationEvidence = FillOrderEvidence | ReleaseOrderEvidence;

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function orderAddress(pubkey: string, orderId: string): string {
  return `30078:${pubkey}:granola:order:v1:${orderId}`;
}

function requireHex(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new Error(`${label} must be lowercase hex`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`
    ).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Value cannot be canonically encoded");
  return encoded;
}

function tagValues(event: NostrEvent, key: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === key && typeof tag[1] === "string")
    .map((tag) => tag[1] as string);
}

function oneTag(event: NostrEvent, key: string): string {
  const values = tagValues(event, key);
  if (values.length !== 1 || !values[0]) {
    throw new Error(`Projection requires one ${key} tag`);
  }
  return values[0];
}

function canonicalNonNegative(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be a canonical non-negative integer string`);
  }
  return value;
}

function parseCanonicalState(value: unknown): OrderState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Projection content must be an object");
  }
  const input = value as Partial<OrderState>;
  if (input.schema !== "granola/order/v1") throw new Error("Unknown order schema");
  if (
    typeof input.order_id !== "string" ||
    typeof input.created_at !== "number" ||
    typeof input.expires_at !== "number" ||
    (input.side !== "buy" && input.side !== "sell") ||
    typeof input.base_unit !== "string" ||
    typeof input.quote_unit !== "string" ||
    !input.offered ||
    !input.requested ||
    typeof input.original_amount !== "string" ||
    typeof input.price_cents_per_btc !== "string" ||
    typeof input.minimum_fill_amount !== "string" ||
    (input.execution !== "all_or_none" && input.execution !== "partial")
  ) {
    throw new Error("Projection content is incomplete");
  }

  const initial = createOrderState({
    orderId: input.order_id,
    createdAt: input.created_at,
    expiresAt: input.expires_at,
    side: input.side,
    baseUnit: input.base_unit,
    quoteUnit: input.quote_unit,
    offered: input.offered,
    requested: {
      unit: input.requested.unit,
      acceptableMints: input.requested.acceptable_mints
    },
    amount: input.original_amount,
    priceCentsPerBtc: input.price_cents_per_btc,
    execution: input.execution,
    minimumFillAmount: input.minimum_fill_amount
  });
  const revision = canonicalNonNegative(input.revision, "Order revision");
  const remaining = canonicalNonNegative(input.remaining_amount, "Remaining amount");
  const reserved = canonicalNonNegative(input.reserved_amount, "Reserved amount");
  if (BigInt(remaining) > BigInt(initial.original_amount)) {
    throw new Error("Remaining amount exceeds original amount");
  }
  if (BigInt(reserved) > BigInt(remaining)) {
    throw new Error("Reserved amount exceeds remaining amount");
  }
  if (
    !input.status ||
    !["open", "partially_filled", "reserved", "filled", "canceled", "expired"]
      .includes(input.status)
  ) {
    throw new Error("Order status is invalid");
  }

  const reservation = input.reservation ?? null;
  if (reservation !== null) {
    if (
      typeof reservation.id !== "string" ||
      !UUID_V4.test(reservation.id) ||
      typeof reservation.amount !== "string" ||
      !/^[1-9]\d*$/.test(reservation.amount) ||
      !Number.isSafeInteger(reservation.accepted_at) ||
      !Number.isSafeInteger(reservation.expires_at) ||
      typeof reservation.proposal_event_id !== "string" ||
      typeof reservation.taker_commitment !== "string"
    ) {
      throw new Error("Reservation is incomplete");
    }
    if (reservation.amount !== reserved || input.status !== "reserved") {
      throw new Error("Reservation amount and status are inconsistent");
    }
    requireHex(reservation.proposal_event_id, HEX_32, "Proposal event ID");
    requireHex(reservation.taker_commitment, HEX_32, "Taker commitment");
    if (
      reservation.accepted_at < initial.created_at ||
      reservation.expires_at <= reservation.accepted_at ||
      reservation.expires_at > initial.expires_at
    ) {
      throw new Error("Reservation expiry is invalid");
    }
  } else if (reserved !== "0" || input.status === "reserved") {
    throw new Error("Reserved amount requires reservation state");
  }
  if (input.status === "filled" && remaining !== "0") {
    throw new Error("Filled order must have zero remaining amount");
  }
  if (remaining === "0" && !["filled", "canceled"].includes(input.status)) {
    throw new Error("Zero remaining amount requires terminal state");
  }
  if (input.status === "open" && remaining !== initial.original_amount) {
    throw new Error("Open order must retain its original amount");
  }
  if (
    input.status === "partially_filled" &&
    (remaining === "0" || remaining === initial.original_amount)
  ) {
    throw new Error("Partially-filled amount is inconsistent");
  }
  const state: OrderState = {
    ...initial,
    revision,
    remaining_amount: remaining,
    reserved_amount: reserved,
    status: input.status,
    reservation
  };
  if (canonicalJson(value) !== canonicalJson(state)) {
    throw new Error("Projection order state must be canonical");
  }
  return state;
}

export async function createProjectionTemplate(
  state: OrderState,
  makerPubkey: string,
  createdAt: number = state.created_at
): Promise<UnsignedNostrEvent> {
  requireHex(makerPubkey, HEX_32, "Maker public key");
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt < state.created_at ||
    (state.revision === "0" && createdAt !== state.created_at)
  ) {
    throw new Error("Projection timestamp is invalid");
  }
  const markets = await eligibleMarketIds(state);
  return {
    kind: 30078,
    created_at: createdAt,
    tags: [
      ["d", `granola:order:v1:${state.order_id}`],
      ["t", "granola-order"],
      ["v", "1"],
      ["s", state.status],
      ["side", state.side],
      ...markets.map((market) => ["m", market]),
      ["expires_at", String(state.expires_at)],
      ["expiration", String(state.expires_at)]
    ],
    content: JSON.stringify(state)
  };
}

export async function parseProjectionEvent(
  event: NostrEvent,
  verify: (event: NostrEvent) => boolean
): Promise<OrderRecord> {
  if (event.kind !== 30078) throw new Error("Event is not an order projection");
  requireHex(event.id, HEX_32, "Event ID");
  requireHex(event.pubkey, HEX_32, "Maker public key");
  requireHex(event.sig, HEX_64, "Event signature");
  if (!verify(event)) throw new Error("Event signature verification failed");

  let decoded: unknown;
  try {
    decoded = JSON.parse(event.content);
  } catch {
    throw new Error("Projection content is not valid JSON");
  }
  const state = parseCanonicalState(decoded);
  if (event.created_at < state.created_at) {
    throw new Error("Projection predates order creation");
  }
  if (state.revision === "0" && event.created_at !== state.created_at) {
    throw new Error("Initial projection timestamp does not match order creation");
  }
  if (
    state.status === "reserved" &&
    event.created_at !== state.reservation?.accepted_at
  ) {
    throw new Error("Reserved projection timestamp does not match acceptance");
  }
  if (oneTag(event, "d") !== `granola:order:v1:${state.order_id}`) {
    throw new Error("Projection order ID tag mismatch");
  }
  if (oneTag(event, "t") !== "granola-order") {
    throw new Error("Projection namespace mismatch");
  }
  if (oneTag(event, "v") !== "1") throw new Error("Projection version mismatch");
  if (oneTag(event, "s") !== state.status) {
    throw new Error("Projection status tag mismatch");
  }
  if (oneTag(event, "side") !== state.side) {
    throw new Error("Projection side tag mismatch");
  }
  if (tagValues(event, "e").length !== 0) {
    throw new Error("Projection cannot reference a public predecessor");
  }
  if (oneTag(event, "expires_at") !== String(state.expires_at)) {
    throw new Error("Projection expiry tag mismatch");
  }
  if (oneTag(event, "expiration") !== String(state.expires_at)) {
    throw new Error("Projection expiration tag mismatch");
  }
  if (state.status === "expired" && event.created_at < state.expires_at) {
    throw new Error("Expired projection predates order expiry");
  }
  const actualMarkets = [...new Set(tagValues(event, "m"))].sort();
  const expectedMarkets = await eligibleMarketIds(state);
  if (JSON.stringify(actualMarkets) !== JSON.stringify(expectedMarkets)) {
    throw new Error("Projection market index mismatch");
  }
  return {
    address: orderAddress(event.pubkey, state.order_id),
    eventId: event.id,
    makerPubkey: event.pubkey,
    verified: true,
    state
  };
}
