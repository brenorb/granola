import { describe, expect, it } from "vitest";

import type { NostrEvent, UnsignedNostrEvent } from "./events.js";
import { createTransitionTemplate } from "./events.js";
import { createOrderState, type ExactMarket } from "./model.js";
import {
  NostrOrderService,
  PublicationQuorumError,
  type OrderRelayPort,
  type OrderSigner
} from "./service.js";

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
    price: { numerator: "101", denominator: "2000" }
  });
}

class FakeSigner implements OrderSigner {
  signed: NostrEvent[] = [];

  async publicKey(): Promise<string> {
    return MAKER;
  }

  async sign(template: UnsignedNostrEvent): Promise<NostrEvent> {
    const event: NostrEvent = {
      ...template,
      tags: template.tags.map((tag) => [...tag]),
      id: (this.signed.length === 0 ? "a" : "d").repeat(64),
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

  async publish(event: NostrEvent) {
    this.published.push(event);
    const fail = event.kind === 78 ? this.failTransition : this.failProjection;
    return [
      { relay: "wss://one.example", ok: true, message: "stored" },
      { relay: "wss://two.example", ok: !fail, message: fail ? "blocked" : "stored" },
      { relay: "wss://three.example", ok: true, message: "stored" }
    ];
  }

  async queryProjections(): Promise<NostrEvent[]> {
    return this.events;
  }

  async queryTransitions(): Promise<NostrEvent[]> {
    return this.transitions ?? this.published.filter((event) => event.kind === 78);
  }
}

describe("Nostr order service", () => {
  it("publishes the signed transition before its signed current projection", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => "operation-1", 2, () => true);

    const publication = await service.publish(order());

    expect(relay.published.map((event) => event.kind)).toEqual([78, 30078]);
    expect(publication.transitionReceipts.filter((receipt) => receipt.ok)).toHaveLength(3);
    expect(publication.projectionReceipts.filter((receipt) => receipt.ok)).toHaveLength(3);
    expect(publication.projection.tags).toContainEqual(["e", publication.transition.id]);
    expect(JSON.parse(publication.projection.content).head).toBe(publication.transition.id);
  });

  it("does not publish a projection when the transition misses quorum", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    relay.failTransition = true;
    const service = new NostrOrderService(signer, relay, () => "operation-1", 3, () => true);

    let failure: PublicationQuorumError | undefined;
    try {
      await service.publish(order());
    } catch (error) {
      if (error instanceof PublicationQuorumError) failure = error;
    }
    expect(failure).toBeInstanceOf(PublicationQuorumError);
    expect(failure?.publication.transition.id).toBe("a".repeat(64));
    expect(failure?.publication.projection.id).toBe("d".repeat(64));
    expect(relay.published.map((event) => event.kind)).toEqual([78]);
    expect(signer.signed).toHaveLength(2);

    relay.failTransition = false;
    const retried = await service.publishStaged(failure!.publication);
    expect(retried.transition.id).toBe("a".repeat(64));
    expect(retried.projection.id).toBe("d".repeat(64));
    expect(relay.published.map((event) => event.kind)).toEqual([78, 78, 30078]);
  });

  it("retries a failed projection without replacing its accepted transition", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    relay.failProjection = true;
    const service = new NostrOrderService(signer, relay, () => "operation-1", 3, () => true);

    let failure: PublicationQuorumError | undefined;
    try {
      await service.publish(order());
    } catch (error) {
      if (error instanceof PublicationQuorumError) failure = error;
    }
    expect(failure?.stage).toBe("projection");
    expect(relay.published.map((event) => event.kind)).toEqual([78, 30078]);

    relay.failProjection = false;
    const retried = await service.publishStaged(failure!.publication);
    expect(retried.transition.id).toBe(failure!.publication.transition.id);
    expect(retried.projection.id).toBe(failure!.publication.projection.id);
    expect(relay.published.map((event) => event.kind)).toEqual([78, 30078, 30078]);
  });

  it("builds the book only from verified, canonical projections", async () => {
    const signer = new FakeSigner();
    const relay = new FakeRelay();
    const service = new NostrOrderService(signer, relay, () => "operation-1", 2, () => true);
    const published = await service.publish(order());
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
    const published = await service.publish(order());
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
    const published = await service.publish(order());
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
    const published = await service.publish(order());
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
