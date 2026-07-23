import { describe, expect, it } from "vitest";

import {
  createProjectionTemplate,
  createTransitionTemplate,
  type NostrEvent
} from "../order/events.js";
import { createOrderState } from "../order/model.js";
import type { StagedOrderPublication } from "../order/service.js";
import { MemoryStorageDriver } from "./wallet-repository.js";
import { OrderOutboxRepository } from "./order-outbox.js";

const MAKER = "a".repeat(64);
const SIG = "b".repeat(128);

async function publication(): Promise<StagedOrderPublication> {
  const state = createOrderState({
    orderId: "11111111-1111-4111-8111-111111111111",
    createdAt: 1_700_000_000,
    side: "sell",
    baseUnit: "sat",
    quoteUnit: "usd",
    offered: { unit: "sat", mint: "https://testnut.cashu.space" },
    requested: { unit: "usd", acceptableMints: ["https://nofee.testnut.cashu.space"] },
    amount: "2000",
    price: { numerator: "101", denominator: "2000" }
  });
  const transition: NostrEvent = {
    ...createTransitionTemplate(state, MAKER, "operation-1"),
    id: "c".repeat(64),
    pubkey: MAKER,
    sig: SIG
  };
  const projection: NostrEvent = {
    ...await createProjectionTemplate(state, transition),
    id: "d".repeat(64),
    pubkey: MAKER,
    sig: SIG
  };
  return {
    schema: "granola/order-publication/v1",
    state,
    transition,
    transitionReceipts: [],
    projection,
    projectionReceipts: []
  };
}

describe("order publication outbox", () => {
  it("persists and updates the exact signed event IDs until removed", async () => {
    const repository = new OrderOutboxRepository(new MemoryStorageDriver());
    const staged = await publication();

    await repository.save(staged);
    const first = await repository.load(staged.state.order_id);
    expect(first).toEqual(staged);
    expect(first).not.toBe(staged);

    await repository.save({
      ...staged,
      transitionReceipts: [{ relay: "wss://one.example", ok: true, message: "stored" }]
    });
    expect((await repository.list())[0]?.transition.id).toBe(staged.transition.id);
    expect((await repository.list())[0]?.transitionReceipts).toHaveLength(1);

    await repository.remove(staged.state.order_id);
    await expect(repository.load(staged.state.order_id)).resolves.toBeUndefined();
  });

  it("fails closed on corrupt persisted event material", async () => {
    const driver = new MemoryStorageDriver();
    await driver.set("granola.order-outbox.v1", [{ schema: "broken" }]);

    await expect(new OrderOutboxRepository(driver).list()).rejects.toThrow(
      "Order outbox storage is corrupt"
    );
  });
});
