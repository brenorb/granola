import { usesDirectRouting } from "./coordinator-plan.js";
import {
  nextCoordinatorAction,
  type CoordinatorAction
} from "./coordinator-plan.js";
import {
  publicTradeView,
  type PublicTradeView,
  type TradeSession
} from "./session.js";

import { canonicalJson } from "../core/canonical-json.js";

export interface CoordinatorSessionRepository {
  list(): Promise<TradeSession[]>;
  get(sessionId: string): Promise<TradeSession | undefined>;
  save(session: TradeSession, expectedRevision: number | null): Promise<void>;
}

export type CoordinatorExecutionKind = "local" | "external";

export interface CoordinatorStepInput {
  action: CoordinatorAction;
  session: TradeSession;
  now: number;
}

export interface CoordinatorExternalEffectInput extends CoordinatorStepInput {
  revision: number;
  fingerprint: string;
}

export interface CoordinatorEffectPort {
  classify(
    action: CoordinatorAction,
    session: TradeSession
  ): CoordinatorExecutionKind;
  externalFingerprintMaterial?(
    action: CoordinatorAction,
    session: TradeSession
  ): Promise<unknown>;
  applyLocal(input: CoordinatorStepInput): Promise<TradeSession>;
  performExternal(input: CoordinatorExternalEffectInput): Promise<TradeSession>;
}

export type RunCoordinatorSessionExclusive = <T>(
  sessionId: string,
  action: () => Promise<T>
) => Promise<T>;

export interface TradeCoordinatorOptions {
  repository: CoordinatorSessionRepository;
  effects: CoordinatorEffectPort;
  now?: () => number;
  runSessionExclusive?: RunCoordinatorSessionExclusive;
  runAdvanceExclusive?: RunCoordinatorSessionExclusive;
  profileAction?: (profile: CoordinatorActionProfile) => void;
}

export interface CoordinatorActionProfile {
  action: CoordinatorAction["kind"];
  execution: CoordinatorExecutionKind;
  sessionId: string;
  role: TradeSession["role"];
  revision: number;
  startedAt: number;
  endedAt: number;
  succeeded: boolean;
}

interface ExternalSnapshot {
  action: CoordinatorAction;
  session: TradeSession;
  revision: number;
  now: number;
  fingerprint: string;
  profileStartedAt: number;
}

type InitialStep =
  | { kind: "complete"; view: PublicTradeView; session: TradeSession }
  | { kind: "external"; snapshot: ExternalSnapshot };

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function checkpointError(action: CoordinatorAction): never {
  throw new Error(
    `External action ${action.kind} requires a complete persisted pre-effect checkpoint`
  );
}

function externalArtifact(
  action: CoordinatorAction,
  session: TradeSession
): unknown {
  const publication = session.pendingOrderPublication;
  const inbox = session.privateState.inbox;
  const outbox = session.privateState.outbox;
  const cashu = session.privateState.cashuOperation;

  switch (action.kind) {
    case "publish_order_projection":
      if (
        publication?.status !== "staged" ||
        !publication.projection?.id
      ) checkpointError(action);
      return {
        operation: publication.operation,
        orderId: publication.orderId,
        projection: publication.projection
      };
    case "publish_inbox_registration":
      if (
        inbox.status !== "staged" ||
        inbox.event === null ||
        inbox.discoveryRelays.length === 0 ||
        inbox.inboxRelays.length === 0
      ) checkpointError(action);
      return {
        event: inbox.event,
        discoveryRelays: inbox.discoveryRelays,
        inboxRelays: inbox.inboxRelays
      };
    case "verify_inbox_registration":
      if (
        inbox.status !== "acknowledged" ||
        inbox.event === null ||
        inbox.discoveryRelays.length === 0 ||
        inbox.inboxRelays.length === 0
      ) checkpointError(action);
      return {
        event: inbox.event,
        discoveryRelays: inbox.discoveryRelays,
        inboxRelays: inbox.inboxRelays,
        receipts: inbox.receipts
      };
    case "deliver_outbox":
      if (
        outbox?.status !== "staged" ||
        !outbox.message.message_id ||
        !outbox.rumor.id ||
        !outbox.seal.id ||
        !outbox.wrapper.id ||
        (outbox.recipientInboxListId !== null && !outbox.recipientInboxListId) ||
        outbox.recipientRelays.length === 0
      ) checkpointError(action);
      return {
        message: outbox.message,
        rumor: outbox.rumor,
        seal: outbox.seal,
        wrapper: outbox.wrapper,
        recipientInboxListId: outbox.recipientInboxListId,
        recipientRelays: outbox.recipientRelays,
        nextChoreography: outbox.nextChoreography
      };
    case "reserve_cashu_inputs":
      if (
        cashu?.status !== "prepared" ||
        cashu.inputsReserved ||
        !cashu.operationId ||
        !cashu.artifact.operationCommitment
      ) checkpointError(action);
      return {
        operationId: cashu.operationId,
        artifact: cashu.artifact
      };
    case "execute_cashu_operation":
      if (
        cashu?.status !== "prepared" ||
        !cashu.inputsReserved ||
        !cashu.operationId ||
        !cashu.artifact.operationCommitment
      ) checkpointError(action);
      return {
        operationId: cashu.operationId,
        artifact: cashu.artifact
      };
    case "reconcile_wallet":
      if (
        cashu?.status !== "completed" ||
        cashu.result === null ||
        !cashu.operationId ||
        !cashu.artifact.operationCommitment
      ) checkpointError(action);
      return {
        operationId: cashu.operationId,
        operationCommitment: cashu.artifact.operationCommitment,
        result: cashu.result
      };
    case "poll_inbox":
      if (
        (inbox.status === "unregistered" || (!usesDirectRouting(session) && inbox.status !== "registered")) ||
        inbox.event === null ||
        inbox.inboxRelays.length === 0
      ) checkpointError(action);
      return {
        inboxListId: inbox.event.id,
        inboxRelays: inbox.inboxRelays,
        nextSequence: session.privateState.transcript.nextSequence,
        lastMessageId: session.privateState.transcript.lastMessageId,
        lastTranscriptHash: session.privateState.transcript.lastTranscriptHash
      };
    case "observe_base":
    case "observe_quote": {
      const leg = action.kind === "observe_base" ? "base" : "quote";
      const privateLeg = session.privateState.legs[leg];
      const evidence = session.evidence.legs[leg];
      if (
        privateLeg.token === null ||
        evidence.tokenCommitment === null ||
        evidence.keysetId.length === 0
      ) checkpointError(action);
      return {
        leg,
        tokenCommitment: evidence.tokenCommitment,
        keysetId: evidence.keysetId,
        previousObservation: privateLeg.observations.at(-1) ?? null
      };
    }
    case "prepare_base_lock":
    case "prepare_quote_lock":
    case "prepare_base_claim":
    case "prepare_quote_claim":
    case "prepare_base_refund":
    case "prepare_quote_refund": {
      const leg = action.kind.includes("base") ? "base" : "quote";
      const privateLeg = session.privateState.legs[leg];
      const expected = privateLeg.expected;
      if (
        session.privateState.htlcHash === null ||
        session.privateState.settlementTranscriptHash === null ||
        (expected !== null && (
          expected.leg !== leg ||
          expected.binding.sessionId !== session.sessionId ||
          expected.binding.reservationId !== session.reservationId ||
          expected.binding.transcriptHash !==
            session.privateState.settlementTranscriptHash
        ))
      ) checkpointError(action);
      return {
        leg,
        terms: {
          mintUrl: leg === "base" ? session.terms.baseMint : session.terms.quoteMint,
          unit: leg === "base" ? session.terms.baseUnit : session.terms.quoteUnit,
          keysetId: leg === "base"
            ? session.terms.baseKeyset
            : session.terms.quoteKeyset,
            amount: leg === "base" ? session.terms.baseAmount : session.terms.quoteAmount
        },
        expected,
        tokenCommitment: session.evidence.legs[leg].tokenCommitment
      };
    }
    case "stage_order_reserve":
    case "stage_order_fill":
    case "stage_order_release":
      return {
        operation: action.kind.replace("stage_order_", ""),
        orderAddress: session.orderAddress,
        orderProjectionId: session.reserveProjectionId ?? session.offeredProjectionId,
        reservationId: session.reservationId,
        terms: session.terms,
        settlementTranscriptHash: session.privateState.settlementTranscriptHash,
        reservationEvidence: session.evidence.reservation,
        legs: session.evidence.legs
      };
    case "verify_order_fill":
      if (
        session.role !== "taker" ||
        session.fillProjectionId !== null ||
        session.evidence.fillProjectionId !== null ||
        session.privateState.transcript.choreography.phase !== "settling"
      ) checkpointError(action);
      return {
        orderAddress: session.orderAddress,
        reservationId: session.reservationId,
        reserveProjectionId: session.reserveProjectionId,
        transcript: {
          lastMessageId: session.privateState.transcript.lastMessageId,
          lastTranscriptHash: session.privateState.transcript.lastTranscriptHash,
          accepted: session.privateState.transcript.accepted
        }
      };
    case "commit_order_publication":
    case "clear_order_publication":
      if (publication === null) checkpointError(action);
      return {
        operation: publication.operation,
        orderId: publication.orderId,
        projectionId: publication.projection.id,
        status: publication.status
      };
    case "stage_reserve_propose":
    case "stage_reserve_accept":
    case "stage_session_ack":
    case "stage_base_lock":
    case "stage_base_lock_ack":
    case "stage_quote_lock":
    case "stage_quote_lock_ack":
    case "stage_claim_notice":
    case "stage_fill_request":
    case "stage_settlement_ack":
      if (outbox !== null || session.privateState.pendingIncoming !== null) {
        checkpointError(action);
      }
      return {
        role: session.role,
        orderProjectionId: session.reserveProjectionId ?? session.offeredProjectionId,
        terms: session.terms,
        plan: session.plan,
        publicEvidence: session.evidence,
        transcript: session.privateState.transcript
      };
    case "validate_incoming":
      if (
        session.privateState.pendingIncoming === null ||
        session.privateState.pendingIncoming.validation.status !== "unvalidated"
      ) checkpointError(action);
      return session.privateState.pendingIncoming;
    default:
      return checkpointError(action);
  }
}

async function externalFingerprint(
  action: CoordinatorAction,
  session: TradeSession,
  portMaterial: unknown = null
): Promise<string> {
  const artifact = externalArtifact(action, session);
  const digest = await sha256(canonicalJson({
    action: action.kind,
    sessionId: session.sessionId,
    revision: session.revision,
    portMaterial,
    artifact
  }));
  return `${action.kind}:${digest}`;
}

function assertCompleteResult(
  before: TradeSession,
  result: TradeSession
): void {
  if (result.sessionId !== before.sessionId) {
    throw new Error("Coordinator result changed the trade session identity");
  }
  if (result.revision !== before.revision + 1) {
    throw new Error("Coordinator result must advance exactly one revision");
  }
  if (result.updatedAt < before.updatedAt) {
    throw new Error("Coordinator result timestamp regressed");
  }
}

function createSessionExclusiveRunner(): RunCoordinatorSessionExclusive {
  const tails = new Map<string, Promise<void>>();
  return async <T>(
    sessionId: string,
    action: () => Promise<T>
  ): Promise<T> => {
    const previous = tails.get(sessionId) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(sessionId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (tails.get(sessionId) === current) tails.delete(sessionId);
    }
  };
}

// Only announcement receipts may advance concurrently with a financial checkpoint.
function settlementSnapshot(session: TradeSession): string {
  const value = structuredClone(session);
  value.revision = 0;
  value.updatedAt = 0;
  Object.assign(value.privateState.inbox, { status: "staged", receipts: [], readbacks: [], acknowledgedAt: null, registeredAt: null });
  if (value.pendingOrderPublication) Object.assign(value.pendingOrderPublication,
    { status: "staged", receipts: [], acknowledgedAt: null, committedAt: null });
  return canonicalJson(value);
}

export class TradeCoordinator {
  private readonly repository: CoordinatorSessionRepository;
  private readonly effects: CoordinatorEffectPort;
  private readonly now: () => number;
  private readonly runSessionExclusive: RunCoordinatorSessionExclusive;
  private readonly runAdvanceExclusive: RunCoordinatorSessionExclusive;
  private readonly profileAction: ((profile: CoordinatorActionProfile) => void) | undefined;
  private readonly inFlight = new Map<string, Promise<PublicTradeView>>();
  private readonly announcements = new Map<string, Promise<void>>();

  constructor(options: TradeCoordinatorOptions) {
    this.repository = options.repository;
    this.effects = options.effects;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.runSessionExclusive =
      options.runSessionExclusive ?? createSessionExclusiveRunner();
    this.runAdvanceExclusive = options.runAdvanceExclusive ?? createSessionExclusiveRunner();
    this.profileAction = options.profileAction;
  }

  async list(): Promise<PublicTradeView[]> {
    const sessions = await this.repository.list();
    sessions.forEach(session => this.startAnnouncements(session));
    return sessions.map(publicTradeView);
  }

  async get(sessionId: string): Promise<PublicTradeView | undefined> {
    const current = await this.repository.get(sessionId);
    return current === undefined ? undefined : publicTradeView(current);
  }

  advance(sessionId: string): Promise<PublicTradeView> {
    const running = this.inFlight.get(sessionId);
    if (running !== undefined) return running;
    const pending = (async (): Promise<PublicTradeView> => {
      try {
        return await this.runAdvanceExclusive(sessionId, () => this.advanceOnce(sessionId));
      } finally {
        this.inFlight.delete(sessionId);
      }
    })();
    this.inFlight.set(sessionId, pending);
    return pending;
  }

  private async advanceOnce(sessionId: string): Promise<PublicTradeView> {
    const initial = await this.runSessionExclusive(
      sessionId,
      async (): Promise<InitialStep> => {
        const current = await this.requiredSession(sessionId);
        const now = this.now();
        const action = nextCoordinatorAction(current, now);
        if (action.kind === "none") {
          return { kind: "complete", view: publicTradeView(current), session: current };
        }
        const execution = this.effects.classify(action, structuredClone(current));
        if (execution === "local") {
          const startedAt = performance.now();
          let succeeded = false;
          try {
            const result = await this.effects.applyLocal({
              action,
              session: structuredClone(current),
              now
            });
            assertCompleteResult(current, result);
            await this.repository.save(result, current.revision);
            succeeded = true;
            return { kind: "complete", view: publicTradeView(result), session: result };
          } finally {
            this.recordProfile(action, execution, current, startedAt, succeeded);
          }
        }
        if (execution !== "external") {
          throw new Error("Coordinator effect port returned an invalid execution kind");
        }
        const profileStartedAt = performance.now();
        return {
          kind: "external",
          snapshot: {
            action,
            session: structuredClone(current),
            revision: current.revision,
            now,
            fingerprint: await externalFingerprint(
              action,
              current,
              await this.effects.externalFingerprintMaterial?.(
                action,
                structuredClone(current)
              ) ?? null
            ),
            profileStartedAt
          }
        };
      }
    );

    if (initial.kind === "complete") {
      this.startAnnouncements(initial.session);
      return initial.view;
    }
    this.startAnnouncements(initial.snapshot.session);
    const { snapshot } = initial;
    let succeeded = false;
    try {
      const result = await this.effects.performExternal({
        action: snapshot.action,
        session: structuredClone(snapshot.session),
        now: snapshot.now,
        revision: snapshot.revision,
        fingerprint: snapshot.fingerprint
      });
      assertCompleteResult(snapshot.session, result);

      const completed = await this.runSessionExclusive(sessionId, async () => {
        const current = await this.requiredSession(sessionId);
        if (canonicalJson(current) === canonicalJson(result)) {
          return { view: publicTradeView(current), session: current };
        }
        if (settlementSnapshot(current) !== settlementSnapshot(snapshot.session)) {
          throw new Error(
            "Coordinator external result conflicts with conflicting concurrent state"
          );
        }
        const currentAction = nextCoordinatorAction(current, snapshot.now);
        if (currentAction.kind !== snapshot.action.kind) {
          throw new Error("Coordinator external action identity changed");
        }
        const currentFingerprint = await externalFingerprint(
          currentAction,
          { ...current, revision: snapshot.revision },
          await this.effects.externalFingerprintMaterial?.(
            currentAction,
            structuredClone(current)
          ) ?? null
        );
        if (currentFingerprint !== snapshot.fingerprint) {
          throw new Error("Coordinator external action fingerprint changed");
        }
        const merged = structuredClone(result);
        if (canonicalJson(result.privateState.inbox) === canonicalJson(snapshot.session.privateState.inbox)) {
          merged.privateState.inbox = structuredClone(current.privateState.inbox);
        }
        if (canonicalJson(result.pendingOrderPublication) === canonicalJson(snapshot.session.pendingOrderPublication)) {
          merged.pendingOrderPublication = structuredClone(current.pendingOrderPublication);
        }
        merged.revision = current.revision + 1;
        merged.updatedAt = Math.max(result.updatedAt, current.updatedAt);
        await this.repository.save(merged, current.revision);
        return { view: publicTradeView(merged), session: merged };
      });
      succeeded = true;
      this.startAnnouncements(completed.session);
      return completed.view;
    } finally {
      this.recordProfile(
        snapshot.action,
        "external",
        snapshot.session,
        snapshot.profileStartedAt,
        succeeded
      );
    }
  }

  private startAnnouncements(session: TradeSession): void {
    if (!usesDirectRouting(session)) return;
    const candidates: Array<{ action: CoordinatorAction; id: string }> = [];
    const inbox = session.privateState.inbox;
    if (inbox.event && (inbox.status === "staged" || inbox.status === "acknowledged")) {
      candidates.push({ action: { kind: "publish_inbox_registration" }, id: inbox.event.id });
    }
    const publication = session.pendingOrderPublication;
    if (publication && publication.status !== "committed" && publication.operation !== "release") {
      candidates.push({ action: { kind: "publish_order_projection" }, id: publication.projection.id });
    }
    for (const { action, id } of candidates) {
      const key = `${session.sessionId}:${id}`;
      if (this.announcements.has(key)) continue;
      const run = (async () => {
        while (true) {
          const snapshot = await this.requiredSession(session.sessionId);
          const registration = action.kind === "publish_inbox_registration";
          if (registration ? snapshot.privateState.inbox.event?.id !== id || snapshot.privateState.inbox.status === "registered"
            : snapshot.pendingOrderPublication?.projection.id !== id || snapshot.pendingOrderPublication.status === "committed") return;
          const effectAction: CoordinatorAction = registration
            ? { kind: snapshot.privateState.inbox.status === "acknowledged" ? "verify_inbox_registration" : "publish_inbox_registration" }
            : { kind: snapshot.pendingOrderPublication?.status === "acknowledged" ? "commit_order_publication" : "publish_order_projection" };
          const startedAt = performance.now();
          let succeeded = false;
          let current: TradeSession | undefined;
          try {
            const result = await this.effects.performExternal({ action: effectAction, session: snapshot, now: this.now(),
              revision: snapshot.revision, fingerprint: await externalFingerprint(effectAction, snapshot) });
            current = await this.runSessionExclusive(session.sessionId, async () => {
              const current = await this.requiredSession(session.sessionId);
              const next = structuredClone(current);
              if (registration) {
                if (current.privateState.inbox.event?.id !== id || current.privateState.inbox.status === "registered") return current;
                if (result.privateState.inbox.event?.id !== id) throw new Error("Announcement artifact changed");
                next.privateState.inbox = structuredClone(result.privateState.inbox);
              } else {
                if (current.pendingOrderPublication?.projection.id !== id || current.pendingOrderPublication.status === "committed") return current;
                if (result.pendingOrderPublication?.projection.id !== id) return current;
                next.pendingOrderPublication = structuredClone(result.pendingOrderPublication);
              }
              next.revision = current.revision + 1;
              next.updatedAt = Math.max(current.updatedAt, result.updatedAt, this.now());
              await this.repository.save(next, current.revision);
              return next;
            });
            succeeded = true;
          } catch { /* The exact pending artifact stays durable for retry/restart. */ }
          finally { this.recordProfile(effectAction, "external", snapshot, startedAt, succeeded); }
          if (current === undefined) current = await this.requiredSession(session.sessionId);
          if (registration ? current.privateState.inbox.status === "registered"
            : current.pendingOrderPublication?.projection.id !== id || current.pendingOrderPublication.status === "committed") return;
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 5_000);
            (timer as unknown as { unref?: () => void }).unref?.();
          });
        }
      })().catch(() => undefined).finally(() => { this.announcements.delete(key); });
      this.announcements.set(key, run);
    }
  }

  private recordProfile(
    action: CoordinatorAction,
    execution: CoordinatorExecutionKind,
    session: TradeSession,
    startedAt: number,
    succeeded: boolean
  ): void {
    try {
      this.profileAction?.({
        action: action.kind,
        execution,
        sessionId: session.sessionId,
        role: session.role,
        revision: session.revision,
        startedAt,
        endedAt: performance.now(),
        succeeded
      });
    } catch {
      // Diagnostics must never change coordinator behavior.
    }
  }

  private async requiredSession(sessionId: string): Promise<TradeSession> {
    const current = await this.repository.get(sessionId);
    if (current === undefined) {
      throw new Error(`Trade session ${sessionId} was not found`);
    }
    return current;
  }
}
