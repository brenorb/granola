import { verifyEvent } from "nostr-tools/pure";

import type { OrderOperationEvidence } from "../order/events.js";
import type { OrderState } from "../order/model.js";
import type {
  StagedOrderPublication,
  SuccessorOperation
} from "../order/service.js";
import type { StorageDriver } from "./wallet-repository.js";

// The projection-only format stores the exact signed artifact required for
// publication retries and local recovery.
const OUTBOX_KEY = "granola.order-outbox.v3";
const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;

export type OrderPublicationOperation = "create" | SuccessorOperation;
export type OrderPublicationStatus = "staged" | "acknowledged" | "committed";

export interface OrderPublicationIntent {
  operation: OrderPublicationOperation;
  orderId: string;
  address: string;
  expectedProjectionId: string | null;
  expectedRevision: string | null;
  compatibility: string;
  state: OrderState;
  evidence: OrderOperationEvidence | null;
  createdAt: number;
}

export interface OrderOutboxEntry {
  schema: "granola/order-outbox/v3";
  status: OrderPublicationStatus;
  intent: OrderPublicationIntent;
  publication: StagedOrderPublication;
}

export class OrderOutboxConflictError extends Error {
  constructor(message = "Order projection intent conflicts with the durable outbox") {
    super(message);
    this.name = "OrderOutboxConflictError";
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Value cannot be canonically encoded");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

export function canonicalOrderPublicationCompatibility(value: unknown): string {
  return canonical(value);
}

function validProjection(
  value: unknown,
  verify: (event: StagedOrderPublication["projection"]) => boolean
): boolean {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return event.kind === 30078 &&
    Number.isSafeInteger(event.created_at) &&
    typeof event.content === "string" &&
    Array.isArray(event.tags) &&
    event.tags.every((tag) =>
      Array.isArray(tag) && tag.every((item) => typeof item === "string")
    ) &&
    typeof event.id === "string" && HEX_32.test(event.id) &&
    typeof event.pubkey === "string" && HEX_32.test(event.pubkey) &&
    typeof event.sig === "string" && HEX_64.test(event.sig) &&
    verify(value as StagedOrderPublication["projection"]);
}

function validateReceipts(value: unknown): number {
  if (!Array.isArray(value)) throw new Error("Order outbox receipts are corrupt");
  const relays = new Set<string>();
  let accepted = 0;
  for (const receipt of value) {
    if (
      !receipt ||
      typeof receipt !== "object" ||
      typeof receipt.relay !== "string" ||
      typeof receipt.ok !== "boolean" ||
      typeof receipt.message !== "string"
    ) {
      throw new Error("Order outbox receipts are corrupt");
    }
    const url = new URL(receipt.relay);
    if (
      url.protocol !== "wss:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Order outbox receipt relay is invalid");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    const normalized = url.toString().replace(/\/$/, "");
    if (normalized !== receipt.relay || relays.has(normalized)) {
      throw new Error("Order outbox receipt relays must be canonical and unique");
    }
    relays.add(normalized);
    if (receipt.ok) accepted += 1;
  }
  return accepted;
}

function assertIntent(value: unknown): asserts value is OrderPublicationIntent {
  if (!value || typeof value !== "object") {
    throw new Error("Order outbox intent is corrupt");
  }
  const intent = value as Record<string, unknown>;
  if (
    !["create", "reserve", "fill", "release", "cancel", "expire"]
      .includes(String(intent.operation)) ||
    typeof intent.orderId !== "string" ||
    typeof intent.address !== "string" ||
    !(intent.expectedProjectionId === null ||
      (typeof intent.expectedProjectionId === "string" &&
        HEX_32.test(intent.expectedProjectionId))) ||
    !(intent.expectedRevision === null ||
      (typeof intent.expectedRevision === "string" &&
        /^(0|[1-9]\d*)$/.test(intent.expectedRevision))) ||
    typeof intent.compatibility !== "string" ||
    intent.compatibility.length === 0 ||
    !intent.state ||
    typeof intent.state !== "object" ||
    (intent.state as { order_id?: unknown }).order_id !== intent.orderId ||
    !(intent.evidence === null || typeof intent.evidence === "object") ||
    !Number.isSafeInteger(intent.createdAt) ||
    (intent.createdAt as number) < 0
  ) {
    throw new Error("Order outbox intent is corrupt");
  }
  try {
    if (canonical(JSON.parse(intent.compatibility as string)) !== intent.compatibility) {
      throw new Error("Order outbox intent is corrupt");
    }
  } catch {
    throw new Error("Order outbox intent is corrupt");
  }
  if (
    (intent.operation === "create") !==
      (intent.expectedProjectionId === null && intent.expectedRevision === null)
  ) {
    throw new Error("Order outbox intent is corrupt");
  }
}

function assertEntry(
  value: unknown,
  verify: (event: StagedOrderPublication["projection"]) => boolean
): asserts value is OrderOutboxEntry {
  if (!value || typeof value !== "object") {
    throw new Error("Order outbox storage is corrupt");
  }
  const entry = value as Record<string, unknown>;
  if (
    entry.schema !== "granola/order-outbox/v3" ||
    !["staged", "acknowledged", "committed"].includes(String(entry.status))
  ) {
    throw new Error("Order outbox storage is corrupt");
  }
  assertIntent(entry.intent);
  if (!entry.publication || typeof entry.publication !== "object") {
    throw new Error("Order outbox storage is corrupt");
  }
  const publication = entry.publication as unknown as StagedOrderPublication;
  const intent = entry.intent as unknown as OrderPublicationIntent;
  const accepted = validateReceipts(publication.receipts);
  const status = entry.status as OrderPublicationStatus;
  if (
    publication.schema !== "granola/order-publication/v1" ||
    !same(publication.state, intent.state) ||
    !validProjection(publication.projection, verify) ||
    (status === "staged" ? accepted !== 0 : accepted < 1) ||
    publication.projection.created_at !== intent.createdAt
  ) {
    throw new Error("Order outbox storage is corrupt");
  }
  let projectionState: unknown;
  try {
    projectionState = JSON.parse(publication.projection.content);
  } catch {
    throw new Error("Order outbox storage is corrupt");
  }
  const dTags = publication.projection.tags
    .filter((tag) => tag[0] === "d")
    .map((tag) => tag[1]);
  const predecessorTags = publication.projection.tags
    .filter((tag) => tag[0] === "e");
  if (
    !same(projectionState, intent.state) ||
    dTags.length !== 1 ||
    intent.address !==
      `30078:${publication.projection.pubkey}:${dTags[0]}` ||
    predecessorTags.length !== 0
  ) {
    throw new Error("Order outbox storage is corrupt");
  }
}

function assertOutbox(
  value: unknown,
  verify: (event: StagedOrderPublication["projection"]) => boolean
): asserts value is OrderOutboxEntry[] {
  if (!Array.isArray(value)) throw new Error("Order outbox storage is corrupt");
  const orderIds = new Set<string>();
  for (const entry of value) {
    assertEntry(entry, verify);
    if (orderIds.has(entry.intent.orderId)) {
      throw new Error("Order outbox storage is corrupt");
    }
    orderIds.add(entry.intent.orderId);
  }
}

function mergeReceipts(
  previous: StagedOrderPublication["receipts"],
  current: StagedOrderPublication["receipts"]
): StagedOrderPublication["receipts"] {
  const receipts = new Map(previous.map((receipt) => [receipt.relay, receipt]));
  for (const receipt of current) {
    const existing = receipts.get(receipt.relay);
    if (!existing?.ok || receipt.ok) receipts.set(receipt.relay, receipt);
  }
  return [...receipts.values()];
}

function mergeExact(existing: OrderOutboxEntry, next: OrderOutboxEntry): OrderOutboxEntry {
  if (
    !same(existing.intent, next.intent) ||
    existing.publication.projection.id !== next.publication.projection.id ||
    !same(existing.publication.projection, next.publication.projection)
  ) {
    throw new OrderOutboxConflictError();
  }
  if (next.status === "committed") {
    throw new OrderOutboxConflictError("Order projection status skipped a durable stage");
  }
  const receipts = mergeReceipts(
    existing.publication.receipts,
    next.publication.receipts
  );
  return {
    ...clone(existing),
    status: validateReceipts(receipts) >= 1 ? "acknowledged" : "staged",
    publication: {
      ...clone(existing.publication),
      receipts
    }
  };
}

export interface OrderOutboxPort {
  load(orderId: string): Promise<OrderOutboxEntry | undefined>;
  list(): Promise<OrderOutboxEntry[]>;
  ensureStaged(
    intent: OrderPublicationIntent,
    stage: () => Promise<StagedOrderPublication>
  ): Promise<OrderOutboxEntry>;
  recordProgress(entry: OrderOutboxEntry): Promise<OrderOutboxEntry>;
  loadAcknowledged(orderId: string): Promise<OrderOutboxEntry | undefined>;
  clearAcknowledged(orderId: string): Promise<OrderOutboxEntry>;
  pruneCommitted(orderId: string): Promise<void>;
}

export type OrderOutboxExclusiveRunner = <T>(action: () => Promise<T>) => Promise<T>;

const withoutCrossTabLock: OrderOutboxExclusiveRunner = async <T>(
  action: () => Promise<T>
): Promise<T> => action();

export class OrderOutboxRepository implements OrderOutboxPort {
  constructor(
    private readonly driver: StorageDriver,
    private readonly runExclusive: OrderOutboxExclusiveRunner = withoutCrossTabLock,
    private readonly verify: (event: StagedOrderPublication["projection"]) => boolean =
      (event) => verifyEvent(event)
  ) {}

  private async read(): Promise<OrderOutboxEntry[]> {
    const value = await this.driver.get(OUTBOX_KEY);
    if (value === undefined || value === null) return [];
    assertOutbox(value, this.verify);
    return clone(value);
  }

  private async write(entries: OrderOutboxEntry[]): Promise<void> {
    assertOutbox(entries, this.verify);
    await this.driver.set(OUTBOX_KEY, clone(entries));
  }

  async list(): Promise<OrderOutboxEntry[]> {
    return this.read();
  }

  async load(orderId: string): Promise<OrderOutboxEntry | undefined> {
    return (await this.read()).find((entry) => entry.intent.orderId === orderId);
  }

  async ensureStaged(
    intent: OrderPublicationIntent,
    stage: () => Promise<StagedOrderPublication>
  ): Promise<OrderOutboxEntry> {
    assertIntent(intent);
    return this.runExclusive(async () => {
      const entries = await this.read();
      const existing = entries.find((entry) => entry.intent.orderId === intent.orderId);
      if (existing) {
        if (same(existing.intent, intent)) return clone(existing);
        if (existing.status !== "committed") throw new OrderOutboxConflictError();
      }
      const entry: OrderOutboxEntry = {
        schema: "granola/order-outbox/v3",
        status: "staged",
        intent: clone(intent),
        publication: await stage()
      };
      assertEntry(entry, this.verify);
      const index = entries.findIndex((item) => item.intent.orderId === intent.orderId);
      if (index < 0) entries.push(entry);
      else entries[index] = entry;
      await this.write(entries);
      return clone(entry);
    });
  }

  async recordProgress(entry: OrderOutboxEntry): Promise<OrderOutboxEntry> {
    assertEntry(entry, this.verify);
    return this.runExclusive(async () => {
      const entries = await this.read();
      const index = entries.findIndex((item) => item.intent.orderId === entry.intent.orderId);
      if (index < 0) {
        throw new OrderOutboxConflictError(
          "Order projection disappeared before progress was saved"
        );
      }
      const merged = mergeExact(entries[index]!, entry);
      entries[index] = merged;
      await this.write(entries);
      return clone(merged);
    });
  }

  async loadAcknowledged(orderId: string): Promise<OrderOutboxEntry | undefined> {
    const entry = await this.load(orderId);
    return entry?.status === "acknowledged" ? entry : undefined;
  }

  async clearAcknowledged(orderId: string): Promise<OrderOutboxEntry> {
    return this.runExclusive(async () => {
      const entries = await this.read();
      const index = entries.findIndex((entry) => entry.intent.orderId === orderId);
      if (index < 0) throw new Error("No acknowledged order projection exists");
      const existing = entries[index]!;
      if (existing.status === "committed") return clone(existing);
      if (existing.status !== "acknowledged") {
        throw new Error("Order projection is not acknowledged");
      }
      const committed: OrderOutboxEntry = { ...existing, status: "committed" };
      entries[index] = committed;
      await this.write(entries);
      return clone(committed);
    });
  }

  async pruneCommitted(orderId: string): Promise<void> {
    await this.runExclusive(async () => {
      const entries = await this.read();
      const existing = entries.find((entry) => entry.intent.orderId === orderId);
      if (!existing) return;
      if (existing.status !== "committed") {
        throw new Error("Only a committed order projection can be pruned");
      }
      await this.write(entries.filter((entry) => entry.intent.orderId !== orderId));
    });
  }
}
