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
  makerIdentity: Pick<MakerIdentity, "publicKey" | "useSecretKey">;
  now?: () => number;
  startSubscription?: StartSubscription;
  openProposal?: (
    event: NostrEvent,
    makerOrderSecretKey: Uint8Array,
    options: { now: number }
  ) => Promise<VerifiedInitialReserveProposal>;
  onChange?: (trade: PublicTradeView) => void;
  onError?: (message: string) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  private readonly onError: (message: string) => void;
  private readonly subscriptions = new Map<string, TradeSubscription>();
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
    this.onError = options.onError ?? (() => undefined);
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
    await Promise.all(trades.map((trade) =>
      this.ensureSessionSubscription(trade.sessionId)
    ));
    return trades;
  }

  async enableMaker(): Promise<MakerInboxStatus> {
    const makerPubkey = await this.makerIdentity.publicKey();
    await this.startSubscriptionOnce("maker-order-key", () =>
      this.makerIdentity.useSecretKey(async (secretKey) => {
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
              const proposal = await this.makerIdentity.useSecretKey(
                (makerOrderSecretKey) => this.openProposal(
                  event,
                  makerOrderSecretKey,
                  { now: this.now() }
                )
              );
              const trade = await this.api.acceptReserveProposal(proposal);
              await this.ensureSessionSubscription(trade.sessionId);
              this.onChange(trade);
            } catch (error) {
              this.onError(messageOf(error));
            }
          },
          onError: (error) => this.handleSubscriptionError(
            "maker-order-key",
            error,
            async () => {
              await this.enableMaker();
            }
          )
        });
      })
    );
    return { makerPubkey, inboxRelay: this.inboxRelay };
  }

  stop(): void {
    this.subscriptionGeneration += 1;
    for (const subscription of this.subscriptions.values()) {
      subscription.stop();
    }
    this.subscriptions.clear();
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
    restart: () => Promise<void>
  ): void {
    this.onError(error.message);
    if (error.kind !== "relay_closed") return;
    const subscription = this.subscriptions.get(key);
    if (subscription === undefined) return;
    subscription.stop();
    this.subscriptions.delete(key);
    void restart().catch((restartError: unknown) => {
      this.onError(messageOf(restartError));
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
