import type { GranolaApi, GranolaState, PublicQuote } from "./api/granola-api.js";
import type {
  OrderApi,
  OrderPublicationProgress,
  PublishCancelInput,
  PublishOrderInput
} from "./api/order-api.js";
import type { TakeOrderInput, TradeApi } from "./api/trade-api.js";
import type { BrowserTradeController } from "./browser/trade-controller.js";
import type { MintCapabilities, TokenSummary } from "./cashu/client.js";
import type { PublicTradeView } from "./trade/session.js";

/** Wire version implemented by the public Granola SDK boundary. */
export const GRANOLA_PROTOCOL_VERSION = "1" as const;

/** The redacted browser facade exposed as `window.granola`. */
export interface GranolaBrowserFacade {
  getState: GranolaApi["getState"];
  inspectMint: GranolaApi["inspectMint"];
  inspectToken: (token: string) => TokenSummary;
  requestMint: GranolaApi["requestMint"];
  claimMint: GranolaApi["claimMint"];
  receiveToken: GranolaApi["receiveToken"];
  createBackup: GranolaApi["createBackup"];
  clearWallet: GranolaApi["clearWallet"];
  resetProfile: (confirmation: string) => Promise<void>;
  getMakerPublicKeys: OrderApi["getMakerPublicKeys"];
  getOrderBook: OrderApi["getOrderBook"];
  publishOrder: (input: PublishOrderInput) => Promise<OrderPublicationProgress>;
  getPendingOrderPublications: OrderApi["getPendingOrderPublications"];
  retryOrderPublication: OrderApi["retryOrderPublication"];
  cancelOrder: (input: PublishCancelInput) => Promise<OrderPublicationProgress>;
  listTrades: TradeApi["listTrades"];
  getTrade: TradeApi["getTrade"];
  takeOrder: (input: TakeOrderInput) => Promise<PublicTradeView>;
  advanceTrade: TradeApi["advanceTrade"];
  runUntilSettled: BrowserTradeController["runUntilSettled"];
  enableMaker: BrowserTradeController["enableMaker"];
}

export type { GranolaState, PublicQuote, MintCapabilities, TokenSummary };
export type { PublishOrderInput, PublishCancelInput, OrderPublicationProgress } from "./api/order-api.js";
export type { TakeOrderInput, TradeApi } from "./api/trade-api.js";
