import { describe, expect, it } from "vitest";

import type { NostrEvent, UnsignedNostrEvent } from "../order/events.js";
import { NostrOrderService, type OrderRelayPort } from "../order/service.js";
import { OrderOutboxRepository } from "../storage/order-outbox.js";
import type { StorageDriver } from "../storage/wallet-repository.js";
import { OrderApi } from "./order-api.js";

const MAKER = "a".repeat(64);
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const RESERVATION_ID = "22222222-2222-4222-8222-222222222222";

class MemoryDriver implements StorageDriver {
  data = new Map<string, unknown>();
  writes = 0;

  async get(key: string) {
    return structuredClone(this.data.get(key));
  }

  async set(key: string, value: unknown) {
    this.writes += 1;
    this.data.set(key, structuredClone(value));
  }

  async delete(key: string) {
    this.data.delete(key);
  }
}

class FakeSigner {
  count = 0;

  async publicKey() {
    return MAKER;
  }

  async sign(template: UnsignedNostrEvent): Promise<NostrEvent> {
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
  orderEvents: NostrEvent[] = [];
  accept = true;
  writesAtPublish: number[] = [];

  constructor(private readonly driver: MemoryDriver) {}

  async publish(event: NostrEvent) {
    this.writesAtPublish.push(this.driver.writes);
    this.published.push(structuredClone(event));
    return [{
      relay: "wss://one.example",
      ok: this.accept,
      message: this.accept ? "stored" : "offline"
    }];
  }

  async queryProjections() {
    return [];
  }

  async queryOrder() {
    return structuredClone(this.orderEvents);
  }
}

function harness(now = 1_700_000_000) {
  let currentNow = now;
  const driver = new MemoryDriver();
  const relay = new FakeRelay(driver);
  const signer = new FakeSigner();
  const outbox = new OrderOutboxRepository(driver, undefined, () => true);
  const service = new NostrOrderService(signer, relay, () => true);
  const api = new OrderApi(
    signer,
    service,
    () => currentNow,
    () => ORDER_ID,
    outbox,
    () => true
  );
  return {
    api,
    driver,
    relay,
    signer,
    outbox,
    setNow(value: number) {
      currentNow = value;
    }
  };
}

const createInput = {
  side: "sell" as const,
  amount: "100",
  priceCentsPerBtc: "200000000"
};

describe("OrderApi projections", () => {
  it("persists the signed projection before publishing and accepts one relay", async () => {
    const { api, driver, relay } = harness();

    const result = await api.publishOrder(createInput);

    expect(result).toMatchObject({
      orderId: ORDER_ID,
      makerPubkey: MAKER,
      revision: "0",
      status: "acknowledged"
    });
    expect(relay.published).toHaveLength(1);
    expect(relay.published[0]?.kind).toBe(30078);
    expect(relay.writesAtPublish[0]).toBeGreaterThan(0);
    expect(driver.writes).toBeGreaterThanOrEqual(2);
  });

  it("retries the exact persisted projection after relay failure", async () => {
    const { api, relay } = harness();
    relay.accept = false;
    const failed = await api.publishOrder(createInput);
    relay.accept = true;

    const retried = await api.retryOrderPublication(ORDER_ID);

    expect(failed.status).toBe("staged");
    expect(retried.status).toBe("acknowledged");
    expect(relay.published.map((event) => event.id)).toEqual([
      failed.projectionId,
      failed.projectionId
    ]);
  });

  it("reserves by replacing the exact projection and advancing revision", async () => {
    const { api, relay, outbox } = harness();
    const created = await api.publishOrder(createInput);
    await api.clearAcknowledgedOrderPublication(ORDER_ID);
    const initial = relay.published[0]!;
    relay.orderEvents = [initial];

    const reserved = await api.reserveOrder({
      address: `30078:${MAKER}:granola:order:v1:${ORDER_ID}`,
      expectedProjectionId: created.projectionId,
      expectedRevision: "0",
      reservationId: RESERVATION_ID,
      amount: "100",
      expiresAt: 1_700_000_600,
      proposalEventId: "c".repeat(64),
      takerCommitment: "d".repeat(64)
    });

    expect(reserved.status).toBe("acknowledged");
    expect(reserved.revision).toBe("1");
    expect(reserved.projectionId).not.toBe(created.projectionId);
    expect(relay.published[1]?.tags.find((tag) => tag[0] === "d")).toEqual(
      initial.tags.find((tag) => tag[0] === "d")
    );
    expect((await outbox.load(ORDER_ID))?.publication.state.status).toBe("reserved");
  });

  it("rejects a stale event ID or revision before signing a replacement", async () => {
    const { api, relay, signer } = harness();
    const created = await api.publishOrder(createInput);
    await api.clearAcknowledgedOrderPublication(ORDER_ID);
    relay.orderEvents = [relay.published[0]!];
    const signedBefore = signer.count;

    await expect(api.reserveOrder({
      address: `30078:${MAKER}:granola:order:v1:${ORDER_ID}`,
      expectedProjectionId: created.projectionId,
      expectedRevision: "9",
      reservationId: RESERVATION_ID,
      amount: "100",
      expiresAt: 1_700_000_600,
      proposalEventId: "c".repeat(64),
      takerCommitment: "d".repeat(64)
    })).rejects.toThrow(/current|revision|stale/i);
    expect(signer.count).toBe(signedBefore);
  });

  it("publishes canceled and expired terminal states at the same address", async () => {
    const canceledHarness = harness();
    const created = await canceledHarness.api.publishOrder(createInput);
    await canceledHarness.api.clearAcknowledgedOrderPublication(ORDER_ID);
    canceledHarness.relay.orderEvents = [canceledHarness.relay.published[0]!];
    const canceled = await canceledHarness.api.cancelOrder({
      address: `30078:${MAKER}:granola:order:v1:${ORDER_ID}`,
      expectedProjectionId: created.projectionId,
      expectedRevision: "0"
    });
    expect(canceled.revision).toBe("1");
    expect(canceledHarness.relay.published[1]?.content)
      .toContain('"status":"canceled"');

    const expiredHarness = harness(1_700_000_000);
    const expiring = await expiredHarness.api.publishOrder({
      ...createInput,
      expiresAt: 1_700_000_001
    });
    await expiredHarness.api.clearAcknowledgedOrderPublication(ORDER_ID);
    expiredHarness.relay.orderEvents = [expiredHarness.relay.published[0]!];
    expiredHarness.setNow(1_700_000_002);
    const expired = await expiredHarness.api.expireOrder({
      address: `30078:${MAKER}:granola:order:v1:${ORDER_ID}`,
      expectedProjectionId: expiring.projectionId,
      expectedRevision: "0"
    });
    expect(expiredHarness.relay.published[1]?.content)
      .toContain('"status":"expired"');
    expect(expired.revision).toBe("1");
  });
});
