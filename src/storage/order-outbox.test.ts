import { describe, expect, it } from "vitest";

import {
  createProjectionTemplate,
  createTransitionTemplate,
  type NostrEvent
} from "../order/events.js";
import { createOrderState } from "../order/model.js";
import type { StagedOrderPublication } from "../order/service.js";
import { MemoryStorageDriver } from "./wallet-repository.js";
import {
  OrderOutboxConflictError,
  OrderOutboxRepository,
  canonicalOrderPublicationCompatibility,
  type OrderPublicationIntent
} from "./order-outbox.js";

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

async function successorIntent(
  operation: OrderPublicationIntent["operation"] = "create"
): Promise<OrderPublicationIntent> {
  const staged = await publication();
  return {
    operation,
    orderId: staged.state.order_id,
    address: `30078:${MAKER}:granola:order:v1:${staged.state.order_id}`,
    expectedHeadId: operation === "create" ? null : "a".repeat(64),
    quorum: 2,
    compatibility: canonicalOrderPublicationCompatibility({ operation }),
    state: staged.state,
    evidence: null,
    createdAt: staged.transition.created_at
  };
}

describe("order publication outbox", () => {
  it("persists the exact signed event IDs and returns defensive copies", async () => {
    const repository = new OrderOutboxRepository(
      new MemoryStorageDriver(),
      undefined,
      () => true
    );
    const staged = await publication();
    const intent = await successorIntent();

    const saved = await repository.ensureStaged(intent, async () => staged);
    const first = await repository.load(staged.state.order_id);
    expect(first).toEqual(saved);
    expect(first).not.toBe(saved);
    expect((await repository.list())[0]?.publication.transition.id)
      .toBe(staged.transition.id);
  });

  it("fails closed on corrupt persisted event material", async () => {
    const driver = new MemoryStorageDriver();
    await driver.set("granola.order-outbox.v2", [{ schema: "broken" }]);

    await expect(new OrderOutboxRepository(driver).list()).rejects.toThrow(
      "Order outbox storage is corrupt"
    );
  });

  it("does not lose publications saved concurrently by separate tabs", async () => {
    const driver = new MemoryStorageDriver();
    const exclusive = serialExclusiveRunner();
    const firstTab = new OrderOutboxRepository(driver, exclusive, () => true);
    const secondTab = new OrderOutboxRepository(driver, exclusive, () => true);
    const first = await publication();
    const second = await publication("22222222-2222-4222-8222-222222222222", "f");

    const firstIntent = await successorIntent();
    const secondIntent = {
      ...firstIntent,
      orderId: second.state.order_id,
      address: `30078:${MAKER}:granola:order:v1:${second.state.order_id}`,
      state: second.state
    };
    await Promise.all([
      firstTab.ensureStaged(firstIntent, async () => first),
      secondTab.ensureStaged(secondIntent, async () => second)
    ]);

    expect((await firstTab.list()).map((item) => item.intent.orderId).sort()).toEqual([
      first.state.order_id,
      second.state.order_id
    ]);
  });

  it("serializes a commit clear while another tab stages another order", async () => {
    const driver = new MemoryStorageDriver();
    const exclusive = serialExclusiveRunner();
    const firstTab = new OrderOutboxRepository(driver, exclusive, () => true);
    const secondTab = new OrderOutboxRepository(driver, exclusive, () => true);
    const acknowledgedPublication = await publication();
    const saved = await publication("22222222-2222-4222-8222-222222222222", "f");
    const firstIntent = await successorIntent();
    const entry = await firstTab.ensureStaged(firstIntent, async () => acknowledgedPublication);
    await firstTab.recordProgress({
      ...entry,
      status: "transition_acknowledged",
      publication: {
        ...entry.publication,
        transitionReceipts: [
          { relay: "wss://one.example", ok: true, message: "stored" },
          { relay: "wss://two.example", ok: true, message: "stored" }
        ]
      }
    });
    await firstTab.recordProgress({
      ...entry,
      status: "projection_acknowledged",
      publication: {
        ...entry.publication,
        transitionReceipts: [
          { relay: "wss://one.example", ok: true, message: "stored" },
          { relay: "wss://two.example", ok: true, message: "stored" }
        ],
        projectionReceipts: [
          { relay: "wss://one.example", ok: true, message: "stored" },
          { relay: "wss://two.example", ok: true, message: "stored" }
        ]
      }
    });
    const secondIntent = {
      ...firstIntent,
      orderId: saved.state.order_id,
      address: `30078:${MAKER}:granola:order:v1:${saved.state.order_id}`,
      state: saved.state
    };

    await Promise.all([
      firstTab.clearAcknowledged(acknowledgedPublication.state.order_id),
      secondTab.ensureStaged(secondIntent, async () => saved)
    ]);

    expect((await firstTab.load(acknowledgedPublication.state.order_id))?.status)
      .toBe("committed");
    expect((await firstTab.load(saved.state.order_id))?.status).toBe("staged");
  });

  it("ensures one exact signed successor across restarts and rejects conflicting intent", async () => {
    const driver = new MemoryStorageDriver();
    const first = new OrderOutboxRepository(driver, undefined, () => true);
    const staged = await publication();
    const intent = await successorIntent();
    let signed = 0;

    const created = await first.ensureStaged(intent, async () => {
      signed += 1;
      return staged;
    });
    const restarted = new OrderOutboxRepository(driver, undefined, () => true);
    const recovered = await restarted.ensureStaged(intent, async () => {
      signed += 1;
      return {
        ...staged,
        transition: { ...staged.transition, id: "f".repeat(64) }
      };
    });

    expect(signed).toBe(1);
    expect(recovered).toEqual(created);
    expect(recovered.status).toBe("staged");
    expect(recovered.publication.transition.id).toBe(staged.transition.id);

    await expect(restarted.ensureStaged(
      {
        ...intent,
        operation: "fill",
        expectedHeadId: "a".repeat(64),
        compatibility: canonicalOrderPublicationCompatibility({ operation: "fill" })
      },
      async () => staged
    )).rejects.toBeInstanceOf(OrderOutboxConflictError);
  });

  it("treats reordered but structurally identical intent as compatible", async () => {
    const driver = new MemoryStorageDriver();
    const repository = new OrderOutboxRepository(driver, undefined, () => true);
    const staged = await publication();
    const intent = await successorIntent();
    await repository.ensureStaged(intent, async () => staged);
    const reordered: OrderPublicationIntent = {
      createdAt: intent.createdAt,
      evidence: intent.evidence,
      state: {
        ...intent.state,
        limit_price: {
          denominator: intent.state.limit_price.denominator,
          numerator: intent.state.limit_price.numerator
        }
      },
      compatibility: intent.compatibility,
      expectedHeadId: intent.expectedHeadId,
      quorum: intent.quorum,
      address: intent.address,
      orderId: intent.orderId,
      operation: intent.operation
    };

    await expect(repository.ensureStaged(reordered, async () => {
      throw new Error("must not re-sign");
    })).resolves.toMatchObject({
      publication: { transition: { id: staged.transition.id } }
    });
  });

  it("rejects invalid signatures and intent/event binding tampering on restart", async () => {
    const driver = new MemoryStorageDriver();
    const verifiesFixture = (event: NostrEvent) => event.sig === SIG;
    const repository = new OrderOutboxRepository(
      driver,
      undefined,
      verifiesFixture
    );
    const staged = await publication();
    await repository.ensureStaged(await successorIntent(), async () => staged);
    const persisted = await driver.get("granola.order-outbox.v2") as Array<{
      publication: StagedOrderPublication;
    }>;
    persisted[0]!.publication.transition.sig = "0".repeat(128);
    await driver.set("granola.order-outbox.v2", persisted);

    await expect(new OrderOutboxRepository(
      driver,
      undefined,
      verifiesFixture
    ).list()).rejects.toThrow("corrupt");

    persisted[0]!.publication.transition.sig = SIG;
    persisted[0]!.publication.transition.content = persisted[0]!.publication.transition.content
      .replace('"operation":"create"', '"operation":"fill"');
    await driver.set("granola.order-outbox.v2", persisted);
    await expect(new OrderOutboxRepository(
      driver,
      undefined,
      () => true
    ).list()).rejects.toThrow("corrupt");
  });

  it("merges concurrent exact progress monotonically without losing relay receipts", async () => {
    const driver = new MemoryStorageDriver();
    const exclusive = serialExclusiveRunner();
    const first = new OrderOutboxRepository(driver, exclusive, () => true);
    const second = new OrderOutboxRepository(driver, exclusive, () => true);
    const staged = await publication();
    const entry = await first.ensureStaged(await successorIntent(), async () => staged);

    await Promise.all([
      first.recordProgress({
        ...entry,
        publication: {
          ...entry.publication,
          transitionReceipts: [
            { relay: "wss://one.example", ok: true, message: "stored" }
          ]
        }
      }),
      second.recordProgress({
        ...entry,
        publication: {
          ...entry.publication,
          transitionReceipts: [
            { relay: "wss://two.example", ok: true, message: "stored" }
          ]
        }
      })
    ]);

    expect((await first.load(entry.intent.orderId))?.publication.transitionReceipts)
      .toEqual(expect.arrayContaining([
        { relay: "wss://one.example", ok: true, message: "stored" },
        { relay: "wss://two.example", ok: true, message: "stored" }
      ]));
  });

  it("retains acknowledged artifacts until an explicit idempotent commit clear", async () => {
    const driver = new MemoryStorageDriver();
    const repository = new OrderOutboxRepository(
      driver,
      undefined,
      () => true
    );
    const staged = await publication();
    const entry = await repository.ensureStaged(await successorIntent(), async () => staged);
    const transitionAcknowledged = await repository.recordProgress({
      ...entry,
      status: "transition_acknowledged",
      publication: {
        ...entry.publication,
        transitionReceipts: [
          { relay: "wss://one.example", ok: true, message: "stored" },
          { relay: "wss://two.example", ok: true, message: "stored" }
        ]
      }
    });
    const acknowledged = await repository.recordProgress({
      ...transitionAcknowledged,
      status: "projection_acknowledged",
      publication: {
        ...transitionAcknowledged.publication,
        projectionReceipts: [
          { relay: "wss://one.example", ok: true, message: "stored" },
          { relay: "wss://two.example", ok: true, message: "stored" }
        ]
      }
    });

    await expect(repository.loadAcknowledged(entry.intent.orderId))
      .resolves.toEqual(acknowledged);
    const committed = await repository.clearAcknowledged(entry.intent.orderId);
    expect(committed.status).toBe("committed");
    await expect(repository.clearAcknowledged(entry.intent.orderId))
      .resolves.toEqual(committed);
    await expect(repository.loadAcknowledged(entry.intent.orderId))
      .resolves.toBeUndefined();
    expect((await repository.load(entry.intent.orderId))?.status).toBe("committed");

    const restarted = new OrderOutboxRepository(
      driver,
      undefined,
      () => true
    );
    await expect(restarted.clearAcknowledged(entry.intent.orderId))
      .resolves.toMatchObject({ status: "committed" });
    await restarted.pruneCommitted(entry.intent.orderId);
    await restarted.pruneCommitted(entry.intent.orderId);
    await expect(restarted.load(entry.intent.orderId)).resolves.toBeUndefined();
  });

  it("rejects duplicate relay receipts, forged status jumps, and persisted quorum mismatch", async () => {
    const repository = new OrderOutboxRepository(
      new MemoryStorageDriver(),
      undefined,
      () => true
    );
    const staged = await publication();
    const entry = await repository.ensureStaged(await successorIntent(), async () => staged);
    const duplicate = {
      ...entry,
      status: "transition_acknowledged" as const,
      publication: {
        ...entry.publication,
        transitionReceipts: [
          { relay: "wss://one.example", ok: true, message: "stored" },
          { relay: "wss://one.example", ok: true, message: "stored again" }
        ]
      }
    };
    await expect(repository.recordProgress(duplicate)).rejects.toThrow(/receipt|quorum|corrupt/i);

    const jumped = {
      ...entry,
      status: "projection_acknowledged" as const,
      publication: {
        ...entry.publication,
        transitionReceipts: [
          { relay: "wss://one.example", ok: true, message: "stored" },
          { relay: "wss://two.example", ok: true, message: "stored" }
        ],
        projectionReceipts: [
          { relay: "wss://one.example", ok: true, message: "stored" },
          { relay: "wss://two.example", ok: true, message: "stored" }
        ]
      }
    };
    await expect(repository.recordProgress(jumped)).rejects.toThrow(/status|stage/i);
    await expect(repository.recordProgress({
      ...entry,
      intent: { ...entry.intent, quorum: 3 }
    })).rejects.toThrow(/conflict|quorum/i);
  });
});
