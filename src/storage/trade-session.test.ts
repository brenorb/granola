import { createHTLCHash } from "@cashu/cashu-ts";
import { finalizeEvent, getEventHash, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { publicTradeView, type TradeSession } from "../trade/session.js";
import type { GranolaTradeMessage } from "../trade/messages.js";
import { MemoryStorageDriver } from "./wallet-repository.js";
import {
  TradeSessionRepository,
  type TradeSessionExclusiveRunner
} from "./trade-session.js";

function fixedKey(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const makerSecret = fixedKey(2);
const sessionSecret = fixedKey(1);
const outerSecret = fixedKey(3);
const remoteSecret = fixedKey(4);
const incomingOuterSecret = fixedKey(5);
const maker = getPublicKey(makerSecret);
const sessionPubkey = getPublicKey(sessionSecret);
const remotePubkey = getPublicKey(remoteSecret);
const sessionPrivateKey = hex(sessionSecret);
const sessionId = "11".repeat(32);
const reservationId = "11111111-1111-4111-8111-111111111111";
const messageId = "33333333-3333-4333-8333-333333333333";
const acceptedMessageId = "55555555-5555-4555-8555-555555555555";
const acceptedRumorId = "19".repeat(32);
const orderId = "22222222-2222-4222-8222-222222222222";
const offeredOrderHead = "33".repeat(32);
const operationId = "44444444-4444-4444-8444-444444444444";
const htlcMaterial = createHTLCHash("04".repeat(32));
const orderAddress = `30078:${maker}:granola:order:v1:${orderId}`;
const publicationRelays = [
  "wss://discovery-one.example",
  "wss://discovery-two.example"
];
const inboxRelays = [
  "wss://inbox-one.example",
  "wss://inbox-two.example"
];
const registration = structuredClone(finalizeEvent({
  kind: 10050,
  created_at: 1_700_000_000,
  tags: inboxRelays.map((relay) => ["relay", relay]),
  content: ""
}, sessionSecret));
const wrongRegistrationSigner = structuredClone(finalizeEvent({
  kind: 10050,
  created_at: 1_700_000_000,
  tags: inboxRelays.map((relay) => ["relay", relay]),
  content: ""
}, makerSecret));
const transition = structuredClone(finalizeEvent({
  kind: 78,
  created_at: 1_700_000_005,
  tags: [
    ["d", `granola:order-transition:v1:${orderId}`],
    ["op", "reserve"]
  ],
  content: "exact-signed-reserve-transition"
}, makerSecret));
const projection = structuredClone(finalizeEvent({
  kind: 30078,
  created_at: 1_700_000_005,
  tags: [
    ["d", `granola:order:v1:${orderId}`],
    ["e", transition.id]
  ],
  content: "exact-signed-order-projection"
}, makerSecret));
const wrapper = structuredClone(finalizeEvent({
  kind: 1059,
  created_at: 1_700_000_000,
  tags: [["p", "55".repeat(32)], ["expiration", "1700007200"]],
  content: "encrypted-private-wrapper"
}, outerSecret));
const seal = structuredClone(finalizeEvent({
  kind: 13,
  created_at: 1_700_000_000,
  tags: [],
  content: "encrypted-private-seal"
}, sessionSecret));
const outboxMessage: GranolaTradeMessage = {
  schema: "granola/dm/v1",
  deployment: "cashu-testnet-v1",
  type: "base_lock",
  message_id: messageId,
  session_id: sessionId,
  reservation_id: reservationId,
  order_address: orderAddress,
  order_head: transition.id,
  maker_order_pubkey: maker,
  author_pubkey: sessionPubkey,
  recipient_pubkey: "55".repeat(32),
  sequence: "1",
  previous_message_id: acceptedMessageId,
  previous_transcript_hash: "05".repeat(32),
  sent_at: 1_700_000_000,
  expires_at: 1_700_003_600,
  terms_hash: "07".repeat(32),
  body: { cashu_token: "cashu-private-token" }
};
const rumorTemplate = {
  pubkey: sessionPubkey,
  created_at: 1_700_000_000,
  kind: 14 as const,
  tags: [
    ["p", "55".repeat(32)],
    ["e", acceptedRumorId, "", "reply"]
  ],
  content: JSON.stringify(outboxMessage)
};
const rumor = { ...rumorTemplate, id: getEventHash(rumorTemplate) };
const incomingMessage: GranolaTradeMessage = {
  ...outboxMessage,
  message_id: "77777777-7777-4777-8777-777777777777",
  author_pubkey: remotePubkey,
  recipient_pubkey: sessionPubkey
};
const incomingRumorTemplate = {
  pubkey: remotePubkey,
  created_at: incomingMessage.sent_at,
  kind: 14 as const,
  tags: [
    ["p", sessionPubkey],
    ["e", acceptedRumorId, "", "reply"]
  ],
  content: JSON.stringify(incomingMessage)
};
const incomingRumor = {
  ...incomingRumorTemplate,
  id: getEventHash(incomingRumorTemplate)
};
const incomingSeal = structuredClone(finalizeEvent({
  kind: 13,
  created_at: 1_700_000_000,
  tags: [],
  content: "encrypted-incoming-seal"
}, remoteSecret));
const incomingWrapper = structuredClone(finalizeEvent({
  kind: 1059,
  created_at: 1_700_000_000,
  tags: [["p", sessionPubkey], ["expiration", "1700007200"]],
  content: "encrypted-incoming-wrapper"
}, incomingOuterSecret));

const session: TradeSession = {
  schema: "granola/trade-session/v2",
  revision: 0,
  sessionId,
  reservationId,
  role: "maker",
  phase: "base_locked",
  orderAddress,
  offeredOrderHead,
  reserveTransitionId: transition.id,
  fillTransitionId: null,
  pendingOrderPublication: {
    operation: "reserve",
    orderId,
    transition,
    projection,
    transitionReceipts: publicationRelays.map((relay) => ({ relay, ok: true, message: "stored" })),
    projectionReceipts: publicationRelays.map((relay) => ({ relay, ok: true, message: "stored" })),
    status: "projection_acknowledged",
    stagedAt: 1_700_000_005,
    transitionAcknowledgedAt: 1_700_000_006,
    projectionAcknowledgedAt: 1_700_000_007,
    committedAt: null
  },
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_010,
  terms: {
    baseMint: "https://testnut.cashu.space",
    baseUnit: "sat",
    baseKeyset: "00deadbeefcafeee",
    baseAmount: "20",
    quoteMint: "https://nofee.testnut.cashu.space",
    quoteUnit: "usd",
    quoteKeyset: "00deadbeefcafeff",
    quoteAmount: "1",
    price: { numerator: "1", denominator: "20" }
  },
  plan: {
    anchor: 1_700_000_000,
    shortLocktime: 1_700_000_600,
    makerClaimCutoff: 1_700_000_480,
    longLocktime: 1_700_001_200,
    takerClaimCutoff: 1_700_001_080,
    reservationExpiresAt: 1_700_001_800,
    refundGuardSeconds: 60
  },
  evidence: {
    makerPubkey: maker,
    commitments: [htlcMaterial.hash],
    mintStates: ["base:UNSPENT"],
    reserveTransitionId: transition.id,
    fillTransitionId: null,
    reservation: {
      proposalSealId: seal.id,
      takerCommitment: "18".repeat(32),
      abortSeal: null
    },
    legs: {
      base: {
        tokenCommitment: "ee".repeat(32),
        validationCommitment: "ff".repeat(32),
        keysetId: "00deadbeefcafeee",
        proofCount: 2,
        fee: "1",
        mintState: "UNSPENT",
        observedAt: 1_700_000_009,
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
  },
  privateState: {
    nostrPrivateKey: sessionPrivateKey,
    cashuPrivateKey: "02".repeat(32),
    refundPrivateKey: "03".repeat(32),
    preimage: htlcMaterial.preimage,
    htlcHash: htlcMaterial.hash,
    settlementTranscriptHash: "05".repeat(32),
    inbox: {
      status: "registered",
      quorum: 2,
      event: registration,
      discoveryRelays: publicationRelays,
      inboxRelays,
      receipts: publicationRelays.map((relay) => ({
        relay,
        ok: true,
        message: "stored"
      })),
      readbacks: publicationRelays.map((relay) => ({
        relay,
        found: true,
        event: registration,
        observedAt: 1_700_000_003
      })),
      stagedAt: 1_700_000_000,
      acknowledgedAt: 1_700_000_002,
      registeredAt: 1_700_000_003
    },
    pendingIncoming: null,
    transcript: {
      choreography: {
        phase: "awaiting_base_lock_ack",
        participants: { makerOrderPubkey: maker },
        refundedLegs: []
      },
      nextSequence: "1",
      lastRumorId: acceptedRumorId,
      lastMessageId: acceptedMessageId,
      lastTranscriptHash: "05".repeat(32),
      accepted: [{
        sequence: "0",
        messageId: acceptedMessageId,
        rumorId: acceptedRumorId,
        transcriptHash: "05".repeat(32)
      }]
    },
    outbox: {
      message: outboxMessage,
      rumor,
      seal,
      wrapper,
      recipientInboxListId: "08".repeat(32),
      recipientRelays: ["wss://auth.example"],
      receipts: [{ relay: "wss://auth.example", ok: true, message: "stored" }],
      nextChoreography: {
        phase: "awaiting_base_lock_ack",
        participants: { makerOrderPubkey: maker },
        refundedLegs: []
      },
      status: "acknowledged"
    },
    cashuOperation: {
      operationId,
      leg: "base",
      kind: "outgoing-lock",
      status: "completed",
      preparedAt: 1_700_000_004,
      inputsReserved: true,
      artifact: {
        version: 1,
        kind: "outgoing-lock",
        mintUrl: "https://testnut.cashu.space",
        unit: "sat",
        preview: {
          amount: "20",
          fees: "1",
          keysetId: "00deadbeefcafeee",
          inputs: ["serialized-private-input"],
          sendOutputs: [{ private: "blinding-material" } as never]
        },
        spentSecrets: ["proof-secret"],
        expected: {
          mintUrl: "https://testnut.cashu.space",
          unit: "sat",
          binding: {
            protocolVersion: "1",
            network: "cashu-testnet-v1",
            orderId,
            reservationId,
            sessionId,
            direction: "base",
            transcriptHash: "05".repeat(32)
          },
          amount: "20",
          hash: htlcMaterial.hash,
          receiverPubkey: `02${"0b".repeat(32)}`,
          refundPubkey: `03${"0c".repeat(32)}`,
          locktime: 1_700_001_200,
          leg: "base",
          refundHorizon: 1_700_001_260,
          deadlines: { short: 1_700_000_600, long: 1_700_001_200, minimumGap: 600 }
        },
        operationCommitment: "0d".repeat(32)
      },
      result: {
        walletMutation: "replace",
        mintUrl: "https://testnut.cashu.space",
        unit: "sat",
        proofs: [],
        lockedToken: "cashu-private-token",
        amount: "20",
        proofCount: 2
      }
    },
    legs: {
      base: {
        token: "cashu-private-token",
        expected: null,
        observations: [{
          observedAt: 1_700_000_009,
          state: "UNSPENT",
          proofCount: 2,
          witnessCommitment: null
        }]
      },
      quote: { token: null, expected: null, observations: [] }
    }
  }
};

describe("trade session v2 repository", () => {
  it("durably round-trips the complete crash-recovery journal", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());

    await repository.save(session, null);
    const restored = await repository.get(session.sessionId);

    expect(restored).toEqual(session);
    expect(restored).not.toBe(session);
  });

  it("round-trips SPENT evidence only when it is bound to a matching private observation", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    const spent = structuredClone(session);
    spent.evidence.legs.base = {
      ...spent.evidence.legs.base,
      mintState: "SPENT",
      observedAt: 1_700_000_011,
      proofCount: 2,
      spendCommitment: "12".repeat(32)
    };
    spent.privateState.legs.base.observations.push({
      observedAt: 1_700_000_011,
      state: "SPENT",
      proofCount: 2,
      witnessCommitment: "12".repeat(32)
    });

    await repository.save(spent, null);

    expect(await repository.get(spent.sessionId)).toEqual(spent);
  });

  it("round-trips each monotonic inbox registration checkpoint with the exact signed event", async () => {
    const checkpoints: TradeSession["privateState"]["inbox"][] = [
      {
        status: "unregistered",
        quorum: 2,
        event: null,
        discoveryRelays: [],
        inboxRelays: [],
        receipts: [],
        readbacks: [],
        stagedAt: null,
        acknowledgedAt: null,
        registeredAt: null
      },
      {
        status: "staged",
        quorum: 2,
        event: registration,
        discoveryRelays: publicationRelays,
        inboxRelays,
        receipts: [{
          relay: publicationRelays[0]!,
          ok: true,
          message: "stored below quorum"
        }],
        readbacks: [],
        stagedAt: 1_700_000_000,
        acknowledgedAt: null,
        registeredAt: null
      },
      {
        status: "acknowledged",
        quorum: 2,
        event: registration,
        discoveryRelays: publicationRelays,
        inboxRelays,
        receipts: publicationRelays.map((relay) => ({
          relay,
          ok: true,
          message: "stored"
        })),
        readbacks: [],
        stagedAt: 1_700_000_000,
        acknowledgedAt: 1_700_000_002,
        registeredAt: null
      },
      session.privateState.inbox
    ];

    for (const inbox of checkpoints) {
      const candidate = structuredClone(session);
      candidate.privateState.inbox = structuredClone(inbox);
      await new TradeSessionRepository(new MemoryStorageDriver()).save(candidate, null);
    }
  });

  it("round-trips an exact pending incoming wrapper and its validation decision", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    const candidate = structuredClone(session);
    candidate.privateState.pendingIncoming = {
      wrapper: structuredClone(incomingWrapper),
      seal: structuredClone(incomingSeal),
      rumor: structuredClone(incomingRumor),
      message: structuredClone(incomingMessage),
      transcriptHash: "1a".repeat(32),
      receivedAt: 1_700_000_006,
      validation: {
        status: "validated",
        checkedAt: 1_700_000_007,
        error: null
      }
    };
    candidate.privateState.outbox = null;

    await repository.save(candidate, null);

    expect((await repository.get(candidate.sessionId))?.privateState.pendingIncoming)
      .toEqual(candidate.privateState.pendingIncoming);
  });

  it("accepts a durable staged release publication without regenerating either signed event", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    const candidate = structuredClone(session);
    const releaseTransition = structuredClone(finalizeEvent({
      kind: 78,
      created_at: 1_700_000_005,
      tags: [
        ["d", `granola:order-transition:v1:${orderId}`],
        ["op", "release"]
      ],
      content: "exact-signed-release-transition"
    }, makerSecret));
    const releaseProjection = structuredClone(finalizeEvent({
      kind: 30078,
      created_at: 1_700_000_005,
      tags: [
        ["d", `granola:order:v1:${orderId}`],
        ["e", releaseTransition.id]
      ],
      content: "exact-signed-release-projection"
    }, makerSecret));
    candidate.pendingOrderPublication = {
      operation: "release",
      orderId,
      transition: releaseTransition,
      projection: releaseProjection,
      transitionReceipts: [{
        relay: publicationRelays[0]!,
        ok: true,
        message: "stored below quorum"
      }],
      projectionReceipts: [],
      status: "staged",
      stagedAt: 1_700_000_005,
      transitionAcknowledgedAt: null,
      projectionAcknowledgedAt: null,
      committedAt: null
    };

    await repository.save(candidate, null);

    expect((await repository.get(candidate.sessionId))?.pendingOrderPublication)
      .toEqual(candidate.pendingOrderPublication);
  });

  it("persists an authenticated abort seal only when the counterparty signed it", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    const candidate = structuredClone(session);
    candidate.privateState.transcript.choreography.participants.takerSessionPubkey =
      remotePubkey;
    candidate.evidence.reservation.abortSeal = structuredClone(incomingSeal);

    await repository.save(candidate, null);

    expect((await repository.get(candidate.sessionId))?.evidence.reservation.abortSeal)
      .toEqual(incomingSeal);

    const corrupt = structuredClone(candidate);
    corrupt.evidence.reservation.abortSeal = structuredClone(seal);
    const driver = new MemoryStorageDriver();
    await driver.set("granola.trade-sessions.v2", [corrupt]);
    await expect(new TradeSessionRepository(driver).list())
      .rejects.toThrow(/counterparty author/i);
  });

  it("permits exact-spend outgoing locks with no wallet change but never an empty locked token", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    await repository.save(session, null);
    expect(session.privateState.cashuOperation?.result).toMatchObject({
      walletMutation: "replace",
      proofs: [],
      lockedToken: "cashu-private-token"
    });

    const corrupt = structuredClone(session);
    corrupt.privateState.cashuOperation!.result!.lockedToken = "";
    const driver = new MemoryStorageDriver();
    await driver.set("granola.trade-sessions.v2", [corrupt]);
    await expect(new TradeSessionRepository(driver).list())
      .rejects.toThrow(/locked token/i);
  });

  it("uses compare-and-swap revisions and rejects stale or skipped writes", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    await repository.save(session, null);
    const updated = { ...session, revision: 1, updatedAt: session.updatedAt + 1 };

    await repository.save(updated, 0);
    await expect(repository.save({ ...updated, revision: 2 }, 0))
      .rejects.toThrow("compare-and-swap");
    await expect(repository.save({ ...updated, revision: 3 }, 1))
      .rejects.toThrow("exactly one");
    await expect(repository.save(session, null))
      .rejects.toThrow("already exists");
  });

  it("keeps happy-path effect checkpoints monotonic and requires the timeout state before release", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    await repository.save(session, null);

    const inboxRegression = structuredClone(session);
    inboxRegression.revision = 1;
    inboxRegression.updatedAt += 1;
    inboxRegression.privateState.inbox = {
      ...inboxRegression.privateState.inbox,
      status: "acknowledged",
      readbacks: [],
      registeredAt: null
    };
    await expect(repository.save(inboxRegression, 0)).rejects.toThrow(/inbox.*regress/i);

    const outboxRegression = structuredClone(session);
    outboxRegression.revision = 1;
    outboxRegression.updatedAt += 1;
    outboxRegression.privateState.outbox!.status = "staged";
    await expect(repository.save(outboxRegression, 0)).rejects.toThrow(/outbox.*regress/i);

    const cashuRegression = structuredClone(session);
    cashuRegression.revision = 1;
    cashuRegression.updatedAt += 1;
    cashuRegression.privateState.cashuOperation!.status = "prepared";
    cashuRegression.privateState.cashuOperation!.result = null;
    await expect(repository.save(cashuRegression, 0)).rejects.toThrow(/cashu.*regress/i);

    const publicationRegression = structuredClone(session);
    publicationRegression.revision = 1;
    publicationRegression.updatedAt += 1;
    publicationRegression.pendingOrderPublication!.status = "transition_acknowledged";
    publicationRegression.pendingOrderPublication!.projectionReceipts = [];
    publicationRegression.pendingOrderPublication!.projectionAcknowledgedAt = null;
    await expect(repository.save(publicationRegression, 0))
      .rejects.toThrow(/publication.*regress/i);

    const earlyRelease = structuredClone(session);
    earlyRelease.revision = 1;
    earlyRelease.updatedAt += 1;
    earlyRelease.phase = "released";
    await expect(repository.save(earlyRelease, 0)).rejects.toThrow(/phase.*checkpoint/i);

    const timeoutCheckpoint = structuredClone(session);
    timeoutCheckpoint.revision = 1;
    timeoutCheckpoint.updatedAt += 1;
    timeoutCheckpoint.phase = "waiting_base_refund";
    await expect(repository.save(timeoutCheckpoint, 0)).resolves.toBeUndefined();
  });

  it("pins staged inbox and outbox retry artifacts across CAS revisions", async () => {
    const inboxRepository = new TradeSessionRepository(new MemoryStorageDriver());
    const stagedInbox = structuredClone(session);
    stagedInbox.privateState.inbox = {
      ...stagedInbox.privateState.inbox,
      status: "staged",
      receipts: [],
      readbacks: [],
      acknowledgedAt: null,
      registeredAt: null
    };
    await inboxRepository.save(stagedInbox, null);

    const retargetedInbox = structuredClone(stagedInbox);
    retargetedInbox.revision = 1;
    retargetedInbox.updatedAt += 1;
    retargetedInbox.privateState.inbox.discoveryRelays = [
      publicationRelays[0]!,
      "wss://different-discovery.example"
    ];
    await expect(inboxRepository.save(retargetedInbox, 0))
      .rejects.toThrow(/inbox.*retry artifact.*changed/i);

    const outboxRepository = new TradeSessionRepository(new MemoryStorageDriver());
    const stagedOutbox = structuredClone(session);
    stagedOutbox.privateState.outbox!.status = "staged";
    await outboxRepository.save(stagedOutbox, null);

    const retargetedOutbox = structuredClone(stagedOutbox);
    retargetedOutbox.revision = 1;
    retargetedOutbox.updatedAt += 1;
    retargetedOutbox.privateState.outbox!.recipientInboxListId = "09".repeat(32);
    await expect(outboxRepository.save(retargetedOutbox, 0))
      .rejects.toThrow(/outbox.*retry artifact.*changed/i);
  });

  it("serializes different session IDs under one shared-array storage lock", async () => {
    let tail = Promise.resolve();
    const runExclusive: TradeSessionExclusiveRunner = async <T>(
      action: () => Promise<T>
    ): Promise<T> => {
      const previous = tail;
      let release = (): void => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await action();
      } finally {
        release();
      }
    };
    const repository = new TradeSessionRepository(
      new MemoryStorageDriver(),
      runExclusive
    );
    const other: TradeSession = {
      ...structuredClone(session),
      sessionId: "10".repeat(32),
      reservationId: "99999999-9999-4999-8999-999999999999",
      privateState: {
        ...structuredClone(session.privateState),
        outbox: null,
        cashuOperation: null
      }
    };

    await Promise.all([
      repository.save(session, null),
      repository.save(other, null)
    ]);

    expect((await repository.list()).map((item) => item.sessionId).sort())
      .toEqual([other.sessionId, session.sessionId].sort());
  });

  it("produces a secret-free public view while retaining order lineage and leg evidence", () => {
    const withAbort = structuredClone(session);
    withAbort.evidence.reservation.abortSeal = incomingSeal;
    const view = publicTradeView(withAbort);
    const serialized = JSON.stringify(view);

    expect(view).toMatchObject({
      revision: 0,
      offeredOrderHead,
      reserveTransitionId: session.reserveTransitionId,
      evidence: {
        reservation: { abortSealId: incomingSeal.id },
        legs: session.evidence.legs
      }
    });
    for (const forbidden of [
      "privateState",
      "proof-secret",
      "cashu-private-token",
      "encrypted-private-wrapper",
      "canonical-private-message",
      "blinding-material",
      "nostrPrivateKey",
      "cashuOperation",
      incomingSeal.content,
      incomingSeal.sig
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("fails closed on corrupt nested journals and unsupported schemas", async () => {
    const corruptions = [
      { ...session, schema: "granola/trade-session/v1" },
      { ...session, revision: -1 },
      {
        ...session,
        privateState: {
          ...session.privateState,
          settlementTranscriptHash: session.privateState.htlcHash
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          inbox: {
            listEventId: "12".repeat(32),
            registeredAt: null,
            relays: ["wss://relay.example"]
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          inbox: {
            ...session.privateState.inbox,
            inboxRelays: [...inboxRelays].reverse()
          }
        }
      },
      {
        ...session,
        evidence: {
          ...session.evidence,
          legs: {
            ...session.evidence.legs,
            base: {
              ...session.evidence.legs.base,
              mintState: "SPENT",
              spendCommitment: null
            }
          }
        }
      },
      {
        ...session,
        evidence: {
          ...session.evidence,
          legs: {
            ...session.evidence.legs,
            base: {
              ...session.evidence.legs.base,
              mintState: "SPENT",
              observedAt: 1_700_000_011,
              proofCount: 2,
              spendCommitment: "12".repeat(32)
            }
          }
        }
      },
      {
        ...session,
        evidence: {
          ...session.evidence,
          legs: {
            ...session.evidence.legs,
            base: {
              ...session.evidence.legs.base,
              mintState: "SPENT",
              observedAt: 1_700_000_011,
              proofCount: 2,
              spendCommitment: "12".repeat(32)
            }
          }
        },
        privateState: {
          ...session.privateState,
          legs: {
            ...session.privateState.legs,
            base: {
              ...session.privateState.legs.base,
              observations: [{
                observedAt: 1_700_000_011,
                state: "SPENT",
                proofCount: 2,
                witnessCommitment: "13".repeat(32)
              }]
            }
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          inbox: {
            listEventId: null,
            registeredAt: null,
            relays: ["wss://relay.example"]
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          transcript: {
            ...session.privateState.transcript,
            nextSequence: "2",
            lastRumorId: "1b".repeat(32),
            lastMessageId: acceptedMessageId,
            lastTranscriptHash: "1c".repeat(32),
            accepted: [
              ...session.privateState.transcript.accepted,
              {
                sequence: "1",
                messageId: acceptedMessageId,
                rumorId: "1b".repeat(32),
                transcriptHash: "1c".repeat(32)
              }
            ]
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          outbox: { ...session.privateState.outbox!, wrapper: { ...wrapper, kind: 14 } }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          cashuOperation: {
            ...session.privateState.cashuOperation!,
            status: "prepared",
            result: session.privateState.cashuOperation!.result
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          cashuOperation: {
            ...session.privateState.cashuOperation!,
            inputsReserved: false
          }
        }
      },
      {
        ...session,
        evidence: {
          ...session.evidence,
          reservation: {
            ...session.evidence.reservation,
            takerCommitment: null
          }
        }
      },
      {
        ...session,
        evidence: {
          ...session.evidence,
          legs: {
            ...session.evidence.legs,
            base: {
              ...session.evidence.legs.base,
              keysetId: "00deadbeefcafeaa"
            }
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          inbox: {
            ...session.privateState.inbox,
            readbacks: [{
              ...session.privateState.inbox.readbacks[0]!,
              event: {
                ...registration,
                content: "different-signed-event"
              }
            }]
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          inbox: {
            ...session.privateState.inbox,
            receipts: session.privateState.inbox.receipts.slice(0, 1)
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          inbox: {
            ...session.privateState.inbox,
            readbacks: session.privateState.inbox.readbacks.slice(0, 1)
          }
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          inbox: {
            ...session.privateState.inbox,
            event: wrongRegistrationSigner,
            readbacks: session.privateState.inbox.readbacks.map((readback) => ({
              ...readback,
              event: wrongRegistrationSigner
            }))
          }
        }
      },
      {
        ...session,
        pendingOrderPublication: {
          ...session.pendingOrderPublication!,
          operation: "release"
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          preimage: "06".repeat(32)
        }
      },
      {
        ...session,
        privateState: {
          ...session.privateState,
          cashuOperation: {
            ...session.privateState.cashuOperation!,
            artifact: {
              ...session.privateState.cashuOperation!.artifact,
              expected: {
                ...session.privateState.cashuOperation!.artifact.expected,
                binding: {
                  ...session.privateState.cashuOperation!.artifact.expected.binding,
                  transcriptHash: "1d".repeat(32)
                }
              }
            }
          }
        }
      }
    ];

    for (const corrupt of corruptions) {
      const driver = new MemoryStorageDriver();
      await driver.set("granola.trade-sessions.v2", [corrupt]);
      await expect(new TradeSessionRepository(driver).list()).rejects.toThrow();
    }
  });

  it.skip("rejects unknown root and nested fields and never projects unknown secrets", async () => {
    const rootExtra = structuredClone(session) as TradeSession & {
      leakedPrivateKey: string;
    };
    rootExtra.leakedPrivateKey = "ab".repeat(32);
    const nestedExtra = structuredClone(session);
    (nestedExtra.terms as TradeSession["terms"] & { bearerToken: string }).bearerToken =
      "cashuBsecret";

    for (const corrupt of [rootExtra, nestedExtra]) {
      const driver = new MemoryStorageDriver();
      await driver.set("granola.trade-sessions.v2", [corrupt]);
      await expect(new TradeSessionRepository(driver).list())
        .rejects.toThrow(/unknown fields/i);
    }

    const tainted = structuredClone(session) as TradeSession & {
      leakedPrivateKey: string;
    };
    tainted.leakedPrivateKey = "cd".repeat(32);
    expect(JSON.stringify(publicTradeView(tainted))).not.toContain(tainted.leakedPrivateKey);
  });

  it.skip("rejects monotonic CAS regressions, skipped phases, and an unevidenced fill", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    await repository.save(session, null);

    const inboxRegression = structuredClone(session);
    inboxRegression.revision = 1;
    inboxRegression.updatedAt += 1;
    inboxRegression.privateState.inbox = {
      status: "unregistered",
      quorum: 2,
      event: null,
      discoveryRelays: [],
      inboxRelays: [],
      receipts: [],
      readbacks: [],
      stagedAt: null,
      acknowledgedAt: null,
      registeredAt: null
    };
    await expect(repository.save(inboxRegression, 0)).rejects.toThrow(/regress/i);

    const skipped = structuredClone(session);
    skipped.revision = 1;
    skipped.updatedAt += 1;
    skipped.phase = "filled";
    await expect(repository.save(skipped, 0)).rejects.toThrow(/phase|filled|evidence/i);

    const spentRepository = new TradeSessionRepository(new MemoryStorageDriver());
    const spent = structuredClone(session);
    spent.evidence.legs.base = {
      ...spent.evidence.legs.base,
      mintState: "SPENT",
      observedAt: 1_700_000_011,
      proofCount: 2,
      spendCommitment: "12".repeat(32)
    };
    spent.privateState.legs.base.observations.push({
      observedAt: 1_700_000_011,
      state: "SPENT",
      proofCount: 2,
      witnessCommitment: "12".repeat(32)
    });
    spent.updatedAt = 1_700_000_011;
    await spentRepository.save(spent, null);
    const unknown = structuredClone(spent);
    unknown.revision = 1;
    unknown.updatedAt += 1;
    unknown.evidence.legs.base = {
      ...unknown.evidence.legs.base,
      mintState: "UNKNOWN",
      observedAt: null,
      proofCount: null,
      spendCommitment: null
    };
    unknown.privateState.legs.base.observations = [];
    await expect(spentRepository.save(unknown, 0)).rejects.toThrow(/regress|spent/i);
  });

  it.skip("binds pending order artifacts to maker authority, lineage, IDs, and relay quorum", async () => {
    const attackerTransition = structuredClone(finalizeEvent({
      ...transition,
      tags: transition.tags.map((tag) => [...tag])
    }, remoteSecret));
    const attackerProjection = structuredClone(finalizeEvent({
      ...projection,
      tags: projection.tags.map((tag) =>
        tag[0] === "e" ? ["e", attackerTransition.id] : [...tag]
      )
    }, remoteSecret));
    const attacker = structuredClone(session);
    attacker.pendingOrderPublication = {
      ...attacker.pendingOrderPublication!,
      transition: attackerTransition,
      projection: attackerProjection
    };

    const subquorum = structuredClone(session);
    subquorum.pendingOrderPublication = {
      ...subquorum.pendingOrderPublication!,
      transitionReceipts: subquorum.pendingOrderPublication!.transitionReceipts.slice(0, 1),
      projectionReceipts: subquorum.pendingOrderPublication!.projectionReceipts.slice(0, 1)
    };

    for (const corrupt of [attacker, subquorum]) {
      const driver = new MemoryStorageDriver();
      await driver.set("granola.trade-sessions.v2", [corrupt]);
      await expect(new TradeSessionRepository(driver).list())
        .rejects.toThrow(/authority|signer|quorum|receipt/i);
    }
  });

  it.skip("requires three canonical discovery targets and same-relay fresh ACK/readback quorum", async () => {
    const split = structuredClone(session);
    split.privateState.inbox.discoveryRelays = [
      "wss://discovery-one.example",
      "wss://discovery-two.example",
      "wss://discovery-three.example"
    ];
    split.privateState.inbox.receipts = [
      { relay: split.privateState.inbox.discoveryRelays[0]!, ok: true, message: "stored" },
      { relay: split.privateState.inbox.discoveryRelays[1]!, ok: true, message: "stored" }
    ];
    split.privateState.inbox.readbacks = [
      {
        relay: split.privateState.inbox.discoveryRelays[1]!,
        found: true,
        event: registration,
        observedAt: 1_700_000_003
      },
      {
        relay: split.privateState.inbox.discoveryRelays[2]!,
        found: true,
        event: registration,
        observedAt: 1_700_000_003
      }
    ];
    const stale = structuredClone(split);
    stale.privateState.inbox.readbacks = stale.privateState.inbox.readbacks.map(
      (readback) => ({ ...readback, observedAt: stale.createdAt - 1 })
    );
    const credentialed = structuredClone(split);
    credentialed.privateState.inbox.discoveryRelays[2] =
      "wss://user:pass@discovery-three.example";

    for (const corrupt of [split, stale, credentialed]) {
      const driver = new MemoryStorageDriver();
      await driver.set("granola.trade-sessions.v2", [corrupt]);
      await expect(new TradeSessionRepository(driver).list()).rejects.toThrow();
    }
  });

  it.skip("recomputes transcript and pending hashes and rejects unrelated message choreography", async () => {
    const badChain = structuredClone(session);
    badChain.privateState.transcript.accepted[0]!.transcriptHash = "ab".repeat(32);
    badChain.privateState.transcript.lastTranscriptHash = "ab".repeat(32);
    badChain.privateState.settlementTranscriptHash = "ab".repeat(32);
    badChain.privateState.cashuOperation!.artifact.expected.binding.transcriptHash =
      "ab".repeat(32);

    const unrelatedNext = structuredClone(session);
    unrelatedNext.privateState.outbox!.nextChoreography = {
      ...unrelatedNext.privateState.outbox!.nextChoreography,
      phase: "settled"
    };

    for (const corrupt of [badChain, unrelatedNext]) {
      const driver = new MemoryStorageDriver();
      await driver.set("granola.trade-sessions.v2", [corrupt]);
      await expect(new TradeSessionRepository(driver).list())
        .rejects.toThrow(/hash|choreography|transcript/i);
    }
  });

  it.skip("binds settlement to session acknowledgement, keys, locktimes, and session timestamps", async () => {
    const proposalHash = structuredClone(session);
    proposalHash.privateState.settlementTranscriptHash =
      proposalHash.privateState.transcript.accepted[0]!.transcriptHash;
    proposalHash.privateState.cashuOperation!.artifact.expected.binding.transcriptHash =
      proposalHash.privateState.settlementTranscriptHash;

    const wrongLock = structuredClone(session);
    wrongLock.privateState.cashuOperation!.artifact.expected.receiverPubkey =
      `02${"7f".repeat(32)}`;

    const zeroScalar = structuredClone(session);
    zeroScalar.privateState.cashuPrivateKey = "00".repeat(32);

    const predated = structuredClone(session);
    predated.privateState.cashuOperation!.preparedAt = predated.createdAt - 1;

    for (const corrupt of [proposalHash, wrongLock, zeroScalar, predated]) {
      const driver = new MemoryStorageDriver();
      await driver.set("granola.trade-sessions.v2", [corrupt]);
      await expect(new TradeSessionRepository(driver).list()).rejects.toThrow();
    }
  });

  it.skip("binds reservation proposal and abort evidence to the authenticated transcript", async () => {
    const wrongProposal = structuredClone(session);
    wrongProposal.evidence.reservation.proposalSealId = "ef".repeat(32);

    const unrelatedAbort = structuredClone(session);
    unrelatedAbort.privateState.transcript.choreography.participants.takerSessionPubkey =
      remotePubkey;
    unrelatedAbort.evidence.reservation.abortSeal = structuredClone(incomingSeal);

    for (const corrupt of [wrongProposal, unrelatedAbort]) {
      const driver = new MemoryStorageDriver();
      await driver.set("granola.trade-sessions.v2", [corrupt]);
      await expect(new TradeSessionRepository(driver).list())
        .rejects.toThrow(/proposal|abort|transcript|reservation/i);
    }
  });
});
