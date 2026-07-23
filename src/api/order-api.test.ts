import { describe, expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey
} from "nostr-tools/pure";

import {
  PublicationQuorumError,
  type OrderPublication,
  type SuccessorOperation,
  type StagedOrderPublication
} from "../order/service.js";
import {
  createOrderState,
  fillOrder,
  reserveOrder,
  type OrderState
} from "../order/model.js";
import {
  createProjectionTemplate,
  createStateTransitionTemplate,
  createTransitionTemplate,
  type NostrEvent,
  type TransitionEvidence
} from "../order/events.js";
import { OrderOutboxRepository } from "../storage/order-outbox.js";
import { MemoryStorageDriver } from "../storage/wallet-repository.js";
import { OrderApi, TEST_MARKET, type OrderServicePort } from "./order-api.js";

const MAKER_SECRET = generateSecretKey();
const OTHER_MAKER_SECRET = generateSecretKey();
const MAKER = getPublicKey(MAKER_SECRET);
const OTHER_MAKER = getPublicKey(OTHER_MAKER_SECRET);
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ADDRESS = `30078:${MAKER}:granola:order:v1:${ORDER_ID}`;
const RESERVE_HEAD = "2".repeat(64);
const FILL_HEAD = "3".repeat(64);
const RESERVATION_ID = "99999999-9999-4999-8999-999999999999";

function initialOrder(): OrderState {
  return createOrderState({
    orderId: ORDER_ID,
    createdAt: 1_700_000_000,
    expiresAt: 1_800_000_000,
    side: "sell",
    baseUnit: TEST_MARKET.baseUnit,
    quoteUnit: TEST_MARKET.quoteUnit,
    offered: { unit: TEST_MARKET.baseUnit, mint: TEST_MARKET.baseMint },
    requested: {
      unit: TEST_MARKET.quoteUnit,
      acceptableMints: [TEST_MARKET.quoteMint]
    },
    amount: "2000",
    price: { numerator: "101", denominator: "2000" }
  });
}

function signed(
  template: ReturnType<typeof createTransitionTemplate>,
  id: string,
  maker = MAKER
): NostrEvent {
  return {
    ...template,
    tags: template.tags.map((tag) => [...tag]),
    id,
    pubkey: maker,
    sig: "c".repeat(128)
  };
}

function verified(
  template: ReturnType<typeof createTransitionTemplate>,
  secretKey = MAKER_SECRET
): NostrEvent {
  return finalizeEvent(template, secretKey);
}

function createHead(maker = MAKER): NostrEvent {
  return verified(
    createTransitionTemplate(initialOrder(), maker, "create-operation"),
    maker === MAKER ? MAKER_SECRET : OTHER_MAKER_SECRET
  );
}

const CREATE_HEAD = createHead().id;

class FakeOrders implements OrderServicePort {
  state?: OrderState;
  fail = false;
  current: NostrEvent = createHead();
  loadFailure?: Error;
  successor?: {
    operation: SuccessorOperation;
    previous: NostrEvent;
    evidence?: TransitionEvidence;
    createdAt?: number;
  };
  successorCalls = 0;
  loadCalls: Array<{ address: string; expectedHeadId: string }> = [];

  private async staged(
    state: OrderState,
    transition: NostrEvent
  ): Promise<StagedOrderPublication> {
    const projectionTemplate = await createProjectionTemplate(state, transition);
    const projection = {
      ...projectionTemplate,
      id: state.revision === "0" ? "d".repeat(64) : "e".repeat(64),
      pubkey: MAKER,
      sig: "c".repeat(128)
    };
    return {
      schema: "granola/order-publication/v1",
      state,
      transition,
      projection,
      transitionReceipts: [],
      projectionReceipts: []
    };
  }

  async stage(state: OrderState): Promise<StagedOrderPublication> {
    this.state = state;
    return this.staged(
      state,
      signed(
        createTransitionTemplate(state, MAKER, "create-operation"),
        "b".repeat(64)
      )
    );
  }

  async loadCurrentTransition(address: string, expectedHeadId: string): Promise<NostrEvent> {
    this.loadCalls.push({ address, expectedHeadId });
    if (this.loadFailure) throw this.loadFailure;
    return structuredClone(this.current);
  }

  async stageSuccessor(
    state: OrderState,
    operation: SuccessorOperation,
    previous: NostrEvent,
    evidence?: TransitionEvidence,
    createdAt?: number
  ): Promise<StagedOrderPublication> {
    this.successorCalls += 1;
    this.state = state;
    this.successor = {
      operation,
      previous,
      ...(evidence ? { evidence } : {}),
      ...(createdAt === undefined ? {} : { createdAt })
    };
    const id = operation === "reserve" ? RESERVE_HEAD : FILL_HEAD;
    return this.staged(
      state,
      signed(
        createStateTransitionTemplate(
          state,
          MAKER,
          `${operation}-operation`,
          operation,
          previous,
          evidence,
          createdAt
        ),
        id
      )
    );
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
    this.current = structuredClone(publication.transition);
    return publication;
  }

  async loadBook() {
    return {
      book: { market: TEST_MARKET, marketId: "e".repeat(64), asks: [], bids: [] },
      rejected: 0
    };
  }
}

const reserveInput = {
  address: ADDRESS,
  expectedHeadId: CREATE_HEAD,
  reservationId: RESERVATION_ID,
  amount: "2000",
  expiresAt: 1_700_001_900,
  proposalEventId: "4".repeat(64),
  takerCommitment: "5".repeat(64)
};

const settlementEvidence = {
  settlement_hash: "6".repeat(64),
  base_token_commitment: "7".repeat(64),
  quote_token_commitment: "8".repeat(64)
};

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

  it("publishes a reserve derived from the exact authoritative current head", async () => {
    const orders = new FakeOrders();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100,
      () => ORDER_ID,
      new OrderOutboxRepository(new MemoryStorageDriver())
    );

    const result = await api.reserveOrder(reserveInput);

    expect(orders.loadCalls).toEqual([{
      address: ADDRESS,
      expectedHeadId: CREATE_HEAD
    }]);
    expect(orders.successor).toMatchObject({
      operation: "reserve",
      previous: { id: CREATE_HEAD, pubkey: MAKER },
      createdAt: 1_700_000_100
    });
    expect(orders.state).toEqual(reserveOrder(initialOrder(), {
      reservationId: RESERVATION_ID,
      amount: "2000",
      acceptedAt: 1_700_000_100,
      expiresAt: 1_700_001_900,
      proposalEventId: "4".repeat(64),
      takerCommitment: "5".repeat(64)
    }));
    expect(result).toMatchObject({
      orderId: ORDER_ID,
      makerPubkey: MAKER,
      transitionId: RESERVE_HEAD
    });
    expect(result).not.toHaveProperty("state");
    expect(JSON.stringify(result)).not.toContain(reserveInput.takerCommitment);
  });

  it("publishes a fill derived from the exact reserved head with settlement evidence", async () => {
    const orders = new FakeOrders();
    const reserved = reserveOrder(initialOrder(), {
      reservationId: RESERVATION_ID,
      amount: "2000",
      acceptedAt: 1_700_000_100,
      expiresAt: 1_700_001_900,
      proposalEventId: "4".repeat(64),
      takerCommitment: "5".repeat(64)
    });
    orders.current = verified(
      createStateTransitionTemplate(
        reserved,
        MAKER,
        "reserve-operation",
        "reserve",
        createHead(),
        undefined,
        1_700_000_100
      )
    );
    const reservedHead = orders.current.id;
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_200
    );

    const result = await api.fillOrder({
      address: ADDRESS,
      expectedHeadId: reservedHead,
      reservationId: RESERVATION_ID,
      amount: "2000",
      evidence: settlementEvidence
    });

    expect(orders.loadCalls).toEqual([{
      address: ADDRESS,
      expectedHeadId: reservedHead
    }]);
    expect(orders.successor).toMatchObject({
      operation: "fill",
      previous: { id: reservedHead, pubkey: MAKER },
      evidence: settlementEvidence,
      createdAt: 1_700_000_200
    });
    expect(orders.state).toEqual(fillOrder(reserved, {
      reservationId: RESERVATION_ID,
      amount: "2000"
    }));
    expect(result.transitionId).toBe(FILL_HEAD);
    expect(result).not.toHaveProperty("state");
    expect(JSON.stringify(result)).not.toContain(settlementEvidence.settlement_hash);
  });

  it("rejects a stale head without staging or persisting a successor", async () => {
    const orders = new FakeOrders();
    orders.loadFailure = new Error("Expected transition is not the current head");
    const outbox = new OrderOutboxRepository(new MemoryStorageDriver());
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100,
      () => ORDER_ID,
      outbox
    );

    await expect(api.reserveOrder(reserveInput))
      .rejects.toThrow("Expected transition is not the current head");
    expect(orders.successor).toBeUndefined();
    await expect(outbox.list()).resolves.toEqual([]);
  });

  it("rejects a transition owned by another maker before staging", async () => {
    const orders = new FakeOrders();
    orders.current = createHead(OTHER_MAKER);
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100
    );

    await expect(api.reserveOrder({
      ...reserveInput,
      address: `30078:${OTHER_MAKER}:granola:order:v1:${ORDER_ID}`,
      expectedHeadId: orders.current.id
    })).rejects.toThrow("another maker");
    expect(orders.successor).toBeUndefined();
  });

  it("rejects invalid reserve and fill transitions before staging", async () => {
    const orders = new FakeOrders();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100
    );

    await expect(api.reserveOrder({ ...reserveInput, amount: "1" }))
      .rejects.toThrow("All-or-none");
    expect(orders.successor).toBeUndefined();

    const reserved = reserveOrder(initialOrder(), {
      reservationId: RESERVATION_ID,
      amount: "2000",
      acceptedAt: 1_700_000_100,
      expiresAt: 1_700_001_900,
      proposalEventId: "4".repeat(64),
      takerCommitment: "5".repeat(64)
    });
    orders.current = verified(
      createStateTransitionTemplate(
        reserved,
        MAKER,
        "reserve-operation",
        "reserve",
        createHead(),
        undefined,
        1_700_000_100
      )
    );
    const reservedHead = orders.current.id;
    await expect(api.fillOrder({
      address: ADDRESS,
      expectedHeadId: reservedHead,
      reservationId: "88888888-8888-4888-8888-888888888888",
      amount: "2000",
      evidence: settlementEvidence
    })).rejects.toThrow("reservation ID does not match");
  });

  it("retains an exact failed reserve publication and blocks replacement until retry", async () => {
    const orders = new FakeOrders();
    orders.fail = true;
    const outbox = new OrderOutboxRepository(new MemoryStorageDriver());
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100,
      () => ORDER_ID,
      outbox
    );

    await expect(api.reserveOrder(reserveInput)).rejects.toMatchObject({
      name: "PendingPublicationError",
      publication: {
        orderId: ORDER_ID,
        transitionId: RESERVE_HEAD
      }
    });
    await expect(api.reserveOrder(reserveInput))
      .rejects.toThrow("pending publication");
    expect(orders.loadCalls).toHaveLength(2);
    expect(orders.successor?.previous.id).toBe(CREATE_HEAD);

    orders.fail = false;
    await expect(api.retryOrderPublication(ORDER_ID)).resolves.toMatchObject({
      orderId: ORDER_ID,
      transitionId: RESERVE_HEAD
    });
    await expect(outbox.list()).resolves.toEqual([]);
  });

  it("serializes same-order successors so concurrent callers cannot publish a fork", async () => {
    const orders = new FakeOrders();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100
    );

    const results = await Promise.allSettled([
      api.reserveOrder(reserveInput),
      api.reserveOrder(reserveInput)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(orders.successorCalls).toBe(1);
    expect(orders.loadCalls).toHaveLength(2);
  });
});
