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

async function publication(
  orderId = "11111111-1111-4111-8111-111111111111",
  eventMarker = "c"
): Promise<StagedOrderPublication> {
  const state = createOrderState({
    orderId,
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
    id: eventMarker.repeat(64),
    pubkey: MAKER,
    sig: SIG
  };
  const projection: NostrEvent = {
    ...await createProjectionTemplate(state, transition),
    id: eventMarker === "c" ? "d".repeat(64) : "e".repeat(64),
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

function serialExclusiveRunner() {
  let tail = Promise.resolve();
  return <T>(action: () => Promise<T>): Promise<T> => {
    const result = tail.then(action, action);
    tail = result.then(() => undefined, () => undefined);
    return result;
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

  it("does not lose publications saved concurrently by separate tabs", async () => {
    const driver = new MemoryStorageDriver();
    const exclusive = serialExclusiveRunner();
    const firstTab = new OrderOutboxRepository(driver, exclusive);
    const secondTab = new OrderOutboxRepository(driver, exclusive);
    const first = await publication();
    const second = await publication("22222222-2222-4222-8222-222222222222", "f");

    await Promise.all([firstTab.save(first), secondTab.save(second)]);

    expect((await firstTab.list()).map((item) => item.state.order_id).sort()).toEqual([
      first.state.order_id,
      second.state.order_id
    ]);
  });

  it("does not resurrect a removed publication while another tab saves", async () => {
    const driver = new MemoryStorageDriver();
    const exclusive = serialExclusiveRunner();
    const firstTab = new OrderOutboxRepository(driver, exclusive);
    const secondTab = new OrderOutboxRepository(driver, exclusive);
    const removed = await publication();
    const saved = await publication("22222222-2222-4222-8222-222222222222", "f");
    await firstTab.save(removed);

    await Promise.all([
      firstTab.remove(removed.state.order_id),
      secondTab.save(saved)
    ]);

    expect(await firstTab.list()).toEqual([saved]);
  });
});
