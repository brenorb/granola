import {
  createOrderState,
  type CreateOrderInput,
  type ExactMarket,
  type OrderState,
  type RationalPrice
} from "../order/model.js";
import type {
  LoadedOrderBook,
  OrderPublication
} from "../order/service.js";

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
  publish(state: OrderState): Promise<OrderPublication>;
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
    private readonly orderId: () => string = () => crypto.randomUUID()
  ) {}

  async getMakerIdentity(): Promise<{ publicKey: string }> {
    return { publicKey: await this.identity.publicKey() };
  }

  async getOrderBook(): Promise<LoadedOrderBook> {
    return this.orders.loadBook(TEST_MARKET, this.now());
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
    const publication = await this.orders.publish(state);
    return {
      orderId: state.order_id,
      makerPubkey: publication.projection.pubkey,
      transitionId: publication.transition.id,
      projectionId: publication.projection.id,
      transitionReceipts: publication.transitionReceipts,
      projectionReceipts: publication.projectionReceipts
    };
  }
}
