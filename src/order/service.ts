import { verifyEvent } from "nostr-tools/pure";

import type { RelayReceipt } from "../nostr/relay.js";
import type { OrderOutboxEntry } from "../storage/order-outbox.js";
import {
  createProjectionTemplate,
  orderAddress,
  parseProjectionEvent,
  type NostrEvent,
  type UnsignedNostrEvent
} from "./events.js";
import {
  buildOrderBook,
  fillOrder,
  marketId,
  reserveOrder,
  type ExactMarket,
  type OrderBook,
  type OrderRecord,
  type OrderState
} from "./model.js";

export type SuccessorOperation = "reserve" | "release" | "fill" | "cancel" | "expire";

export interface OrderSigner {
  publicKey(): Promise<string>;
  sign(template: UnsignedNostrEvent): Promise<NostrEvent>;
}

export interface OrderRelayPort {
  publish(event: NostrEvent): Promise<RelayReceipt[]>;
  queryProjections(market: string, since: number): Promise<NostrEvent[]>;
  queryOrder(address: string): Promise<NostrEvent[]>;
}

export interface StagedOrderPublication {
  schema: "granola/order-publication/v1";
  state: OrderState;
  projection: NostrEvent;
  receipts: RelayReceipt[];
}

export interface LoadedOrderBook {
  book: OrderBook;
  rejected: number;
}

export interface PublishedOrderProjection {
  eventId: string;
  revision: string;
  projection: NostrEvent;
  record: OrderRecord;
}

function assertMaker(event: NostrEvent, expected: string): void {
  if (event.pubkey !== expected) {
    throw new Error("Signer returned the wrong maker public key");
  }
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

function sameState(left: OrderState, right: OrderState): boolean {
  return canonical(left) === canonical(right);
}

function accepted(receipts: RelayReceipt[]): boolean {
  return new Set(
    receipts.filter((receipt) => receipt.ok).map((receipt) => receipt.relay)
  ).size >= 1;
}

function assertUniqueReceipts(receipts: RelayReceipt[]): void {
  const relays = receipts.map((receipt) => receipt.relay);
  if (new Set(relays).size !== relays.length) {
    throw new Error("Relay publication returned duplicate receipt URLs");
  }
}

function mergeReceipts(previous: RelayReceipt[], current: RelayReceipt[]): RelayReceipt[] {
  const byRelay = new Map(previous.map((receipt) => [receipt.relay, receipt]));
  for (const receipt of current) {
    const existing = byRelay.get(receipt.relay);
    if (!existing?.ok || receipt.ok) byRelay.set(receipt.relay, receipt);
  }
  return [...byRelay.values()];
}

function assertStaticTerms(previous: OrderState, next: OrderState): void {
  const mutable = new Set([
    "revision",
    "remaining_amount",
    "reserved_amount",
    "status",
    "reservation",
    "replaced_by"
  ]);
  const stablePrevious = Object.fromEntries(
    Object.entries(previous).filter(([key]) => !mutable.has(key))
  );
  const stableNext = Object.fromEntries(
    Object.entries(next).filter(([key]) => !mutable.has(key))
  );
  if (canonical(stablePrevious) !== canonical(stableNext)) {
    throw new Error("Order projection changed immutable terms");
  }
}

function assertSuccessorState(
  previous: OrderState,
  operation: SuccessorOperation,
  next: OrderState,
  createdAt: number
): void {
  if (next.order_id !== previous.order_id) throw new Error("Successor order ID changed");
  if (BigInt(next.revision) !== BigInt(previous.revision) + 1n) {
    throw new Error("Successor revision is not monotonic");
  }
  assertStaticTerms(previous, next);
  let expected: OrderState | undefined;
  if (operation === "reserve") {
    const reservation = next.reservation;
    if (!reservation) throw new Error("Reserved projection is missing reservation state");
    expected = reserveOrder(previous, {
      reservationId: reservation.id,
      amount: reservation.amount,
      acceptedAt: reservation.accepted_at,
      expiresAt: reservation.expires_at,
      proposalEventId: reservation.proposal_event_id,
      takerCommitment: reservation.taker_commitment
    });
  } else if (operation === "fill") {
    const reservation = previous.reservation;
    if (!reservation) throw new Error("Fill requires a reserved projection");
    expected = fillOrder(previous, {
      reservationId: reservation.id,
      amount: reservation.amount
    });
  } else if (operation === "release") {
    const reservation = previous.reservation;
    if (!reservation) throw new Error("Release requires a reserved projection");
    if (
      next.reservation !== null ||
      next.reserved_amount !== "0" ||
      next.remaining_amount !== previous.remaining_amount ||
      !["open", "partially_filled"].includes(next.status)
    ) {
      throw new Error("Release projection is invalid");
    }
  } else if (operation === "cancel") {
    if (next.status !== "canceled" || next.reservation !== null) {
      throw new Error("Canceled projection is invalid");
    }
  } else if (operation === "expire") {
    if (createdAt < previous.expires_at || next.status !== "expired") {
      throw new Error("Expired projection is invalid");
    }
  }
  if (expected && !sameState(expected, next)) {
    throw new Error(`Invalid ${operation} order projection`);
  }
}

function replaceableOrder(events: NostrEvent[]): NostrEvent | undefined {
  return [...events].sort((left, right) =>
    right.created_at - left.created_at || left.id.localeCompare(right.id)
  )[0];
}

export class NostrOrderService {
  constructor(
    private readonly signer: OrderSigner,
    private readonly relays: OrderRelayPort,
    private readonly verify: (event: NostrEvent) => boolean =
      (event) => verifyEvent(event)
  ) {}

  async stage(state: OrderState): Promise<StagedOrderPublication> {
    const maker = await this.signer.publicKey();
    const projection = await this.signer.sign(
      await createProjectionTemplate(state, maker)
    );
    assertMaker(projection, maker);
    return {
      schema: "granola/order-publication/v1",
      state: structuredClone(state),
      projection,
      receipts: []
    };
  }

  async stageSuccessor(
    state: OrderState,
    operation: SuccessorOperation,
    previous: NostrEvent,
    createdAt: number
  ): Promise<StagedOrderPublication> {
    const maker = await this.signer.publicKey();
    const previousRecord = await parseProjectionEvent(previous, this.verify);
    if (previousRecord.makerPubkey !== maker) {
      throw new Error("Previous projection belongs to another maker");
    }
    if (createdAt <= previous.created_at) {
      throw new Error("Successor projection timestamp must advance");
    }
    assertSuccessorState(previousRecord.state, operation, state, createdAt);
    const projection = await this.signer.sign(
      await createProjectionTemplate(state, maker, createdAt)
    );
    assertMaker(projection, maker);
    return {
      schema: "granola/order-publication/v1",
      state: structuredClone(state),
      projection,
      receipts: []
    };
  }

  private async validateOutboxEntry(entry: OrderOutboxEntry): Promise<OrderRecord> {
    const projection = await parseProjectionEvent(
      entry.publication.projection,
      this.verify
    );
    if (
      entry.schema !== "granola/order-outbox/v2" ||
      entry.publication.schema !== "granola/order-publication/v1" ||
      projection.address !== entry.intent.address ||
      projection.eventId !== entry.publication.projection.id ||
      projection.state.order_id !== entry.intent.orderId ||
      entry.publication.projection.created_at !== entry.intent.createdAt ||
      !sameState(projection.state, entry.intent.state) ||
      !sameState(entry.publication.state, entry.intent.state)
    ) {
      throw new Error("Durable order projection is inconsistent");
    }
    return projection;
  }

  private async assertPublishPosition(
    entry: OrderOutboxEntry,
    projection: OrderRecord
  ): Promise<void> {
    const current = await this.currentProjection(projection.address);
    if (current?.event.id === entry.publication.projection.id) return;
    if (entry.intent.expectedProjectionId === null) {
      if (current) throw new Error("Order address is already published");
      return;
    }
    if (
      !current ||
      current.event.id !== entry.intent.expectedProjectionId ||
      current.record.state.revision !== entry.intent.expectedRevision
    ) {
      throw new Error("Staged order projection is stale");
    }
  }

  async publishNextStage(entry: OrderOutboxEntry): Promise<OrderOutboxEntry> {
    const projection = await this.validateOutboxEntry(entry);
    if (entry.status === "acknowledged" || entry.status === "committed") {
      return structuredClone(entry);
    }
    await this.assertPublishPosition(entry, projection);
    const receipts = await this.relays.publish(entry.publication.projection);
    assertUniqueReceipts(receipts);
    const publication = {
      ...structuredClone(entry.publication),
      receipts: mergeReceipts(entry.publication.receipts, receipts)
    };
    return {
      ...structuredClone(entry),
      status: accepted(publication.receipts) ? "acknowledged" : "staged",
      publication
    };
  }

  private async currentProjection(
    address: string
  ): Promise<{ event: NostrEvent; record: OrderRecord } | undefined> {
    const valid: Array<{ event: NostrEvent; record: OrderRecord }> = [];
    for (const event of await this.relays.queryOrder(address)) {
      try {
        const record = await parseProjectionEvent(event, this.verify);
        if (record.address === address) valid.push({ event, record });
      } catch {
        // Untrusted relay data cannot become the current projection.
      }
    }
    const current = replaceableOrder(valid.map(({ event }) => event));
    return current
      ? valid.find(({ event }) => event.id === current.id)
      : undefined;
  }

  async loadCurrentProjection(
    address: string,
    expectedProjectionId: string,
    expectedRevision: string
  ): Promise<NostrEvent> {
    const current = await this.currentProjection(address);
    if (
      !current ||
      current.event.id !== expectedProjectionId ||
      current.record.state.revision !== expectedRevision
    ) {
      throw new Error("Expected projection is not current");
    }
    return structuredClone(current.event);
  }

  async loadPublishedProjection(
    address: string,
    expectedProjectionId: string,
    expectedRevision: string
  ): Promise<PublishedOrderProjection> {
    const projection = await this.loadCurrentProjection(
      address,
      expectedProjectionId,
      expectedRevision
    );
    return {
      eventId: projection.id,
      revision: expectedRevision,
      projection,
      record: await parseProjectionEvent(projection, this.verify)
    };
  }

  async loadBook(market: ExactMarket, now: number): Promise<LoadedOrderBook> {
    const selectedMarket = await marketId(market);
    const events = await this.relays.queryProjections(selectedMarket, 0);
    let rejected = 0;
    const byAddress = new Map<
      string,
      Array<{ event: NostrEvent; record: OrderRecord }>
    >();
    for (const event of events) {
      try {
        const record = await parseProjectionEvent(event, this.verify);
        const candidates = byAddress.get(record.address) ?? [];
        candidates.push({ event, record });
        byAddress.set(record.address, candidates);
      } catch {
        rejected += 1;
      }
    }

    const records: OrderRecord[] = [];
    for (const candidates of byAddress.values()) {
      const current = replaceableOrder(candidates.map(({ event }) => event));
      const selected = current
        ? candidates.find(({ event }) => event.id === current.id)
        : undefined;
      if (selected) records.push(selected.record);
      rejected += Math.max(0, candidates.length - 1);
    }
    return {
      book: await buildOrderBook(records, market, now),
      rejected
    };
  }
}

export function projectionAddress(pubkey: string, state: OrderState): string {
  return orderAddress(pubkey, state.order_id);
}
