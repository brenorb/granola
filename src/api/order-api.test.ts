import { describe, expect, it } from "vitest";

import type { OrderPublication } from "../order/service.js";
import type { OrderState } from "../order/model.js";
import { OrderApi, TEST_MARKET, type OrderServicePort } from "./order-api.js";

const MAKER = "a".repeat(64);

class FakeOrders implements OrderServicePort {
  state?: OrderState;

  async publish(state: OrderState): Promise<OrderPublication> {
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
      transition,
      projection,
      transitionReceipts: [{ relay: "wss://one.example", ok: true, message: "stored" }],
      projectionReceipts: [{ relay: "wss://one.example", ok: true, message: "stored" }]
    };
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
      () => "order-1"
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
      orderId: "order-1",
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
      () => "order-2"
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
      () => "order-1"
    );

    await expect(api.getMakerIdentity()).resolves.toEqual({ publicKey: MAKER });
    await expect(api.getOrderBook()).resolves.toMatchObject({ rejected: 0, book: { asks: [], bids: [] } });
  });
});
