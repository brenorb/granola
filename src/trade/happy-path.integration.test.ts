import { createHTLCHash } from "@cashu/cashu-ts";
import {
  finalizeEvent,
  getPublicKey,
  type EventTemplate
} from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { OrderApi, TEST_MARKET } from "../api/order-api.js";
import type {
  CompletedHtlcSpend,
  CompletedLock,
  PreparedTradeOperation,
  RedactedLockSummary
} from "../cashu/trade-client.js";
import type { ExpectedHtlcLock } from "../cashu/htlc.js";
import type { WalletPocket, WalletState } from "../core/wallet.js";
import { createInboxList } from "../nostr/inbox.js";
import type {
  DiscoveredTradeInbox
} from "../nostr/trade-transport.js";
import type { NostrEvent, UnsignedNostrEvent } from "../order/events.js";
import {
  NostrOrderService,
  type OrderRelayPort,
  type OrderSigner
} from "../order/service.js";
import { OrderOutboxRepository } from "../storage/order-outbox.js";
import { ProofReservationRepository } from "../storage/proof-reservation-repository.js";
import { TradeSessionRepository } from "../storage/trade-session.js";
import {
  MemoryStorageDriver,
  WalletRepository
} from "../storage/wallet-repository.js";
import { nextCoordinatorAction } from "./coordinator-plan.js";
import { TradeCoordinator } from "./coordinator.js";
import { GranolaCoordinatorEffects } from "./effects.js";
import {
  unwrapInitialReserveProposalForMaker
} from "./messages.js";
import {
  createMakerSession,
  createTakerSession,
  type SessionFactoryEntropy
} from "./session-factory.js";
import type { TradeSession } from "./session.js";

const NOW = 1_800_000_000;
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22".repeat(32);
const RESERVATION_ID = "33333333-3333-4333-8333-333333333333";
const BASE_KEYSET = "00deadbeefcafeee";
const QUOTE_KEYSET = "00deadbeefcafeff";
const DISCOVERY_RELAYS = [
  "wss://discovery-one.example",
  "wss://discovery-two.example",
  "wss://discovery-three.example"
];
const INBOX_RELAY = "wss://inbox.example";
const ORDER_RELAYS = [
  "wss://orders-one.example",
  "wss://orders-two.example"
];

function secret(lastByte: number): Uint8Array {
  const result = new Uint8Array(32);
  result[31] = lastByte;
  return result;
}

function hex(value: Uint8Array): string {
  return [...value]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return hex(new Uint8Array(digest));
}

function uuid(counter: number): string {
  return `00000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`;
}

function sessionEntropy(
  role: "maker" | "taker"
): SessionFactoryEntropy {
  const offset = role === "maker" ? 5 : 2;
  const keys = {
    nostr: hex(secret(offset)),
    cashu: hex(secret(offset + 1)),
    refund: hex(secret(offset + 2))
  };
  return {
    sessionId: () => SESSION_ID,
    reservationId: () => RESERVATION_ID,
    privateKey: (purpose) => keys[purpose],
    htlcMaterial: () => createHTLCHash("ab".repeat(32))
  };
}

class MemoryOrderRelay implements OrderRelayPort {
  private readonly projections = new Map<string, NostrEvent>();

  async publish(event: NostrEvent) {
    if (event.kind === 30078) {
      const identifier = event.tags.find((tag) => tag[0] === "d")?.[1];
      if (!identifier) throw new Error("Projection lacks its replaceable identifier");
      this.projections.set(
        `${event.pubkey}:${identifier}`,
        structuredClone(event)
      );
    }
    return ORDER_RELAYS.map((relay) => ({
      relay,
      ok: true,
      message: "stored"
    }));
  }

  async queryProjections(): Promise<NostrEvent[]> {
    return structuredClone([...this.projections.values()]);
  }

  async queryOrder(address: string): Promise<NostrEvent[]> {
    const [, author, ...identifierParts] = address.split(":");
    const identifier = identifierParts.join(":");
    const event = this.projections.get(`${author}:${identifier}`);
    return event === undefined ? [] : [structuredClone(event)];
  }
}

class MemoryTradeTransport {
  private readonly registrations = new Map<string, NostrEvent>();
  private readonly wrappers = new Map<string, NostrEvent[]>();

  createRegistration(protocolSecretKey: Uint8Array): NostrEvent {
    return createInboxList([INBOX_RELAY], protocolSecretKey, NOW);
  }

  async publishRegistration(
    event: NostrEvent,
    _protocolSecretKey: Uint8Array
  ) {
    this.registrations.set(event.pubkey, structuredClone(event));
    return {
      event: structuredClone(event),
      receipts: DISCOVERY_RELAYS.map((relay) => ({
        relay,
        ok: true,
        message: "stored"
      })),
      readback: DISCOVERY_RELAYS.map((relay) => ({
        relay,
        found: true,
        event: structuredClone(event),
        observedAt: NOW
      })),
      confirmed: [...DISCOVERY_RELAYS]
    };
  }

  async discoverInbox(authorPubkey: string): Promise<DiscoveredTradeInbox> {
    const event = this.registrations.get(authorPubkey);
    if (!event) throw new Error("Recipient inbox is not registered");
    return {
      event: structuredClone(event),
      eventId: event.id,
      relays: [INBOX_RELAY]
    };
  }

  async send(wrapper: NostrEvent) {
    const recipient = wrapper.tags.find((tag) => tag[0] === "p")?.[1];
    if (!recipient) throw new Error("Gift wrap has no recipient");
    const current = this.wrappers.get(recipient) ?? [];
    if (!current.some((event) => event.id === wrapper.id)) {
      current.push(structuredClone(wrapper));
      this.wrappers.set(recipient, current);
    }
    return [{ relay: INBOX_RELAY, ok: true, message: "stored" }];
  }

  async read(recipientPubkey: string): Promise<NostrEvent[]> {
    return structuredClone(this.wrappers.get(recipientPubkey) ?? []);
  }

  wrappersFor(recipientPubkey: string): NostrEvent[] {
    return structuredClone(this.wrappers.get(recipientPubkey) ?? []);
  }
}

interface FakeLock {
  token: string;
  expected: ExpectedHtlcLock;
  keysetId: string;
  spent: boolean;
  preimage: string | null;
  proofSecret: string;
}

class MemoryCashuMint {
  private readonly locks = new Map<string, FakeLock>();
  private readonly claims = new Map<
    string,
    { token: string; preimage: string }
  >();
  private counter = 0;

  async prepareOutgoingLock(input: {
    pocket: WalletPocket;
    expected: ExpectedHtlcLock;
  }): Promise<PreparedTradeOperation> {
    const funding = input.pocket.proofs[0];
    if (!funding) throw new Error("Test wallet is unfunded");
    return this.artifact(
      "outgoing-lock",
      input.expected,
      funding.secret
    );
  }

  async completeOutgoingLock(
    artifact: PreparedTradeOperation,
    expected: ExpectedHtlcLock
  ): Promise<CompletedLock> {
    const keysetId = expected.leg === "base" ? BASE_KEYSET : QUOTE_KEYSET;
    const token =
      `cashuBtest-${expected.leg}-${expected.binding.sessionId}`;
    const proofSecret = `locked-proof:${expected.leg}:${expected.binding.sessionId}`;
    this.locks.set(token, {
      token,
      expected: structuredClone(expected),
      keysetId,
      spent: false,
      preimage: null,
      proofSecret
    });
    return {
      change: {
        mintUrl: artifact.mintUrl,
        unit: artifact.unit,
        proofs: []
      },
      lockedToken: token,
      summary: await this.summary(token)
    };
  }

  async validateIncomingLock(
    token: string,
    expected: ExpectedHtlcLock
  ): Promise<RedactedLockSummary> {
    this.exactLock(token, expected);
    return this.summary(token);
  }

  async prepareClaim(input: {
    token: string;
    expected: ExpectedHtlcLock;
    preimage: string;
  }): Promise<PreparedTradeOperation> {
    const lock = this.exactLock(input.token, input.expected);
    const artifact = await this.artifact(
      "claim",
      input.expected,
      lock.proofSecret
    );
    this.claims.set(artifact.operationCommitment, {
      token: input.token,
      preimage: input.preimage
    });
    return artifact;
  }

  async completeClaim(
    artifact: PreparedTradeOperation
  ): Promise<CompletedHtlcSpend> {
    const claim = this.claims.get(artifact.operationCommitment);
    if (!claim) throw new Error("Claim was not prepared");
    const lock = this.locks.get(claim.token);
    if (!lock) throw new Error("Locked token is missing");
    lock.spent = true;
    lock.preimage = claim.preimage;
    this.counter += 1;
    return {
      pocket: {
        mintUrl: artifact.mintUrl,
        unit: artifact.unit,
        proofs: [{
          amount: artifact.expected.amount,
          id: lock.keysetId,
          secret: `claimed-proof:${this.counter}`,
          C: `claimed-point:${this.counter}`
        }]
      },
      summary: {
        mintUrl: artifact.mintUrl,
        unit: artifact.unit,
        amount: artifact.expected.amount,
        proofCount: 1
      }
    };
  }

  async prepareRefund(): Promise<PreparedTradeOperation> {
    throw new Error("Refund is outside the happy-path integration");
  }

  async completeRefund(): Promise<CompletedHtlcSpend> {
    throw new Error("Refund is outside the happy-path integration");
  }

  async observeSpentInternal(
    token: string,
    expected: ExpectedHtlcLock,
    expectedCommitment: string
  ) {
    const lock = this.exactLock(token, expected);
    if (await sha256(token) !== expectedCommitment) {
      throw new Error("Token commitment differs");
    }
    return lock.spent
      ? { status: "SPENT" as const, proofCount: 1, preimage: lock.preimage! }
      : { status: "UNSPENT" as const, proofCount: 1 };
  }

  private async artifact(
    kind: PreparedTradeOperation["kind"],
    expected: ExpectedHtlcLock,
    spentSecret: string
  ): Promise<PreparedTradeOperation> {
    this.counter += 1;
    return {
      version: 1,
      kind,
      mintUrl: expected.mintUrl,
      unit: expected.unit,
      preview: {
        amount: expected.amount,
        fees: "0",
        keysetId: expected.leg === "base" ? BASE_KEYSET : QUOTE_KEYSET,
        inputs: []
      },
      spentSecrets: [spentSecret],
      expected: structuredClone(expected),
      operationCommitment: await sha256(
        `${kind}:${expected.leg}:${expected.binding.sessionId}:${this.counter}`
      )
    };
  }

  private exactLock(token: string, expected: ExpectedHtlcLock): FakeLock {
    const lock = this.locks.get(token);
    if (!lock || JSON.stringify(lock.expected) !== JSON.stringify(expected)) {
      throw new Error("Locked token does not match its exact terms");
    }
    return lock;
  }

  private async summary(token: string): Promise<RedactedLockSummary> {
    const lock = this.locks.get(token);
    if (!lock) throw new Error("Locked token is missing");
    return {
      mintUrl: lock.expected.mintUrl,
      unit: lock.expected.unit,
      amount: lock.expected.amount,
      fee: "0",
      proofCount: 1,
      keysetId: lock.keysetId,
      commitment: await sha256(`validation:${token}`)
    };
  }
}

function fundedWallet(
  mintUrl: string,
  unit: string,
  amount: string,
  keysetId: string,
  owner: string
): WalletState {
  return {
    version: 1,
    revision: 1,
    pockets: [{
      mintUrl,
      unit,
      proofs: [{
        amount,
        id: keysetId,
        secret: `${owner}-funding-proof`,
        C: `${owner}-funding-point`
      }]
    }]
  };
}

function effectEntropy(seed: number) {
  let message = seed;
  let operation = seed + 100;
  let ephemeral = seed / 100 + 20;
  let nonce = seed / 100 + 30;
  return {
    messageId: () => uuid(message++),
    operationId: () => uuid(operation++),
    ephemeralSecretKey: () => secret(ephemeral++),
    nonce: () => new Uint8Array(32).fill(nonce++),
    randomizedTimestamp: (now: number, purpose: "seal" | "wrapper") =>
      now - (purpose === "seal" ? 1 : 2),
    outerExpiration: (expiration: number) => expiration + 3_600
  };
}

describe("two-party coordinator happy path", () => {
  it("settles exact SAT/USD legs and a signed public fill one action at a time", async () => {
    const makerOrderKey = secret(1);
    const makerPubkey = getPublicKey(makerOrderKey);
    const signer: OrderSigner = {
      publicKey: async () => makerPubkey,
      sign: async (template: UnsignedNostrEvent) =>
        finalizeEvent(template as EventTemplate, makerOrderKey)
    };
    const orderRelay = new MemoryOrderRelay();
    const orderService = new NostrOrderService(
      signer,
      orderRelay
    );
    const orderOutbox = new OrderOutboxRepository(new MemoryStorageDriver());
    const orderApi = new OrderApi(
      { publicKey: async () => makerPubkey },
      orderService,
      () => NOW,
      () => ORDER_ID,
      orderOutbox
    );
    const create = await orderApi.publishOrder({
      side: "sell",
      amount: "20",
      price: { numerator: "1", denominator: "20" },
      expiresAt: NOW + 9 * 86_400
    });
    await orderApi.publishNextStage(create.orderId);
    await orderApi.clearAcknowledgedOrderPublication(create.orderId);
    const order = (await orderService.loadBook(TEST_MARKET, NOW)).book.asks[0]!;

    const transport = new MemoryTradeTransport();
    await transport.publishRegistration(
      transport.createRegistration(makerOrderKey),
      makerOrderKey
    );
    const cashu = new MemoryCashuMint();
    const makerDriver = new MemoryStorageDriver();
    const takerDriver = new MemoryStorageDriver();
    const makerSessions = new TradeSessionRepository(makerDriver);
    const takerSessions = new TradeSessionRepository(takerDriver);
    const makerWallet = new WalletRepository(makerDriver);
    const takerWallet = new WalletRepository(takerDriver);
    await makerWallet.save(fundedWallet(
      TEST_MARKET.baseMint,
      TEST_MARKET.baseUnit,
      "20",
      BASE_KEYSET,
      "maker"
    ));
    await takerWallet.save(fundedWallet(
      TEST_MARKET.quoteMint,
      TEST_MARKET.quoteUnit,
      "1",
      QUOTE_KEYSET,
      "taker"
    ));

    const common = {
      orderApi,
      orderOutbox,
      orderReader: orderService,
      nostr: transport,
      cashu,
      makerIdentity: {
        publicKey: async () => makerPubkey,
        useSecretKey: async <T>(
          action: (key: Uint8Array) => Promise<T>
        ): Promise<T> => action(Uint8Array.from(makerOrderKey))
      },
      discoveryRelays: DISCOVERY_RELAYS,
      withWalletLock: async <T>(action: () => Promise<T>) => action(),
      commitment: sha256
    };
    const makerEffects = new GranolaCoordinatorEffects({
      ...common,
      wallet: makerWallet,
      reservations: new ProofReservationRepository(makerDriver),
      entropy: effectEntropy(1_000)
    });
    const takerEffects = new GranolaCoordinatorEffects({
      ...common,
      wallet: takerWallet,
      reservations: new ProofReservationRepository(takerDriver),
      entropy: effectEntropy(2_000)
    });
    let coordinatorTime = NOW;
    const tick = () => coordinatorTime++;
    const makerCoordinator = new TradeCoordinator({
      repository: makerSessions,
      effects: makerEffects,
      now: tick
    });
    const takerCoordinator = new TradeCoordinator({
      repository: takerSessions,
      effects: takerEffects,
      now: tick
    });

    const clocks = {
      localNow: NOW,
      baseMintNow: NOW,
      quoteMintNow: NOW
    };
    const market = {
      baseMint: TEST_MARKET.baseMint,
      baseUnit: TEST_MARKET.baseUnit,
      baseKeyset: BASE_KEYSET,
      quoteMint: TEST_MARKET.quoteMint,
      quoteUnit: TEST_MARKET.quoteUnit,
      quoteKeyset: QUOTE_KEYSET
    };
    await takerSessions.save(await createTakerSession({
      order,
      expectedOrderProjectionId: order.eventId,
      expectedOrderRevision: "0",
      market,
      fillBaseAmount: "20",
      clocks
    }, sessionEntropy("taker")), null);

    const actionTrace: string[] = [];
    while (
      (await takerSessions.get(SESSION_ID))!.privateState.transcript
        .choreography.phase !== "awaiting_reserve_accept"
    ) {
      actionTrace.push(
        `taker:${nextCoordinatorAction(
          (await takerSessions.get(SESSION_ID))!,
          coordinatorTime
        ).kind}`
      );
      await takerCoordinator.advance(SESSION_ID);
    }

    const initialWrapper = transport.wrappersFor(makerPubkey)[0]!;
    const proposal = await unwrapInitialReserveProposalForMaker(
      initialWrapper,
      makerOrderKey,
      { now: coordinatorTime }
    );
    await makerSessions.save(await createMakerSession({
      order,
      proposal,
      market,
      clocks: {
        localNow: NOW + 1,
        baseMintNow: NOW + 1,
        quoteMintNow: NOW + 1
      }
    }, sessionEntropy("maker")), null);

    let steps = 0;
    while (steps++ < 200) {
      const maker = (await makerSessions.get(SESSION_ID))!;
      const taker = (await takerSessions.get(SESSION_ID))!;
      const makerAction = nextCoordinatorAction(maker, coordinatorTime);
      const takerAction = nextCoordinatorAction(taker, coordinatorTime);
      if (makerAction.kind === "none" && takerAction.kind === "none") break;

      const candidates = [
        {
          role: "maker",
          phase: maker.privateState.transcript.choreography.phase,
          action: makerAction,
          coordinator: makerCoordinator
        },
        {
          role: "taker",
          phase: taker.privateState.transcript.choreography.phase,
          action: takerAction,
          coordinator: takerCoordinator
        }
      ].filter(({ action }) => action.kind !== "none");
      candidates.sort((left, right) =>
        Number(left.action.kind === "poll_inbox") -
        Number(right.action.kind === "poll_inbox")
      );

      let advanced = false;
      for (const candidate of candidates) {
        try {
          await candidate.coordinator.advance(SESSION_ID);
          actionTrace.push(`${candidate.role}:${candidate.action.kind}`);
          advanced = true;
          break;
        } catch (error) {
          if (
            candidate.action.kind !== "poll_inbox" ||
            !(error instanceof Error) ||
            !/private trade message/.test(error.message)
          ) {
            throw new Error(
              `${candidate.role} ${candidate.phase} ` +
              `${candidate.action.kind} failed: ${String(error)}`,
              { cause: error }
            );
          }
        }
      }
      if (!advanced) throw new Error("Happy-path scheduler made no progress");
    }
    expect(steps).toBeLessThan(200);
    expect(actionTrace).toHaveLength(95);
    expect(actionTrace.slice(0, 6)).toEqual([
      "taker:stage_inbox_registration",
      "taker:publish_inbox_registration",
      "taker:verify_inbox_registration",
      "taker:stage_reserve_propose",
      "taker:deliver_outbox",
      "taker:commit_outbox"
    ]);
    expect(actionTrace.at(-1)).toBe("taker:verify_order_fill");
    expect(actionTrace.some((action) =>
      action.includes("refund") || action.endsWith(":enter_recovery")
    )).toBe(false);

    const makerSession = (await makerSessions.get(SESSION_ID))!;
    const takerSession = (await takerSessions.get(SESSION_ID))!;
    expect(nextCoordinatorAction(makerSession, coordinatorTime))
      .toEqual({ kind: "none" });
    expect(nextCoordinatorAction(takerSession, coordinatorTime))
      .toEqual({ kind: "none" });
    expect([makerSession, takerSession].map((session) => session.phase))
      .toEqual(["filled", "filled"]);
    for (const session of [makerSession, takerSession]) {
      expect(session.evidence.legs.base.mintState).toBe("SPENT");
      expect(session.evidence.legs.quote.mintState).toBe("SPENT");
    }

    expect(makerSession.pendingOrderPublication).toMatchObject({
      operation: "fill",
      status: "committed"
    });
    expect(makerSession.evidence.reserveProjectionId)
      .toBe(makerSession.reserveProjectionId);
    expect(makerSession.evidence.fillProjectionId)
      .toBe(makerSession.fillProjectionId);
    const published = await orderService.loadPublishedProjection(
      makerSession.orderAddress,
      makerSession.fillProjectionId!,
      makerSession.fillProjectionRevision!
    );
    expect(published.eventId).toBe(makerSession.fillProjectionId);
    expect(published.revision).toBe(makerSession.fillProjectionRevision);
    expect(published.record.state).toMatchObject({
      status: "filled",
      remaining_amount: "0",
      reserved_amount: "0",
      reservation: null
    });
    expect(makerSession.evidence).toMatchObject({
      reserveProjectionId: makerSession.reserveProjectionId,
      reserveProjectionRevision: makerSession.reserveProjectionRevision,
      fillProjectionId: makerSession.fillProjectionId,
      fillProjectionRevision: makerSession.fillProjectionRevision
    });

    const makerView = await makerCoordinator.get(SESSION_ID);
    const takerView = await takerCoordinator.get(SESSION_ID);
    const publicJson = JSON.stringify([makerView, takerView]);
    expect(makerView).not.toHaveProperty("privateState");
    expect(takerView).not.toHaveProperty("privateState");
    for (const secretValue of [
      makerSession.privateState.preimage!,
      makerSession.privateState.nostrPrivateKey,
      makerSession.privateState.cashuPrivateKey,
      makerSession.privateState.refundPrivateKey,
      makerSession.privateState.legs.base.token!,
      takerSession.privateState.legs.quote.token!,
      "maker-funding-proof",
      "taker-funding-proof"
    ]) {
      expect(publicJson).not.toContain(secretValue);
    }
  }, 60_000);
});
