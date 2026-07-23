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
    offeredOrderHead: "88".repeat(32),
    reserveTransitionId: null,
    fillTransitionId: null,
    pendingOrderPublication: null,
    createdAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    terms: {
      baseMint: "https://testnut.cashu.space",
      baseUnit: "sat",
      baseKeyset: "00deadbeefcafeee",
      baseAmount: "1000",
      quoteMint: "https://nofee.testnut.cashu.space",
      quoteUnit: "usd",
      quoteKeyset: "00deadbeefcafeff",
      quoteAmount: "20",
      price: { numerator: "1", denominator: "50" }
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
      reserveTransitionId: null,
      fillTransitionId: null,
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

function setup(): {
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
    listTrades: vi.fn(async () => [publicView]),
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
      useSecretKey: vi.fn(async (action) => action(makerKey.slice()))
    },
    now: () => 1_800_000_000,
    startSubscription: vi.fn(async (input) => {
      subscriptions.push(input);
      const stop = vi.fn();
      stops.push(stop);
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

  it("opens a proposal from the live maker inbox and persists its maker session", async () => {
    const { controller, api, subscriptions } = setup();
    await controller.enableMaker();
    await subscriptions[0]!.onEvent(wrapper, "wss://inbox.example");

    expect(api.acceptReserveProposal).toHaveBeenCalledOnce();
  });

  it("starts the session inbox and advances only one coordinator action per call", async () => {
    const { controller, api, subscriptions } = setup();
    const input: TakeOrderInput = {
      requestId: "99999999-9999-4999-8999-999999999999",
      address: view().orderAddress,
      expectedHeadId: view().offeredOrderHead,
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

  it("closes retained subscriptions and never returns their secret keys", async () => {
    const { controller, stops } = setup();
    await controller.enableMaker();
    await controller.takeOrder({
      requestId: "99999999-9999-4999-8999-999999999999",
      address: view().orderAddress,
      expectedHeadId: view().offeredOrderHead,
      fillBaseAmount: "1000"
    });

    controller.stop();
    expect(stops).toHaveLength(2);
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    expect(JSON.stringify(await controller.listTrades())).not.toContain("nostrPrivateKey");
  });
});
