import { describe, expect, it } from "vitest";

import { publicTradeView, type TradeSession } from "../trade/session.js";
import { MemoryStorageDriver } from "./wallet-repository.js";
import {
  TradeSessionRepository,
  type TradeSessionExclusiveRunner
} from "./trade-session.js";

const maker = "22".repeat(32);
const sessionId = "11".repeat(32);
const reservationId = "11111111-1111-4111-8111-111111111111";
const messageId = "33333333-3333-4333-8333-333333333333";
const orderId = "22222222-2222-4222-8222-222222222222";
const offeredOrderHead = "33".repeat(32);
const operationId = "44444444-4444-4444-8444-444444444444";
const wrapper = {
  kind: 1059,
  created_at: 1_700_000_000,
  tags: [["p", "55".repeat(32)], ["expiration", "1700007200"]],
  content: "encrypted-private-wrapper",
  id: "66".repeat(32),
  pubkey: "77".repeat(32),
  sig: "88".repeat(64)
};
const seal = {
  ...wrapper,
  kind: 13,
  tags: [],
  content: "encrypted-private-seal",
  id: "99".repeat(32),
  pubkey: maker
};
const rumor = {
  id: "aa".repeat(32),
  pubkey: maker,
  created_at: 1_700_000_000,
  kind: 14 as const,
  tags: [["p", "55".repeat(32)]],
  content: "canonical-private-message"
};

const session: TradeSession = {
  schema: "granola/trade-session/v2",
  revision: 0,
  sessionId,
  reservationId,
  role: "maker",
  phase: "base_locked",
  orderAddress: `30078:${maker}:granola:order:v1:${orderId}`,
  offeredOrderHead,
  reserveTransitionId: "bb".repeat(32),
  fillTransitionId: null,
  pendingOrderPublication: {
    operation: "reserve",
    stage: "projection",
    orderId,
    transitionId: "bb".repeat(32),
    projectionId: "cc".repeat(32)
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
    commitments: ["dd".repeat(32)],
    mintStates: ["base:UNSPENT"],
    reserveTransitionId: "bb".repeat(32),
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
    nostrPrivateKey: "01".repeat(32),
    cashuPrivateKey: "02".repeat(32),
    refundPrivateKey: "03".repeat(32),
    preimage: "04".repeat(32),
    transcript: {
      choreography: {
        phase: "awaiting_base_lock_ack",
        participants: { makerOrderPubkey: maker },
        refundedLegs: []
      },
      nextSequence: "4",
      lastRumorId: rumor.id,
      lastMessageId: messageId,
      lastTranscriptHash: "05".repeat(32),
      acceptedRumorIds: [rumor.id],
      acceptedMessageIds: [messageId]
    },
    outbox: {
      message: {
        schema: "granola/dm/v1",
        deployment: "cashu-testnet-v1",
        type: "base_lock",
        message_id: messageId,
        session_id: sessionId,
        reservation_id: reservationId,
        order_address: `30078:${maker}:granola:order:v1:${orderId}`,
        order_head: "bb".repeat(32),
        maker_order_pubkey: maker,
        author_pubkey: maker,
        recipient_pubkey: "55".repeat(32),
        sequence: "3",
        previous_message_id: "55555555-5555-4555-8555-555555555555",
        previous_transcript_hash: "06".repeat(32),
        sent_at: 1_700_000_000,
        expires_at: 1_700_003_600,
        terms_hash: "07".repeat(32),
        body: { cashu_token: "cashu-private-token" }
      },
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
      status: "staged"
    },
    cashuOperation: {
      operationId,
      leg: "base",
      kind: "outgoing-lock",
      status: "completed",
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
            transcriptHash: "09".repeat(32)
          },
          amount: "20",
          hash: "0a".repeat(32),
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
        proofs: [{
          amount: "3",
          id: "00deadbeefcafeee",
          secret: "change-proof-secret",
          C: "change-proof-signature"
        }],
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
      reservationId: "99999999-9999-4999-8999-999999999999"
    };

    await Promise.all([
      repository.save(session, null),
      repository.save(other, null)
    ]);

    expect((await repository.list()).map((item) => item.sessionId).sort())
      .toEqual([other.sessionId, session.sessionId].sort());
  });

  it("produces a secret-free public view while retaining order lineage and leg evidence", () => {
    const view = publicTradeView(session);
    const serialized = JSON.stringify(view);

    expect(view).toMatchObject({
      revision: 0,
      offeredOrderHead,
      reserveTransitionId: session.reserveTransitionId,
      evidence: { legs: session.evidence.legs }
    });
    for (const forbidden of [
      "privateState",
      "proof-secret",
      "cashu-private-token",
      "encrypted-private-wrapper",
      "canonical-private-message",
      "blinding-material",
      "nostrPrivateKey",
      "cashuOperation"
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
          transcript: {
            ...session.privateState.transcript,
            acceptedRumorIds: [rumor.id, rumor.id]
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
      }
    ];

    for (const corrupt of corruptions) {
      const driver = new MemoryStorageDriver();
      await driver.set("granola.trade-sessions.v2", [corrupt]);
      await expect(new TradeSessionRepository(driver).list()).rejects.toThrow();
    }
  });
});
