import {
  nextCoordinatorAction,
  type CoordinatorAction
} from "./coordinator-plan.js";
import {
  publicTradeView,
  type PublicTradeView,
  type TradeSession
} from "./session.js";

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
}

interface ExternalSnapshot {
  action: CoordinatorAction;
  session: TradeSession;
  revision: number;
  now: number;
  fingerprint: string;
}

type InitialStep =
  | { kind: "complete"; view: PublicTradeView }
  | { kind: "external"; snapshot: ExternalSnapshot };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

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
    case "publish_order_transition":
      if (
        publication?.status !== "staged" ||
        !publication.transition?.id
      ) checkpointError(action);
      return {
        operation: publication.operation,
        orderId: publication.orderId,
        transition: publication.transition
      };
    case "publish_order_projection":
      if (
        publication?.status !== "transition_acknowledged" ||
        !publication.projection?.id
      ) checkpointError(action);
      return {
        operation: publication.operation,
        orderId: publication.orderId,
        transitionId: publication.transition.id,
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
        !outbox.recipientInboxListId ||
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
        inbox.status !== "registered" ||
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
    default:
      return checkpointError(action);
  }
}

async function externalFingerprint(
  action: CoordinatorAction,
  session: TradeSession
): Promise<string> {
  const artifact = externalArtifact(action, session);
  const digest = await sha256(canonicalJson({
    action: action.kind,
    sessionId: session.sessionId,
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

export class TradeCoordinator {
  private readonly repository: CoordinatorSessionRepository;
  private readonly effects: CoordinatorEffectPort;
  private readonly now: () => number;
  private readonly runSessionExclusive: RunCoordinatorSessionExclusive;
  private readonly inFlight = new Map<string, Promise<PublicTradeView>>();

  constructor(options: TradeCoordinatorOptions) {
    this.repository = options.repository;
    this.effects = options.effects;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.runSessionExclusive =
      options.runSessionExclusive ?? createSessionExclusiveRunner();
  }

  async list(): Promise<PublicTradeView[]> {
    return (await this.repository.list()).map(publicTradeView);
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
        return await this.advanceOnce(sessionId);
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
          return { kind: "complete", view: publicTradeView(current) };
        }
        const execution = this.effects.classify(action, clone(current));
        if (execution === "local") {
          const result = await this.effects.applyLocal({
            action,
            session: clone(current),
            now
          });
          assertCompleteResult(current, result);
          await this.repository.save(result, current.revision);
          return { kind: "complete", view: publicTradeView(result) };
        }
        if (execution !== "external") {
          throw new Error("Coordinator effect port returned an invalid execution kind");
        }
        return {
          kind: "external",
          snapshot: {
            action,
            session: clone(current),
            revision: current.revision,
            now,
            fingerprint: await externalFingerprint(action, current)
          }
        };
      }
    );

    if (initial.kind === "complete") return initial.view;
    const { snapshot } = initial;
    const result = await this.effects.performExternal({
      action: snapshot.action,
      session: clone(snapshot.session),
      now: snapshot.now,
      revision: snapshot.revision,
      fingerprint: snapshot.fingerprint
    });
    assertCompleteResult(snapshot.session, result);

    return this.runSessionExclusive(sessionId, async () => {
      const current = await this.requiredSession(sessionId);
      if (canonicalJson(current) === canonicalJson(result)) {
        return publicTradeView(current);
      }
      if (canonicalJson(current) !== canonicalJson(snapshot.session)) {
        throw new Error(
          "Coordinator external result conflicts with conflicting concurrent state"
        );
      }
      const currentAction = nextCoordinatorAction(current, snapshot.now);
      if (currentAction.kind !== snapshot.action.kind) {
        throw new Error("Coordinator external action identity changed");
      }
      const currentFingerprint = await externalFingerprint(currentAction, current);
      if (currentFingerprint !== snapshot.fingerprint) {
        throw new Error("Coordinator external action fingerprint changed");
      }
      await this.repository.save(result, snapshot.revision);
      return publicTradeView(result);
    });
  }

  private async requiredSession(sessionId: string): Promise<TradeSession> {
    const current = await this.repository.get(sessionId);
    if (current === undefined) {
      throw new Error(`Trade session ${sessionId} was not found`);
    }
    return current;
  }
}
