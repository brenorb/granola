import {
  createOrderState,
  type CreateOrderInput,
  type ExactMarket,
  type OrderState,
  type RationalPrice
} from "../order/model.js";
import type {
  LoadedOrderBook,
  OrderPublication,
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
  publishStaged(staged: StagedOrderPublication): Promise<OrderPublication>;
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
}
