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

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;

function orderAddress(pubkey: string, orderId: string): string {
  return `30078:${pubkey}:granola:order:v1:${orderId}`;
}

function requireHex(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new Error(`${label} must be lowercase hex`);
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

function parseOpenState(value: unknown): { state: OrderState; head: string } {
  if (!value || typeof value !== "object") throw new Error("Projection content must be an object");
  const input = value as Partial<ProjectionContent>;
  if (input.schema !== "granola/order/v1") throw new Error("Unknown order schema");
  if (typeof input.head !== "string") throw new Error("Projection head is required");
  requireHex(input.head, HEX_32, "Projection head");
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

  const state = createOrderState({
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

  if (
    input.revision !== "0" ||
    input.remaining_amount !== state.original_amount ||
    input.reserved_amount !== "0" ||
    input.status !== "open" ||
    input.reservation !== null ||
    input.replaces !== null ||
    input.replaced_by !== null
  ) {
    throw new Error("Only canonical open revision-zero projections are supported");
  }
  return { state, head: input.head };
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
  const { state, head } = parseOpenState(decoded);
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
    verified: true,
    state
  };
}
