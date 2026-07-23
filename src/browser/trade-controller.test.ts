import { getPublicKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import type { TradeApi, TakeOrderInput } from "../api/trade-api.js";
import type { NostrEvent } from "../order/events.js";
import {
  initialAtomicSwapChoreography
} from "../trade/atomic-messages.js";
import type { TradeSessionRepository } from "../storage/trade-session.js";
import type {
  VerifiedInitialReserveProposal
} from "../trade/messages.js";
import type {
  PublicTradeView,
  TradeSession
} from "../trade/session.js";
import type {
  StartTradeSubscriptionInput
} from "../nostr/trade-subscription.js";
import {
  BrowserTradeController,
  type BrowserTradeControllerOptions
} from "./trade-controller.js";

const sessionId = "11".repeat(32);
const makerKey = Uint8Array.from({ length: 32 }, (_, index) =>
  index === 31 ? 9 : 0
);
const sessionKey = Uint8Array.from({ length: 32 }, (_, index) =>
  index === 31 ? 8 : 0
);
const sessionPubkey = getPublicKey(sessionKey);
const wrapper = {
  id: "22".repeat(32),
  pubkey: "33".repeat(32),
  created_at: 1_800_000_000,
  kind: 1059,
  tags: [["p", getPublicKey(makerKey)], ["expiration", "1800003600"]],
  content: "opaque",
  sig: "44".repeat(64)
} satisfies NostrEvent;

function view(revision = 0): PublicTradeView {
  return {
    revision,
    sessionId,
    reservationId: "55555555-5555-4555-8555-555555555555",
    role: "taker",
    phase: "negotiating",
    orderAddress: `30078:${"66".repeat(32)}:granola:order:v1:77777777-7777-4777-8777-777777777777`,
    offeredProjectionId: "88".repeat(32),
    offeredProjectionRevision: "0",
    reserveProjectionId: null,
    reserveProjectionRevision: null,
    fillProjectionId: null,
    fillProjectionRevision: null,
    pendingOrderPublication: null,
    createdAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    protocol: {
      localNostrPubkey: null,
      orderAuthorityPubkey: "66".repeat(32),
      counterpartyNostrPubkey: null,
      inbox: {
        status: "unregistered",
        registrationEventId: null,
        relayCount: 0,
        acknowledgements: 0
      },
      messages: []
    },
    terms: {
      baseMint: "https://testnut.cashu.space",
      baseUnit: "sat",
      baseKeyset: "00deadbeefcafeee",
      baseAmount: "1000",
      quoteMint: "https://nofee.testnut.cashu.space",
      quoteUnit: "usd",
      quoteKeyset: "00deadbeefcafeff",
      quoteAmount: "20",
      priceCentsPerBtc: "2000000"
    },
    plan: {
      anchor: 1_800_000_000,
      shortLocktime: 1_800_000_600,
      makerClaimCutoff: 1_800_000_480,
      longLocktime: 1_800_001_200,
      takerClaimCutoff: 1_800_001_080,
      reservationExpiresAt: 1_800_001_800,
      refundGuardSeconds: 60
    },
    evidence: {
      makerPubkey: "66".repeat(32),
      commitments: [],
      mintStates: [],
      reserveProjectionId: null,
      reserveProjectionRevision: null,
      fillProjectionId: null,
      fillProjectionRevision: null,
      reservation: {
        proposalSealId: null,
        takerCommitment: null,
        abortSealId: null
      },
      legs: {
        base: {
          tokenCommitment: null,
          validationCommitment: null,
          keysetId: "00deadbeefcafeee",
          proofCount: null,
          fee: null,
          mintState: "UNKNOWN",
          observedAt: null,
          spendCommitment: null,
          claimOperationCommitment: null,
          refundOperationCommitment: null
        },
        quote: {
          tokenCommitment: null,
          validationCommitment: null,
          keysetId: "00deadbeefcafeff",
          proofCount: null,
          fee: null,
          mintState: "UNKNOWN",
          observedAt: null,
          spendCommitment: null,
          claimOperationCommitment: null,
          refundOperationCommitment: null
        }
      }
    }
  };
}

function privateSession(): TradeSession {
  return {
    ...view(),
    schema: "granola/trade-session/v2",
    evidence: {
      ...view().evidence,
      reservation: {
        proposalSealId: null,
        takerCommitment: null,
        abortSeal: null
      }
    },
    privateState: {
      nostrPrivateKey: [...sessionKey].map((byte) =>
        byte.toString(16).padStart(2, "0")
      ).join(""),
      cashuPrivateKey: "99".repeat(32),
      refundPrivateKey: "aa".repeat(32),
      preimage: null,
      htlcHash: null,
      settlementTranscriptHash: null,
      inbox: {
        status: "registered",
        quorum: 2,
        event: { ...wrapper, pubkey: sessionPubkey },
        discoveryRelays: ["wss://one.example", "wss://two.example"],
        inboxRelays: ["wss://inbox.example"],
        receipts: [],
        readbacks: [],
        stagedAt: 1_800_000_000,
        acknowledgedAt: 1_800_000_000,
        registeredAt: 1_800_000_000
      },
      pendingIncoming: null,
      transcript: {
        choreography: initialAtomicSwapChoreography(view().evidence.makerPubkey),
        nextSequence: "0",
        lastRumorId: null,
        lastMessageId: null,
        lastTranscriptHash: null,
        accepted: []
      },
      outbox: null,
      cashuOperation: null,
      legs: {
        base: { token: null, expected: null, observations: [] },
        quote: { token: null, expected: null, observations: [] }
      }
    }
  } as unknown as TradeSession;
}

function setup(options: {
  startGates?: Array<Promise<void> | undefined>;
  wait?: (delayMs: number) => Promise<void>;
  onMakerError?: (message: string) => void;
  makerOrderIds?: string[];
  trades?: PublicTradeView[];
} = {}): {
  controller: BrowserTradeController;
  api: {
    listTrades: ReturnType<typeof vi.fn>;
    getTrade: ReturnType<typeof vi.fn>;
    takeOrder: ReturnType<typeof vi.fn>;
    acceptReserveProposal: ReturnType<typeof vi.fn>;
    advanceTrade: ReturnType<typeof vi.fn>;
  };
  subscriptions: StartTradeSubscriptionInput[];
  stops: Array<ReturnType<typeof vi.fn>>;
} {
  const publicView = view();
  const api = {
    listTrades: vi.fn(async () => options.trades ?? [publicView]),
    getTrade: vi.fn(async () => publicView),
    takeOrder: vi.fn(async (_input: TakeOrderInput) => publicView),
    acceptReserveProposal: vi.fn(async (_proposal: VerifiedInitialReserveProposal) => publicView),
    advanceTrade: vi.fn(async () => view(1))
  };
  const subscriptions: Array<Parameters<NonNullable<
    BrowserTradeControllerOptions["startSubscription"]
  >>[0]> = [];
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const controller = new BrowserTradeController({
    api: api as unknown as TradeApi,
    sessions: {
      get: vi.fn(async () => privateSession())
    } as unknown as TradeSessionRepository,
    transport: {
      createRegistration: vi.fn(() => wrapper),
      publishRegistration: vi.fn(async () => ({
        event: wrapper,
        receipts: [],
        readback: [],
        confirmed: ["wss://inbox.example"]
      }))
    },
    inboxPort: {} as BrowserTradeControllerOptions["inboxPort"],
    inboxRelay: "wss://inbox.example",
    makerIdentity: {
      publicKey: vi.fn(async () => getPublicKey(makerKey)),
      ...(options.makerOrderIds === undefined ? {} : {
        listOrderIds: vi.fn(async () => options.makerOrderIds!)
      }),
      useSecretKey: vi.fn(async (action) => action(makerKey.slice()))
    },
    now: () => 1_800_000_000,
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    ...(options.onMakerError === undefined ? {} : { onMakerError: options.onMakerError }),
    startSubscription: vi.fn(async (input) => {
      const startIndex = subscriptions.length;
      subscriptions.push(input);
      const stop = vi.fn();
      stops.push(stop);
      await options.startGates?.[startIndex];
      return { restart: {
        recipientPubkey: input.recipientPubkey,
        inboxRelays: [...input.inboxRelays],
        cursor: { ...input.cursor }
      }, stop };
    }),
    openProposal: vi.fn(async () => ({ message: {} } as VerifiedInitialReserveProposal))
  });
  return { controller, api, subscriptions, stops };
}

describe("BrowserTradeController", () => {
  it("registers and keeps the maker order-key inbox open", async () => {
    const { controller, subscriptions } = setup();
    const result = await controller.enableMaker();

    expect(result).toEqual({
      makerPubkey: getPublicKey(makerKey),
      inboxRelay: "wss://inbox.example"
    });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({
      recipientPubkey: getPublicKey(makerKey),
      inboxRelays: ["wss://inbox.example"],
      cursor: { since: 1_799_827_200 }
    });
  });

  it("single-flights concurrent maker startup without duplicate subscriptions", async () => {
    let releaseSubscription!: () => void;
    const subscriptionGate = new Promise<void>((resolve) => {
      releaseSubscription = resolve;
    });
    const { controller, subscriptions } = setup({
      startGates: [subscriptionGate]
    });

    const first = controller.enableMaker();
    const second = controller.enableMaker();
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    releaseSubscription();
    await Promise.all([first, second]);

    expect(subscriptions).toHaveLength(1);
  });

  it("syncs maker listeners when orders are added or removed without reloading", async () => {
    const orderA = "11111111-1111-4111-8111-111111111111";
    const orderB = "22222222-2222-4222-8222-222222222222";
    const orderIds = [orderA];
    const { controller, subscriptions, stops } = setup({ makerOrderIds: orderIds });

    await controller.enableMaker();
    expect(subscriptions).toHaveLength(1);

    orderIds.push(orderB);
    await controller.enableMaker();
    expect(subscriptions).toHaveLength(2);

    orderIds.splice(0, 1);
    await controller.enableMaker();
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(subscriptions).toHaveLength(2);
  });

  it("opens a proposal from the live maker inbox and persists its maker session", async () => {
    const { controller, api, subscriptions } = setup();
    await controller.enableMaker();
    await subscriptions[0]!.onEvent(wrapper, "wss://inbox.example");

    expect(api.acceptReserveProposal).toHaveBeenCalledOnce();
  });

  it("automatically advances an accepted maker session", async () => {
    const makerTrade = { ...view(), role: "maker" as const };
    const { controller, api, subscriptions } = setup({
      trades: [makerTrade]
    });
    api.acceptReserveProposal.mockResolvedValue(makerTrade);
    api.getTrade.mockResolvedValue(makerTrade);
    api.advanceTrade.mockResolvedValueOnce({
      ...makerTrade,
      revision: 1,
      phase: "filled"
    });

    await controller.enableMaker();
    await subscriptions[0]!.onEvent(wrapper, "wss://inbox.example");

    await vi.waitFor(() => expect(api.advanceTrade).toHaveBeenCalledOnce());
  });

  it("resumes only one maker settlement when old duplicate sessions exist", async () => {
    const older = {
      ...view(),
      sessionId: "aa".repeat(32),
      role: "maker" as const,
      createdAt: 1_800_000_000,
      updatedAt: 1_800_000_001
    };
    const newer = {
      ...older,
      sessionId: "bb".repeat(32),
      createdAt: 1_800_000_002,
      updatedAt: 1_800_000_003
    };
    const { controller, api } = setup({ trades: [older, newer] });
    api.getTrade.mockImplementation(async (id: string) =>
      id === older.sessionId ? older : newer
    );
    api.advanceTrade.mockImplementation(async (id: string) => ({
      ...(id === older.sessionId ? older : newer),
      revision: 1,
      phase: "filled"
    }));

    await controller.resume();

    await vi.waitFor(() => expect(api.advanceTrade).toHaveBeenCalledOnce());
    expect(api.advanceTrade).toHaveBeenCalledWith(newer.sessionId);
  });

  it("prefers the session that already advanced the order projection", async () => {
    const advanced = {
      ...view(),
      sessionId: "aa".repeat(32),
      role: "maker" as const,
      phase: "reserved" as const,
      createdAt: 1_800_000_000,
      updatedAt: 1_800_000_001
    };
    const staleNewer = {
      ...advanced,
      sessionId: "bb".repeat(32),
      phase: "negotiating" as const,
      createdAt: 1_800_000_002,
      updatedAt: 1_800_000_003
    };
    const { controller, api } = setup({
      trades: [advanced, staleNewer]
    });
    api.getTrade.mockImplementation(async (id: string) =>
      id === advanced.sessionId ? advanced : staleNewer
    );
    api.advanceTrade.mockImplementation(async (id: string) => ({
      ...(id === advanced.sessionId ? advanced : staleNewer),
      revision: 1,
      phase: "filled"
    }));

    await controller.resume();

    await vi.waitFor(() => expect(api.advanceTrade).toHaveBeenCalledOnce());
    expect(api.advanceTrade).toHaveBeenCalledWith(advanced.sessionId);
  });

  it("silently reconnects a maker inbox after a transient relay close", async () => {
    const onMakerError = vi.fn();
    const { controller, subscriptions, stops } = setup({ onMakerError });
    await controller.enableMaker();

    subscriptions[0]!.onError({
      relay: "wss://inbox.example",
      kind: "relay_closed",
      message: "Inbox relay subscription closed unexpectedly"
    });

    await vi.waitFor(() => expect(subscriptions).toHaveLength(2));
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(onMakerError).not.toHaveBeenCalled();
  });

  it("recovers when the relay closes before subscription startup completes", async () => {
    let releaseSubscription!: () => void;
    const subscriptionGate = new Promise<void>((resolve) => {
      releaseSubscription = resolve;
    });
    const onMakerError = vi.fn();
    const { controller, subscriptions, stops } = setup({
      startGates: [subscriptionGate],
      onMakerError
    });

    const enabling = controller.enableMaker();
    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    subscriptions[0]!.onError({
      relay: "wss://inbox.example",
      kind: "relay_closed",
      message: "Inbox relay subscription closed unexpectedly"
    });
    releaseSubscription();
    await enabling;

    await vi.waitFor(() => expect(subscriptions).toHaveLength(2));
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(onMakerError).not.toHaveBeenCalled();
  });

  it("starts the session inbox and advances only one coordinator action per call", async () => {
    const { controller, api, subscriptions } = setup();
    const input: TakeOrderInput = {
      requestId: "99999999-9999-4999-8999-999999999999",
      address: view().orderAddress,
      expectedProjectionId: view().offeredProjectionId,
      expectedRevision: "0",
      fillBaseAmount: "1000"
    };
    expect(await controller.takeOrder(input)).toEqual(view());
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({
      recipientPubkey: sessionPubkey,
      cursor: { since: 1_799_827_200 }
    });

    await subscriptions[0]!.onEvent(wrapper, "wss://inbox.example");
    expect(api.advanceTrade).toHaveBeenCalledTimes(1);
    await controller.advanceTrade(sessionId);
    expect(api.advanceTrade).toHaveBeenCalledTimes(2);
  });

  it("runs one durable action at a time until filled and returns only redacted checkpoints", async () => {
    const wait = vi.fn(async () => undefined);
    const { controller, api } = setup({ wait });
    api.getTrade
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view());
    api.advanceTrade
      .mockRejectedValueOnce(new Error("No private trade message is available"))
      .mockResolvedValueOnce(view(1))
      .mockResolvedValueOnce({ ...view(2), phase: "filled" });

    const result = await controller.runUntilSettled(sessionId);

    expect(wait).toHaveBeenCalledWith(250);
    expect(api.advanceTrade).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      sessionId,
      finalPhase: "filled",
      checkpoints: [
        { revision: 0, phase: "negotiating", role: "taker" },
        { revision: 1, phase: "negotiating", role: "taker" },
        { revision: 2, phase: "filled", role: "taker" }
      ]
    });
    expect(JSON.stringify(result)).not.toMatch(
      /token|proof|preimage|private|secret|nostr|cashu/i
    );
  });

  it("keeps settling while a live inbox subscription is still connecting", async () => {
    let releaseSubscription!: () => void;
    const subscriptionGate = new Promise<void>((resolve) => {
      releaseSubscription = resolve;
    });
    const { controller, api, subscriptions } = setup({
      startGates: [subscriptionGate]
    });
    api.advanceTrade.mockResolvedValueOnce({ ...view(1), phase: "filled" });

    const result = await Promise.race([
      controller.runUntilSettled(sessionId),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 50)
      )
    ]);

    expect(result).toMatchObject({ finalPhase: "filled" });
    expect(subscriptions).toHaveLength(1);
    releaseSubscription();
  });

  it("reopens a session inbox after its relay subscription closes", async () => {
    const { controller, api, subscriptions, stops } = setup();
    await controller.takeOrder({
      requestId: "99999999-9999-4999-8999-999999999999",
      address: view().orderAddress,
      expectedProjectionId: view().offeredProjectionId,
      expectedRevision: "0",
      fillBaseAmount: "1000"
    });

    subscriptions[0]!.onError({
      relay: "wss://inbox.example",
      kind: "relay_closed",
      message: "Inbox relay subscription closed unexpectedly"
    });

    await vi.waitFor(() => expect(subscriptions).toHaveLength(2));
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(subscriptions[1]).toMatchObject({
      recipientPubkey: sessionPubkey,
      cursor: { since: 1_799_827_200 }
    });

    await subscriptions[1]!.onEvent(wrapper, "wss://inbox.example");
    expect(api.advanceTrade).toHaveBeenCalledTimes(1);
  });

  it("does not restart a stale duplicate maker session from relay backlog", async () => {
    const older = {
      ...view(),
      sessionId: "aa".repeat(32),
      role: "maker" as const,
      createdAt: 1_800_000_000,
      updatedAt: 1_800_000_001
    };
    const newer = {
      ...older,
      sessionId: "bb".repeat(32),
      createdAt: 1_800_000_002,
      updatedAt: 1_800_000_003
    };
    const { controller, api, subscriptions } = setup({
      trades: [older, newer]
    });
    api.acceptReserveProposal.mockResolvedValue(older);
    api.getTrade.mockImplementation(async (id: string) =>
      id === older.sessionId ? older : newer
    );
    api.advanceTrade.mockImplementation(async (id: string) => ({
      ...(id === older.sessionId ? older : newer),
      revision: 1,
      phase: "filled"
    }));

    await controller.enableMaker();
    await subscriptions[0]!.onEvent(wrapper, "wss://inbox.example");

    await vi.waitFor(() => expect(api.advanceTrade).toHaveBeenCalledOnce());
    expect(api.advanceTrade).toHaveBeenCalledWith(newer.sessionId);
  });

  it("single-flights a reconnect racing durable resume", async () => {
    let releaseReconnect!: () => void;
    const reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });
    const { controller, subscriptions } = setup({
      startGates: [undefined, reconnectGate]
    });
    await controller.takeOrder({
      requestId: "99999999-9999-4999-8999-999999999999",
      address: view().orderAddress,
      expectedProjectionId: view().offeredProjectionId,
      expectedRevision: "0",
      fillBaseAmount: "1000"
    });

    subscriptions[0]!.onError({
      relay: "wss://inbox.example",
      kind: "relay_closed",
      message: "Inbox relay subscription closed unexpectedly"
    });
    await vi.waitFor(() => expect(subscriptions).toHaveLength(2));
    const resumed = controller.resume();
    releaseReconnect();
    await resumed;

    expect(subscriptions).toHaveLength(2);
  });

  it("discards a reconnect that completes after the controller stops", async () => {
    let releaseReconnect!: () => void;
    const reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });
    const { controller, subscriptions, stops } = setup({
      startGates: [undefined, reconnectGate]
    });
    await controller.takeOrder({
      requestId: "99999999-9999-4999-8999-999999999999",
      address: view().orderAddress,
      expectedProjectionId: view().offeredProjectionId,
      expectedRevision: "0",
      fillBaseAmount: "1000"
    });

    subscriptions[0]!.onError({
      relay: "wss://inbox.example",
      kind: "relay_closed",
      message: "Inbox relay subscription closed unexpectedly"
    });
    await vi.waitFor(() => expect(subscriptions).toHaveLength(2));
    controller.stop();
    releaseReconnect();
    await vi.waitFor(() => expect(stops[1]).toHaveBeenCalledOnce());
    controller.stop();

    expect(stops[1]).toHaveBeenCalledOnce();
  });

  it("closes retained subscriptions and never returns their secret keys", async () => {
    const { controller, stops } = setup();
    await controller.enableMaker();
    await controller.takeOrder({
      requestId: "99999999-9999-4999-8999-999999999999",
      address: view().orderAddress,
      expectedProjectionId: view().offeredProjectionId,
      expectedRevision: "0",
      fillBaseAmount: "1000"
    });

    controller.stop();
    expect(stops).toHaveLength(2);
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    expect(JSON.stringify(await controller.listTrades())).not.toContain("nostrPrivateKey");
  });
});
