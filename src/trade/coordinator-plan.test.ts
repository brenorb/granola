import { describe, expect, it } from "vitest";

import type { TradeSession } from "./session.js";
import { nextCoordinatorAction } from "./coordinator-plan.js";

function session(
  role: "maker" | "taker",
  choreographyPhase: TradeSession["privateState"]["transcript"]["choreography"]["phase"]
): TradeSession {
  return {
    schema: "granola/trade-session/v2",
    revision: 0,
    sessionId: "11".repeat(32),
    reservationId: "11111111-1111-4111-8111-111111111111",
    role,
    phase: "negotiating",
    orderAddress: `30078:${"22".repeat(32)}:granola:order:v2:22222222-2222-4222-8222-222222222222`,
    offeredOrderHead: "33".repeat(32),
    reserveTransitionId: null,
    fillTransitionId: null,
    pendingOrderPublication: null,
    createdAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    terms: {
      baseMint: "https://testnut.cashu.space",
      baseUnit: "sat",
      baseKeyset: "00deadbeefcafeee",
      baseAmount: "20",
      quoteMint: "https://nofee.testnut.cashu.space",
      quoteUnit: "usd",
      quoteKeyset: "00deadbeefcafeff",
      quoteAmount: "1",
      priceCentsPerBtc: "5000000"
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
      makerPubkey: "22".repeat(32),
      commitments: [],
      mintStates: [],
      reserveTransitionId: null,
      fillTransitionId: null,
      reservation: {
        proposalSealId: null,
        takerCommitment: null,
        abortSeal: null
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
    },
    privateState: {
      nostrPrivateKey: "01".repeat(32),
      cashuPrivateKey: "02".repeat(32),
      refundPrivateKey: "03".repeat(32),
      preimage: role === "maker" ? "04".repeat(32) : null,
      htlcHash: role === "maker" ? "05".repeat(32) : null,
      settlementTranscriptHash: null,
      inbox: {
        status: "registered",
        quorum: 2,
        event: {
          kind: 10050,
          created_at: 1_800_000_000,
          tags: [["relay", "wss://auth.example"]],
          content: "",
          id: "06".repeat(32),
          pubkey: "07".repeat(32),
          sig: "08".repeat(64)
        },
        discoveryRelays: ["wss://auth.example", "wss://auth-two.example"],
        inboxRelays: ["wss://auth.example"],
        receipts: [
          { relay: "wss://auth.example", ok: true, message: "stored" },
          { relay: "wss://auth-two.example", ok: true, message: "stored" }
        ],
        readbacks: [{
          relay: "wss://auth.example",
          found: true,
          event: {
            kind: 10050,
            created_at: 1_800_000_000,
            tags: [["relay", "wss://auth.example"]],
            content: "",
            id: "06".repeat(32),
            pubkey: "07".repeat(32),
            sig: "08".repeat(64)
          },
          observedAt: 1_800_000_001
        }, {
          relay: "wss://auth-two.example",
          found: true,
          event: {
            kind: 10050,
            created_at: 1_800_000_000,
            tags: [["relay", "wss://auth.example"]],
            content: "",
            id: "06".repeat(32),
            pubkey: "07".repeat(32),
            sig: "08".repeat(64)
          },
          observedAt: 1_800_000_001
        }],
        stagedAt: 1_800_000_000,
        acknowledgedAt: 1_800_000_001,
        registeredAt: 1_800_000_001
      },
      pendingIncoming: null,
      transcript: {
        choreography: {
          phase: choreographyPhase,
          participants: { makerOrderPubkey: "22".repeat(32) },
          refundedLegs: []
        },
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
  };
}

function markSpent(
  current: TradeSession,
  leg: "base" | "quote",
  observedAt = 1_800_000_100
): void {
  current.evidence.legs[leg].mintState = "SPENT";
  current.evidence.legs[leg].observedAt = observedAt;
  current.evidence.legs[leg].proofCount = 1;
  current.evidence.legs[leg].spendCommitment = "aa".repeat(32);
  current.privateState.legs[leg].observations.push({
    observedAt,
    state: "SPENT",
    proofCount: 1,
    witnessCommitment: current.evidence.legs[leg].spendCommitment
  });
}

function markPostExpiryUnspent(
  current: TradeSession,
  leg: "base" | "quote",
  observedAt: number
): void {
  current.evidence.legs[leg].mintState = "UNSPENT";
  current.evidence.legs[leg].observedAt = observedAt;
  current.evidence.legs[leg].proofCount = 1;
  current.privateState.legs[leg].observations.push({
    observedAt,
    state: "UNSPENT",
    proofCount: 1,
    witnessCommitment: null
  });
}

function setCommittedPublication(
  current: TradeSession,
  operation: "reserve" | "fill" | "release",
  transitionId: string
): void {
  current.pendingOrderPublication = {
    operation,
    status: "committed",
    transition: { id: transitionId }
  } as TradeSession["pendingOrderPublication"];
  if (operation === "reserve") {
    current.reserveTransitionId = transitionId;
    current.evidence.reserveTransitionId = transitionId;
  } else if (operation === "fill") {
    current.fillTransitionId = transitionId;
    current.evidence.fillTransitionId = transitionId;
  } else {
    current.phase = "released";
  }
}

function markLockReady(current: TradeSession, leg: "base" | "quote"): void {
  const evidence = current.evidence.legs[leg];
  const privateLeg = current.privateState.legs[leg];
  const locktime = leg === "base"
    ? current.plan.longLocktime
    : current.plan.shortLocktime;
  current.privateState.htlcHash ??= "05".repeat(32);
  current.privateState.settlementTranscriptHash ??= "09".repeat(32);
  evidence.tokenCommitment = (leg === "base" ? "44" : "55").repeat(32);
  evidence.validationCommitment = (leg === "base" ? "66" : "77").repeat(32);
  privateLeg.token = leg === "base" ? "cashuBbase" : "cashuBquote";
  privateLeg.expected = {
    mintUrl: leg === "base" ? current.terms.baseMint : current.terms.quoteMint,
    unit: leg === "base" ? current.terms.baseUnit : current.terms.quoteUnit,
    amount: leg === "base" ? current.terms.baseAmount : current.terms.quoteAmount,
    hash: current.privateState.htlcHash,
    locktime,
    leg,
    binding: {
      sessionId: current.sessionId,
      reservationId: current.reservationId,
      transcriptHash: current.privateState.settlementTranscriptHash
    }
  } as NonNullable<typeof privateLeg.expected>;
}

function setWalletAppliedRefund(
  current: TradeSession,
  leg: "base" | "quote",
  status: "completed" | "wallet_applied"
): void {
  const expected = current.privateState.legs[leg].expected;
  if (expected === null) throw new Error("Test refund requires a prepared lock");
  const commitment = "aa".repeat(32);
  current.evidence.legs[leg].refundOperationCommitment = commitment;
  current.privateState.cashuOperation = {
    operationId: "33333333-3333-4333-8333-333333333333",
    leg,
    kind: "refund",
    status,
    preparedAt: current.updatedAt,
    inputsReserved: true,
    artifact: {
      version: 1,
      kind: "refund",
      mintUrl: expected.mintUrl,
      unit: expected.unit,
      preview: {},
      spentSecrets: ["refund-input"],
      expected,
      operationCommitment: commitment
    },
    result: {
      walletMutation: "receive",
      mintUrl: expected.mintUrl,
      unit: expected.unit,
      proofs: [{
        amount: "20",
        id: current.evidence.legs[leg].keysetId,
        secret: "refund-output",
        C: "02".repeat(33)
      }],
      lockedToken: null,
      amount: leg === "base" ? current.terms.baseAmount : current.terms.quoteAmount,
      proofCount: 1
    }
  } as TradeSession["privateState"]["cashuOperation"];
}

describe("atomic swap coordinator action planning", () => {
  it("retries durable effects before planning any new protocol action", () => {
    const current = session("maker", "awaiting_base_lock");
    current.pendingOrderPublication = {
      operation: "reserve",
      status: "staged"
    } as TradeSession["pendingOrderPublication"];
    expect(nextCoordinatorAction(current, 1_800_000_100)).toEqual({
      kind: "publish_order_transition"
    });
    current.pendingOrderPublication!.status = "transition_acknowledged";
    expect(nextCoordinatorAction(current, 1_800_000_100)).toEqual({
      kind: "publish_order_projection"
    });
    current.pendingOrderPublication!.status = "projection_acknowledged";
    expect(nextCoordinatorAction(current, 1_800_000_100)).toEqual({
      kind: "commit_order_publication"
    });
    current.pendingOrderPublication!.status = "committed";
    expect(nextCoordinatorAction(current, 1_800_000_100)).toEqual({
      kind: "clear_order_publication"
    });

    current.pendingOrderPublication = null;
    current.privateState.outbox = {
      status: "staged",
      message: {
        type: "claim_notice",
        expires_at: 1_800_000_300
      }
    } as TradeSession["privateState"]["outbox"];
    expect(nextCoordinatorAction(current, 1_800_000_100)).toEqual({
      kind: "deliver_outbox"
    });
    current.privateState.outbox!.status = "acknowledged";
    expect(nextCoordinatorAction(current, 1_800_000_100)).toEqual({
      kind: "commit_outbox"
    });
  });

  it("executes, reconciles, then clears one durable Cashu operation", () => {
    const current = session("maker", "awaiting_base_lock");
    current.privateState.cashuOperation = {
      status: "prepared",
      inputsReserved: false
    } as
      TradeSession["privateState"]["cashuOperation"];
    expect(nextCoordinatorAction(current, 1_800_000_100).kind)
      .toBe("reserve_cashu_inputs");
    current.privateState.cashuOperation!.inputsReserved = true;
    expect(nextCoordinatorAction(current, 1_800_000_100).kind)
      .toBe("execute_cashu_operation");
    current.privateState.cashuOperation!.status = "completed";
    expect(nextCoordinatorAction(current, 1_800_000_100).kind)
      .toBe("reconcile_wallet");
    current.privateState.cashuOperation!.status = "wallet_applied";
    expect(nextCoordinatorAction(current, 1_800_000_100).kind)
      .toBe("clear_cashu_operation");
  });

  it("registers the exact local inbox before any protocol message", () => {
    const current = session("taker", "awaiting_reserve_propose");
    current.privateState.inbox = {
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
    expect(nextCoordinatorAction(current, 1_800_000_100).kind)
      .toBe("stage_inbox_registration");
    current.privateState.inbox.status = "staged";
    current.privateState.inbox.event = session(
      "taker",
      "awaiting_reserve_propose"
    ).privateState.inbox.event;
    current.privateState.inbox.discoveryRelays = [
      "wss://auth.example",
      "wss://auth-two.example"
    ];
    current.privateState.inbox.inboxRelays = ["wss://auth.example"];
    current.privateState.inbox.stagedAt = 1_800_000_100;
    expect(nextCoordinatorAction(current, 1_800_000_100).kind)
      .toBe("publish_inbox_registration");
    current.privateState.inbox.status = "acknowledged";
    expect(nextCoordinatorAction(current, 1_800_000_100).kind)
      .toBe("verify_inbox_registration");
  });

  it("validates and commits one durable incoming message before new work", () => {
    const current = session("taker", "awaiting_reserve_accept");
    current.privateState.pendingIncoming = {
      validation: { status: "unvalidated", checkedAt: null, error: null }
    } as TradeSession["privateState"]["pendingIncoming"];
    expect(nextCoordinatorAction(current, 1_800_000_100).kind)
      .toBe("validate_incoming");
    current.privateState.pendingIncoming!.validation = {
      status: "validated",
      checkedAt: 1_800_000_100,
      error: null
    };
    expect(nextCoordinatorAction(current, 1_800_000_100).kind)
      .toBe("commit_incoming");
    current.privateState.pendingIncoming!.validation = {
      status: "rejected",
      checkedAt: 1_800_000_100,
      error: "conflicting replay"
    };
    expect(nextCoordinatorAction(current, 1_800_000_100).kind)
      .toBe("enter_recovery");
  });

  it.each([
    ["taker", "awaiting_reserve_propose", "stage_reserve_propose"],
    ["maker", "awaiting_reserve_propose", "poll_inbox"],
    ["maker", "awaiting_reserve_accept", "stage_order_reserve"],
    ["taker", "awaiting_reserve_accept", "poll_inbox"],
    ["maker", "awaiting_session_ack", "poll_inbox"],
    ["taker", "awaiting_session_ack", "stage_session_ack"],
    ["maker", "awaiting_base_lock", "prepare_base_lock"],
    ["taker", "awaiting_base_lock", "poll_inbox"],
    ["maker", "awaiting_base_lock_ack", "poll_inbox"],
    ["taker", "awaiting_base_lock_ack", "stage_base_lock_ack"],
    ["maker", "awaiting_quote_lock", "poll_inbox"],
    ["taker", "awaiting_quote_lock", "prepare_quote_lock"],
    ["maker", "awaiting_quote_lock_ack", "stage_quote_lock_ack"],
    ["taker", "awaiting_quote_lock_ack", "poll_inbox"],
    ["taker", "awaiting_claim_notice", "poll_inbox"],
    ["maker", "awaiting_fill_request", "poll_inbox"],
    ["taker", "awaiting_settlement_ack", "poll_inbox"]
  ] as const)("%s at %s plans %s", (role, phase, action) => {
    expect(nextCoordinatorAction(session(role, phase), 1_800_000_100).kind)
      .toBe(action);
  });

  it("stages each protocol message only after its durable prerequisite exists", () => {
    const reserve = session("maker", "awaiting_reserve_accept");
    reserve.reserveTransitionId = "44".repeat(32);
    reserve.evidence.reserveTransitionId = reserve.reserveTransitionId;
    expect(nextCoordinatorAction(reserve, 1_800_000_100).kind)
      .toBe("enter_recovery");
    setCommittedPublication(reserve, "reserve", reserve.reserveTransitionId);
    expect(nextCoordinatorAction(reserve, 1_800_000_100).kind)
      .toBe("stage_reserve_accept");

    const base = session("maker", "awaiting_base_lock");
    base.privateState.legs.base.token = "cashuBbase";
    expect(nextCoordinatorAction(base, 1_800_000_100).kind)
      .toBe("enter_recovery");
    markLockReady(base, "base");
    expect(nextCoordinatorAction(base, 1_800_000_100).kind)
      .toBe("stage_base_lock");

    const quote = session("taker", "awaiting_quote_lock");
    quote.privateState.legs.quote.token = "cashuBquote";
    expect(nextCoordinatorAction(quote, 1_800_000_100).kind)
      .toBe("enter_recovery");
    markLockReady(quote, "quote");
    expect(nextCoordinatorAction(quote, 1_800_000_100).kind)
      .toBe("stage_quote_lock");
  });

  it("plans claim, observation, fill, and settlement only from mint evidence", () => {
    const makerClaim = session("maker", "awaiting_claim_notice");
    markLockReady(makerClaim, "quote");
    expect(nextCoordinatorAction(makerClaim, 1_800_000_100).kind)
      .toBe("prepare_quote_claim");
    makerClaim.evidence.legs.quote.claimOperationCommitment = "44".repeat(32);
    expect(nextCoordinatorAction(makerClaim, 1_800_000_100).kind)
      .toBe("observe_quote");
    markSpent(makerClaim, "quote");
    expect(nextCoordinatorAction(makerClaim, 1_800_000_100).kind)
      .toBe("stage_claim_notice");

    const takerClaim = session("taker", "awaiting_fill_request");
    takerClaim.privateState.legs.base.token = "cashuBbase";
    takerClaim.privateState.legs.quote.token = "cashuBquote";
    expect(nextCoordinatorAction(takerClaim, 1_800_000_100).kind)
      .toBe("observe_quote");
    markSpent(takerClaim, "quote");
    expect(nextCoordinatorAction(takerClaim, 1_800_000_100).kind)
      .toBe("observe_quote");
    takerClaim.privateState.preimage = "66".repeat(32);
    expect(nextCoordinatorAction(takerClaim, 1_800_000_100).kind)
      .toBe("prepare_base_claim");
    takerClaim.evidence.legs.base.claimOperationCommitment = "77".repeat(32);
    expect(nextCoordinatorAction(takerClaim, 1_800_000_100).kind)
      .toBe("observe_base");
    markSpent(takerClaim, "base");
    expect(nextCoordinatorAction(takerClaim, 1_800_000_100).kind)
      .toBe("stage_fill_request");

    const makerFill = session("maker", "awaiting_settlement_ack");
    makerFill.reserveTransitionId = "88".repeat(32);
    makerFill.privateState.legs.base.token = "cashuBbase";
    makerFill.privateState.legs.quote.token = "cashuBquote";
    expect(nextCoordinatorAction(makerFill, 1_800_000_100).kind).toBe("observe_quote");
    markSpent(makerFill, "quote");
    expect(nextCoordinatorAction(makerFill, 1_800_000_100).kind).toBe("observe_base");
    markSpent(makerFill, "base");
    expect(nextCoordinatorAction(makerFill, 1_800_000_100).kind)
      .toBe("stage_order_fill");
    setCommittedPublication(makerFill, "fill", "99".repeat(32));
    expect(nextCoordinatorAction(makerFill, 1_800_000_100).kind)
      .toBe("stage_settlement_ack");
  });

  it("fails closed at claim cutoffs and plans refunds only after locktime plus guard", () => {
    const maker = session("maker", "awaiting_claim_notice");
    maker.privateState.legs.base.token = "cashuBbase";
    maker.privateState.legs.quote.token = "cashuBquote";
    expect(nextCoordinatorAction(maker, maker.plan.makerClaimCutoff).kind)
      .toBe("enter_recovery");
    expect(nextCoordinatorAction(maker, maker.plan.longLocktime + 59).kind)
      .toBe("enter_recovery");
    expect(nextCoordinatorAction(maker, maker.plan.longLocktime + 60).kind)
      .toBe("observe_base");
    markPostExpiryUnspent(maker, "base", maker.plan.longLocktime + 61);
    expect(nextCoordinatorAction(maker, maker.plan.longLocktime + 61).kind)
      .toBe("prepare_base_refund");

    const taker = session("taker", "awaiting_fill_request");
    taker.privateState.legs.base.token = "cashuBbase";
    taker.privateState.legs.quote.token = "cashuBquote";
    markSpent(taker, "quote", taker.plan.takerClaimCutoff);
    expect(nextCoordinatorAction(taker, taker.plan.takerClaimCutoff).kind)
      .toBe("enter_recovery");
    taker.privateState.legs.quote.observations = [];
    taker.evidence.legs.quote.mintState = "UNKNOWN";
    expect(nextCoordinatorAction(taker, taker.plan.shortLocktime + 60).kind)
      .toBe("observe_quote");
    markPostExpiryUnspent(taker, "quote", taker.plan.shortLocktime + 61);
    expect(nextCoordinatorAction(taker, taker.plan.shortLocktime + 61).kind)
      .toBe("prepare_quote_refund");
  });

  it("requires independently persisted spent observations for settlement", () => {
    const inconsistent = session("maker", "settled");
    expect(nextCoordinatorAction(inconsistent, 1_800_000_100))
      .toEqual({ kind: "enter_recovery" });

    markSpent(inconsistent, "base");
    markSpent(inconsistent, "quote");
    expect(nextCoordinatorAction(inconsistent, 1_800_000_100))
      .toEqual({ kind: "enter_recovery" });
    setCommittedPublication(inconsistent, "fill", "99".repeat(32));
    expect(nextCoordinatorAction(inconsistent, 1_800_000_100))
      .toEqual({ kind: "none" });
  });

  it("continues to the private settlement acknowledgement after public fill", () => {
    const current = session("maker", "awaiting_settlement_ack");
    current.phase = "filled";
    current.fillTransitionId = "99".repeat(32);
    current.evidence.fillTransitionId = current.fillTransitionId;
    markSpent(current, "base");
    markSpent(current, "quote");
    expect(nextCoordinatorAction(current, 1_800_000_100).kind)
      .toBe("enter_recovery");
    setCommittedPublication(current, "fill", current.fillTransitionId);
    expect(nextCoordinatorAction(current, 1_800_000_100).kind)
      .toBe("stage_settlement_ack");
  });

  it("does not initiate a prepared effect or private delivery after its cutoff", () => {
    const prepared = session("maker", "awaiting_claim_notice");
    prepared.privateState.cashuOperation = {
      status: "prepared",
      leg: "quote",
      kind: "claim",
      inputsReserved: true
    } as TradeSession["privateState"]["cashuOperation"];
    expect(nextCoordinatorAction(prepared, prepared.plan.makerClaimCutoff).kind)
      .toBe("enter_recovery");
    prepared.privateState.cashuOperation!.inputsReserved = false;
    expect(nextCoordinatorAction(prepared, prepared.plan.makerClaimCutoff).kind)
      .toBe("enter_recovery");
    prepared.privateState.cashuOperation!.status = "completed";
    expect(nextCoordinatorAction(prepared, prepared.plan.makerClaimCutoff).kind)
      .toBe("reconcile_wallet");

    const staged = session("maker", "awaiting_base_lock_ack");
    staged.privateState.outbox = {
      status: "staged",
      message: { type: "base_lock" }
    } as TradeSession["privateState"]["outbox"];
    expect(nextCoordinatorAction(staged, staged.plan.makerClaimCutoff).kind)
      .toBe("enter_recovery");
  });

  it("does not start settlement after its safe deadline", () => {
    const expired = session("taker", "awaiting_reserve_propose");
    expect(nextCoordinatorAction(expired, expired.plan.reservationExpiresAt).kind)
      .toBe("enter_recovery");

    const lateQuote = session("taker", "awaiting_quote_lock");
    markLockReady(lateQuote, "quote");
    expect(nextCoordinatorAction(lateQuote, lateQuote.plan.makerClaimCutoff).kind)
      .toBe("enter_recovery");
  });

  it("releases after a completed and wallet-reconciled refund without claim witness evidence", () => {
    const current = session("maker", "refunding");
    setCommittedPublication(current, "reserve", "88".repeat(32));
    markLockReady(current, "base");
    const eligible = current.plan.longLocktime + current.plan.refundGuardSeconds;
    markPostExpiryUnspent(current, "base", eligible + 1);

    expect(nextCoordinatorAction(current, eligible + 1).kind)
      .toBe("prepare_base_refund");

    setWalletAppliedRefund(current, "base", "completed");
    expect(nextCoordinatorAction(current, eligible + 2).kind)
      .toBe("reconcile_wallet");

    current.privateState.cashuOperation!.status = "wallet_applied";
    expect(nextCoordinatorAction(current, eligible + 2).kind)
      .toBe("clear_order_publication");

    current.pendingOrderPublication = null;
    expect(nextCoordinatorAction(current, eligible + 2).kind)
      .toBe("stage_order_release");

    setCommittedPublication(current, "release", "bb".repeat(32));
    expect(nextCoordinatorAction(current, eligible + 2).kind)
      .toBe("clear_cashu_operation");

    current.privateState.cashuOperation = null;
    expect(nextCoordinatorAction(current, eligible + 2).kind).toBe("none");
  });

  it("keeps an exactly filled authoritative settlement terminal", () => {
    const current = session("maker", "settled");
    markSpent(current, "base");
    markSpent(current, "quote", 1_800_000_101);
    setCommittedPublication(current, "fill", "cc".repeat(32));

    expect(nextCoordinatorAction(current, 1_800_000_102).kind).toBe("none");

    current.privateState.legs.quote.observations = [];
    expect(nextCoordinatorAction(current, 1_800_000_102).kind)
      .toBe("enter_recovery");
  });

  it("requires a taker to verify the maker fill before settlement is terminal", () => {
    const current = session("taker", "settled");
    current.phase = "filled";
    current.fillTransitionId = "cc".repeat(32);
    markSpent(current, "base");
    markSpent(current, "quote", 1_800_000_101);

    expect(nextCoordinatorAction(current, 1_800_000_102).kind)
      .toBe("verify_order_fill");

    current.evidence.fillTransitionId = current.fillTransitionId;
    expect(nextCoordinatorAction(current, 1_800_000_102).kind).toBe("none");

    current.evidence.fillTransitionId = "dd".repeat(32);
    expect(nextCoordinatorAction(current, 1_800_000_102).kind)
      .toBe("enter_recovery");
  });
});
