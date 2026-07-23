import type { NostrEvent } from "../order/events.js";
import type { StagedOrderPublication } from "../order/service.js";
import type { StorageDriver } from "./wallet-repository.js";

const OUTBOX_KEY = "granola.order-outbox.v1";
const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validEvent(value: unknown, kind: 78 | 30078): value is NostrEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<NostrEvent>;
  return event.kind === kind &&
    Number.isSafeInteger(event.created_at) &&
    typeof event.content === "string" &&
    Array.isArray(event.tags) &&
    event.tags.every((tag) => Array.isArray(tag) && tag.every((item) => typeof item === "string")) &&
    typeof event.id === "string" && HEX_32.test(event.id) &&
    typeof event.pubkey === "string" && HEX_32.test(event.pubkey) &&
    typeof event.sig === "string" && HEX_64.test(event.sig);
}

function validReceipts(value: unknown): boolean {
  return Array.isArray(value) && value.every((receipt) =>
    receipt &&
    typeof receipt === "object" &&
    typeof receipt.relay === "string" &&
    typeof receipt.ok === "boolean" &&
    typeof receipt.message === "string"
  );
}

function assertOutbox(value: unknown): asserts value is StagedOrderPublication[] {
  if (!Array.isArray(value)) throw new Error("Order outbox storage is corrupt");
  const orderIds = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      item.schema !== "granola/order-publication/v1" ||
      !item.state ||
      typeof item.state.order_id !== "string" ||
      orderIds.has(item.state.order_id) ||
      !validEvent(item.transition, 78) ||
      !validEvent(item.projection, 30078) ||
      !validReceipts(item.transitionReceipts) ||
      !validReceipts(item.projectionReceipts)
    ) {
      throw new Error("Order outbox storage is corrupt");
    }
    orderIds.add(item.state.order_id);
  }
}

export interface OrderOutboxPort {
  load(orderId: string): Promise<StagedOrderPublication | undefined>;
  list(): Promise<StagedOrderPublication[]>;
  save(publication: StagedOrderPublication): Promise<void>;
  remove(orderId: string): Promise<void>;
}

export class OrderOutboxRepository implements OrderOutboxPort {
  constructor(private readonly driver: StorageDriver) {}

  async list(): Promise<StagedOrderPublication[]> {
    const value = await this.driver.get(OUTBOX_KEY);
    if (value === undefined || value === null) return [];
    assertOutbox(value);
    return clone(value);
  }

  async load(orderId: string): Promise<StagedOrderPublication | undefined> {
    return (await this.list()).find((publication) => publication.state.order_id === orderId);
  }

  async save(publication: StagedOrderPublication): Promise<void> {
    assertOutbox([publication]);
    const existing = await this.list();
    const next = existing.filter((item) => item.state.order_id !== publication.state.order_id);
    next.push(clone(publication));
    assertOutbox(next);
    await this.driver.set(OUTBOX_KEY, next);
  }

  async remove(orderId: string): Promise<void> {
    const existing = await this.list();
    await this.driver.set(
      OUTBOX_KEY,
      existing.filter((publication) => publication.state.order_id !== orderId)
    );
  }
}
