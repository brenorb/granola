import type {
  TakeOrderInput,
  TradeApi
} from "../api/trade-api.js";
import type { BrowserInboxPort } from "./trade-runtime.js";
import type { MakerIdentity } from "../nostr/identity.js";
import {
  startTradeSubscription,
  type StartTradeSubscriptionInput,
  type TradeSubscription,
  type TradeSubscriptionError
} from "../nostr/trade-subscription.js";
import type { NostrTradeTransport } from "../nostr/trade-transport.js";
import type { NostrEvent } from "../order/events.js";
import type { TradeSessionRepository } from "../storage/trade-session.js";
import {
  unwrapInitialReserveProposalForMaker,
  type VerifiedInitialReserveProposal
} from "../trade/messages.js";
import type {
  PublicTradeView,
  TradeSession
} from "../trade/session.js";

const GIFT_WRAP_LOOKBACK = 172_800;
const HEX_SECRET = /^[0-9a-f]{64}$/;

function bytes(hex: string): Uint8Array {
  if (!HEX_SECRET.test(hex)) {
    throw new Error("Trade session contains an invalid Nostr key");
  }
  return Uint8Array.from(
    hex.match(/../g) ?? [],
    (part) => Number.parseInt(part, 16)
  );
}

export interface MakerInboxStatus {
  makerPubkey: string;
  inboxRelay: string;
}

export interface RedactedTradeCheckpoint {
  revision: number;
  phase: PublicTradeView["phase"];
  role: PublicTradeView["role"];
}

export interface RunUntilSettledResult {
  sessionId: string;
  finalPhase: "filled";
  checkpoints: readonly RedactedTradeCheckpoint[];
}

type StartSubscription = (
  input: StartTradeSubscriptionInput
) => Promise<TradeSubscription>;

export interface BrowserTradeControllerOptions {
  api: Pick<
    TradeApi,
    | "listTrades"
    | "getTrade"
    | "takeOrder"
    | "acceptReserveProposal"
    | "advanceTrade"
  >;
  sessions: Pick<TradeSessionRepository, "get">;
  transport: Pick<
    NostrTradeTransport,
    "createRegistration" | "publishRegistration"
  >;
  inboxPort: BrowserInboxPort;
  inboxRelay: string;
  makerIdentity: {
    publicKey: (orderId?: string) => Promise<string>;
    useOrderSecretKey?: MakerIdentity["useOrderSecretKey"];
    listOrderIds?: () => Promise<string[]>;
    useSecretKey?: <T>(action: (secretKey: Uint8Array) => Promise<T>) => Promise<T>;
  };
  now?: () => number;
  startSubscription?: StartSubscription;
  openProposal?: (
    event: NostrEvent,
    makerOrderSecretKey: Uint8Array,
    options: { now: number }
  ) => Promise<VerifiedInitialReserveProposal>;
  onChange?: (trade: PublicTradeView) => void;
  onMakerAccepted?: (trade: PublicTradeView) => void;
  onError?: (message: string) => void;
  onMakerError?: (message: string) => void;
  wait?: (delayMs: number) => Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PEER_WAIT_MESSAGES = new Set([
  "No private trade message is available",
  "No next private trade message is available"
]);

export class BrowserTradeController {
  private readonly api: BrowserTradeControllerOptions["api"];
  private readonly sessions: BrowserTradeControllerOptions["sessions"];
  private readonly transport: BrowserTradeControllerOptions["transport"];
  private readonly inboxPort: BrowserTradeControllerOptions["inboxPort"];
  private readonly inboxRelay: string;
  private readonly makerIdentity: BrowserTradeControllerOptions["makerIdentity"];
  private readonly now: () => number;
  private readonly startSubscription: StartSubscription;
  private readonly openProposal: NonNullable<
    BrowserTradeControllerOptions["openProposal"]
  >;
  private readonly onChange: (trade: PublicTradeView) => void;
  private readonly onMakerAccepted: (trade: PublicTradeView) => void;
  private readonly onError: (message: string) => void;
  private readonly onMakerError: (message: string) => void;
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly subscriptions = new Map<string, TradeSubscription>();
  private readonly makerSettlementRuns = new Map<string, Promise<RunUntilSettledResult>>();
  private makerSubscriptionKeys = new Set<string>();
  private readonly subscriptionStarts = new Map<string, Promise<void>>();
  private subscriptionGeneration = 0;

  constructor(options: BrowserTradeControllerOptions) {
    this.api = options.api;
    this.sessions = options.sessions;
    this.transport = options.transport;
    this.inboxPort = options.inboxPort;
    this.inboxRelay = options.inboxRelay;
    this.makerIdentity = options.makerIdentity;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.startSubscription = options.startSubscription ?? startTradeSubscription;
    this.openProposal = options.openProposal ??
      ((event, secretKey, openOptions) =>
        unwrapInitialReserveProposalForMaker(event, secretKey, openOptions));
    this.onChange = options.onChange ?? (() => undefined);
    this.onMakerAccepted = options.onMakerAccepted ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.onMakerError = options.onMakerError ?? this.onError;
    this.wait = options.wait ?? ((delayMs) =>
      new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)));
  }

  listTrades(): Promise<PublicTradeView[]> {
    return this.api.listTrades();
  }

  getTrade(sessionId: string): Promise<PublicTradeView | undefined> {
    return this.api.getTrade(sessionId);
  }

  async takeOrder(input: TakeOrderInput): Promise<PublicTradeView> {
    const trade = await this.api.takeOrder(input);
    await this.ensureSessionSubscription(trade.sessionId);
    this.onChange(trade);
    return trade;
  }

  async advanceTrade(sessionId: string): Promise<PublicTradeView> {
    const trade = await this.api.advanceTrade(sessionId);
    await this.ensureSessionSubscription(sessionId);
    this.onChange(trade);
    return trade;
  }

  async resume(): Promise<PublicTradeView[]> {
    const trades = await this.api.listTrades();
    const makerWinners = this.makerSettlementWinners(trades);
    await Promise.all(trades.map(async (trade) => {
      await this.ensureSessionSubscription(trade.sessionId);
      if (makerWinners.has(trade.sessionId)) {
        this.startMakerSettlementInBackground(trade.sessionId);
      }
    }));
    return trades;
  }

  async runUntilSettled(
    sessionId: string,
    reportError: (message: string) => void = this.onError
  ): Promise<RunUntilSettledResult> {
    let current = await this.api.getTrade(sessionId);
    if (current === undefined) throw new Error("Trade session does not exist");
    this.startSessionSubscriptionInBackground(sessionId, reportError);
    const checkpoints: RedactedTradeCheckpoint[] = [];
    const record = (trade: PublicTradeView): void => {
      const latest = checkpoints.at(-1);
      if (latest?.revision === trade.revision) return;
      checkpoints.push({
        revision: trade.revision,
        phase: trade.phase,
        role: trade.role
      });
    };
    record(current);
    let actions = 0;
    let idlePolls = 0;
    while (current.phase !== "filled") {
      if (current.phase === "frozen" || current.phase === "released") {
        throw new Error(`Trade stopped in terminal phase ${current.phase}`);
      }
      if (actions >= 200) {
        throw new Error("Trade did not settle within 200 coordinator actions");
      }
      try {
        current = await this.api.advanceTrade(sessionId);
        this.startSessionSubscriptionInBackground(sessionId, reportError);
        this.onChange(current);
        record(current);
        actions += 1;
        idlePolls = 0;
      } catch (error) {
        if (!PEER_WAIT_MESSAGES.has(messageOf(error))) {
          throw error;
        }
        idlePolls += 1;
        if (idlePolls >= 2_400) {
          throw new Error("Trade peer did not respond before the agent deadline");
        }
        await this.wait(250);
        const observed = await this.api.getTrade(sessionId);
        if (observed === undefined) {
          throw new Error("Trade session disappeared while settling");
        }
        current = observed;
        record(current);
      }
    }
    return Object.freeze({
      sessionId,
      finalPhase: "filled" as const,
      checkpoints: Object.freeze(checkpoints.map((checkpoint) =>
        Object.freeze({ ...checkpoint })
      ))
    });
  }

  private startSessionSubscriptionInBackground(
    sessionId: string,
    reportError: (message: string) => void = this.onError
  ): void {
    void this.ensureSessionSubscription(sessionId).catch((error: unknown) => {
      reportError(messageOf(error));
    });
  }

  private makerSettlementWinners(trades: PublicTradeView[]): Set<string> {
    const winners = new Map<string, PublicTradeView>();
    for (const trade of trades) {
      if (
        trade.role !== "maker" ||
        trade.phase === "filled" ||
        trade.phase === "frozen" ||
        trade.phase === "released"
      ) continue;
      const current = winners.get(trade.orderAddress);
      if (
        current === undefined ||
        (trade.pendingOrderPublication !== null &&
          current.pendingOrderPublication === null) ||
        ((trade.pendingOrderPublication !== null) ===
          (current.pendingOrderPublication !== null) &&
          (trade.updatedAt > current.updatedAt ||
            (trade.updatedAt === current.updatedAt &&
              trade.createdAt > current.createdAt)))
      ) {
        winners.set(trade.orderAddress, trade);
      }
    }
    return new Set([...winners.values()].map((trade) => trade.sessionId));
  }

  private startMakerSettlementInBackground(sessionId: string): void {
    if (this.makerSettlementRuns.has(sessionId)) return;
    const run = this.runUntilSettled(sessionId, this.onMakerError);
    this.makerSettlementRuns.set(sessionId, run);
    void run
      .catch((error: unknown) => {
        this.onMakerError(messageOf(error));
      })
      .finally(() => {
        if (this.makerSettlementRuns.get(sessionId) === run) {
          this.makerSettlementRuns.delete(sessionId);
        }
      });
  }

  async enableMaker(): Promise<MakerInboxStatus> {
    const orderIds = this.makerIdentity.listOrderIds
      ? await this.makerIdentity.listOrderIds()
      : [undefined];
    const makerSubscriptionKeys = new Set(
      orderIds.map((orderId) =>
        orderId ? `maker-order-key:${orderId}` : "maker-order-key"
      )
    );
    for (const key of this.makerSubscriptionKeys) {
      if (makerSubscriptionKeys.has(key)) continue;
      this.subscriptions.get(key)?.stop();
      this.subscriptions.delete(key);
    }
    this.makerSubscriptionKeys = makerSubscriptionKeys;
    const makerPubkeys: string[] = [];
    await Promise.all(orderIds.map(async (orderId) => {
      const makerPubkey = await this.makerIdentity.publicKey(orderId);
      makerPubkeys.push(makerPubkey);
      const subscriptionKey = orderId ? `maker-order-key:${orderId}` : "maker-order-key";
      await this.startSubscriptionOnce(subscriptionKey, () =>
        this.useMakerKey(orderId, async (secretKey) => {
        const registration = this.transport.createRegistration(secretKey);
        await this.transport.publishRegistration(registration, secretKey);
        return this.startSubscription({
          recipientPubkey: makerPubkey,
          recipientSecretKey: secretKey,
          inboxRelays: [this.inboxRelay],
          cursor: { since: Math.max(0, this.now() - GIFT_WRAP_LOOKBACK) },
          port: this.inboxPort,
          now: this.now,
          onEvent: async (event) => {
            try {
              const proposal = await this.useMakerKey(orderId,
                (makerOrderSecretKey) => this.openProposal(
                  event,
                  makerOrderSecretKey,
                  { now: this.now() }
                )
              );
              const trade = await this.api.acceptReserveProposal(proposal);
              await this.ensureSessionSubscription(trade.sessionId);
              this.onMakerAccepted(trade);
              this.onChange(trade);
              this.startMakerSettlementInBackground(trade.sessionId);
            } catch (error) {
              this.onMakerError(messageOf(error));
            }
          },
          onError: (error) => this.handleSubscriptionError(
            subscriptionKey,
            error,
            async () => {
              await this.enableMaker();
            },
            this.onMakerError
          )
        });
        })
      );
    }));
    return {
      makerPubkey: makerPubkeys[0] ?? "",
      inboxRelay: this.inboxRelay
    };
  }

  private async useMakerKey<T>(
    orderId: string | undefined,
    action: (secretKey: Uint8Array) => Promise<T>
  ): Promise<T> {
    if (orderId !== undefined && this.makerIdentity.useOrderSecretKey) {
      return this.makerIdentity.useOrderSecretKey(orderId, action);
    }
    if (this.makerIdentity.useSecretKey) return this.makerIdentity.useSecretKey(action);
    throw new Error("Maker order key access is unavailable");
  }

  stop(): void {
    this.subscriptionGeneration += 1;
    for (const subscription of this.subscriptions.values()) {
      subscription.stop();
    }
    this.subscriptions.clear();
    this.makerSubscriptionKeys.clear();
  }

  private async ensureSessionSubscription(sessionId: string): Promise<void> {
    const key = `session:${sessionId}`;
    await this.startSubscriptionOnce(key, async () => {
      const session = await this.sessions.get(sessionId);
      if (
        session === undefined ||
        session.privateState.inbox.status !== "registered"
      ) return undefined;
      const secretKey = bytes(session.privateState.nostrPrivateKey);
      try {
        return await this.startSubscription({
          recipientPubkey: this.sessionPubkey(session),
          recipientSecretKey: secretKey,
          inboxRelays: session.privateState.inbox.inboxRelays,
          cursor: {
            since: Math.max(0, session.createdAt - GIFT_WRAP_LOOKBACK)
          },
          port: this.inboxPort,
          now: this.now,
          onEvent: async () => {
            try {
              const trade = await this.api.advanceTrade(sessionId);
              this.onChange(trade);
            } catch (error) {
              this.onError(messageOf(error));
            }
          },
          onError: (error) => this.handleSubscriptionError(
            key,
            error,
            () => this.ensureSessionSubscription(sessionId)
          )
        });
      } finally {
        secretKey.fill(0);
      }
    });
  }

  private startSubscriptionOnce(
    key: string,
    create: () => Promise<TradeSubscription | undefined>
  ): Promise<void> {
    if (this.subscriptions.has(key)) return Promise.resolve();
    const existing = this.subscriptionStarts.get(key);
    if (existing !== undefined) return existing;
    const generation = this.subscriptionGeneration;
    let start!: Promise<void>;
    start = (async () => {
      const subscription = await create();
      if (subscription === undefined) return;
      if (
        this.subscriptionGeneration !== generation ||
        this.subscriptions.has(key)
      ) {
        subscription.stop();
        return;
      }
      this.subscriptions.set(key, subscription);
    })().finally(() => {
      if (this.subscriptionStarts.get(key) === start) {
        this.subscriptionStarts.delete(key);
      }
    });
    this.subscriptionStarts.set(key, start);
    return start;
  }

  private handleSubscriptionError(
    key: string,
    error: TradeSubscriptionError,
    restart: () => Promise<void>,
    reportError: (message: string) => void = this.onError
  ): void {
    reportError(error.message);
    if (error.kind !== "relay_closed") return;
    const subscription = this.subscriptions.get(key);
    if (subscription === undefined) return;
    subscription.stop();
    this.subscriptions.delete(key);
    void restart().catch((restartError: unknown) => {
      reportError(messageOf(restartError));
    });
  }

  private sessionPubkey(session: TradeSession): string {
    const event = session.privateState.inbox.event;
    if (event === null || event.pubkey.length !== 64) {
      throw new Error("Registered trade inbox lacks its exact public key");
    }
    return event.pubkey;
  }
}
