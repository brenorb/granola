import { verifyEvent } from "nostr-tools/pure";

import {
  createOrderState,
  fillOrder as fillOrderState,
  reserveOrder as reserveOrderState,
  type CreateOrderInput,
  type ExactMarket,
  type FillOrderInput,
  type OrderState,
  type RationalPrice,
  type ReserveOrderInput
} from "../order/model.js";
import {
  parseTransitionEvent,
  type NostrEvent,
  type TransitionEvidence
} from "../order/events.js";
import type {
  LoadedOrderBook,
  OrderPublication,
  SuccessorOperation,
  StagedOrderPublication
} from "../order/service.js";
import { PublicationQuorumError } from "../order/service.js";
import type { OrderOutboxPort } from "../storage/order-outbox.js";

export const TEST_MARKET: ExactMarket = {
  baseUnit: "sat",
  baseMint: "https://testnut.cashu.space",
  quoteUnit: "usd",
  quoteMint: "https://nofee.testnut.cashu.space"
};

export interface MakerIdentityPort {
  publicKey(): Promise<string>;
}

export interface OrderServicePort {
  stage(state: OrderState): Promise<StagedOrderPublication>;
  stageSuccessor(
    state: OrderState,
    operation: SuccessorOperation,
    previous: NostrEvent,
    evidence?: TransitionEvidence,
    createdAt?: number
  ): Promise<StagedOrderPublication>;
  publishStaged(staged: StagedOrderPublication): Promise<OrderPublication>;
  loadCurrentTransition(address: string, expectedHeadId: string): Promise<NostrEvent>;
  loadBook(market: ExactMarket, now: number): Promise<LoadedOrderBook>;
}

export interface PublishOrderInput {
  side: "buy" | "sell";
  amount: string;
  price: RationalPrice;
  expiresAt?: number;
  execution?: "all_or_none" | "partial";
  minimumFillAmount?: string;
}

export interface PublicOrderPublication {
  orderId: string;
  makerPubkey: string;
  transitionId: string;
  projectionId: string;
  transitionReceipts: OrderPublication["transitionReceipts"];
  projectionReceipts: OrderPublication["projectionReceipts"];
}

export interface PublishReserveInput extends Omit<ReserveOrderInput, "acceptedAt"> {
  address: string;
  expectedHeadId: string;
}

export interface PublishFillInput extends FillOrderInput {
  address: string;
  expectedHeadId: string;
  evidence: TransitionEvidence;
}

class VolatileOrderOutbox implements OrderOutboxPort {
  private readonly publications = new Map<string, StagedOrderPublication>();

  async load(orderId: string): Promise<StagedOrderPublication | undefined> {
    const publication = this.publications.get(orderId);
    return publication ? structuredClone(publication) : undefined;
  }

  async list(): Promise<StagedOrderPublication[]> {
    return [...this.publications.values()].map((publication) => structuredClone(publication));
  }

  async save(publication: StagedOrderPublication): Promise<void> {
    this.publications.set(publication.state.order_id, structuredClone(publication));
  }

  async remove(orderId: string): Promise<void> {
    this.publications.delete(orderId);
  }
}

function publicPublication(publication: StagedOrderPublication): PublicOrderPublication {
  return {
    orderId: publication.state.order_id,
    makerPubkey: publication.projection.pubkey,
    transitionId: publication.transition.id,
    projectionId: publication.projection.id,
    transitionReceipts: publication.transitionReceipts,
    projectionReceipts: publication.projectionReceipts
  };
}

export class PendingPublicationError extends Error {
  readonly publication: PublicOrderPublication;

  constructor(
    readonly stage: "transition" | "projection",
    publication: StagedOrderPublication
  ) {
    super(`Order publication is pending at the ${stage} relay quorum`);
    this.name = "PendingPublicationError";
    this.publication = publicPublication(publication);
  }
}

function orderAssets(side: PublishOrderInput["side"]): Pick<CreateOrderInput, "offered" | "requested"> {
  return side === "sell"
    ? {
        offered: { unit: TEST_MARKET.baseUnit, mint: TEST_MARKET.baseMint },
        requested: {
          unit: TEST_MARKET.quoteUnit,
          acceptableMints: [TEST_MARKET.quoteMint]
        }
      }
    : {
        offered: { unit: TEST_MARKET.quoteUnit, mint: TEST_MARKET.quoteMint },
        requested: {
          unit: TEST_MARKET.baseUnit,
          acceptableMints: [TEST_MARKET.baseMint]
        }
      };
}

export class OrderApi {
  private readonly successorQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly identity: MakerIdentityPort,
    private readonly orders: OrderServicePort,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly orderId: () => string = () => crypto.randomUUID(),
    private readonly outbox: OrderOutboxPort = new VolatileOrderOutbox()
  ) {}

  async getMakerIdentity(): Promise<{ publicKey: string }> {
    return { publicKey: await this.identity.publicKey() };
  }

  async getOrderBook(): Promise<LoadedOrderBook> {
    return this.orders.loadBook(TEST_MARKET, this.now());
  }

  async getPendingOrderPublications(): Promise<PublicOrderPublication[]> {
    return (await this.outbox.list()).map(publicPublication);
  }

  private async serializeSuccessor<T>(
    address: string,
    action: () => Promise<T>
  ): Promise<T> {
    const previous = this.successorQueues.get(address) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.successorQueues.set(address, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.successorQueues.get(address) === queued) {
        this.successorQueues.delete(address);
      }
    }
  }

  private async loadMakerHead(
    address: string,
    expectedHeadId: string
  ): Promise<{ previous: NostrEvent; state: OrderState }> {
    const previous = await this.orders.loadCurrentTransition(address, expectedHeadId);
    if (previous.id !== expectedHeadId) {
      throw new Error("Order service returned a different transition head");
    }
    const record = parseTransitionEvent(previous, (event) => verifyEvent(event));
    if (record.address !== address) {
      throw new Error("Order service returned a transition for another address");
    }
    if (record.makerPubkey !== await this.identity.publicKey()) {
      throw new Error("Order transition belongs to another maker");
    }
    if (await this.outbox.load(record.state.order_id)) {
      throw new Error("Order has a pending publication; retry it before publishing a successor");
    }
    return { previous, state: record.state };
  }

  private async settle(staged: StagedOrderPublication): Promise<PublicOrderPublication> {
    try {
      const publication = await this.orders.publishStaged(staged);
      await this.outbox.remove(publication.state.order_id);
      return publicPublication(publication);
    } catch (error) {
      if (error instanceof PublicationQuorumError) {
        await this.outbox.save(error.publication);
        throw new PendingPublicationError(error.stage, error.publication);
      }
      throw error;
    }
  }

  async retryOrderPublication(orderId: string): Promise<PublicOrderPublication> {
    const staged = await this.outbox.load(orderId);
    if (!staged) throw new Error("No pending publication exists for this order ID");
    return this.settle(staged);
  }

  async publishOrder(input: PublishOrderInput): Promise<PublicOrderPublication> {
    const createdAt = this.now();
    const state = createOrderState({
      orderId: this.orderId(),
      createdAt,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      side: input.side,
      baseUnit: TEST_MARKET.baseUnit,
      quoteUnit: TEST_MARKET.quoteUnit,
      ...orderAssets(input.side),
      amount: input.amount,
      price: input.price,
      ...(input.execution === undefined ? {} : { execution: input.execution }),
      ...(input.minimumFillAmount === undefined
        ? {}
        : { minimumFillAmount: input.minimumFillAmount })
    });
    const staged = await this.orders.stage(state);
    await this.outbox.save(staged);
    return this.settle(staged);
  }

  async reserveOrder(input: PublishReserveInput): Promise<PublicOrderPublication> {
    return this.serializeSuccessor(input.address, async () => {
      const { previous, state } = await this.loadMakerHead(
        input.address,
        input.expectedHeadId
      );
      const acceptedAt = this.now();
      const next = reserveOrderState(state, {
        reservationId: input.reservationId,
        amount: input.amount,
        acceptedAt,
        expiresAt: input.expiresAt,
        proposalEventId: input.proposalEventId,
        takerCommitment: input.takerCommitment
      });
      const staged = await this.orders.stageSuccessor(
        next,
        "reserve",
        previous,
        undefined,
        acceptedAt
      );
      await this.outbox.save(staged);
      return this.settle(staged);
    });
  }

  async fillOrder(input: PublishFillInput): Promise<PublicOrderPublication> {
    return this.serializeSuccessor(input.address, async () => {
      const { previous, state } = await this.loadMakerHead(
        input.address,
        input.expectedHeadId
      );
      const createdAt = this.now();
      const next = fillOrderState(state, {
        reservationId: input.reservationId,
        amount: input.amount
      });
      const staged = await this.orders.stageSuccessor(
        next,
        "fill",
        previous,
        input.evidence,
        createdAt
      );
      await this.outbox.save(staged);
      return this.settle(staged);
    });
  }
}
