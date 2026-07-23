import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey
} from "nostr-tools/pure";

import { TEST_MARKET, type OrderApi } from "../api/order-api.js";
import { TradeApi } from "../api/trade-api.js";
import { CashuClient } from "../cashu/client.js";
import { CashuTradeClient } from "../cashu/trade-client.js";
import {
  createInboxList,
  probeInboxRelayLive,
  type InboxRelayPort,
  type VerifiedInboxLiveProbeResult
} from "../nostr/inbox.js";
import { NostrToolsInboxRelayPort } from "../nostr/inbox-relay.js";
import type { MakerIdentity } from "../nostr/identity.js";
import { PUBLIC_RELAYS } from "../nostr/relay.js";
import type { TradeSubscriptionRelayPort } from "../nostr/trade-subscription.js";
import { NostrTradeTransport } from "../nostr/trade-transport.js";
import type { NostrOrderService } from "../order/service.js";
import type { OrderOutboxRepository } from "../storage/order-outbox.js";
import { ProofReservationRepository } from "../storage/proof-reservation-repository.js";
import { TradeSessionRepository } from "../storage/trade-session.js";
import type {
  StorageDriver,
  WalletRepository
} from "../storage/wallet-repository.js";
import { TradeCoordinator } from "../trade/coordinator.js";
import { GranolaCoordinatorEffects } from "../trade/effects.js";
import {
  withTradeSessionLock,
  withTradeSessionStorageLock,
  withWalletLock
} from "./lock.js";

export const TRADE_INBOX_RELAY = "wss://auth.nostr1.com";

type KeyGenerator = () => Uint8Array;

export interface TradeInboxProbeInput {
  relay: string;
  port: InboxRelayPort;
  now: number;
  generateSecretKey?: KeyGenerator;
}

export async function probeTradeInboxRelay(
  input: TradeInboxProbeInput
): Promise<VerifiedInboxLiveProbeResult> {
  const generate = input.generateSecretKey ?? generateSecretKey;
  const recipient = generate();
  const sender = generate();
  const other = generate();
  const wrapperSigner = generate();
  try {
    const recipientPubkey = getPublicKey(recipient);
    const inboxList = createInboxList([input.relay], recipient, input.now);
    const wrapper = finalizeEvent({
      kind: 1059,
      created_at: input.now,
      tags: [
        ["p", recipientPubkey],
        ["expiration", String(input.now + 3_600)]
      ],
      content: "granola-inbox-live-probe"
    }, wrapperSigner);
    return await probeInboxRelayLive({
      relay: input.relay,
      inboxList,
      wrapper,
      recipientProtocolSecretKey: recipient,
      senderProtocolSecretKey: sender,
      otherProtocolSecretKey: other,
      port: input.port,
      now: input.now
    });
  } finally {
    recipient.fill(0);
    sender.fill(0);
    other.fill(0);
    wrapperSigner.fill(0);
  }
}

export interface CreateBrowserTradeRuntimeInput {
  profile: string;
  driver: StorageDriver;
  wallet: WalletRepository;
  makerIdentity: MakerIdentity;
  orderApi: OrderApi;
  orderService: NostrOrderService;
  orderOutbox: OrderOutboxRepository;
  inboxPort?: BrowserInboxPort;
  inboxRelay?: string;
  discoveryRelays?: readonly string[];
  now?: () => number;
  generateSecretKey?: KeyGenerator;
  cashu?: CashuClient;
  cashuTrade?: CashuTradeClient;
}

export interface BrowserTradeRuntime {
  api: TradeApi;
  sessions: TradeSessionRepository;
  transport: NostrTradeTransport;
  inboxPort: BrowserInboxPort;
  inboxRelay: string;
  market: typeof TEST_MARKET;
}

export interface BrowserInboxPort
  extends InboxRelayPort, TradeSubscriptionRelayPort {}

export async function createBrowserTradeRuntime(
  input: CreateBrowserTradeRuntimeInput
): Promise<BrowserTradeRuntime> {
  const now = input.now ?? (() => Math.floor(Date.now() / 1_000));
  const currentTime = now();
  if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
    throw new Error("Trade runtime clock must be a non-negative Unix timestamp");
  }
  const inboxRelay = input.inboxRelay ?? TRADE_INBOX_RELAY;
  const discoveryRelays = input.discoveryRelays ?? PUBLIC_RELAYS;
  const inboxPort = input.inboxPort ?? new NostrToolsInboxRelayPort();
  const probe = await probeTradeInboxRelay({
    relay: inboxRelay,
    port: inboxPort,
    now: currentTime,
    ...(input.generateSecretKey
      ? { generateSecretKey: input.generateSecretKey }
      : {})
  });
  const transport = new NostrTradeTransport(
    inboxPort,
    discoveryRelays,
    [inboxRelay],
    now,
    [probe]
  );
  const sessions = new TradeSessionRepository(
    input.driver,
    (action) => withTradeSessionStorageLock(input.profile, action)
  );
  const reservations = new ProofReservationRepository(input.driver);
  const cashu = input.cashu ?? new CashuClient();
  const effects = new GranolaCoordinatorEffects({
    orderApi: input.orderApi,
    orderOutbox: input.orderOutbox,
    orderReader: input.orderService,
    nostr: transport,
    cashu: input.cashuTrade ?? new CashuTradeClient(),
    wallet: input.wallet,
    reservations,
    makerIdentity: input.makerIdentity,
    discoveryRelays,
    withWalletLock: (action) => withWalletLock(input.profile, action)
  });
  const coordinator = new TradeCoordinator({
    repository: sessions,
    effects,
    now,
    runSessionExclusive: (sessionId, action) =>
      withTradeSessionLock(input.profile, sessionId, action)
  });
  return {
    api: new TradeApi({
      coordinator,
      orders: input.orderService,
      cashu,
      wallets: input.wallet,
      spendability: cashu,
      sessions,
      market: TEST_MARKET,
      now
    }),
    sessions,
    transport,
    inboxPort,
    inboxRelay,
    market: TEST_MARKET
  };
}
