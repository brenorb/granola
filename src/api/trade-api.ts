import type {
  TradeMintPreflight,
  TradeSpendability
} from "../cashu/client.js";
import {
  normalizeMintUrl,
  type WalletPocket,
  type WalletState
} from "../core/wallet.js";
import type {
  ExactMarket,
  OrderRecord,
  OrderSide
} from "../order/model.js";
import type { LoadedOrderBook } from "../order/service.js";
import type { TakerStartIntent } from "../storage/trade-session.js";
import {
  assertVerifiedInitialReserveProposal,
  type VerifiedInitialReserveProposal
} from "../trade/messages.js";
import {
  createMakerSession,
  createTakerSession,
  type MakerSessionInput,
  type SessionMarketSelection,
  type TakerSessionInput
} from "../trade/session-factory.js";
import {
  publicTradeView,
  type PublicTradeView,
  type TradeSession
} from "../trade/session.js";

export interface TradeCoordinatorApiPort {
  list(): Promise<PublicTradeView[]>;
  get(sessionId: string): Promise<PublicTradeView | undefined>;
  advance(sessionId: string): Promise<PublicTradeView>;
}

export interface TradeOrderBookPort {
  loadBook(market: ExactMarket, now: number): Promise<LoadedOrderBook>;
}

export interface TradeMintPreflightPort {
  inspectTradeMint(mintUrl: string, unit: string): Promise<TradeMintPreflight>;
}

export interface TradeWalletPort {
  load(): Promise<WalletState>;
}

export interface TradeSpendabilityPort {
  inspectTradeSpendability(pocket: WalletPocket): Promise<TradeSpendability>;
}

export type { TakerStartIntent } from "../storage/trade-session.js";

export interface TradeStartRepository {
  list(): Promise<TradeSession[]>;
  get(sessionId: string): Promise<TradeSession | undefined>;
  save(session: TradeSession, expectedRevision: number | null): Promise<void>;
  /**
   * Atomically binds requestId and its exact immutable intent to one revision-0
   * session. An exact retry returns the already-bound session; a reused request
   * ID with different intent fails.
   */
  createTakerForRequest(
    intent: TakerStartIntent,
    session: TradeSession
  ): Promise<TradeSession>;
  getTakerForRequest(intent: TakerStartIntent): Promise<TradeSession | undefined>;
  /**
   * Atomically creates one active maker session for an order. Exact proposal
   * retries return the existing session; another taker cannot race it.
   */
  createMakerForOrder(session: TradeSession): Promise<TradeSession>;
}

export interface TradeSessionFactoryPort {
  createTaker(input: TakerSessionInput): Promise<TradeSession>;
  createMaker(input: MakerSessionInput): Promise<TradeSession>;
}

export interface TradeApiOptions {
  coordinator: TradeCoordinatorApiPort;
  orders: TradeOrderBookPort;
  cashu: TradeMintPreflightPort;
  wallets: TradeWalletPort;
  spendability: TradeSpendabilityPort;
  sessions: TradeStartRepository;
  market: ExactMarket;
  now?: () => number;
  sessionFactory?: TradeSessionFactoryPort;
}

export interface TakeOrderInput {
  requestId: string;
  address: string;
  expectedProjectionId: string;
  expectedRevision: string;
  fillBaseAmount: string;
}

const KEYSET = /^[0-9a-f]{16,66}$/;
const HEX_32 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const defaultSessionFactory: TradeSessionFactoryPort = {
  createTaker: (input) => createTakerSession(input),
  createMaker: (input) => createMakerSession(input)
};

function exactMarket(left: ExactMarket, right: ExactMarket): boolean {
  return left.baseMint === right.baseMint &&
    left.baseUnit === right.baseUnit &&
    left.quoteMint === right.quoteMint &&
    left.quoteUnit === right.quoteUnit;
}

function makerOfferedLeg(side: OrderSide): "base" | "quote" {
  return side === "sell" ? "base" : "quote";
}

function takerFundingLeg(side: OrderSide): "base" | "quote" {
  return side === "sell" ? "quote" : "base";
}

function proofAmount(value: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("Wallet contains a malformed proof amount");
  }
  return BigInt(value);
}

function exactPocket(
  wallet: WalletState,
  mintValue: string,
  unit: string,
  label: "base" | "quote"
): WalletPocket {
  const mintUrl = normalizeMintUrl(mintValue);
  const proofs = wallet.pockets
    .filter((pocket) =>
      normalizeMintUrl(pocket.mintUrl) === mintUrl &&
      pocket.unit === unit
    )
    .flatMap((pocket) => pocket.proofs)
    .map((proof) => structuredClone(proof));
  if (proofs.length === 0) {
    throw new Error(`Wallet has no exact ${label} funding pocket`);
  }
  return { mintUrl, unit, proofs };
}

function assertFunding(
  pocket: WalletPocket,
  spendability: TradeSpendability,
  targetAmount: string,
  label: "base" | "quote"
): void {
  if (
    !/^[1-9]\d*$/.test(targetAmount) ||
    !/^[1-9]\d*$/.test(spendability.faceAmount) ||
    !/^(0|[1-9]\d*)$/.test(spendability.spendableAmount) ||
    !/^(0|[1-9]\d*)$/.test(spendability.inputFee) ||
    spendability.mintUrl !== pocket.mintUrl ||
    spendability.unit !== pocket.unit ||
    spendability.proofCount !== pocket.proofs.length
  ) {
    throw new Error(`Exact ${label} spendability result is invalid`);
  }
  const face = pocket.proofs.reduce(
    (sum, proof) => sum + proofAmount(proof.amount),
    0n
  );
  const reportedFace = BigInt(spendability.faceAmount);
  const spendable = BigInt(spendability.spendableAmount);
  const fee = BigInt(spendability.inputFee);
  if (
    reportedFace !== face ||
    spendable > face ||
    face - spendable !== fee
  ) {
    throw new Error(`Exact ${label} spendability amount is inconsistent`);
  }
  if (spendable < BigInt(targetAmount)) {
    throw new Error(`Exact ${label} funding cannot cover the amount and input fee`);
  }
}

function assertPreflight(
  result: TradeMintPreflight,
  mintValue: string,
  unit: string
): TradeMintPreflight {
  const mint = normalizeMintUrl(mintValue);
  if (
    result.mintUrl !== mint ||
    result.unit !== unit ||
    !KEYSET.test(result.keysetId) ||
    !Number.isSafeInteger(result.inputFeePpk) ||
    result.inputFeePpk < 0
  ) {
    throw new Error("Trade mint preflight does not match an exact usable market leg");
  }
  return result;
}

export class TradeApi {
  private readonly coordinator: TradeCoordinatorApiPort;
  private readonly orders: TradeOrderBookPort;
  private readonly cashu: TradeMintPreflightPort;
  private readonly wallets: TradeWalletPort;
  private readonly spendability: TradeSpendabilityPort;
  private readonly sessions: TradeStartRepository;
  private readonly market: ExactMarket;
  private readonly now: () => number;
  private readonly sessionFactory: TradeSessionFactoryPort;

  constructor(options: TradeApiOptions) {
    this.coordinator = options.coordinator;
    this.orders = options.orders;
    this.cashu = options.cashu;
    this.wallets = options.wallets;
    this.spendability = options.spendability;
    this.sessions = options.sessions;
    this.market = {
      baseMint: normalizeMintUrl(options.market.baseMint),
      baseUnit: options.market.baseUnit,
      quoteMint: normalizeMintUrl(options.market.quoteMint),
      quoteUnit: options.market.quoteUnit
    };
    if (!exactMarket(this.market, options.market)) {
      throw new Error("Trade API market must use canonical mint URLs");
    }
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.sessionFactory = options.sessionFactory ?? defaultSessionFactory;
  }

  async listTrades(): Promise<PublicTradeView[]> {
    return structuredClone(await this.coordinator.list());
  }

  async getTrade(sessionId: string): Promise<PublicTradeView | undefined> {
    const view = await this.coordinator.get(sessionId);
    return view === undefined ? undefined : structuredClone(view);
  }

  async advanceTrade(sessionId: string): Promise<PublicTradeView> {
    return structuredClone(await this.coordinator.advance(sessionId));
  }

  async takeOrder(input: TakeOrderInput): Promise<PublicTradeView> {
    if (!UUID_V4.test(input.requestId)) {
      throw new Error("Taker start request ID must be a lowercase UUIDv4");
    }
    const intent = {
      requestId: input.requestId,
      address: input.address,
      expectedProjectionId: input.expectedProjectionId,
      expectedRevision: input.expectedRevision,
      fillBaseAmount: input.fillBaseAmount
    };
    const existing = await this.sessions.getTakerForRequest(intent);
    if (existing !== undefined) {
      this.assertBoundTaker(existing, intent);
      return publicTradeView(existing);
    }
    const currentTime = this.currentTime();
    const order = await this.loadExactOrder(
      input.address,
      input.expectedProjectionId,
      input.expectedRevision,
      currentTime
    );
    const selectedMarket = await this.preflightMarket(order);
    const session = await this.sessionFactory.createTaker({
      order,
      expectedOrderProjectionId: input.expectedProjectionId,
      expectedOrderRevision: input.expectedRevision,
      market: selectedMarket,
      fillBaseAmount: input.fillBaseAmount,
      clocks: {
        localNow: currentTime,
        baseMintNow: currentTime,
        quoteMintNow: currentTime
      }
    });
    const wallet = await this.wallets.load();
    const fundingLeg = takerFundingLeg(order.state.side);
    const fundingMint = fundingLeg === "base"
      ? session.terms.baseMint
      : session.terms.quoteMint;
    const fundingUnit = fundingLeg === "base"
      ? session.terms.baseUnit
      : session.terms.quoteUnit;
    const fundingKeyset = fundingLeg === "base"
      ? session.terms.baseKeyset
      : session.terms.quoteKeyset;
    const targetAmount = fundingLeg === "base"
      ? session.terms.baseAmount
      : session.terms.quoteAmount;
    if (fundingKeyset !== (fundingLeg === "base"
      ? selectedMarket.baseKeyset
      : selectedMarket.quoteKeyset)) {
      throw new Error(`Session ${fundingLeg} keyset changed after exact mint preflight`);
    }
    const fundingPocket = exactPocket(
      wallet,
      fundingMint,
      fundingUnit,
      fundingLeg
    );
    const spendability =
      await this.spendability.inspectTradeSpendability(fundingPocket);
    assertFunding(
      fundingPocket,
      spendability,
      targetAmount,
      fundingLeg
    );
    const persisted = await this.sessions.createTakerForRequest(intent, session);
    this.assertBoundTaker(persisted, intent);
    return publicTradeView(persisted);
  }

  async acceptReserveProposal(
    proposal: VerifiedInitialReserveProposal
  ): Promise<PublicTradeView> {
    assertVerifiedInitialReserveProposal(proposal);
    const existing = await this.sessions.get(proposal.message.session_id);
    if (existing !== undefined) {
      this.assertBoundMaker(existing, proposal);
      return publicTradeView(existing);
    }
    const currentTime = this.currentTime();
    const order = await this.loadExactOrder(
      proposal.message.order_address,
      proposal.message.order_projection_id,
      proposal.message.order_revision,
      currentTime
    );
    const selectedMarket = await this.preflightMarket(order);
    const session = await this.sessionFactory.createMaker({
      order,
      proposal,
      market: selectedMarket,
      clocks: {
        localNow: currentTime,
        baseMintNow: currentTime,
        quoteMintNow: currentTime
      }
    });
    const wallet = await this.wallets.load();
    const fundingLeg = makerOfferedLeg(order.state.side);
    const fundingMint = fundingLeg === "base"
      ? session.terms.baseMint
      : session.terms.quoteMint;
    const fundingUnit = fundingLeg === "base"
      ? session.terms.baseUnit
      : session.terms.quoteUnit;
    const fundingKeyset = fundingLeg === "base"
      ? session.terms.baseKeyset
      : session.terms.quoteKeyset;
    const targetAmount = fundingLeg === "base"
      ? session.terms.baseAmount
      : session.terms.quoteAmount;
    if (fundingKeyset !== (fundingLeg === "base"
      ? selectedMarket.baseKeyset
      : selectedMarket.quoteKeyset)) {
      throw new Error(`Session ${fundingLeg} keyset changed after exact mint preflight`);
    }
    const fundingPocket = exactPocket(
      wallet,
      fundingMint,
      fundingUnit,
      fundingLeg
    );
    const spendability =
      await this.spendability.inspectTradeSpendability(fundingPocket);
    assertFunding(
      fundingPocket,
      spendability,
      targetAmount,
      fundingLeg
    );
    const persisted = await this.sessions.createMakerForOrder(session);
    this.assertBoundMaker(persisted, proposal);
    return publicTradeView(persisted);
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Trade API clock must be a non-negative Unix timestamp");
    }
    return value;
  }

  private assertBoundTaker(
    persisted: TradeSession,
    intent: TakerStartIntent
  ): void {
    if (
      persisted.role !== "taker" ||
      persisted.orderAddress !== intent.address ||
      persisted.offeredProjectionId !== intent.expectedProjectionId ||
      persisted.offeredProjectionRevision !== intent.expectedRevision ||
      persisted.terms.baseAmount !== intent.fillBaseAmount ||
      persisted.terms.baseMint !== this.market.baseMint ||
      persisted.terms.baseUnit !== this.market.baseUnit ||
      persisted.terms.quoteMint !== this.market.quoteMint ||
      persisted.terms.quoteUnit !== this.market.quoteUnit
    ) {
      throw new Error("Durable taker request binding returned a conflicting session");
    }
  }

  private assertBoundMaker(
    session: TradeSession,
    proposal: VerifiedInitialReserveProposal
  ): void {
    const accepted = session.privateState.transcript.accepted[0];
    if (
      session.role !== "maker" ||
      session.sessionId !== proposal.message.session_id ||
      session.reservationId !== proposal.message.reservation_id ||
      session.orderAddress !== proposal.message.order_address ||
      session.offeredProjectionId !== proposal.message.order_projection_id ||
      session.offeredProjectionRevision !== proposal.message.order_revision ||
      session.evidence.makerPubkey !== proposal.message.maker_order_pubkey ||
      session.evidence.reservation.proposalSealId !== proposal.seal.id ||
      accepted?.messageId !== proposal.message.message_id ||
      accepted.rumorId !== proposal.rumor.id ||
      accepted.transcriptHash !== proposal.transcriptHash ||
      accepted.authorPubkey !== proposal.message.author_pubkey ||
      accepted.recipientPubkey !== proposal.message.recipient_pubkey
    ) {
      throw new Error("Maker proposal is bound to a conflicting trade session");
    }
  }

  private async loadExactOrder(
    address: string,
    expectedProjectionId: string,
    expectedRevision: string,
    now: number
  ): Promise<OrderRecord> {
    if (
      !address ||
      !HEX_32.test(expectedProjectionId) ||
      !/^(0|[1-9]\d*)$/.test(expectedRevision)
    ) {
      throw new Error("Trade order projection binding is invalid");
    }
    const loaded = await this.orders.loadBook(this.market, now);
    if (!exactMarket(loaded.book.market, this.market)) {
      throw new Error("Loaded order book does not match the exact trade market");
    }
    const matching = [...loaded.book.asks, ...loaded.book.bids]
      .filter((record) => record.address === address);
    if (matching.length !== 1) {
      throw new Error("Exact current order was not found in the verified order book");
    }
    const record = matching[0]!;
    if (!record.verified) throw new Error("Trade order is not verified");
    if (
      record.eventId !== expectedProjectionId ||
      record.state.revision !== expectedRevision
    ) {
      throw new Error("Trade order projection is stale");
    }
    const state = record.state;
    const exactAssets = state.side === "sell"
      ? state.offered.mint === this.market.baseMint &&
        state.offered.unit === this.market.baseUnit &&
        state.requested.unit === this.market.quoteUnit &&
        state.requested.acceptable_mints.includes(this.market.quoteMint)
      : state.side === "buy" &&
        state.offered.mint === this.market.quoteMint &&
        state.offered.unit === this.market.quoteUnit &&
        state.requested.unit === this.market.baseUnit &&
        state.requested.acceptable_mints.includes(this.market.baseMint);
    if (
      (state.side !== "sell" && state.side !== "buy") ||
      state.status !== "open" ||
      state.reservation !== null ||
      state.base_unit !== this.market.baseUnit ||
      state.quote_unit !== this.market.quoteUnit ||
      !exactAssets
    ) {
      throw new Error("Trade order does not match the exact configured market");
    }
    return structuredClone(record);
  }

  private async preflightMarket(
    order: OrderRecord
  ): Promise<SessionMarketSelection> {
    const baseRequest = order.state.side === "sell"
      ? { mint: order.state.offered.mint, unit: order.state.offered.unit }
      : { mint: this.market.baseMint, unit: order.state.requested.unit };
    const quoteRequest = order.state.side === "sell"
      ? { mint: this.market.quoteMint, unit: order.state.requested.unit }
      : { mint: order.state.offered.mint, unit: order.state.offered.unit };
    const [base, quote] = await Promise.all([
      this.cashu.inspectTradeMint(baseRequest.mint, baseRequest.unit),
      this.cashu.inspectTradeMint(quoteRequest.mint, quoteRequest.unit)
    ]);
    const exactBase = assertPreflight(base, baseRequest.mint, baseRequest.unit);
    const exactQuote = assertPreflight(quote, quoteRequest.mint, quoteRequest.unit);
    if (exactBase.mintUrl !== this.market.baseMint ||
        exactBase.unit !== this.market.baseUnit ||
        exactQuote.mintUrl !== this.market.quoteMint ||
        exactQuote.unit !== this.market.quoteUnit) {
      throw new Error("Trade mint preflight does not match the exact configured market");
    }
    return {
      baseMint: exactBase.mintUrl,
      baseUnit: exactBase.unit,
      baseKeyset: exactBase.keysetId,
      quoteMint: exactQuote.mintUrl,
      quoteUnit: exactQuote.unit,
      quoteKeyset: exactQuote.keysetId
    };
  }

}
