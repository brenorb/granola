import { describe, expect, it, vi } from "vitest";

import type { CoordinatorAction } from "./coordinator-plan.js";
import {
  TradeCoordinator,
  type CoordinatorEffectPort,
  type CoordinatorSessionRepository,
  type RunCoordinatorSessionExclusive
} from "./coordinator.js";
import type { TradeSession } from "./session.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function session(): TradeSession {
  return {
    schema: "granola/trade-session/v2",
    revision: 0,
    sessionId: "11".repeat(32),
    reservationId: "11111111-1111-4111-8111-111111111111",
    role: "maker",
    phase: "negotiating",
    orderAddress:
      `30078:${"22".repeat(32)}:granola:order:v2:22222222-2222-4222-8222-222222222222`,
    offeredOrderHead: "33".repeat(32),
    reserveTransitionId: null,
    fillTransitionId: null,
    pendingOrderPublication: null,
    createdAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    terms: {
      baseMint: "https://testnut.cashu.space",
      baseUnit: "sat",
      baseKeyset: "base-keyset",
      baseAmount: "20",
      quoteMint: "https://nofee.testnut.cashu.space",
      quoteUnit: "usd",
      quoteKeyset: "quote-keyset",
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
        abortSeal: {
          kind: 13,
          created_at: 1_800_000_000,
          tags: [],
          content: "encrypted-abort-secret",
          id: "44".repeat(32),
          pubkey: "55".repeat(32),
          sig: "66".repeat(64)
        }
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
      nostrPrivateKey: "private-nostr-key",
      cashuPrivateKey: "private-cashu-key",
      refundPrivateKey: "private-refund-key",
      preimage: "private-preimage",
      htlcHash: null,
      settlementTranscriptHash: null,
      inbox: {
        status: "registered",
        quorum: 1,
        event: {
          kind: 10050,
          created_at: 1_800_000_000,
          tags: [["relay", "wss://inbox.example"]],
          content: "",
          id: "77".repeat(32),
          pubkey: "88".repeat(32),
          sig: "99".repeat(64)
        },
        discoveryRelays: ["wss://discovery.example"],
        inboxRelays: ["wss://inbox.example"],
        receipts: [{
          relay: "wss://discovery.example",
          ok: true,
          message: "stored"
        }],
        readbacks: [],
        stagedAt: 1_800_000_000,
        acknowledgedAt: 1_800_000_000,
        registeredAt: 1_800_000_000
      },
      pendingIncoming: null,
      transcript: {
        choreography: {
          phase: "failed",
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

class MemorySessionRepository implements CoordinatorSessionRepository {
  readonly save = vi.fn(async (
    next: TradeSession,
    expectedRevision: number | null
  ): Promise<void> => {
    const current = this.value;
    if (current === undefined || expectedRevision === null) {
      throw new Error("Test repository requires an existing CAS revision");
    }
    if (current.revision !== expectedRevision) {
      throw new Error("Trade session compare-and-swap revision failed");
    }
    if (next.revision !== expectedRevision + 1) {
      throw new Error("Trade session revision must advance exactly one step");
    }
    if (next.updatedAt < current.updatedAt) {
      throw new Error("Trade session update time regressed");
    }
    this.value = clone(next);
  });

  constructor(private value: TradeSession | undefined) {}

  async list(): Promise<TradeSession[]> {
    return this.value === undefined ? [] : [clone(this.value)];
  }

  async get(sessionId: string): Promise<TradeSession | undefined> {
    return this.value?.sessionId === sessionId ? clone(this.value) : undefined;
  }
}

function stagedInbox(current = session()): TradeSession {
  current.privateState.inbox.status = "staged";
  current.privateState.inbox.receipts = [];
  current.privateState.inbox.readbacks = [];
  current.privateState.inbox.acknowledgedAt = null;
  current.privateState.inbox.registeredAt = null;
  return current;
}

function acknowledgeInbox(current: TradeSession, now: number): TradeSession {
  const next = clone(current);
  next.revision += 1;
  next.updatedAt = now;
  next.privateState.inbox.status = "acknowledged";
  next.privateState.inbox.receipts = [{
    relay: next.privateState.inbox.discoveryRelays[0]!,
    ok: true,
    message: "stored"
  }];
  next.privateState.inbox.acknowledgedAt = now;
  return next;
}

function port(
  overrides: Partial<CoordinatorEffectPort> = {}
): CoordinatorEffectPort {
  return {
    classify: () => "local",
    applyLocal: async ({ session: current, now }) => ({
      ...clone(current),
      revision: current.revision + 1,
      updatedAt: now
    }),
    performExternal: async ({ session: current, now }) =>
      acknowledgeInbox(current, now),
    ...overrides
  };
}

function trackingSessionLock(): {
  run: RunCoordinatorSessionExclusive;
  isHeld: () => boolean;
} {
  let held = false;
  let tail = Promise.resolve();
  return {
    isHeld: () => held,
    run: async <T>(_sessionId: string, action: () => Promise<T>): Promise<T> => {
      const previous = tail;
      let release = (): void => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      held = true;
      try {
        return await action();
      } finally {
        held = false;
        release();
      }
    }
  };
}

describe("durable trade coordinator shell", () => {
  it("lists and gets only redacted views, while none performs no save or effect", async () => {
    const repository = new MemorySessionRepository(session());
    const effects = port({
      applyLocal: vi.fn(),
      performExternal: vi.fn()
    });
    const coordinator = new TradeCoordinator({
      repository,
      effects,
      now: () => 1_800_000_100
    });

    const [listed] = await coordinator.list();
    const found = await coordinator.get(session().sessionId);
    const advanced = await coordinator.advance(session().sessionId);

    for (const view of [listed, found, advanced]) {
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain("privateState");
      expect(serialized).not.toContain("encrypted-abort-secret");
      expect(serialized).not.toContain("private-nostr-key");
      expect(view?.evidence.reservation.abortSealId).toBe("44".repeat(32));
    }
    expect(repository.save).not.toHaveBeenCalled();
    expect(effects.applyLocal).not.toHaveBeenCalled();
    expect(effects.performExternal).not.toHaveBeenCalled();
  });

  it("runs a local staging transition and one CAS save under the session lock", async () => {
    const current = session();
    current.privateState.inbox = {
      status: "unregistered",
      quorum: 1,
      event: null,
      discoveryRelays: [],
      inboxRelays: [],
      receipts: [],
      readbacks: [],
      stagedAt: null,
      acknowledgedAt: null,
      registeredAt: null
    };
    const repository = new MemorySessionRepository(current);
    const lock = trackingSessionLock();
    const applyLocal = vi.fn(async ({
      action,
      session: before,
      now
    }: {
      action: CoordinatorAction;
      session: TradeSession;
      now: number;
    }) => {
      expect(lock.isHeld()).toBe(true);
      expect(action.kind).toBe("stage_inbox_registration");
      const next = stagedInbox(clone(before));
      next.revision += 1;
      next.updatedAt = now;
      return next;
    });
    const performExternal = vi.fn();
    const effects = port({ applyLocal, performExternal });
    const coordinator = new TradeCoordinator({
      repository,
      effects,
      now: () => 1_800_000_100,
      runSessionExclusive: lock.run
    });

    const view = await coordinator.advance(current.sessionId);

    expect(view.revision).toBe(1);
    expect(applyLocal).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(performExternal).not.toHaveBeenCalled();
  });

  it("rejects an external action without its complete persisted checkpoint", async () => {
    const current = stagedInbox();
    current.privateState.inbox.event = null;
    const repository = new MemorySessionRepository(current);
    const performExternal = vi.fn();
    const coordinator = new TradeCoordinator({
      repository,
      effects: port({
        classify: () => "external",
        performExternal
      }),
      now: () => 1_800_000_100
    });

    await expect(coordinator.advance(current.sessionId))
      .rejects.toThrow(/persisted.*checkpoint/i);
    expect(performExternal).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("releases the session lock for one external effect and coalesces same-session calls", async () => {
    const current = stagedInbox();
    const repository = new MemorySessionRepository(current);
    const lock = trackingSessionLock();
    let releaseEffect = (): void => {};
    const effectGate = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    let effectStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      effectStarted = resolve;
    });
    const performExternal = vi.fn(async (input) => {
      expect(lock.isHeld()).toBe(false);
      expect(input.action).toEqual({ kind: "publish_inbox_registration" });
      expect(input.revision).toBe(0);
      expect(input.fingerprint).toMatch(/publish_inbox_registration/);
      effectStarted();
      await effectGate;
      return acknowledgeInbox(input.session, input.now);
    });
    const coordinator = new TradeCoordinator({
      repository,
      effects: port({
        classify: () => "external",
        performExternal
      }),
      now: () => 1_800_000_100,
      runSessionExclusive: lock.run
    });

    const first = coordinator.advance(current.sessionId);
    await started;
    const second = coordinator.advance(current.sessionId);
    releaseEffect();
    const [left, right] = await Promise.all([first, second]);

    expect(left).toEqual(right);
    expect(performExternal).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("converges when another retry has already saved the exact external result", async () => {
    const current = stagedInbox();
    const repository = new MemorySessionRepository(current);
    const coordinator = new TradeCoordinator({
      repository,
      effects: port({
        classify: () => "external",
        performExternal: async ({ session: before, now }) => {
          const result = acknowledgeInbox(before, now);
          await repository.save(result, before.revision);
          return result;
        }
      }),
      now: () => 1_800_000_100
    });

    await expect(coordinator.advance(current.sessionId))
      .resolves.toMatchObject({ revision: 1 });
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("fails closed when concurrent state conflicts with the external result", async () => {
    const current = stagedInbox();
    const repository = new MemorySessionRepository(current);
    const coordinator = new TradeCoordinator({
      repository,
      effects: port({
        classify: () => "external",
        performExternal: async ({ session: before, now }) => {
          const result = acknowledgeInbox(before, now);
          const conflict = clone(result);
          conflict.terms.quoteAmount = "2";
          await repository.save(conflict, before.revision);
          return result;
        }
      }),
      now: () => 1_800_000_100
    });

    await expect(coordinator.advance(current.sessionId))
      .rejects.toThrow(/conflicting concurrent state/i);
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("rejects effect results that do not preserve the snapshotted session identity", async () => {
    const current = stagedInbox();
    const repository = new MemorySessionRepository(current);
    const coordinator = new TradeCoordinator({
      repository,
      effects: port({
        classify: () => "external",
        performExternal: async ({ session: before, now }) => ({
          ...acknowledgeInbox(before, now),
          sessionId: "aa".repeat(32)
        })
      }),
      now: () => 1_800_000_100
    });

    await expect(coordinator.advance(current.sessionId))
      .rejects.toThrow(/session identity/i);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("fingerprints network preparation with persisted lock terms and wallet input commitment", async () => {
    const current = session();
    current.privateState.transcript.choreography.phase = "awaiting_base_lock";
    current.privateState.settlementTranscriptHash = "ab".repeat(32);
    current.privateState.htlcHash = "cd".repeat(32);
    current.privateState.legs.base.expected = {
      mintUrl: current.terms.baseMint,
      unit: current.terms.baseUnit,
      binding: {
        protocolVersion: "1",
        network: "cashu-testnet-v1",
        orderId: "22222222-2222-4222-8222-222222222222",
        reservationId: current.reservationId,
        sessionId: current.sessionId,
        direction: "base",
        transcriptHash: current.privateState.settlementTranscriptHash
      },
      amount: current.terms.baseAmount,
      hash: current.privateState.htlcHash,
      receiverPubkey: `02${"01".repeat(32)}`,
      refundPubkey: `03${"02".repeat(32)}`,
      locktime: current.plan.longLocktime,
      leg: "base",
      refundHorizon: current.plan.longLocktime + current.plan.refundGuardSeconds,
      deadlines: {
        short: current.plan.shortLocktime,
        long: current.plan.longLocktime,
        minimumGap: current.plan.longLocktime - current.plan.shortLocktime
      }
    };
    const repository = new MemorySessionRepository(current);
    const externalFingerprintMaterial = vi.fn(async () => ({
      walletRevision: 4,
      inputCommitment: "ef".repeat(32)
    }));
    const performExternal = vi.fn(async (input) => ({
      ...clone(input.session),
      revision: input.revision + 1,
      updatedAt: input.now
    }));
    const coordinator = new TradeCoordinator({
      repository,
      effects: port({
        classify: () => "external",
        externalFingerprintMaterial,
        performExternal
      }),
      now: () => 1_800_000_100
    });

    await coordinator.advance(current.sessionId);

    expect(externalFingerprintMaterial).toHaveBeenCalledWith(
      { kind: "prepare_base_lock" },
      expect.objectContaining({ revision: 0 })
    );
    expect(performExternal).toHaveBeenCalledWith(expect.objectContaining({
      action: { kind: "prepare_base_lock" },
      revision: 0,
      fingerprint: expect.stringMatching(/^prepare_base_lock:/)
    }));
  });
});
