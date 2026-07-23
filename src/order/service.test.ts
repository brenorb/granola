import { describe, expect, it } from "vitest";

import type { NostrEvent, UnsignedNostrEvent } from "./events.js";
import {
  createProjectionTemplate,
  createStateTransitionTemplate,
  createTransitionTemplate
} from "./events.js";
import {
  createOrderState,
  fillOrder,
  releaseOrder,
  reserveOrder,
  type ExactMarket
} from "./model.js";
import {
  NostrOrderService,
  type StagedOrderPublication,
  type OrderRelayPort,
  type OrderSigner
} from "./service.js";
import {
  canonicalOrderPublicationCompatibility,
  type OrderOutboxEntry
} from "../storage/order-outbox.js";

const MAKER = "b".repeat(64);
const SAT_MINT = "https://testnut.cashu.space";
const USD_MINT = "https://nofee.testnut.cashu.space";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const MARKET: ExactMarket = {
  baseUnit: "sat",
  baseMint: SAT_MINT,
  quoteUnit: "usd",
  quoteMint: USD_MINT
};

function order() {
  return createOrderState({
    orderId: ORDER_ID,
    createdAt: 1_700_000_000,
    expiresAt: 1_800_000_000,
    side: "sell",
    baseUnit: "sat",
    quoteUnit: "usd",
    offered: { unit: "sat", mint: SAT_MINT },
    requested: { unit: "usd", acceptableMints: [USD_MINT] },
    amount: "2000",
    priceCentsPerBtc: "5050000"
  });
}

function reserved(initial = order()) {
  return reserveOrder(initial, {
    reservationId: "99999999-9999-4999-8999-999999999999",
    amount: "2000",
    acceptedAt: 1_700_000_100,
    expiresAt: 1_700_001_900,
    proposalEventId: "1".repeat(64),
    takerCommitment: "2".repeat(64)
  });
}

const evidence = {
  settlement_hash: "3".repeat(64),
  base_token_commitment: "4".repeat(64),
  quote_token_commitment: "5".repeat(64)
};

class FakeSigner implements OrderSigner {
  signed: NostrEvent[] = [];

  async publicKey(): Promise<string> {
    return MAKER;
  }

  async sign(template: UnsignedNostrEvent): Promise<NostrEvent> {
    const ids = ["a", "d", "e", "f", "6", "7"];
    const event: NostrEvent = {
      ...template,
      tags: template.tags.map((tag) => [...tag]),
      id: (ids[this.signed.length] ?? "8").repeat(64),
      pubkey: MAKER,
      sig: "c".repeat(128)
    };
    this.signed.push(event);
    return event;
  }
}

class FakeRelay implements OrderRelayPort {
  published: NostrEvent[] = [];
  events: NostrEvent[] = [];
  transitions?: NostrEvent[];
  failTransition = false;
  failProjection = false;
  duplicateReceipt = false;

  async publish(event: NostrEvent) {
    this.published.push(event);
    const fail = event.kind === 78 ? this.failTransition : this.failProjection;
    const receipts = [
      { relay: "wss://one.example", ok: true, message: "stored" },
      { relay: "wss://two.example", ok: !fail, message: fail ? "blocked" : "stored" },
      { relay: "wss://three.example", ok: true, message: "stored" }
    ];
    if (this.duplicateReceipt) receipts[1]!.relay = receipts[0]!.relay;
    return receipts;
  }

  async queryProjections(): Promise<NostrEvent[]> {
    return this.events;
  }

  async queryTransitions(): Promise<NostrEvent[]> {
    return this.transitions ?? this.published.filter((event) => event.kind === 78);
  }
}

describe("Nostr order service", () => {
  function entryFor(
    publication: StagedOrderPublication,
    operation: OrderOutboxEntry["intent"]["operation"],
    expectedHeadId: string | null,
    quorum: number,
    evidence: OrderOutboxEntry["intent"]["evidence"] = null
  ): OrderOutboxEntry {
    return {
      schema: "granola/order-outbox/v2",
      status: "staged",
      intent: {
        operation,
        orderId: publication.state.order_id,
        address: `30078:${MAKER}:granola:order:v2:${publication.state.order_id}`,
        expectedHeadId,
        quorum,
        compatibility: canonicalOrderPublicationCompatibility({ operation }),
        state: publication.state,
        evidence,
        createdAt: publication.transition.created_at
      },
      publication
    };
  }

  async function publishEntry(
    service: NostrOrderService,
    entry: OrderOutboxEntry
  ): Promise<OrderOutboxEntry> {
    const transitionAcknowledged = await service.publishNextStage(entry);
    if (transitionAcknowledged.status !== "transition_acknowledged") {
      throw new Error("Test publication did not reach transition quorum");
    }
    const projectionAcknowledged = await service.publishNextStage(
      transitionAcknowledged
    );
    if (projectionAcknowledged.status !== "projection_acknowledged") {
      throw new Error("Test publication did not reach projection quorum");
    }
    return projectionAcknowledged;
  }

  async function publishCreate(
    service: NostrOrderService
  ): Promise<StagedOrderPublication> {
    const publication = await service.stage(order());
    return (await publishEntry(
      service,
      entryFor(publication, "create", null, service.publicationQuorum())
    )).publication;
  }

  async function publishSuccessor(
    service: NostrOrderService,
    state: ReturnType<typeof order>,
    operation: "reserve" | "release" | "fill",
    previous: NostrEvent,
    transitionEvidence?: OrderOutboxEntry["intent"]["evidence"],
    createdAt?: number
  ): Promise<StagedOrderPublication> {
    const publication = await service.stageSuccessor(
      state,
      operation,
      previous,
      transitionEvidence ?? undefined,
      createdAt
    );
    return (await publishEntry(
      service,
      entryFor(
        publication,
        operation,
        previous.id,
        service.publicationQuorum(),
        transitionEvidence ?? null
      )
    )).publication;
  }

  async function outboxEntry(
    service: NostrOrderService,
    previous: NostrEvent,
    status: OrderOutboxEntry["status"] = "staged"
  ): Promise<OrderOutboxEntry> {
    const state = reserved();
    return {
      schema: "granola/order-outbox/v2",
      status,
      intent: {
        operation: "reserve",
        orderId: state.order_id,
        address: `30078:${MAKER}:granola:order:v2:${ORDER_ID}`,
        expectedHeadId: previous.id,
        quorum: service.publicationQuorum(),
        compatibility: canonicalOrderPublicationCompatibility({ operation: "reserve" }),
        state,
        evidence: null,
        createdAt: state.reservation!.accepted_at
      },
      publication: await service.stageSuccessor(
        state,
        "reserve",
        previous,
        undefined,
        state.reservation!.accepted_at
      )
    };
  }

  it("advances exactly one network stage and keeps the exact signed IDs across restart", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(
      signer,
      relay,
      () => `operation-${signer.signed.length}`,
      2,
      () => true
    );
    const created = await publishCreate(service);
    relay.transitions = [created.transition];
    relay.published = [];
    const entry = await outboxEntry(service, created.transition);

    const transitionAcknowledged = await service.publishNextStage(entry);
    expect(transitionAcknowledged.status).toBe("transition_acknowledged");
    expect(relay.published.map((event) => event.id)).toEqual([
      entry.publication.transition.id
    ]);
    relay.transitions = [created.transition, entry.publication.transition];

    const restarted = new NostrOrderService(
      signer,
      relay,
      () => "must-not-sign",
      2,
      () => true
    );
    const projectionAcknowledged = await restarted.publishNextStage(
      transitionAcknowledged
    );
    expect(projectionAcknowledged.status).toBe("projection_acknowledged");
    expect(relay.published.map((event) => event.id)).toEqual([
      entry.publication.transition.id,
      entry.publication.projection.id
    ]);
    expect(signer.signed).toHaveLength(4);
  });

  it("retries a partial relay failure with the same transition and never projects early", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(
      signer,
      relay,
      () => `operation-${signer.signed.length}`,
      3,
      () => true
    );
    const created = await publishCreate(service);
    relay.transitions = [created.transition];
    relay.published = [];
    relay.failTransition = true;
    const entry = await outboxEntry(service, created.transition);

    const partial = await service.publishNextStage(entry);
    expect(partial.status).toBe("staged");
    expect(relay.published).toEqual([entry.publication.transition]);

    relay.failTransition = false;
    const accepted = await service.publishNextStage(partial);
    expect(accepted.status).toBe("transition_acknowledged");
    expect(relay.published.map((event) => event.id)).toEqual([
      entry.publication.transition.id,
      entry.publication.transition.id
    ]);
    expect(accepted.publication.transitionReceipts.filter((receipt) => receipt.ok))
      .toHaveLength(3);
  });

  it("rejects a stale or forked successor before any relay publication", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(
      signer,
      relay,
      () => `operation-${signer.signed.length}`,
      2,
      () => true
    );
    const created = await publishCreate(service);
    const entry = await outboxEntry(service, created.transition);
    const competing = {
      ...await service.stageSuccessor(
        reserved(),
        "reserve",
        created.transition
      )
    }.transition;
    relay.transitions = [created.transition, competing];
    relay.published = [];

    await expect(service.publishNextStage(entry)).rejects.toThrow(/head|fork|stale/i);
    expect(relay.published).toEqual([]);
  });

  it("rejects a competing create root before publishing the staged create", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(
      signer,
      relay,
      () => "operation-create",
      2,
      () => true
    );
    const staged = await service.stage(order());
    const competing: NostrEvent = {
      ...createTransitionTemplate(order(), MAKER, "operation-competing"),
      id: "9".repeat(64),
      pubkey: MAKER,
      sig: "c".repeat(128)
    };
    relay.transitions = [competing];

    await expect(service.publishNextStage(
      entryFor(staged, "create", null, 2)
    )).rejects.toThrow(/root|head|competing/i);
    expect(relay.published).toEqual([]);
  });

  it("rejects duplicate relay receipts and a durable quorum mismatch", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(
      signer,
      relay,
      () => "operation-create",
      2,
      () => true
    );
    const staged = await service.stage(order());
    relay.duplicateReceipt = true;

    await expect(service.publishNextStage(
      entryFor(staged, "create", null, 2)
    )).rejects.toThrow(/duplicate receipt/i);

    relay.duplicateReceipt = false;
    relay.published = [];
    await expect(service.publishNextStage(
      entryFor(staged, "create", null, 3)
    )).rejects.toThrow(/quorum.*match/i);
    expect(relay.published).toEqual([]);
  });

  it("stages and publishes reserve then fill successors against exact heads", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => `operation-${signer.signed.length}`, 2, () => true);
    const created = await publishCreate(service);
    const reservePublication = await publishSuccessor(
      service,
      reserved(),
      "reserve",
      created.transition
    );
    const filled = fillOrder(reserved(), {
      reservationId: reserved().reservation!.id,
      amount: "2000"
    });
    const fillPublication = await publishSuccessor(
      service,
      filled,
      "fill",
      reservePublication.transition,
      evidence
    );

    expect(relay.published.map((event) => event.kind)).toEqual([78, 30078, 78, 30078, 78, 30078]);
    expect(reservePublication.transition.tags).toEqual(expect.arrayContaining([
      ["op", "reserve"], ["e", created.transition.id]
    ]));
    expect(fillPublication.transition.tags).toEqual(expect.arrayContaining([
      ["op", "fill"], ["e", reservePublication.transition.id]
    ]));
    expect(JSON.parse(fillPublication.transition.content).evidence).toEqual(evidence);
    expect(JSON.parse(fillPublication.projection.content).head).toBe(fillPublication.transition.id);
  });

  it("publishes a release successor and rejects premature expiry evidence", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(
      signer,
      relay,
      () => `operation-${signer.signed.length}`,
      2,
      () => true
    );
    const created = await publishCreate(service);
    const reservePublication = await publishSuccessor(
      service,
      reserved(),
      "reserve",
      created.transition
    );
    const abortEventId = "9".repeat(64);
    const released = releaseOrder(reserved(), {
      reservationId: reserved().reservation!.id,
      reason: "abort",
      releasedAt: 1_700_000_200,
      abortEventId
    });
    const publication = await publishSuccessor(
      service,
      released,
      "release",
      reservePublication.transition,
      { release_reason: "abort", abort_event_id: abortEventId },
      1_700_000_200
    );
    relay.events = [publication.projection];

    expect(JSON.parse(publication.transition.content).evidence).toEqual({
      release_reason: "abort",
      abort_event_id: abortEventId
    });
    expect((await service.loadBook(MARKET, 1_700_000_300)).book.asks[0]?.state)
      .toMatchObject({ status: "open", reservation: null, reserved_amount: "0" });

    const expired = releaseOrder(reserved(), {
      reservationId: reserved().reservation!.id,
      reason: "expired",
      releasedAt: 1_700_001_900
    });
    await expect(service.stageSuccessor(
      expired,
      "release",
      reservePublication.transition,
      { release_reason: "expired" },
      1_700_001_899
    )).rejects.toThrow("not expired");
  });

  it("loads an exact current maker head and rejects it after a successor exists", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => `operation-${signer.signed.length}`, 2, () => true);
    const created = await publishCreate(service);
    const address = `30078:${MAKER}:granola:order:v2:${ORDER_ID}`;

    await expect(service.loadCurrentTransition(address, created.transition.id))
      .resolves.toEqual(created.transition);

    await publishSuccessor(
      service,
      reserved(),
      "reserve",
      created.transition
    );
    await expect(service.loadCurrentTransition(address, created.transition.id))
      .rejects.toThrow("not the current head");
  });

  it("loads the exact current fill with its reserve predecessor and projection", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(
      signer,
      relay,
      () => `operation-${signer.signed.length}`,
      2,
      () => true
    );
    const created = await publishCreate(service);
    const reservePublication = await publishSuccessor(
      service,
      reserved(),
      "reserve",
      created.transition
    );
    const filled = fillOrder(reserved(), {
      reservationId: reserved().reservation!.id,
      amount: "2000"
    });
    const fillPublication = await publishSuccessor(
      service,
      filled,
      "fill",
      reservePublication.transition,
      evidence
    );
    relay.events = [fillPublication.projection];
    const address = `30078:${MAKER}:granola:order:v2:${ORDER_ID}`;

    await expect(service.loadPublishedHead(
      address,
      fillPublication.transition.id
    )).resolves.toEqual({
      headEventId: fillPublication.transition.id,
      predecessor: reservePublication.transition,
      transition: fillPublication.transition,
      projection: fillPublication.projection
    });

    relay.events = [];
    await expect(service.loadPublishedHead(
      address,
      fillPublication.transition.id
    )).rejects.toThrow(/projection/i);
  });

  it("verifies a complete create-to-fill chain and excludes its filled projection", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => `operation-${signer.signed.length}`, 2, () => true);
    const created = await publishCreate(service);
    const reservePublication = await publishSuccessor(
      service,
      reserved(),
      "reserve",
      created.transition
    );
    const filled = fillOrder(reserved(), {
      reservationId: reserved().reservation!.id,
      amount: "2000"
    });
    const fillPublication = await publishSuccessor(
      service,
      filled,
      "fill",
      reservePublication.transition,
      evidence
    );
    relay.events = [fillPublication.projection];

    const result = await service.loadBook(MARKET, 1_700_000_200);

    expect(result.book.asks).toEqual([]);
    expect(result.book.bids).toEqual([]);
    expect(result.rejected).toBe(0);
  });

  it("rejects successor equivocation from one authoritative head", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => `operation-${signer.signed.length}`, 2, () => true);
    const created = await publishCreate(service);
    const accepted = await publishSuccessor(
      service,
      reserved(),
      "reserve",
      created.transition
    );
    const fork: NostrEvent = {
      ...createStateTransitionTemplate(reserved(), MAKER, "fork-op", "reserve", created.transition),
      id: "9".repeat(64),
      pubkey: MAKER,
      sig: "c".repeat(128)
    };
    relay.events = [accepted.projection];
    relay.transitions = [created.transition, accepted.transition, fork];

    const result = await service.loadBook(MARKET, 1_700_000_200);

    expect(result.book.asks).toEqual([]);
    expect(result.rejected).toBeGreaterThanOrEqual(3);
  });

  it("rejects a stale projection when a later linear successor exists", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => `operation-${signer.signed.length}`, 2, () => true);
    const created = await publishCreate(service);
    const reservePublication = await publishSuccessor(
      service,
      reserved(),
      "reserve",
      created.transition
    );
    const filled = fillOrder(reserved(), {
      reservationId: reserved().reservation!.id,
      amount: "2000"
    });
    await publishSuccessor(
      service,
      filled,
      "fill",
      reservePublication.transition,
      evidence
    );
    relay.events = [reservePublication.projection];

    const result = await service.loadBook(MARKET, 1_700_000_200);

    expect(result.book.asks).toEqual([]);
    expect(result.rejected).toBeGreaterThanOrEqual(3);
  });

  it("rejects a cryptographically valid successor with an invalid economic delta", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => "operation", 2, () => true);
    const created = await publishCreate(service);
    const invalidState = {
      ...reserved(),
      price_cents_per_btc: "100000000"
    };
    const invalidTransition: NostrEvent = {
      ...createStateTransitionTemplate(invalidState, MAKER, "invalid-op", "reserve", created.transition),
      id: "9".repeat(64),
      pubkey: MAKER,
      sig: "c".repeat(128)
    };
    const invalidProjection: NostrEvent = {
      ...await createProjectionTemplate(invalidState, invalidTransition),
      id: "8".repeat(64),
      pubkey: MAKER,
      sig: "c".repeat(128)
    };
    relay.events = [invalidProjection];
    relay.transitions = [created.transition, invalidTransition];

    const result = await service.loadBook(MARKET, 1_700_000_200);

    expect(result.book.asks).toEqual([]);
    expect(result.rejected).toBeGreaterThanOrEqual(2);
  });

  it("publishes the signed transition before its signed current projection", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => "operation-1", 2, () => true);
    const staged = await service.stage(order());
    const entry = entryFor(staged, "create", null, 2);

    const transitionAcknowledged = await service.publishNextStage(entry);

    expect(relay.published.map((event) => event.kind)).toEqual([78]);
    expect(transitionAcknowledged.status).toBe("transition_acknowledged");
    expect(transitionAcknowledged.publication.transitionReceipts
      .filter((receipt) => receipt.ok)).toHaveLength(3);
    expect(transitionAcknowledged.publication.projectionReceipts).toEqual([]);

    const projectionAcknowledged = await service.publishNextStage(transitionAcknowledged);
    expect(relay.published.map((event) => event.kind)).toEqual([78, 30078]);
    expect(projectionAcknowledged.status).toBe("projection_acknowledged");
    expect(projectionAcknowledged.publication.projection.tags)
      .toContainEqual(["e", staged.transition.id]);
    expect(JSON.parse(projectionAcknowledged.publication.projection.content).head)
      .toBe(staged.transition.id);
  });

  it("does not publish a projection when the transition misses quorum", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    relay.failTransition = true;
    const service = new NostrOrderService(signer, relay, () => "operation-1", 3, () => true);
    const staged = await service.stage(order());
    const entry = entryFor(staged, "create", null, 3);

    const partial = await service.publishNextStage(entry);
    expect(partial.status).toBe("staged");
    expect(partial.publication.transition.id).toBe("a".repeat(64));
    expect(partial.publication.projection.id).toBe("d".repeat(64));
    expect(relay.published.map((event) => event.kind)).toEqual([78]);
    expect(signer.signed).toHaveLength(2);

    relay.failTransition = false;
    const retried = await service.publishNextStage(partial);
    expect(retried.status).toBe("transition_acknowledged");
    expect(retried.publication.transition.id).toBe("a".repeat(64));
    expect(retried.publication.projection.id).toBe("d".repeat(64));
    expect(relay.published.map((event) => event.kind)).toEqual([78, 78]);

    const projected = await service.publishNextStage(retried);
    expect(projected.status).toBe("projection_acknowledged");
    expect(relay.published.map((event) => event.kind)).toEqual([78, 78, 30078]);
  });

  it("retries a failed projection without replacing its accepted transition", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => "operation-1", 3, () => true);
    const staged = await service.stage(order());
    const entry = entryFor(staged, "create", null, 3);
    const transitionAcknowledged = await service.publishNextStage(entry);
    relay.failProjection = true;

    const partial = await service.publishNextStage(transitionAcknowledged);
    expect(partial.status).toBe("transition_acknowledged");
    expect(relay.published.map((event) => event.kind)).toEqual([78, 30078]);

    relay.failProjection = false;
    const retried = await service.publishNextStage(partial);
    expect(retried.status).toBe("projection_acknowledged");
    expect(retried.publication.transition.id).toBe(staged.transition.id);
    expect(retried.publication.projection.id).toBe(staged.projection.id);
    expect(relay.published.map((event) => event.kind)).toEqual([78, 30078, 30078]);
  });

  it("builds the book only from verified, canonical projections", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => "operation-1", 2, () => true);
    const published = await publishCreate(service);
    relay.events = [
      published.projection,
      { ...published.projection, id: "f".repeat(64), content: "not json" }
    ];

    const result = await service.loadBook(MARKET, 1_700_000_100);

    expect(result.book.asks.map((entry) => entry.state.order_id)).toEqual([ORDER_ID]);
    expect(result.book.topAsk?.verified).toBe(true);
    expect(result.rejected).toBe(1);
  });

  it("omits conflicting current projections for the same order authority", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => "operation-1", 2, () => true);
    const published = await publishCreate(service);
    const conflicting: NostrEvent = {
      ...published.projection,
      id: "f".repeat(64),
      content: published.projection.content.replace(
        published.transition.id,
        "e".repeat(64)
      ),
      tags: published.projection.tags.map((tag) =>
        tag[0] === "e" ? ["e", "e".repeat(64)] : [...tag]
      )
    };
    relay.events = [published.projection, conflicting];

    const result = await service.loadBook(MARKET, 1_700_000_100);

    expect(result.book.asks).toEqual([]);
    expect(result.rejected).toBe(2);
  });

  it("rejects a projection whose authoritative head is missing", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => "operation-1", 2, () => true);
    const published = await publishCreate(service);
    relay.events = [published.projection];
    relay.transitions = [];

    const result = await service.loadBook(MARKET, 1_700_000_100);

    expect(result.book.asks).toEqual([]);
    expect(result.rejected).toBeGreaterThanOrEqual(1);
  });

  it("rejects hidden competing create roots for one order authority", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => "operation-1", 2, () => true);
    const published = await publishCreate(service);
    const fork: NostrEvent = {
      ...createTransitionTemplate(order(), MAKER, "operation-fork"),
      id: "e".repeat(64),
      pubkey: MAKER,
      sig: "f".repeat(128)
    };
    relay.events = [published.projection];
    relay.transitions = [published.transition, fork];

    const result = await service.loadBook(MARKET, 1_700_000_100);

    expect(result.book.asks).toEqual([]);
    expect(result.rejected).toBeGreaterThanOrEqual(2);
  });
});
