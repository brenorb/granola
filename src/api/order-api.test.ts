import { describe, expect, it } from "vitest";

import {
  PublicationQuorumError,
  type OrderPublication,
  type StagedOrderPublication
} from "../order/service.js";
import type { OrderState } from "../order/model.js";
import { OrderOutboxRepository } from "../storage/order-outbox.js";
import { MemoryStorageDriver } from "../storage/wallet-repository.js";
import { OrderApi, TEST_MARKET, type OrderServicePort } from "./order-api.js";

const MAKER = "a".repeat(64);
const ORDER_ID = "11111111-1111-4111-8111-111111111111";

class FakeOrders implements OrderServicePort {
  state?: OrderState;
  fail = false;

  async stage(state: OrderState): Promise<StagedOrderPublication> {
    this.state = state;
    const transition = {
      kind: 78,
      created_at: state.created_at,
      tags: [],
      content: "{}",
      id: "b".repeat(64),
      pubkey: MAKER,
      sig: "c".repeat(128)
    };
    const projection = { ...transition, kind: 30078, id: "d".repeat(64) };
    return {
      schema: "granola/order-publication/v1",
      state,
      transition,
      projection,
      transitionReceipts: [],
      projectionReceipts: []
    };
  }

  async publishStaged(staged: StagedOrderPublication): Promise<OrderPublication> {
    const publication: OrderPublication = {
      ...staged,
      transitionReceipts: [{ relay: "wss://one.example", ok: !this.fail, message: this.fail ? "blocked" : "stored" }],
      projectionReceipts: this.fail
        ? []
        : [{ relay: "wss://one.example", ok: true, message: "stored" }]
    };
    if (this.fail) throw new PublicationQuorumError("transition", publication, 2);
    return publication;
  }

  async loadBook() {
    return {
      book: { market: TEST_MARKET, marketId: "e".repeat(64), asks: [], bids: [] },
      rejected: 0
    };
  }
}

describe("order browser API", () => {
  it("maps a sell to offered SAT and requested USD on the fixed issuer pair", async () => {
    const orders = new FakeOrders();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_000,
      () => ORDER_ID
    );

    const result = await api.publishOrder({
      side: "sell",
      amount: "2000",
      price: { numerator: "101", denominator: "2000" }
    });

    expect(orders.state?.offered).toEqual({ unit: "sat", mint: TEST_MARKET.baseMint });
    expect(orders.state?.requested).toEqual({
      unit: "usd",
      acceptable_mints: [TEST_MARKET.quoteMint]
    });
    expect(orders.state?.expires_at).toBe(1_702_592_000);
    expect(result).toEqual({
      orderId: ORDER_ID,
      makerPubkey: MAKER,
      transitionId: "b".repeat(64),
      projectionId: "d".repeat(64),
      transitionReceipts: [{ relay: "wss://one.example", ok: true, message: "stored" }],
      projectionReceipts: [{ relay: "wss://one.example", ok: true, message: "stored" }]
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("maps a buy to offered USD and requested SAT", async () => {
    const orders = new FakeOrders();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_000,
      () => "22222222-2222-4222-8222-222222222222"
    );

    await api.publishOrder({
      side: "buy",
      amount: "2000",
      price: { numerator: "99", denominator: "2000" }
    });

    expect(orders.state?.offered).toEqual({ unit: "usd", mint: TEST_MARKET.quoteMint });
    expect(orders.state?.requested).toEqual({
      unit: "sat",
      acceptable_mints: [TEST_MARKET.baseMint]
    });
  });

  it("exposes only the public maker identity and verified book", async () => {
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      new FakeOrders(),
      () => 1_700_000_000,
      () => ORDER_ID
    );

    await expect(api.getMakerIdentity()).resolves.toEqual({ publicKey: MAKER });
    await expect(api.getOrderBook()).resolves.toMatchObject({ rejected: 0, book: { asks: [], bids: [] } });
  });

  it("persists a failed publication and retries the exact signed IDs", async () => {
    const orders = new FakeOrders();
    orders.fail = true;
    const outbox = new OrderOutboxRepository(new MemoryStorageDriver());
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_000,
      () => ORDER_ID,
      outbox
    );

    await expect(api.publishOrder({
      side: "sell",
      amount: "2000",
      price: { numerator: "101", denominator: "2000" }
    })).rejects.toMatchObject({
      name: "PendingPublicationError",
      stage: "transition",
      publication: {
        orderId: ORDER_ID,
        transitionId: "b".repeat(64),
        projectionId: "d".repeat(64)
      }
    });
    await expect(api.getPendingOrderPublications()).resolves.toMatchObject([{
      orderId: ORDER_ID,
      transitionId: "b".repeat(64),
      projectionId: "d".repeat(64)
    }]);

    orders.fail = false;
    const retried = await api.retryOrderPublication(ORDER_ID);
    expect(retried.transitionId).toBe("b".repeat(64));
    expect(retried.projectionId).toBe("d".repeat(64));
    await expect(api.getPendingOrderPublications()).resolves.toEqual([]);
  });
});
