import { withSharedLock } from "../core/lock.js";
import { createOrderResponse } from "../trade/order-response.js";
import type { VerifiedInitialReserveProposal } from "../trade/messages.js";
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
import {
  TradeCoordinator,
  type CoordinatorActionProfile
} from "../trade/coordinator.js";
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
  profileAction?: (profile: CoordinatorActionProfile) => void;
}

export interface BrowserTradeRuntime {
  onRejectedProposal(proposal: VerifiedInitialReserveProposal): Promise<void>;
  api: TradeApi;
  sessions: TradeSessionRepository;
  transport: NostrTradeTransport;
  inboxPort: BrowserInboxPort;
  inboxRelay: string;
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
  if (inboxPort instanceof NostrToolsInboxRelayPort) {
    inboxPort.warmConnections([inboxRelay]);
    window.addEventListener("pagehide", () => inboxPort.dispose(), { once: true });
  }
  const probe = await probeTradeInboxRelay({
    relay: inboxRelay,
    port: inboxPort,
    now: currentTime,
    ...(input.generateSecretKey
      ? { generateSecretKey: input.generateSecretKey }
      : {})
  });
  // Let the order-book sockets connect before adding spare sockets to those hosts.
  if (inboxPort instanceof NostrToolsInboxRelayPort) inboxPort.warmConnections(discoveryRelays);
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
    runAdvanceExclusive: (sessionId, action) =>
      withSharedLock(`granola-trade-${input.profile}-${sessionId}-advance`, action),
    runSessionExclusive: (sessionId, action) =>
      withTradeSessionLock(input.profile, sessionId, action),
    ...(input.profileAction ? { profileAction: input.profileAction } : {})
  });
  let repliesRunning: Promise<void> | undefined;
  const flushReplies = (): void => {
    if (repliesRunning) return;
    repliesRunning = (async () => {
      for (const reply of await input.orderOutbox.listReplies()) {
        if (reply.delivered || reply.expiresAt <= now()) continue;
        // AUTH for publishing uses a fresh transport key; the persisted seal authenticates the maker.
        const key = generateSecretKey();
        try {
          let route = await transport.discoverInbox(reply.recipient, key, reply.relays.length ? reply.relays : undefined);
          try { await transport.send(reply.wrapper, route.relays, key); }
          catch {
            route = await transport.discoverInbox(reply.recipient, key);
            await transport.send(reply.wrapper, route.relays, key);
          }
          await input.orderOutbox.acknowledgeReply(reply.proposalRumorId, reply.wrapper.id);
        } catch { /* Keep the exact encrypted reply for retry/reload. */ }
        finally { key.fill(0); }
      }
    })().finally(async () => {
      repliesRunning = undefined;
      if ((await input.orderOutbox.listReplies()).some(reply => !reply.delivered && reply.expiresAt > now())) {
        const timer = setTimeout(flushReplies, 5_000);
        (timer as unknown as { unref?: () => void }).unref?.();
      }
    });
    void repliesRunning.catch(() => undefined);
  };
  const onRejectedProposal = async (proposal: VerifiedInitialReserveProposal): Promise<void> => {
    const current = (await input.orderOutbox.list()).find(entry => entry.intent.address === proposal.message.order_address);
    if (!current) return;
    const busy = (await sessions.list()).some(session => session.role === "maker" &&
      session.orderAddress === proposal.message.order_address && session.sessionId !== proposal.message.session_id &&
      !["filled", "released"].includes(session.phase));
    const changed = current.publication.projection.id !== proposal.message.order_projection_id ||
      current.publication.state.status !== "open";
    if (!busy && !changed) return;
    await input.orderOutbox.stageReply(proposal.rumor.id, now(), () =>
      input.makerIdentity.useOrderSecretKey(current.intent.orderId, key =>
        createOrderResponse(proposal, current.publication.projection, busy ? "preparing" : "changed", key, now())));
    flushReplies();
  };
  flushReplies();

  return {
    api: new TradeApi({
      coordinator,
      orders: input.orderService,
      orderOutbox: input.orderOutbox,
      cashu,
      wallets: input.wallet,
      spendability: cashu,
      sessions,
      market: TEST_MARKET,
      now
    }),
    onRejectedProposal,
    sessions,
    transport,
    inboxPort,
    inboxRelay
  };
}
