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
  OrderRecord
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
  expectedHeadId: string;
  fillBaseAmount: string;
}

const KEYSET = /^[0-9a-f]{16,66}$/;
const HEX_32 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const defaultSessionFactory: TradeSessionFactoryPort = {
  createTaker: (input) => createTakerSession(input),
  createMaker: (input) => createMakerSession(input)
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Trade identity is not canonical");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function exactMarket(left: ExactMarket, right: ExactMarket): boolean {
  return left.baseMint === right.baseMint &&
    left.baseUnit === right.baseUnit &&
    left.quoteMint === right.quoteMint &&
    left.quoteUnit === right.quoteUnit;
}

function immutableSessionIdentity(session: TradeSession): unknown {
  return {
    sessionId: session.sessionId,
    reservationId: session.reservationId,
    role: session.role,
    orderAddress: session.orderAddress,
    offeredOrderHead: session.offeredOrderHead,
    terms: session.terms,
    makerPubkey: session.evidence.makerPubkey,
    proposalSealId: session.evidence.reservation.proposalSealId
  };
}

function sameImmutableSession(left: TradeSession, right: TradeSession): boolean {
  return canonical(immutableSessionIdentity(left)) ===
    canonical(immutableSessionIdentity(right));
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
      expectedHeadId: input.expectedHeadId,
      fillBaseAmount: input.fillBaseAmount
    };
    const existing = await this.sessions.getTakerForRequest(intent);
    if (existing !== undefined) {
      this.assertBoundTaker(existing, intent);
      return publicTradeView(existing);
    }
    const currentTime = this.currentTime();
    const order = await this.loadExactSellOrder(
      input.address,
      input.expectedHeadId,
      currentTime
    );
    const selectedMarket = await this.preflightMarket(order);
    const session = await this.sessionFactory.createTaker({
      order,
      expectedOrderHead: input.expectedHeadId,
      market: selectedMarket,
      fillBaseAmount: input.fillBaseAmount,
      clocks: {
        localNow: currentTime,
        baseMintNow: currentTime,
        quoteMintNow: currentTime
      }
    });
    const wallet = await this.wallets.load();
    if (selectedMarket.quoteKeyset !== session.terms.quoteKeyset) {
      throw new Error("Session quote keyset changed after exact mint preflight");
    }
    const quotePocket = exactPocket(
      wallet,
      session.terms.quoteMint,
      session.terms.quoteUnit,
      "quote"
    );
    const spendability =
      await this.spendability.inspectTradeSpendability(quotePocket);
    assertFunding(
      quotePocket,
      spendability,
      session.terms.quoteAmount,
      "quote"
    );
    const persisted = await this.sessions.createTakerForRequest(intent, session);
    this.assertBoundTaker(persisted, intent);
    return publicTradeView(persisted);
  }

  async acceptReserveProposal(
    proposal: VerifiedInitialReserveProposal
  ): Promise<PublicTradeView> {
    assertVerifiedInitialReserveProposal(proposal);
    const currentTime = this.currentTime();
    const order = await this.loadExactSellOrder(
      proposal.message.order_address,
      proposal.message.order_head,
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
    if (selectedMarket.baseKeyset !== session.terms.baseKeyset) {
      throw new Error("Session base keyset changed after exact mint preflight");
    }
    const basePocket = exactPocket(
      wallet,
      session.terms.baseMint,
      session.terms.baseUnit,
      "base"
    );
    const spendability =
      await this.spendability.inspectTradeSpendability(basePocket);
    assertFunding(
      basePocket,
      spendability,
      session.terms.baseAmount,
      "base"
    );
    return publicTradeView(await this.persistCreation(session));
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
      persisted.offeredOrderHead !== intent.expectedHeadId ||
      persisted.terms.baseAmount !== intent.fillBaseAmount ||
      persisted.terms.baseMint !== this.market.baseMint ||
      persisted.terms.baseUnit !== this.market.baseUnit ||
      persisted.terms.quoteMint !== this.market.quoteMint ||
      persisted.terms.quoteUnit !== this.market.quoteUnit
    ) {
      throw new Error("Durable taker request binding returned a conflicting session");
    }
  }

  private async loadExactSellOrder(
    address: string,
    expectedHeadId: string,
    now: number
  ): Promise<OrderRecord> {
    if (!address || !HEX_32.test(expectedHeadId)) {
      throw new Error("Trade order address or expected head is invalid");
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
    if (record.headEventId !== expectedHeadId) throw new Error("Trade order head is stale");
    if (
      record.state.side !== "sell" ||
      record.state.status !== "open" ||
      record.state.reservation !== null
    ) {
      throw new Error("Trade API accepts only open maker sell orders");
    }
    if (
      record.state.offered.mint !== this.market.baseMint ||
      record.state.offered.unit !== this.market.baseUnit ||
      record.state.base_unit !== this.market.baseUnit ||
      record.state.requested.unit !== this.market.quoteUnit ||
      record.state.quote_unit !== this.market.quoteUnit ||
      !record.state.requested.acceptable_mints.includes(this.market.quoteMint)
    ) {
      throw new Error("Trade order does not match the exact configured market");
    }
    return structuredClone(record);
  }

  private async preflightMarket(
    order: OrderRecord
  ): Promise<SessionMarketSelection> {
    const [base, quote] = await Promise.all([
      this.cashu.inspectTradeMint(
        order.state.offered.mint,
        order.state.offered.unit
      ),
      this.cashu.inspectTradeMint(
        this.market.quoteMint,
        order.state.requested.unit
      )
    ]);
    const exactBase = assertPreflight(
      base,
      order.state.offered.mint,
      order.state.offered.unit
    );
    const exactQuote = assertPreflight(
      quote,
      this.market.quoteMint,
      order.state.requested.unit
    );
    return {
      baseMint: exactBase.mintUrl,
      baseUnit: exactBase.unit,
      baseKeyset: exactBase.keysetId,
      quoteMint: exactQuote.mintUrl,
      quoteUnit: exactQuote.unit,
      quoteKeyset: exactQuote.keysetId
    };
  }

  private async persistCreation(session: TradeSession): Promise<TradeSession> {
    if (session.revision !== 0) {
      throw new Error("Trade session creation requires revision zero");
    }
    const existing = await this.sessions.get(session.sessionId);
    if (existing !== undefined) {
      if (!sameImmutableSession(existing, session)) {
        throw new Error("Trade start found a conflicting session");
      }
      return existing;
    }
    try {
      await this.sessions.save(session, null);
      return session;
    } catch (error) {
      const raced = await this.sessions.get(session.sessionId);
      if (raced === undefined) throw error;
      if (!sameImmutableSession(raced, session)) {
        throw new Error("Trade start found a conflicting session");
      }
      return raced;
    }
  }
}
