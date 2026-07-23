import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import type { OrderApi } from "../api/order-api.js";
import type {
  CompletedLock,
  PreparedTradeOperation,
  CashuTradeClient
} from "../cashu/trade-client.js";
import type { WalletState } from "../core/wallet.js";
import type { NostrTradeTransport } from "../nostr/trade-transport.js";
import {
  createProjectionTemplate,
  createStateTransitionTemplate,
  createTransitionTemplate,
  type NostrEvent
} from "../order/events.js";
import {
  createOrderState,
  fillOrder,
  reserveOrder
} from "../order/model.js";
import type { OrderOutboxEntry, OrderOutboxPort } from "../storage/order-outbox.js";
import type { ProofReservationRepository } from "../storage/proof-reservation-repository.js";
import type { WalletRepository } from "../storage/wallet-repository.js";
import type { CoordinatorAction } from "./coordinator-plan.js";
import {
  GranolaCoordinatorEffects,
  type CoordinatorOrderReadPort,
  type PublishedOrderHead
} from "./effects.js";
import type { TradeSession } from "./session.js";

const NOW = 1_800_000_100;
const SESSION_ID = "11".repeat(32);
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const MAKER = "22".repeat(32);
const DISCOVERY_RELAYS = [
  "wss://discovery-one.example",
  "wss://discovery-two.example"
];
const INBOX_RELAYS = ["wss://inbox.example"];
const ORDER_SIGNING_KEY = new Uint8Array(32).fill(12);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function event(
  kind: number,
  idByte: string,
  tags: string[][] = []
): NostrEvent {
  return {
    kind,
    created_at: NOW - 100,
    tags,
    content: "",
    id: idByte.repeat(32),
    pubkey: MAKER,
    sig: "ee".repeat(64)
  };
}

async function publishedFill(): Promise<PublishedOrderHead> {
  const maker = getPublicKey(ORDER_SIGNING_KEY);
  const initial = createOrderState({
    orderId: ORDER_ID,
    createdAt: NOW - 200,
    expiresAt: NOW + 2_000,
    side: "sell",
    baseUnit: "sat",
    quoteUnit: "usd",
    offered: { unit: "sat", mint: "https://testnut.cashu.space" },
    requested: {
      unit: "usd",
      acceptableMints: ["https://nofee.testnut.cashu.space"]
    },
    amount: "20",
    price: { numerator: "1", denominator: "20" }
  });
  const create = finalizeEvent(
    createTransitionTemplate(initial, maker, "create"),
    ORDER_SIGNING_KEY
  );
  const reserved = reserveOrder(initial, {
    reservationId: "11111111-1111-4111-8111-111111111111",
    amount: "20",
    acceptedAt: NOW - 150,
    expiresAt: NOW + 1_700,
    proposalEventId: "31".repeat(32),
    takerCommitment: "32".repeat(32)
  });
  const predecessor = finalizeEvent(
    createStateTransitionTemplate(
      reserved,
      maker,
      "reserve",
      "reserve",
      create
    ),
    ORDER_SIGNING_KEY
  );
  const filled = fillOrder(reserved, {
    reservationId: reserved.reservation!.id,
    amount: reserved.reservation!.amount
  });
  const transition = finalizeEvent(
    createStateTransitionTemplate(
      filled,
      maker,
      "fill",
      "fill",
      predecessor,
      {
        settlement_hash: "44".repeat(32),
        base_token_commitment: "45".repeat(32),
        quote_token_commitment: "46".repeat(32)
      },
      NOW - 120
    ),
    ORDER_SIGNING_KEY
  );
  const projection = finalizeEvent(
    await createProjectionTemplate(filled, transition),
    ORDER_SIGNING_KEY
  );
  return {
    headEventId: transition.id,
    predecessor,
    transition,
    projection
  };
}

function preparedOperation(): PreparedTradeOperation {
  return {
    version: 1,
    kind: "outgoing-lock",
    mintUrl: "https://testnut.cashu.space",
    unit: "sat",
    preview: {
      amount: "20",
      fees: "0",
      keysetId: "base-keyset",
      inputs: [],
      keepOutputs: [],
      sendOutputs: []
    },
    spentSecrets: ["proof-unreserved"],
    expected: {
      mintUrl: "https://testnut.cashu.space",
      unit: "sat",
      amount: "20",
      hash: "44".repeat(32),
      receiverPubkey: "55".repeat(32),
      refundPubkey: "66".repeat(32),
      locktime: NOW + 1_100,
      leg: "base",
      refundHorizon: NOW + 1_160,
      deadlines: {
        short: NOW + 500,
        long: NOW + 1_100,
        minimumGap: 600
      },
      binding: {
        protocolVersion: "1",
        network: "cashu-testnet-v1",
        orderId: ORDER_ID,
        reservationId: "11111111-1111-4111-8111-111111111111",
        sessionId: SESSION_ID,
        direction: "base",
        transcriptHash: "77".repeat(32)
      }
    },
    operationCommitment: "88".repeat(32)
  };
}

function baseSession(): TradeSession {
  const inboxEvent = event(10050, "07", [["relay", INBOX_RELAYS[0]!]]);
  return {
    schema: "granola/trade-session/v2",
    revision: 4,
    sessionId: SESSION_ID,
    reservationId: "11111111-1111-4111-8111-111111111111",
    role: "maker",
    phase: "base_locked",
    orderAddress: `30078:${MAKER}:granola:order:v1:${ORDER_ID}`,
    offeredOrderHead: "33".repeat(32),
    reserveTransitionId: "34".repeat(32),
    fillTransitionId: null,
    pendingOrderPublication: null,
    createdAt: NOW - 100,
    updatedAt: NOW - 10,
    terms: {
      baseMint: "https://testnut.cashu.space",
      baseUnit: "sat",
      baseKeyset: "base-keyset",
      baseAmount: "20",
      quoteMint: "https://nofee.testnut.cashu.space",
      quoteUnit: "usd",
      quoteKeyset: "quote-keyset",
      quoteAmount: "1",
      price: { numerator: "1", denominator: "20" }
    },
    plan: {
      anchor: NOW - 100,
      shortLocktime: NOW + 500,
      makerClaimCutoff: NOW + 380,
      longLocktime: NOW + 1_100,
      takerClaimCutoff: NOW + 980,
      reservationExpiresAt: NOW + 1_700,
      refundGuardSeconds: 60
    },
    evidence: {
      makerPubkey: MAKER,
      commitments: [],
      mintStates: [],
      reserveTransitionId: "34".repeat(32),
      fillTransitionId: null,
      reservation: {
        proposalSealId: "35".repeat(32),
        takerCommitment: "36".repeat(32),
        abortSeal: null
      },
      legs: {
        base: {
          tokenCommitment: null,
          validationCommitment: null,
          keysetId: "base-keyset",
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
          keysetId: "quote-keyset",
          proofCount: null,
          fee: null,
          mintState: "UNKNOWN",
          observedAt: null,
          spendCommitment: null,
          claimOperationCommitment: null,
          refundOperationCommitment: null
        }
      }
    },
    privateState: {
      nostrPrivateKey: "01".repeat(32),
      cashuPrivateKey: "02".repeat(32),
      refundPrivateKey: "03".repeat(32),
      preimage: "04".repeat(32),
      htlcHash: "44".repeat(32),
      settlementTranscriptHash: "77".repeat(32),
      inbox: {
        status: "registered",
        quorum: 2,
        event: inboxEvent,
        discoveryRelays: [...DISCOVERY_RELAYS],
        inboxRelays: [...INBOX_RELAYS],
        receipts: DISCOVERY_RELAYS.map((relay) => ({
          relay,
          ok: true,
          message: "stored"
        })),
        readbacks: DISCOVERY_RELAYS.map((relay) => ({
          relay,
          found: true,
          event: inboxEvent,
          observedAt: NOW - 90
        })),
        stagedAt: NOW - 100,
        acknowledgedAt: NOW - 90,
        registeredAt: NOW - 90
      },
      pendingIncoming: null,
      transcript: {
        choreography: {
          phase: "awaiting_base_lock",
          participants: {
            makerOrderPubkey: MAKER,
            makerSessionPubkey: "55".repeat(32),
            takerSessionPubkey: "56".repeat(32),
            makerCashuPubkey: "57".repeat(32),
            takerCashuPubkey: "55".repeat(32),
            makerRefundPubkey: "66".repeat(32),
            takerRefundPubkey: "58".repeat(32)
          },
          refundedLegs: []
        },
        nextSequence: "3",
        lastRumorId: "90".repeat(32),
        lastMessageId: "91".repeat(32),
        lastTranscriptHash: "77".repeat(32),
        accepted: []
      },
      outbox: null,
      cashuOperation: null,
      legs: {
        base: {
          token: null,
          expected: preparedOperation().expected,
          observations: []
        },
        quote: { token: null, expected: null, observations: [] }
      }
    }
  };
}

function stagedDeliverySession(): TradeSession {
  const current = baseSession();
  current.privateState.outbox = {
    message: {
      schema: "granola/dm/v1",
      deployment: "cashu-testnet-v1",
      type: "base_lock",
      message_id: "11111111-1111-4111-8111-111111111112",
      session_id: current.sessionId,
      reservation_id: current.reservationId,
      order_address: current.orderAddress,
      order_head: current.reserveTransitionId!,
      maker_order_pubkey: MAKER,
      author_pubkey: "55".repeat(32),
      recipient_pubkey: "56".repeat(32),
      sequence: "3",
      previous_message_id: "91".repeat(32),
      previous_transcript_hash: "77".repeat(32),
      sent_at: NOW - 10,
      expires_at: NOW + 300,
      terms_hash: "92".repeat(32),
      body: {
        schema: "granola/atomic-swap-body/v1",
        cashu_token: "cashuBprivate",
        token_commitment: "93".repeat(32),
        validation_commitment: "98".repeat(32),
        settlement_hash: "44".repeat(32),
        mint: current.terms.baseMint,
        unit: current.terms.baseUnit,
        keyset: current.terms.baseKeyset,
        amount: current.terms.baseAmount,
        receiver_cashu_pubkey: "55".repeat(32),
        refund_cashu_pubkey: "66".repeat(32),
        locktime: current.plan.longLocktime
      }
    },
    rumor: {
      kind: 14,
      created_at: NOW - 10,
      tags: [["p", "56".repeat(32)]],
      content: "encrypted-rumor",
      id: "94".repeat(32),
      pubkey: "55".repeat(32)
    },
    seal: event(13, "95"),
    wrapper: event(1059, "96", [["p", "56".repeat(32)]]),
    recipientInboxListId: "97".repeat(32),
    recipientRelays: ["wss://recipient.example"],
    receipts: [],
    nextChoreography: {
      phase: "awaiting_base_lock_ack",
      participants: clone(current.privateState.transcript.choreography.participants),
      refundedLegs: []
    },
    status: "staged"
  };
  return current;
}

function stagedOrderSession(): TradeSession {
  const current = baseSession();
  current.pendingOrderPublication = {
    operation: "reserve",
    orderId: ORDER_ID,
    transition: event(78, "a1"),
    projection: event(30078, "a2"),
    transitionReceipts: [],
    projectionReceipts: [],
    status: "staged",
    stagedAt: NOW - 10,
    transitionAcknowledgedAt: null,
    projectionAcknowledgedAt: null,
    committedAt: null
  };
  return current;
}

function walletState(): WalletState {
  return {
    version: 1,
    revision: 7,
    pockets: [{
      mintUrl: "https://testnut.cashu.space",
      unit: "sat",
      proofs: [{
        amount: "8",
        id: "base-keyset",
        secret: "proof-reserved",
        C: "point-reserved"
      }, {
        amount: "32",
        id: "base-keyset",
        secret: "proof-unreserved",
        C: "point-unreserved"
      }]
    }]
  };
}

interface Harness {
  effects: GranolaCoordinatorEffects;
  orderApi: {
    publishNextStage: ReturnType<typeof vi.fn>;
  };
  orderOutbox: {
    load: ReturnType<typeof vi.fn>;
  };
  orderReader: {
    loadPublishedHead: ReturnType<typeof vi.fn>;
  };
  nostr: {
    send: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
  };
  cashu: {
    prepareOutgoingLock: ReturnType<typeof vi.fn>;
    completeOutgoingLock: ReturnType<typeof vi.fn>;
  };
  wallet: {
    load: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
  reservations: {
    load: ReturnType<typeof vi.fn>;
    reserve: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  withWalletLock: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const orderApi = {
    publishNextStage: vi.fn()
  };
  const orderOutbox = {
    load: vi.fn(),
    list: vi.fn(),
    ensureStaged: vi.fn(),
    recordProgress: vi.fn(),
    loadAcknowledged: vi.fn(),
    clearAcknowledged: vi.fn(),
    pruneCommitted: vi.fn()
  };
  const orderReader = {
    loadPublishedHead: vi.fn()
  };
  const nostr = {
    createRegistration: vi.fn(),
    publishRegistration: vi.fn(),
    discoverInbox: vi.fn(),
    send: vi.fn(),
    read: vi.fn()
  };
  const cashu = {
    prepareOutgoingLock: vi.fn(),
    completeOutgoingLock: vi.fn(),
    validateIncomingLock: vi.fn(),
    prepareClaim: vi.fn(),
    completeClaim: vi.fn(),
    prepareRefund: vi.fn(),
    completeRefund: vi.fn(),
    checkToken: vi.fn()
  };
  const wallet = {
    load: vi.fn(),
    save: vi.fn()
  };
  const reservations = {
    load: vi.fn(),
    reserve: vi.fn(),
    release: vi.fn()
  };
  const withWalletLock = vi.fn(async (action: () => Promise<unknown>) =>
    action()
  );
  const effects = new GranolaCoordinatorEffects({
    orderApi: orderApi as unknown as OrderApi,
    orderOutbox: orderOutbox as unknown as OrderOutboxPort,
    orderReader: orderReader as unknown as CoordinatorOrderReadPort,
    nostr: nostr as unknown as NostrTradeTransport,
    cashu: cashu as unknown as CashuTradeClient,
    wallet: wallet as unknown as WalletRepository,
    reservations: reservations as unknown as ProofReservationRepository,
    makerIdentity: {
      publicKey: async () => MAKER,
      useSecretKey: async (action) => action(new Uint8Array(32).fill(9))
    },
    discoveryRelays: DISCOVERY_RELAYS,
    withWalletLock: withWalletLock as unknown as
      <T>(action: () => Promise<T>) => Promise<T>,
    entropy: {
      messageId: () => "11111111-1111-4111-8111-111111111113",
      operationId: () => "11111111-1111-4111-8111-111111111114",
      ephemeralSecretKey: () => new Uint8Array(32).fill(7),
      nonce: () => new Uint8Array(32).fill(8),
      randomizedTimestamp: (now: number) => now - 1,
      outerExpiration: (expiration: number) => expiration + 3_600
    },
    commitment: async () => "ab".repeat(32)
  });
  return {
    effects,
    orderApi,
    orderOutbox,
    orderReader,
    nostr,
    cashu,
    wallet,
    reservations,
    withWalletLock
  };
}

function externalInput(
  action: CoordinatorAction,
  session: TradeSession
) {
  return {
    action,
    session: clone(session),
    now: NOW,
    revision: session.revision,
    fingerprint: `${action.kind}:fixed-test-fingerprint`
  };
}

async function takerAwaitingFillVerification(): Promise<{
  session: TradeSession;
  publication: PublishedOrderHead;
}> {
  const publication = await publishedFill();
  const current = baseSession();
  current.role = "taker";
  current.phase = "filled";
  current.orderAddress =
    `30078:${publication.transition.pubkey}:granola:order:v1:${ORDER_ID}`;
  current.offeredOrderHead = publication.predecessor.id;
  current.reserveTransitionId = publication.predecessor.id;
  current.fillTransitionId = publication.transition.id;
  current.pendingOrderPublication = null;
  current.evidence.makerPubkey = publication.transition.pubkey;
  current.evidence.reserveTransitionId = publication.predecessor.id;
  current.evidence.fillTransitionId = null;
  current.evidence.legs.base.tokenCommitment = "45".repeat(32);
  current.evidence.legs.quote.tokenCommitment = "46".repeat(32);
  current.privateState.outbox = null;
  current.privateState.cashuOperation = null;
  current.privateState.htlcHash = "44".repeat(32);
  current.privateState.transcript.choreography.phase = "settled";
  return { session: current, publication };
}

describe("GranolaCoordinatorEffects", () => {
  it("classifies every planner action at an explicit I/O boundary", () => {
    const { effects } = harness();
    const local = [
      "stage_inbox_registration",
      "commit_outbox",
      "commit_incoming",
      "clear_cashu_operation",
      "enter_recovery",
      "none"
    ] satisfies CoordinatorAction["kind"][];
    const external = [
      "publish_order_transition",
      "publish_order_projection",
      "commit_order_publication",
      "clear_order_publication",
      "publish_inbox_registration",
      "verify_inbox_registration",
      "deliver_outbox",
      "validate_incoming",
      "reserve_cashu_inputs",
      "execute_cashu_operation",
      "reconcile_wallet",
      "stage_reserve_propose",
      "stage_order_reserve",
      "stage_reserve_accept",
      "poll_inbox",
      "stage_session_ack",
      "prepare_base_lock",
      "stage_base_lock",
      "stage_base_lock_ack",
      "prepare_quote_lock",
      "stage_quote_lock",
      "stage_quote_lock_ack",
      "prepare_quote_claim",
      "stage_claim_notice",
      "observe_quote",
      "prepare_base_claim",
      "stage_fill_request",
      "observe_base",
      "stage_order_fill",
      "verify_order_fill",
      "stage_order_release",
      "stage_settlement_ack",
      "prepare_quote_refund",
      "prepare_base_refund"
    ] satisfies CoordinatorAction["kind"][];
    const allKinds = [...local, ...external];

    expect(new Set(allKinds).size).toBe(allKinds.length);
    expect(allKinds).toHaveLength(40);
    for (const kind of local) {
      expect(effects.classify({ kind } as CoordinatorAction), kind).toBe("local");
    }
    for (const kind of external) {
      expect(effects.classify({ kind } as CoordinatorAction), kind).toBe("external");
    }
  });

  it("retries the exact persisted Nostr wrapper and only records its receipts", async () => {
    const { effects, nostr } = harness();
    const current = stagedDeliverySession();
    const receipts = [{
      relay: current.privateState.outbox!.recipientRelays[0]!,
      ok: true,
      message: "stored"
    }];
    const sentKeys: Uint8Array[] = [];
    nostr.send.mockImplementation(async (
      _wrapper: NostrEvent,
      _relays: string[],
      secretKey: Uint8Array
    ) => {
      sentKeys.push(Uint8Array.from(secretKey));
      return receipts;
    });

    const first = await effects.performExternal(
      externalInput({ kind: "deliver_outbox" }, current)
    );
    const retry = await effects.performExternal(
      externalInput({ kind: "deliver_outbox" }, current)
    );

    expect(nostr.send).toHaveBeenCalledTimes(2);
    for (const [wrapper, relays] of nostr.send.mock.calls) {
      expect(wrapper).toEqual(current.privateState.outbox!.wrapper);
      expect(relays).toEqual(current.privateState.outbox!.recipientRelays);
    }
    expect(sentKeys).toEqual([
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(1)
    ]);
    expect(first.privateState.outbox).toEqual({
      ...current.privateState.outbox,
      receipts,
      status: "acknowledged"
    });
    expect(retry).toEqual(first);
    expect(first.revision).toBe(current.revision + 1);
    expect(first.updatedAt).toBe(NOW);
  });

  it("uses the shared order outbox as retry authority and never republishes an acknowledged stage", async () => {
    const { effects, orderApi, orderOutbox } = harness();
    const current = stagedOrderSession();
    const stagedEntry = {
      schema: "granola/order-outbox/v2",
      status: "staged",
      intent: {
        operation: "reserve",
        orderId: ORDER_ID,
        address: current.orderAddress
      },
      publication: {
        transition: current.pendingOrderPublication!.transition,
        projection: current.pendingOrderPublication!.projection,
        transitionReceipts: [],
        projectionReceipts: []
      }
    } as unknown as OrderOutboxEntry;
    const acknowledgedEntry = clone(stagedEntry);
    acknowledgedEntry.status = "transition_acknowledged";
    acknowledgedEntry.publication.transitionReceipts = [{
      relay: "wss://orders.example",
      ok: true,
      message: "stored"
    }];
    let durableEntry = stagedEntry;
    orderOutbox.load.mockImplementation(async () => clone(durableEntry));
    orderApi.publishNextStage.mockImplementation(async () => {
      durableEntry = acknowledgedEntry;
      return {
        orderId: ORDER_ID,
        makerPubkey: MAKER,
        transitionId: current.pendingOrderPublication!.transition.id,
        projectionId: current.pendingOrderPublication!.projection.id,
        transitionReceipts: clone(acknowledgedEntry.publication.transitionReceipts),
        projectionReceipts: [],
        status: "transition_acknowledged"
      };
    });

    const first = await effects.performExternal(
      externalInput({ kind: "publish_order_transition" }, current)
    );
    const retry = await effects.performExternal(
      externalInput({ kind: "publish_order_transition" }, current)
    );

    expect(orderApi.publishNextStage).toHaveBeenCalledTimes(1);
    expect(orderApi.publishNextStage).toHaveBeenCalledWith(ORDER_ID);
    expect(first.pendingOrderPublication?.transition)
      .toEqual(current.pendingOrderPublication!.transition);
    expect(first.pendingOrderPublication?.projection)
      .toEqual(current.pendingOrderPublication!.projection);
    expect(first.pendingOrderPublication?.transitionReceipts)
      .toEqual(acknowledgedEntry.publication.transitionReceipts);
    expect(first.pendingOrderPublication?.status)
      .toBe("transition_acknowledged");
    expect(retry).toEqual(first);
  });

  it("prepares from an unreserved wallet snapshot under the wallet lock without mutating storage", async () => {
    const {
      effects,
      cashu,
      wallet,
      reservations,
      withWalletLock
    } = harness();
    const current = baseSession();
    const artifact = preparedOperation();
    wallet.load.mockResolvedValue(walletState());
    reservations.load.mockResolvedValue({
      version: 1,
      revision: 3,
      reservations: [{
        proofSecret: "proof-reserved",
        sessionId: "99".repeat(32),
        mintUrl: current.terms.baseMint,
        unit: current.terms.baseUnit,
        reservedAt: NOW - 20
      }]
    });
    cashu.prepareOutgoingLock.mockResolvedValue(artifact);

    const prepared = await effects.performExternal(
      externalInput({ kind: "prepare_base_lock" }, current)
    );

    expect(withWalletLock).toHaveBeenCalledTimes(1);
    expect(cashu.prepareOutgoingLock).toHaveBeenCalledWith({
      pocket: {
        mintUrl: current.terms.baseMint,
        unit: current.terms.baseUnit,
        proofs: [walletState().pockets[0]!.proofs[1]!]
      },
      expected: current.privateState.legs.base.expected,
      now: NOW
    });
    expect(prepared.privateState.cashuOperation).toEqual({
      operationId: "11111111-1111-4111-8111-111111111114",
      leg: "base",
      kind: "outgoing-lock",
      status: "prepared",
      preparedAt: NOW,
      inputsReserved: false,
      artifact,
      result: null
    });
    expect(wallet.save).not.toHaveBeenCalled();
    expect(reservations.reserve).not.toHaveBeenCalled();
    expect(reservations.release).not.toHaveBeenCalled();
  });

  it("reserves the persisted Cashu inputs before executing the exact prepared artifact on retry", async () => {
    const {
      effects,
      cashu,
      wallet,
      reservations,
      withWalletLock
    } = harness();
    const prepared = baseSession();
    prepared.privateState.cashuOperation = {
      operationId: "11111111-1111-4111-8111-111111111114",
      leg: "base",
      kind: "outgoing-lock",
      status: "prepared",
      preparedAt: NOW - 1,
      inputsReserved: false,
      artifact: preparedOperation(),
      result: null
    };
    reservations.load.mockResolvedValue({
      version: 1,
      revision: 3,
      reservations: []
    });
    reservations.reserve.mockResolvedValue({
      version: 1,
      revision: 4,
      reservations: preparedOperation().spentSecrets.map((proofSecret) => ({
        proofSecret,
        sessionId: prepared.sessionId,
        mintUrl: prepared.terms.baseMint,
        unit: prepared.terms.baseUnit,
        reservedAt: prepared.privateState.cashuOperation!.preparedAt
      }))
    });

    const reserved = await effects.performExternal(
      externalInput({ kind: "reserve_cashu_inputs" }, prepared)
    );

    expect(withWalletLock).toHaveBeenCalledTimes(1);
    expect(reservations.reserve).toHaveBeenCalledWith(3, {
      sessionId: prepared.sessionId,
      mintUrl: prepared.terms.baseMint,
      unit: prepared.terms.baseUnit,
      proofSecrets: preparedOperation().spentSecrets,
      reservedAt: prepared.privateState.cashuOperation.preparedAt
    });
    expect(reserved.privateState.cashuOperation?.inputsReserved).toBe(true);
    expect(wallet.save).not.toHaveBeenCalled();

    const completedLock: CompletedLock = {
      change: {
        mintUrl: prepared.terms.baseMint,
        unit: prepared.terms.baseUnit,
        proofs: [{
          amount: "12",
          id: "base-keyset",
          secret: "change-proof",
          C: "change-point"
        }]
      },
      lockedToken: "cashuBlocked",
      summary: {
        mintUrl: prepared.terms.baseMint,
        unit: prepared.terms.baseUnit,
        amount: prepared.terms.baseAmount,
        proofCount: 1,
        fee: "0",
        keysetId: "base-keyset",
        locktime: prepared.plan.longLocktime,
        hash: prepared.privateState.htlcHash!,
        receiverPubkey: "55".repeat(32),
        refundPubkey: "66".repeat(32),
        commitment: "89".repeat(32)
      }
    } as CompletedLock;
    cashu.completeOutgoingLock.mockResolvedValue(completedLock);

    const first = await effects.performExternal(
      externalInput({ kind: "execute_cashu_operation" }, reserved)
    );
    const retry = await effects.performExternal(
      externalInput({ kind: "execute_cashu_operation" }, reserved)
    );

    expect(cashu.completeOutgoingLock).toHaveBeenCalledTimes(2);
    for (const [artifact, expected] of cashu.completeOutgoingLock.mock.calls) {
      expect(artifact).toEqual(reserved.privateState.cashuOperation!.artifact);
      expect(expected).toEqual(reserved.privateState.legs.base.expected);
    }
    expect(first.privateState.cashuOperation?.status).toBe("completed");
    expect(first.privateState.cashuOperation?.artifact)
      .toEqual(reserved.privateState.cashuOperation!.artifact);
    expect(first.privateState.cashuOperation?.result).toMatchObject({
      walletMutation: "replace",
      mintUrl: completedLock.change.mintUrl,
      unit: completedLock.change.unit,
      proofs: completedLock.change.proofs,
      lockedToken: completedLock.lockedToken
    });
    expect(retry).toEqual(first);
    expect(wallet.save).not.toHaveBeenCalled();
    expect(reservations.release).not.toHaveBeenCalled();
  });

  it("accepts only the maker's exact current published fill before taker termination", async () => {
    const { effects, orderReader } = harness();
    const { session, publication } = await takerAwaitingFillVerification();

    orderReader.loadPublishedHead.mockRejectedValueOnce(
      new Error("fill is absent from relays")
    );
    await expect(effects.performExternal(
      externalInput({ kind: "verify_order_fill" }, session)
    )).rejects.toThrow(/absent/i);

    orderReader.loadPublishedHead.mockResolvedValueOnce({
      ...publication,
      headEventId: "ff".repeat(32)
    });
    await expect(effects.performExternal(
      externalInput({ kind: "verify_order_fill" }, session)
    )).rejects.toThrow(/head/i);

    orderReader.loadPublishedHead.mockResolvedValueOnce({
      ...publication,
      projection: {
        ...publication.projection,
        content: JSON.stringify({
          ...JSON.parse(publication.projection.content),
          head: "fe".repeat(32)
        })
      }
    });
    await expect(effects.performExternal(
      externalInput({ kind: "verify_order_fill" }, session)
    )).rejects.toThrow();

    orderReader.loadPublishedHead.mockResolvedValueOnce(publication);
    const verified = await effects.performExternal(
      externalInput({ kind: "verify_order_fill" }, session)
    );

    expect(orderReader.loadPublishedHead).toHaveBeenLastCalledWith(
      session.orderAddress,
      session.fillTransitionId
    );
    expect(verified.evidence.fillTransitionId).toBe(session.fillTransitionId);
    expect(verified.revision).toBe(session.revision + 1);
    });
  });

  it("polls with the bounded NIP-17 lookback and skips replayed wrappers", async () => {
    const { effects, nostr } = harness();
    const current = baseSession();
    current.privateState.outbox = null;
    const replay = event(1059, "81");
    replay.created_at = current.updatedAt - 120;
    const fresh = event(1059, "82");
    fresh.created_at = current.updatedAt - 60;
    nostr.read.mockImplementation(async (
      _recipient: string,
      _key: Uint8Array,
      since: number
    ) => [replay, fresh].filter((wrapper) => wrapper.created_at >= since));
    const openIncoming = vi.fn()
      .mockRejectedValueOnce(new Error("message was already accepted"))
      .mockResolvedValueOnce({
        wrapper: fresh,
        seal: event(13, "83"),
        rumor: event(14, "84"),
        message: { message_id: "11111111-1111-4111-8111-111111111115" },
        transcriptHash: "85".repeat(32)
      });
    Object.assign(effects, { openIncoming });

    const polled = await effects.performExternal(
      externalInput({ kind: "poll_inbox" }, current)
    );

    expect(nostr.read).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Uint8Array),
      current.updatedAt - 172_800
    );
    expect(openIncoming).toHaveBeenCalledTimes(2);
    expect(polled.privateState.pendingIncoming?.wrapper).toEqual(fresh);
  });
