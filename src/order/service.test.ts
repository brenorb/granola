import { describe, expect, it } from "vitest";

import type { RelayReceipt } from "../nostr/relay.js";
import type { OrderOutboxEntry } from "../storage/order-outbox.js";
import type { NostrEvent, UnsignedNostrEvent } from "./events.js";
import {
  createOrderState,
  reserveOrder,
  type OrderState
} from "./model.js";
import {
  NostrOrderService,
  type OrderRelayPort,
  type OrderSigner,
  type StagedOrderPublication
} from "./service.js";

const MAKER = "a".repeat(64);
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ADDRESS = `30078:${MAKER}:granola:order:v1:${ORDER_ID}`;

function open(): OrderState {
  return createOrderState({
    orderId: ORDER_ID,
    createdAt: 1_700_000_000,
    expiresAt: 1_700_003_600,
    side: "sell",
    baseUnit: "sat",
    quoteUnit: "usd",
    offered: { unit: "sat", mint: "https://mint.example" },
    requested: {
      unit: "usd",
      acceptableMints: ["https://quote.example"]
    },
    amount: "100",
    priceCentsPerBtc: "200000000"
  });
}

class FakeSigner implements OrderSigner {
  count = 0;
  templates: UnsignedNostrEvent[] = [];

  async publicKey() {
    return MAKER;
  }

  async sign(template: UnsignedNostrEvent): Promise<NostrEvent> {
    this.templates.push(structuredClone(template));
    this.count += 1;
    return {
      ...structuredClone(template),
      id: this.count.toString(16).padStart(64, "0"),
      pubkey: MAKER,
      sig: "b".repeat(128)
    };
  }
}

class FakeRelay implements OrderRelayPort {
  published: NostrEvent[] = [];
  marketEvents: NostrEvent[] = [];
  orderEvents: NostrEvent[] = [];
  receipts: RelayReceipt[] = [
    { relay: "wss://one.example", ok: true, message: "stored" },
    { relay: "wss://two.example", ok: false, message: "offline" }
  ];

  async publish(event: NostrEvent) {
    this.published.push(structuredClone(event));
    return structuredClone(this.receipts);
  }

  async queryProjections() {
    return structuredClone(this.marketEvents);
  }

  async queryOrder() {
    return structuredClone(this.orderEvents);
  }
}

function entry(
  publication: StagedOrderPublication,
  expectedProjectionId: string | null = null,
  expectedRevision: string | null = null,
  operation: OrderOutboxEntry["intent"]["operation"] = "create"
): OrderOutboxEntry {
  return {
    schema: "granola/order-outbox/v3",
    status: "staged",
    intent: {
      operation,
      orderId: publication.state.order_id,
      address: ADDRESS,
      expectedProjectionId,
      expectedRevision,
      compatibility: "{}",
      state: structuredClone(publication.state),
      evidence: null,
      createdAt: publication.projection.created_at
    },
    publication: structuredClone(publication)
  };
}

describe("NostrOrderService", () => {
  it("signs and stages only one complete kind 30078 projection", async () => {
    const signer = new FakeSigner();
    const service = new NostrOrderService(signer, new FakeRelay(), () => true);
    const publication = await service.stage(open());

    expect(signer.templates).toHaveLength(1);
    expect(signer.templates[0]?.kind).toBe(30078);
    expect(publication).toEqual({
      schema: "granola/order-publication/v1",
      state: open(),
      projection: expect.objectContaining({ kind: 30078 }),
      receipts: []
    });
  });

  it("acknowledges after any one configured relay accepts the exact event", async () => {
    const relay = new FakeRelay();
    const service = new NostrOrderService(new FakeSigner(), relay, () => true);
    const staged = entry(await service.stage(open()));

    const result = await service.publishNextStage(staged);

    expect(result.status).toBe("acknowledged");
    expect(relay.published).toEqual([staged.publication.projection]);
    expect(result.publication.receipts.filter((receipt) => receipt.ok)).toHaveLength(1);
  });

  it("retries the exact signed projection after publication failure", async () => {
    const relay = new FakeRelay();
    relay.receipts = [
      { relay: "wss://one.example", ok: false, message: "offline" }
    ];
    const service = new NostrOrderService(new FakeSigner(), relay, () => true);
    const staged = entry(await service.stage(open()));
    const failed = await service.publishNextStage(staged);
    relay.receipts = [
      { relay: "wss://one.example", ok: true, message: "stored" }
    ];

    const retried = await service.publishNextStage(failed);

    expect(retried.status).toBe("acknowledged");
    expect(relay.published.map((event) => event.id)).toEqual([
      staged.publication.projection.id,
      staged.publication.projection.id
    ]);
  });

  it("replaces the same d tag with a monotonic reserved revision", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => true);
    const initial = await service.stage(open());
    relay.orderEvents = [initial.projection];
    const reserved = reserveOrder(open(), {
      reservationId: "22222222-2222-4222-8222-222222222222",
      amount: "100",
      acceptedAt: 1_700_000_001,
      expiresAt: 1_700_000_600,
      proposalEventId: "d".repeat(64),
      takerCommitment: "e".repeat(64)
    });

    const successor = await service.stageSuccessor(
      reserved,
      "reserve",
      initial.projection,
      1_700_000_001
    );

    expect(successor.state.revision).toBe("1");
    expect(successor.projection.tags.find((tag) => tag[0] === "d")).toEqual(
      initial.projection.tags.find((tag) => tag[0] === "d")
    );
    expect(successor.projection.tags.some((tag) => tag[0] === "e")).toBe(false);
  });

  it("rejects stale successor publication before contacting relays", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => true);
    const initial = await service.stage(open());
    const reserved = reserveOrder(open(), {
      reservationId: "22222222-2222-4222-8222-222222222222",
      amount: "100",
      acceptedAt: 1_700_000_001,
      expiresAt: 1_700_000_600,
      proposalEventId: "d".repeat(64),
      takerCommitment: "e".repeat(64)
    });
    const successor = await service.stageSuccessor(
      reserved,
      "reserve",
      initial.projection,
      1_700_000_001
    );
    relay.orderEvents = [{ ...initial.projection, id: "f".repeat(64) }];

    await expect(service.publishNextStage(entry(
      successor,
      initial.projection.id,
      "0",
      "reserve"
    ))).rejects.toThrow(/stale/i);
    expect(relay.published).toEqual([]);
  });

  it("builds the book from the newest verified replacement only", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => true);
    const initial = await service.stage(open());
    const later = {
      ...initial.projection,
      id: "f".repeat(64),
      created_at: initial.projection.created_at + 1,
      content: JSON.stringify({ ...open(), revision: "1" })
    };
    relay.marketEvents = [initial.projection, later];

    const result = await service.loadBook({
      baseUnit: "sat",
      baseMint: "https://mint.example",
      quoteUnit: "usd",
      quoteMint: "https://quote.example"
    }, 1_700_000_100);

    expect(result.book.asks[0]?.eventId).toBe(later.id);
    expect(result.rejected).toBe(1);
  });
});
