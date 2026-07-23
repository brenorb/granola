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

interface ProjectionContent extends OrderState {
  head: string;
}

interface CreateTransitionContent {
  schema: "granola/order-transition/v1";
  operation_id: string;
  operation: "create";
  revision: "0";
  previous: null;
  state: OrderState;
}

export type OrderOperation = "create" | "reserve" | "release" | "fill" | "cancel" | "replace";

export interface TransitionEvidence {
  settlement_hash: string;
  base_token_commitment: string;
  quote_token_commitment: string;
}

interface StateTransitionContent {
  schema: "granola/order-transition/v1";
  operation_id: string;
  operation: OrderOperation;
  revision: string;
  previous: string | null;
  state: OrderState;
  evidence?: TransitionEvidence;
}

export interface TransitionRecord extends CreateTransitionRecord {
  operation: OrderOperation;
  revision: string;
  previous: string | null;
  evidence?: TransitionEvidence;
}

export interface CreateTransitionRecord {
  eventId: string;
  makerPubkey: string;
  address: string;
  operationId: string;
  state: OrderState;
}

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;

function orderAddress(pubkey: string, orderId: string): string {
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
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createTransitionTemplate(
  state: OrderState,
  makerPubkey: string,
  operationId: string
): UnsignedNostrEvent {
  requireHex(makerPubkey, HEX_32, "Maker public key");
  if (!operationId.trim()) throw new Error("Operation ID is required");
  if (state.revision !== "0" || state.status !== "open") {
    throw new Error("Create transition requires an initial open state");
  }
  return {
    kind: 78,
    created_at: state.created_at,
    tags: [
      ["d", `granola:order-transition:v1:${state.order_id}`],
      ["t", "granola-order-transition"],
      ["v", "1"],
      ["a", orderAddress(makerPubkey, state.order_id)],
      ["op", "create"]
    ],
    content: JSON.stringify({
      schema: "granola/order-transition/v1",
      operation_id: operationId,
      operation: "create",
      revision: "0",
      previous: null,
      state
    })
  };
}

export function createStateTransitionTemplate(
  state: OrderState,
  makerPubkey: string,
  operationId: string,
  operation: Exclude<OrderOperation, "create">,
  previous: NostrEvent,
  evidence?: TransitionEvidence,
  createdAt?: number
): UnsignedNostrEvent {
  requireHex(makerPubkey, HEX_32, "Maker public key");
  requireHex(previous.id, HEX_32, "Previous transition ID");
  if (previous.pubkey !== makerPubkey) throw new Error("Previous transition maker mismatch");
  if (!operationId.trim()) throw new Error("Operation ID is required");
  if (!/^[1-9]\d*$/.test(state.revision)) {
    throw new Error("State transition requires a positive canonical revision");
  }
  if (operation === "reserve" && state.status !== "reserved") {
    throw new Error("Reserve transition requires reserved state");
  }
  if (operation === "fill" && state.status !== "filled" && state.status !== "partially_filled") {
    throw new Error("Fill transition requires filled or partially-filled state");
  }
  if (operation === "fill") {
    if (!evidence) throw new Error("Fill transition requires settlement commitments");
    for (const value of Object.values(evidence)) requireHex(value, HEX_32, "Settlement commitment");
  } else if (evidence) {
    throw new Error("Only fill transitions carry settlement commitments");
  }
  const timestamp = createdAt ?? (
    operation === "reserve" && state.reservation
      ? state.reservation.accepted_at
      : previous.created_at + 1
  );
  if (!Number.isSafeInteger(timestamp) || timestamp < previous.created_at) {
    throw new Error("Transition timestamp is invalid");
  }
  const content: StateTransitionContent = {
    schema: "granola/order-transition/v1",
    operation_id: operationId,
    operation,
    revision: state.revision,
    previous: previous.id,
    state,
    ...(evidence ? { evidence } : {})
  };
  return {
    kind: 78,
    created_at: timestamp,
    tags: [
      ["d", `granola:order-transition:v1:${state.order_id}`],
      ["t", "granola-order-transition"],
      ["v", "1"],
      ["a", orderAddress(makerPubkey, state.order_id)],
      ["op", operation],
      ["e", previous.id]
    ],
    content: JSON.stringify(content)
  };
}

export async function createProjectionTemplate(
  state: OrderState,
  transition: NostrEvent
): Promise<UnsignedNostrEvent> {
  requireHex(transition.id, HEX_32, "Transition ID");
  requireHex(transition.pubkey, HEX_32, "Maker public key");
  const markets = await eligibleMarketIds(state);
  const retention = state.expires_at + 604_800;
  if (!Number.isSafeInteger(retention)) throw new Error("Projection retention timestamp is invalid");
  const content: ProjectionContent = { ...state, head: transition.id };
  return {
    kind: 30078,
    created_at: transition.created_at,
    tags: [
      ["d", `granola:order:v1:${state.order_id}`],
      ["t", "granola-order"],
      ["v", "1"],
      ["s", state.status],
      ["side", state.side],
      ...markets.map((market) => ["m", market]),
      ["expires_at", String(state.expires_at)],
      ["expiration", String(retention)],
      ["e", transition.id]
    ],
    content: JSON.stringify(content)
  };
}

function tagValues(event: NostrEvent, key: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === key && typeof tag[1] === "string")
    .map((tag) => tag[1] as string);
}

function oneTag(event: NostrEvent, key: string): string {
  const values = tagValues(event, key);
  if (values.length !== 1 || !values[0]) throw new Error(`Projection requires one ${key} tag`);
  return values[0];
}

function canonicalNonNegative(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be a canonical non-negative integer string`);
  }
  return value;
}

function parseCanonicalState(value: unknown): { state: OrderState; head?: string } {
  if (!value || typeof value !== "object") throw new Error("Projection content must be an object");
  const input = value as Partial<ProjectionContent>;
  if (input.schema !== "granola/order/v1") throw new Error("Unknown order schema");
  if (input.head !== undefined) {
    if (typeof input.head !== "string") throw new Error("Projection head is invalid");
    requireHex(input.head, HEX_32, "Projection head");
  }
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
    !input.limit_price ||
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
    price: input.limit_price,
    execution: input.execution,
    minimumFillAmount: input.minimum_fill_amount
  });
  const revision = canonicalNonNegative(input.revision, "Order revision");
  const remaining = canonicalNonNegative(input.remaining_amount, "Remaining amount");
  const reserved = canonicalNonNegative(input.reserved_amount, "Reserved amount");
  if (BigInt(remaining) > BigInt(initial.original_amount)) throw new Error("Remaining amount exceeds original amount");
  if (BigInt(reserved) > BigInt(remaining)) throw new Error("Reserved amount exceeds remaining amount");
  if (!input.status || !["open", "partially_filled", "reserved", "filled", "canceled", "expired"].includes(input.status)) {
    throw new Error("Order status is invalid");
  }
  let reservation = input.reservation ?? null;
  if (reservation !== null) {
    if (
      typeof reservation.id !== "string" ||
      typeof reservation.amount !== "string" ||
      typeof reservation.accepted_at !== "number" ||
      typeof reservation.expires_at !== "number" ||
      typeof reservation.proposal_event_id !== "string" ||
      typeof reservation.taker_commitment !== "string"
    ) throw new Error("Reservation is incomplete");
    if (reservation.amount !== reserved || input.status !== "reserved") {
      throw new Error("Reservation amount and status are inconsistent");
    }
    requireHex(reservation.proposal_event_id, HEX_32, "Proposal event ID");
    requireHex(reservation.taker_commitment, HEX_32, "Taker commitment");
    if (reservation.expires_at <= reservation.accepted_at || reservation.expires_at > initial.expires_at) {
      throw new Error("Reservation expiry is invalid");
    }
  } else if (reserved !== "0" || input.status === "reserved") {
    throw new Error("Reserved amount requires reservation state");
  }
  if (input.status === "filled" && remaining !== "0") throw new Error("Filled order must have zero remaining amount");
  if (remaining === "0" && input.status !== "filled" && input.status !== "canceled") {
    throw new Error("Zero remaining amount requires terminal state");
  }
  if (input.status === "open" && remaining !== initial.original_amount) {
    throw new Error("Open order must retain its original amount");
  }
  if (input.status === "partially_filled" && (remaining === "0" || remaining === initial.original_amount)) {
    throw new Error("Partially-filled amount is inconsistent");
  }
  const state: OrderState = {
    ...initial,
    revision,
    remaining_amount: remaining,
    reserved_amount: reserved,
    status: input.status,
    reservation,
    replaces: input.replaces ?? null,
    replaced_by: input.replaced_by ?? null
  };
  const { head: _head, ...rawState } = input as ProjectionContent;
  if (canonicalJson(rawState) !== canonicalJson(state)) {
    throw new Error("Projection order state must be canonical");
  }
  return { state, ...(input.head ? { head: input.head } : {}) };
}

export function parseCreateTransitionEvent(
  event: NostrEvent,
  verify: (event: NostrEvent) => boolean
): CreateTransitionRecord {
  const parsed = parseTransitionEvent(event, verify);
  if (parsed.operation !== "create" || parsed.revision !== "0" || parsed.previous !== null) {
    throw new Error("Event is not a create transition");
  }
  return parsed;
}

export function parseTransitionEvent(
  event: NostrEvent,
  verify: (event: NostrEvent) => boolean
): TransitionRecord {
  if (event.kind !== 78) throw new Error("Event is not an order transition");
  requireHex(event.id, HEX_32, "Event ID");
  requireHex(event.pubkey, HEX_32, "Maker public key");
  requireHex(event.sig, HEX_64, "Event signature");
  if (!verify(event)) throw new Error("Event signature verification failed");

  let decoded: unknown;
  try {
    decoded = JSON.parse(event.content);
  } catch {
    throw new Error("Transition content is not valid JSON");
  }
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Transition content must be an object");
  }
  const input = decoded as Partial<StateTransitionContent>;
  if (
    input.schema !== "granola/order-transition/v1" ||
    !input.operation ||
    !["create", "reserve", "release", "fill", "cancel", "replace"].includes(input.operation) ||
    typeof input.revision !== "string" ||
    typeof input.operation_id !== "string" ||
    !input.operation_id.trim() ||
    !input.state
  ) {
    throw new Error("Transition content is incomplete");
  }
  const { state } = parseCanonicalState(input.state);
  if (input.revision !== state.revision) throw new Error("Transition revision and state mismatch");
  const isCreate = input.operation === "create";
  if (isCreate ? input.previous !== null : typeof input.previous !== "string") {
    throw new Error("Transition predecessor is invalid");
  }
  if (typeof input.previous === "string") requireHex(input.previous, HEX_32, "Transition predecessor");
  if (isCreate && (state.revision !== "0" || state.status !== "open")) {
    throw new Error("Create transition requires initial open state");
  }
  if (!isCreate && state.revision === "0") throw new Error("Successor transition requires positive revision");
  let evidence: TransitionEvidence | undefined;
  if (input.operation === "fill") {
    if (!input.evidence) throw new Error("Fill transition requires settlement commitments");
    evidence = input.evidence;
    for (const value of Object.values(evidence)) requireHex(value, HEX_32, "Settlement commitment");
  } else if (input.evidence !== undefined) {
    throw new Error("Only fill transitions carry settlement commitments");
  }
  const expectedContent: StateTransitionContent = {
    schema: "granola/order-transition/v1",
    operation_id: input.operation_id,
    operation: input.operation,
    revision: state.revision,
    previous: input.previous ?? null,
    state,
    ...(evidence ? { evidence } : {})
  };
  if (canonicalJson(decoded) !== canonicalJson(expectedContent)) {
    throw new Error("Transition content and order state must be canonical");
  }
  if (isCreate && event.created_at !== state.created_at) {
    throw new Error("Transition timestamp does not match order creation");
  }
  if (input.operation === "reserve" && event.created_at !== state.reservation?.accepted_at) {
    throw new Error("Reserve timestamp does not match reservation acceptance");
  }
  const address = orderAddress(event.pubkey, state.order_id);
  if (oneTag(event, "d") !== `granola:order-transition:v1:${state.order_id}`) {
    throw new Error("Transition order ID tag mismatch");
  }
  if (oneTag(event, "t") !== "granola-order-transition") {
    throw new Error("Transition namespace mismatch");
  }
  if (oneTag(event, "v") !== "1") throw new Error("Transition version mismatch");
  if (oneTag(event, "op") !== input.operation) throw new Error("Transition operation mismatch");
  if (oneTag(event, "a") !== address) throw new Error("Transition address tag mismatch");
  const predecessors = tagValues(event, "e");
  if (isCreate ? predecessors.length !== 0 : predecessors.length !== 1 || predecessors[0] !== input.previous) {
    throw new Error("Transition predecessor tag mismatch");
  }

  return {
    eventId: event.id,
    makerPubkey: event.pubkey,
    address,
    operationId: input.operation_id,
    operation: input.operation,
    revision: state.revision,
    previous: input.previous ?? null,
    state,
    ...(evidence ? { evidence } : {})
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
  const { state, head } = parseCanonicalState(decoded);
  if (!head) throw new Error("Projection head is required");
  if (state.revision === "0" && event.created_at !== state.created_at) {
    throw new Error("Initial projection timestamp does not match order creation");
  }
  const expectedD = `granola:order:v1:${state.order_id}`;
  if (oneTag(event, "d") !== expectedD) throw new Error("Projection order ID tag mismatch");
  if (oneTag(event, "t") !== "granola-order") throw new Error("Projection namespace mismatch");
  if (oneTag(event, "v") !== "1") throw new Error("Projection version mismatch");
  if (oneTag(event, "s") !== state.status) throw new Error("Projection status tag mismatch");
  if (oneTag(event, "side") !== state.side) throw new Error("Projection side tag mismatch");
  if (oneTag(event, "e") !== head) throw new Error("Projection head tag mismatch");
  if (oneTag(event, "expires_at") !== String(state.expires_at)) {
    throw new Error("Projection expiry tag mismatch");
  }
  if (oneTag(event, "expiration") !== String(state.expires_at + 604_800)) {
    throw new Error("Projection retention tag mismatch");
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
    verified: false,
    state
  };
}
