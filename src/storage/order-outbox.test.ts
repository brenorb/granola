import { describe, expect, it } from "vitest";

import { createProjectionTemplate, type NostrEvent } from "../order/events.js";
import { createOrderState } from "../order/model.js";
import type { StagedOrderPublication } from "../order/service.js";
import {
  OrderOutboxConflictError,
  OrderOutboxRepository,
  canonicalOrderPublicationCompatibility,
  type OrderPublicationIntent
} from "./order-outbox.js";
import type { StorageDriver } from "./wallet-repository.js";

const MAKER = "a".repeat(64);
const ORDER_ID = "11111111-1111-4111-8111-111111111111";

class MemoryDriver implements StorageDriver {
  data = new Map<string, unknown>();
  writes: unknown[] = [];

  async get(key: string) {
    return structuredClone(this.data.get(key));
  }

  async set(key: string, value: unknown) {
    this.writes.push(structuredClone(value));
    this.data.set(key, structuredClone(value));
  }

  async delete(key: string) {
    this.data.delete(key);
  }
}

function state() {
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

async function publication(): Promise<StagedOrderPublication> {
  const projection: NostrEvent = {
    ...await createProjectionTemplate(state(), MAKER),
    id: "b".repeat(64),
    pubkey: MAKER,
    sig: "c".repeat(128)
  };
  return {
    schema: "granola/order-publication/v1",
    state: state(),
    projection,
    receipts: []
  };
}

function intent(): OrderPublicationIntent {
  return {
    operation: "create",
    orderId: ORDER_ID,
    address: `30078:${MAKER}:granola:order:v1:${ORDER_ID}`,
    expectedProjectionId: null,
    expectedRevision: null,
    compatibility: canonicalOrderPublicationCompatibility({
      operation: "create",
      orderId: ORDER_ID
    }),
    state: state(),
    evidence: null,
    createdAt: state().created_at
  };
}

describe("OrderOutboxRepository", () => {
  it("persists the exact signed projection before returning it to the publisher", async () => {
    const driver = new MemoryDriver();
    const repository = new OrderOutboxRepository(driver, undefined, () => true);
    const signed = await publication();

    const staged = await repository.ensureStaged(intent(), async () => signed);

    expect(driver.writes).toHaveLength(1);
    expect(staged.publication.projection).toEqual(signed.projection);
    await expect(repository.load(ORDER_ID)).resolves.toEqual(staged);
  });

  it("returns the persisted signed event for an idempotent repeated intent", async () => {
    const repository = new OrderOutboxRepository(
      new MemoryDriver(),
      undefined,
      () => true
    );
    const first = await repository.ensureStaged(intent(), publication);
    let resigned = false;
    const second = await repository.ensureStaged(intent(), async () => {
      resigned = true;
      return publication();
    });

    expect(resigned).toBe(false);
    expect(second.publication.projection.id).toBe(first.publication.projection.id);
  });

  it("records one-relay acknowledgement without changing the event", async () => {
    const repository = new OrderOutboxRepository(
      new MemoryDriver(),
      undefined,
      () => true
    );
    const staged = await repository.ensureStaged(intent(), publication);
    const acknowledged = await repository.recordProgress({
      ...staged,
      status: "acknowledged",
      publication: {
        ...staged.publication,
        receipts: [
          { relay: "wss://one.example", ok: true, message: "stored" }
        ]
      }
    });

    expect(acknowledged.status).toBe("acknowledged");
    expect(acknowledged.publication.projection).toEqual(
      staged.publication.projection
    );
    await expect(repository.clearAcknowledged(ORDER_ID))
      .resolves.toMatchObject({ status: "committed" });
  });

  it("rejects a different signed projection for the same durable intent", async () => {
    const repository = new OrderOutboxRepository(
      new MemoryDriver(),
      undefined,
      () => true
    );
    const staged = await repository.ensureStaged(intent(), publication);
    await expect(repository.recordProgress({
      ...staged,
      publication: {
        ...staged.publication,
        projection: {
          ...staged.publication.projection,
          id: "d".repeat(64)
        }
      }
    })).rejects.toBeInstanceOf(OrderOutboxConflictError);
  });

  it("rejects forged acknowledgements and predecessor tags in storage", async () => {
    const driver = new MemoryDriver();
    const repository = new OrderOutboxRepository(driver, undefined, () => true);
    const staged = await repository.ensureStaged(intent(), publication);
    const corrupt = [{
      ...staged,
      status: "acknowledged",
      publication: {
        ...staged.publication,
        projection: {
          ...staged.publication.projection,
          tags: [
            ...staged.publication.projection.tags,
            ["e", "f".repeat(64)]
          ]
        },
        receipts: []
      }
    }];
    driver.data.set("granola.order-outbox.v3", corrupt);

    await expect(repository.list()).rejects.toThrow(/corrupt/i);
  });

  it("does not read records outside the active outbox namespace", async () => {
    const driver = new MemoryDriver();
    driver.data.set("granola.order-outbox.unrecognized", [{ schema: "unrecognized" }]);
    const repository = new OrderOutboxRepository(driver, undefined, () => true);

    await expect(repository.list()).resolves.toEqual([]);
  });
});
