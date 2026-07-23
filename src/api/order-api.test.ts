import { describe, expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey
} from "nostr-tools/pure";

import {
  type SuccessorOperation,
  type StagedOrderPublication
} from "../order/service.js";
import type { OrderOutboxEntry } from "../storage/order-outbox.js";
import {
  createOrderState,
  fillOrder,
  releaseOrder,
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
import {
  createTradeRumor,
  termsHash,
  unwrapInitialReserveProposal,
  unwrapTradeMessage,
  wrapTradeRumor,
  type GranolaTradeMessage,
  type GranolaTradeTerms,
  type OpenedTradeMessage,
  type TradeMessageType,
  type VerifiedInitialReserveProposal
} from "../trade/messages.js";
import { OrderApi, TEST_MARKET, type OrderServicePort } from "./order-api.js";

const MAKER_SECRET = generateSecretKey();
const OTHER_MAKER_SECRET = generateSecretKey();
const TAKER_SECRET = generateSecretKey();
const OTHER_TAKER_SECRET = generateSecretKey();
const MAKER = getPublicKey(MAKER_SECRET);
const OTHER_MAKER = getPublicKey(OTHER_MAKER_SECRET);
const TAKER = getPublicKey(TAKER_SECRET);
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ADDRESS = `30078:${MAKER}:granola:order:v1:${ORDER_ID}`;
const RESERVE_HEAD = "2".repeat(64);
const FILL_HEAD = "3".repeat(64);
const RELEASE_HEAD = "9".repeat(64);
const RESERVATION_ID = "99999999-9999-4999-8999-999999999999";
const SESSION_ID = "a".repeat(64);
const DM_NOW = 1_700_000_200;

const tradeTerms: GranolaTradeTerms = {
  base_unit: TEST_MARKET.baseUnit,
  base_mint: TEST_MARKET.baseMint,
  base_keyset: "1".repeat(64),
  quote_unit: TEST_MARKET.quoteUnit,
  quote_mint: TEST_MARKET.quoteMint,
  quote_keyset: "2".repeat(64),
  base_amount: "2000",
  quote_amount: "101",
  limit_price: { numerator: "101", denominator: "2000" }
};

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

interface AuthenticatedAbortFixture {
  reserved: OrderState;
  reservedHead: NostrEvent;
  proposalMessage: VerifiedInitialReserveProposal;
  abortMessage: OpenedTradeMessage;
}

async function authenticatedAbortFixture(options: {
  abortSecretKey?: Uint8Array;
  abort?: Partial<GranolaTradeMessage>;
  expectedType?: TradeMessageType;
} = {}): Promise<AuthenticatedAbortFixture> {
  const hash = await termsHash(tradeTerms);
  const proposal: GranolaTradeMessage = {
    schema: "granola/dm/v1",
    deployment: "cashu-testnet-v1",
    type: "reserve_propose",
    message_id: "77777777-7777-4777-8777-777777777777",
    session_id: SESSION_ID,
    reservation_id: RESERVATION_ID,
    order_address: ADDRESS,
    order_head: CREATE_HEAD,
    maker_order_pubkey: MAKER,
    author_pubkey: TAKER,
    recipient_pubkey: MAKER,
    sequence: "0",
    previous_message_id: null,
    previous_transcript_hash: null,
    sent_at: DM_NOW - 20,
    expires_at: DM_NOW + 120,
    terms_hash: hash,
    terms: tradeTerms,
    body: {}
  };
  const proposalRumor = await createTradeRumor(proposal, TAKER_SECRET);
  const proposalWrapped = wrapTradeRumor(proposalRumor, TAKER_SECRET, {
    ephemeralSecretKey: generateSecretKey(),
    sealCreatedAt: DM_NOW - 30,
    wrapperCreatedAt: DM_NOW - 40,
    outerExpiration: proposal.expires_at + 3_600
  });
  const proposalMessage = await unwrapInitialReserveProposal(
    proposalWrapped.wrapper,
    MAKER_SECRET,
    {
      now: DM_NOW,
      expectedOrderAddress: ADDRESS,
      expectedOrderHead: CREATE_HEAD,
      expectedTermsHash: hash
    }
  );
  const reserved = reserveOrder(initialOrder(), {
    reservationId: RESERVATION_ID,
    amount: "2000",
    acceptedAt: 1_700_000_100,
    expiresAt: 1_700_001_900,
    proposalEventId: proposalMessage.seal.id,
    takerCommitment: "5".repeat(64)
  });
  const reservedHead = verified(
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
  const abortSecretKey = options.abortSecretKey ?? TAKER_SECRET;
  const abortAuthor = getPublicKey(abortSecretKey);
  const abort: GranolaTradeMessage = {
    schema: "granola/dm/v1",
    deployment: "cashu-testnet-v1",
    type: "abort",
    message_id: "88888888-8888-4888-8888-888888888888",
    session_id: SESSION_ID,
    reservation_id: RESERVATION_ID,
    order_address: ADDRESS,
    order_head: reservedHead.id,
    maker_order_pubkey: MAKER,
    author_pubkey: abortAuthor,
    recipient_pubkey: MAKER,
    sequence: "1",
    previous_message_id: proposal.message_id,
    previous_transcript_hash: proposalMessage.transcriptHash,
    sent_at: DM_NOW - 5,
    expires_at: DM_NOW + 120,
    terms_hash: hash,
    body: {},
    ...options.abort
  };
  const abortRumor = await createTradeRumor(abort, abortSecretKey, proposalRumor.id);
  const abortWrapped = wrapTradeRumor(abortRumor, abortSecretKey, {
    ephemeralSecretKey: generateSecretKey(),
    sealCreatedAt: DM_NOW - 10,
    wrapperCreatedAt: DM_NOW - 15,
    outerExpiration: abort.expires_at + 3_600
  });
  const abortMessage = await unwrapTradeMessage(abortWrapped.wrapper, MAKER_SECRET, {
    now: DM_NOW,
    expectedAuthorPubkey: abortAuthor,
    expectedOrderAddress: abort.order_address,
    expectedOrderHead: abort.order_head,
    expectedTermsHash: abort.terms_hash,
    expectedType: options.expectedType ?? "abort",
    expectedSequence: "1",
    expectedPreviousRumorId: proposalRumor.id,
    expectedPreviousMessageId: proposal.message_id,
    expectedPreviousTranscriptHash: proposalMessage.transcriptHash
  });
  return { reserved, reservedHead, proposalMessage, abortMessage };
}

class FakeOrders implements OrderServicePort {
  state?: OrderState;
  fail = false;
  publishCalls = 0;
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
    const id = operation === "reserve"
      ? RESERVE_HEAD
      : operation === "release"
        ? RELEASE_HEAD
        : FILL_HEAD;
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

  publicationQuorum(): number {
    return 1;
  }

  async publishNextStage(entry: OrderOutboxEntry): Promise<OrderOutboxEntry> {
    if (entry.status === "staged") {
      if (
        entry.intent.expectedHeadId !== null &&
        this.current.id !== entry.intent.expectedHeadId &&
        this.current.id !== entry.publication.transition.id
      ) {
        throw new Error("Staged successor is stale or the authoritative head forked");
      }
      this.publishCalls += 1;
      if (!this.fail) this.current = structuredClone(entry.publication.transition);
      return {
        ...entry,
        status: this.fail ? "staged" : "transition_acknowledged",
        publication: {
          ...entry.publication,
          transitionReceipts: [{
            relay: "wss://one.example",
            ok: !this.fail,
            message: this.fail ? "blocked" : "stored"
          }]
        }
      };
    }
    this.publishCalls += 1;
    this.current = structuredClone(entry.publication.transition);
    return {
      ...entry,
      status: this.fail ? "transition_acknowledged" : "projection_acknowledged",
      publication: {
        ...entry.publication,
        projectionReceipts: [{
          relay: "wss://one.example",
          ok: !this.fail,
          message: this.fail ? "blocked" : "stored"
        }]
      }
    };
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

function testOutbox(driver = new MemoryStorageDriver()): OrderOutboxRepository {
  return new OrderOutboxRepository(driver, undefined, () => true);
}

describe("order browser API", () => {
  it("maps a sell to offered SAT and requested USD on the fixed issuer pair", async () => {
    const orders = new FakeOrders();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_000,
      () => ORDER_ID,
      testOutbox()
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
      status: "transition_acknowledged",
      transitionReceipts: [{ relay: "wss://one.example", ok: true, message: "stored" }],
      projectionReceipts: []
    });
    expect(orders.publishCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("maps a buy to offered USD and requested SAT", async () => {
    const orders = new FakeOrders();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_000,
      () => "22222222-2222-4222-8222-222222222222",
      testOutbox()
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
      () => ORDER_ID,
      testOutbox()
    );

    await expect(api.getMakerIdentity()).resolves.toEqual({ publicKey: MAKER });
    await expect(api.getOrderBook()).resolves.toMatchObject({ rejected: 0, book: { asks: [], bids: [] } });
  });

  it("persists a failed publication and retries the exact signed IDs", async () => {
    const orders = new FakeOrders();
    orders.fail = true;
    const outbox = testOutbox();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_000,
      () => ORDER_ID,
      outbox,
      () => true
    );

    const partial = await api.publishOrder({
      side: "sell",
      amount: "2000",
      price: { numerator: "101", denominator: "2000" }
    });
    expect(partial).toMatchObject({
      status: "staged",
      orderId: ORDER_ID,
      transitionId: "b".repeat(64),
      projectionId: "d".repeat(64)
    });
    await expect(api.getPendingOrderPublications()).resolves.toMatchObject([{
      orderId: ORDER_ID,
      transitionId: "b".repeat(64),
      projectionId: "d".repeat(64)
    }]);

    orders.fail = false;
    const retried = await api.retryOrderPublication(ORDER_ID);
    expect(retried.status).toBe("transition_acknowledged");
    expect(retried.transitionId).toBe("b".repeat(64));
    expect(retried.projectionId).toBe("d".repeat(64));
    expect(orders.publishCalls).toBe(2);
    const projected = await api.retryOrderPublication(ORDER_ID);
    expect(projected.status).toBe("projection_acknowledged");
    expect(orders.publishCalls).toBe(3);
    await api.clearAcknowledgedOrderPublication(ORDER_ID);
    await expect(api.getPendingOrderPublications()).resolves.toEqual([]);
  });

  it("refuses a locally tampered pending publication before retrying it", async () => {
    const orders = new FakeOrders();
    orders.fail = true;
    const driver = new MemoryStorageDriver();
    const outbox = testOutbox(driver);
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
    })).resolves.toMatchObject({ status: "staged" });
    const persisted = await driver.get("granola.order-outbox.v2") as OrderOutboxEntry[];
    if (!persisted[0]) throw new Error("Expected pending publication");
    persisted[0].publication.transition.content =
      persisted[0].publication.transition.content.replace(
        '"operation":"create"',
        '"operation":"fill"'
      );
    await driver.set("granola.order-outbox.v2", persisted);
    orders.fail = false;

    await expect(api.retryOrderPublication(ORDER_ID)).rejects.toThrow(/corrupt/i);
    expect(orders.publishCalls).toBe(1);
  });

  it("publishes a reserve derived from the exact authoritative current head", async () => {
    const orders = new FakeOrders();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100,
      () => ORDER_ID,
      testOutbox()
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
      () => 1_700_000_200,
      () => ORDER_ID,
      testOutbox()
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

  it("publishes an expiry release only when the reservation has expired", async () => {
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
    const outbox = testOutbox();
    const earlyApi = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_001_899,
      () => ORDER_ID,
      outbox
    );

    await expect(earlyApi.releaseOrder({
      address: ADDRESS,
      expectedHeadId: reservedHead,
      reservationId: RESERVATION_ID,
      reason: "expired"
    })).rejects.toThrow("not expired");
    expect(orders.successorCalls).toBe(0);
    await expect(outbox.list()).resolves.toEqual([]);

    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_001_900,
      () => ORDER_ID,
      outbox
    );
    const result = await api.releaseOrder({
      address: ADDRESS,
      expectedHeadId: reservedHead,
      reservationId: RESERVATION_ID,
      reason: "expired"
    });

    expect(orders.successor).toMatchObject({
      operation: "release",
      previous: { id: reservedHead, pubkey: MAKER },
      evidence: { release_reason: "expired" },
      createdAt: 1_700_001_900
    });
    expect(orders.state).toEqual(releaseOrder(reserved, {
      reservationId: RESERVATION_ID,
      reason: "expired",
      releasedAt: 1_700_001_900
    }));
    expect(result.transitionId).toBe(RELEASE_HEAD);
    expect(result).not.toHaveProperty("state");
  });

  it("retains and retries the exact failed abort release publication", async () => {
    const orders = new FakeOrders();
    const authenticated = await authenticatedAbortFixture();
    orders.current = authenticated.reservedHead;
    const outbox = testOutbox();
    orders.fail = true;
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => DM_NOW,
      () => ORDER_ID,
      outbox,
      () => true
    );

    const partial = await api.releaseOrder({
      address: ADDRESS,
      expectedHeadId: authenticated.reservedHead.id,
      reservationId: RESERVATION_ID,
      reason: "abort",
      proposalMessage: authenticated.proposalMessage,
      abortMessage: authenticated.abortMessage
    });
    expect(partial).toMatchObject({
      status: "staged",
      orderId: ORDER_ID,
      transitionId: RELEASE_HEAD
    });
    expect(orders.successor?.evidence).toEqual({
      release_reason: "abort",
      abort_event_id: authenticated.abortMessage.seal.id
    });
    const pending = await api.getPendingOrderPublications();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.transitionId).toBe(RELEASE_HEAD);

    orders.fail = false;
    const retried = await api.retryOrderPublication(ORDER_ID);
    expect(retried.status).toBe("transition_acknowledged");
    expect(retried.transitionId).toBe(RELEASE_HEAD);
    expect(retried.projectionId).toBe(pending[0]?.projectionId);
    const projected = await api.retryOrderPublication(ORDER_ID);
    expect(projected.status).toBe("projection_acknowledged");
    await api.clearAcknowledgedOrderPublication(ORDER_ID);
    expect((await outbox.list())[0]?.status).toBe("committed");
  });

  it("rejects fabricated or incorrectly bound abort artifacts before staging", async () => {
    const valid = await authenticatedAbortFixture();
    const cases: Array<{ label: string; fixture: AuthenticatedAbortFixture }> = [
      {
        label: "wrong author",
        fixture: await authenticatedAbortFixture({ abortSecretKey: OTHER_TAKER_SECRET })
      },
      {
        label: "wrong type",
        fixture: await authenticatedAbortFixture({
          abort: { type: "ack" },
          expectedType: "ack"
        })
      },
      {
        label: "wrong order",
        fixture: await authenticatedAbortFixture({
          abort: {
            order_address: `30078:${MAKER}:granola:order:v1:22222222-2222-4222-8222-222222222222`
          }
        })
      },
      {
        label: "wrong head",
        fixture: await authenticatedAbortFixture({ abort: { order_head: "b".repeat(64) } })
      },
      {
        label: "wrong reservation",
        fixture: await authenticatedAbortFixture({
          abort: { reservation_id: "33333333-3333-4333-8333-333333333333" }
        })
      },
      {
        label: "wrong session",
        fixture: await authenticatedAbortFixture({ abort: { session_id: "c".repeat(64) } })
      }
    ];

    for (const item of cases) {
      const orders = new FakeOrders();
      orders.current = item.fixture.reservedHead;
      const api = new OrderApi(
        { publicKey: async () => MAKER },
        orders,
        () => DM_NOW,
        () => ORDER_ID,
        testOutbox()
      );
      await expect(api.releaseOrder({
        address: ADDRESS,
        expectedHeadId: item.fixture.reservedHead.id,
        reservationId: RESERVATION_ID,
        reason: "abort",
        proposalMessage: item.fixture.proposalMessage,
        abortMessage: item.fixture.abortMessage
      }), item.label).rejects.toThrow();
      expect(orders.successorCalls, item.label).toBe(0);
    }

    const orders = new FakeOrders();
    orders.current = valid.reservedHead;
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => DM_NOW,
      () => ORDER_ID,
      testOutbox()
    );
    const fabricated = structuredClone(valid.abortMessage);
    fabricated.seal.sig = "0".repeat(128);
    await expect(api.releaseOrder({
      address: ADDRESS,
      expectedHeadId: valid.reservedHead.id,
      reservationId: RESERVATION_ID,
      reason: "abort",
      proposalMessage: valid.proposalMessage,
      abortMessage: fabricated
    })).rejects.toThrow(/authenticated/i);
    expect(orders.successorCalls).toBe(0);

    await expect(api.releaseOrder({
      address: ADDRESS,
      expectedHeadId: valid.reservedHead.id,
      reservationId: RESERVATION_ID,
      reason: "abort",
      abortEventId: "d".repeat(64)
    } as unknown as Parameters<OrderApi["releaseOrder"]>[0]))
      .rejects.toThrow(/verified|authenticated/i);
    expect(orders.successorCalls).toBe(0);

    valid.abortMessage.message.session_id = "e".repeat(64);
    await expect(api.releaseOrder({
      address: ADDRESS,
      expectedHeadId: valid.reservedHead.id,
      reservationId: RESERVATION_ID,
      reason: "abort",
      proposalMessage: valid.proposalMessage,
      abortMessage: valid.abortMessage
    })).rejects.toThrow(/authenticated/i);
    expect(orders.successorCalls).toBe(0);
  });

  it("rejects a stale head without staging or persisting a successor", async () => {
    const orders = new FakeOrders();
    orders.loadFailure = new Error("Expected transition is not the current head");
    const outbox = testOutbox();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100,
      () => ORDER_ID,
      outbox,
      () => true
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
      () => 1_700_000_100,
      () => ORDER_ID,
      testOutbox()
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
      () => 1_700_000_100,
      () => ORDER_ID,
      testOutbox()
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
    const outbox = testOutbox();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100,
      () => ORDER_ID,
      outbox,
      () => true
    );

    await expect(api.reserveOrder(reserveInput)).resolves.toMatchObject({
      status: "staged",
      orderId: ORDER_ID,
      transitionId: RESERVE_HEAD
    });
    await expect(api.reserveOrder(reserveInput))
      .resolves.toMatchObject({ status: "staged", transitionId: RESERVE_HEAD });
    expect(orders.loadCalls).toHaveLength(1);
    expect(orders.successor?.previous.id).toBe(CREATE_HEAD);

    orders.fail = false;
    await expect(api.retryOrderPublication(ORDER_ID)).resolves.toMatchObject({
      status: "transition_acknowledged",
      orderId: ORDER_ID,
      transitionId: RESERVE_HEAD
    });
    await expect(api.retryOrderPublication(ORDER_ID)).resolves.toMatchObject({
      status: "projection_acknowledged",
      transitionId: RESERVE_HEAD
    });
    await api.clearAcknowledgedOrderPublication(ORDER_ID);
    expect((await outbox.list())[0]?.status).toBe("committed");
  });

  it("rejects a pending successor retry after another instance advances the head", async () => {
    const orders = new FakeOrders();
    orders.fail = true;
    const outbox = testOutbox();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100,
      () => ORDER_ID,
      outbox,
      () => true
    );
    await expect(api.reserveOrder(reserveInput)).resolves.toMatchObject({
      status: "staged"
    });
    orders.current = verified(
      createStateTransitionTemplate(
        reserveOrder(initialOrder(), {
          reservationId: "44444444-4444-4444-8444-444444444444",
          amount: "2000",
          acceptedAt: 1_700_000_100,
          expiresAt: 1_700_001_900,
          proposalEventId: "d".repeat(64),
          takerCommitment: "e".repeat(64)
        }),
        MAKER,
        "other-instance-reserve",
        "reserve",
        createHead(),
        undefined,
        1_700_000_100
      )
    );
    orders.fail = false;

    await expect(api.retryOrderPublication(ORDER_ID)).rejects.toThrow(/stale|current head/i);
    expect(orders.publishCalls).toBe(1);
    await expect(outbox.list()).resolves.toHaveLength(1);
  });

  it("serializes concurrent pending retries and publishes the signed batch once", async () => {
    const orders = new FakeOrders();
    orders.fail = true;
    const outbox = testOutbox();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100,
      () => ORDER_ID,
      outbox,
      () => true
    );
    await expect(api.reserveOrder(reserveInput)).resolves.toMatchObject({
      status: "staged"
    });
    orders.fail = false;

    const results = await Promise.allSettled([
      api.retryOrderPublication(ORDER_ID),
      api.retryOrderPublication(ORDER_ID)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);
    expect(orders.publishCalls).toBe(3);
    expect((await outbox.list())[0]?.status).toBe("projection_acknowledged");
  });

  it("serializes same-order successors so concurrent callers cannot publish a fork", async () => {
    const orders = new FakeOrders();
    const outbox = testOutbox();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100,
      () => ORDER_ID,
      outbox
    );

    const results = await Promise.allSettled([
      api.reserveOrder(reserveInput),
      api.reserveOrder(reserveInput)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);
    expect(orders.successorCalls).toBe(1);
    expect(orders.loadCalls).toHaveLength(1);
    expect(orders.publishCalls).toBe(2);
    expect((await outbox.list())[0]?.status).toBe("projection_acknowledged");
  });

  it("ensures one compatible reserve artifact without publishing or re-signing", async () => {
    const orders = new FakeOrders();
    const outbox = testOutbox();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100,
      () => ORDER_ID,
      outbox,
      () => true
    );

    const first = await api.ensureReserveStaged(reserveInput);
    const restarted = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_999,
      () => ORDER_ID,
      outbox,
      () => true
    );
    const recovered = await restarted.ensureReserveStaged(reserveInput);

    expect(first.status).toBe("staged");
    expect(recovered).toEqual(first);
    expect(orders.successorCalls).toBe(1);
    expect(orders.publishCalls).toBe(0);
    await expect(restarted.ensureReserveStaged({
      ...reserveInput,
      takerCommitment: "6".repeat(64)
    })).rejects.toThrow(/conflict/i);
    expect(orders.successorCalls).toBe(1);
  });

  it("recovers compatible fill and release artifacts without re-signing", async () => {
    const makeReservedOrders = () => {
      const orders = new FakeOrders();
      const reserved = reserveOrder(initialOrder(), {
        reservationId: RESERVATION_ID,
        amount: "2000",
        acceptedAt: 1_700_000_100,
        expiresAt: 1_700_001_900,
        proposalEventId: "4".repeat(64),
        takerCommitment: "5".repeat(64)
      });
      orders.current = verified(createStateTransitionTemplate(
        reserved,
        MAKER,
        "reserve-operation",
        "reserve",
        createHead(),
        undefined,
        1_700_000_100
      ));
      return orders;
    };

    const fillOrders = makeReservedOrders();
    const fillOutbox = testOutbox();
    const fillApi = new OrderApi(
      { publicKey: async () => MAKER },
      fillOrders,
      () => 1_700_000_200,
      () => ORDER_ID,
      fillOutbox,
      () => true
    );
    const fillInput = {
      address: ADDRESS,
      expectedHeadId: fillOrders.current.id,
      reservationId: RESERVATION_ID,
      amount: "2000",
      evidence: settlementEvidence
    };
    const firstFill = await fillApi.ensureFillStaged(fillInput);
    await expect(fillApi.ensureFillStaged(fillInput)).resolves.toEqual(firstFill);
    await expect(fillApi.ensureFillStaged({
      ...fillInput,
      evidence: { ...settlementEvidence, settlement_hash: "a".repeat(64) }
    })).rejects.toThrow(/conflict/i);
    expect(fillOrders.successorCalls).toBe(1);

    const releaseOrders = makeReservedOrders();
    const releaseApi = new OrderApi(
      { publicKey: async () => MAKER },
      releaseOrders,
      () => 1_700_001_900,
      () => ORDER_ID,
      testOutbox(),
      () => true
    );
    const releaseInput = {
      address: ADDRESS,
      expectedHeadId: releaseOrders.current.id,
      reservationId: RESERVATION_ID,
      reason: "expired" as const
    };
    const firstRelease = await releaseApi.ensureReleaseStaged(releaseInput);
    await expect(releaseApi.ensureReleaseStaged(releaseInput))
      .resolves.toEqual(firstRelease);
    await expect(releaseApi.ensureReleaseStaged({
      ...releaseInput,
      reservationId: "88888888-8888-4888-8888-888888888888"
    })).rejects.toThrow(/conflict/i);
    expect(releaseOrders.successorCalls).toBe(1);
  });

  it("advances transition then projection across restarts and clears only after commit", async () => {
    const orders = new FakeOrders();
    const outbox = testOutbox();
    const firstApi = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100,
      () => ORDER_ID,
      outbox,
      () => true
    );
    const staged = await firstApi.ensureReserveStaged(reserveInput);

    const transition = await firstApi.publishNextStage(ORDER_ID);
    expect(transition.status).toBe("transition_acknowledged");
    expect(orders.publishCalls).toBe(1);
    expect(transition.transitionId).toBe(staged.transitionId);

    const restarted = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_200,
      () => ORDER_ID,
      outbox,
      () => true
    );
    const projection = await restarted.publishNextStage(ORDER_ID);
    expect(projection.status).toBe("projection_acknowledged");
    expect(orders.publishCalls).toBe(2);
    await expect(restarted.loadAcknowledgedOrderPublication(ORDER_ID))
      .resolves.toEqual(projection);
    expect((await restarted.getPendingOrderPublications())).toHaveLength(1);

    const committed = await restarted.clearAcknowledgedOrderPublication(ORDER_ID);
    expect(committed.status).toBe("committed");
    await expect(restarted.clearAcknowledgedOrderPublication(ORDER_ID))
      .resolves.toEqual(committed);
    await expect(restarted.loadAcknowledgedOrderPublication(ORDER_ID))
      .resolves.toBeUndefined();
    await expect(restarted.getPendingOrderPublications()).resolves.toEqual([]);
  });

  it("retries a partial relay stage with the same signed IDs", async () => {
    const orders = new FakeOrders();
    const outbox = testOutbox();
    const api = new OrderApi(
      { publicKey: async () => MAKER },
      orders,
      () => 1_700_000_100,
      () => ORDER_ID,
      outbox,
      () => true
    );
    const staged = await api.ensureReserveStaged(reserveInput);
    orders.fail = true;

    const partial = await api.publishNextStage(ORDER_ID);
    expect(partial.status).toBe("staged");
    expect(partial.transitionId).toBe(staged.transitionId);

    orders.fail = false;
    const retried = await api.publishNextStage(ORDER_ID);
    expect(retried.status).toBe("transition_acknowledged");
    expect(retried.transitionId).toBe(staged.transitionId);
    expect(retried.projectionId).toBe(staged.projectionId);
    expect(orders.publishCalls).toBe(2);
  });
});
