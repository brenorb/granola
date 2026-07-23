import {
  getPubKeyFromPrivKey,
  verifyHTLCHash
} from "@cashu/cashu-ts";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import type {
  OrderApi,
  PublishFillInput,
  PublishReleaseInput,
  PublishReserveInput
} from "../api/order-api.js";
import type {
  CashuTradeClient,
  CompletedHtlcSpend,
  CompletedLock,
  PreparedTradeOperation
} from "../cashu/trade-client.js";
import type { ExpectedHtlcLock } from "../cashu/htlc.js";
import {
  unreservedPocket,
  type ProofReservationState
} from "../core/proof-reservations.js";
import type { WalletState } from "../core/wallet.js";
import type {
  DiscoveredTradeInbox,
  NostrTradeTransport
} from "../nostr/trade-transport.js";
import type {
  FillTransitionEvidence,
  NostrEvent
} from "../order/events.js";
import type { PublishedOrderHead } from "../order/service.js";
import type {
  OrderOutboxEntry,
  OrderOutboxPort,
  OrderPublicationStatus
} from "../storage/order-outbox.js";
import type { ProofReservationRepository } from "../storage/proof-reservation-repository.js";
import type { WalletRepository } from "../storage/wallet-repository.js";
import {
  advanceAtomicSwapChoreography,
  validateAtomicSwapMessage,
  type AtomicSwapBody,
  type AtomicSwapMessageType
} from "./atomic-messages.js";
import type {
  CoordinatorAction
} from "./coordinator-plan.js";
import type {
  CoordinatorEffectPort,
  CoordinatorExternalEffectInput,
  CoordinatorStepInput
} from "./coordinator.js";
import {
  createTradeRumor,
  termsHash,
  transcriptHash,
  unwrapReserveAcceptance,
  unwrapTradeMessage,
  wrapTradeRumor,
  type GranolaTradeMessage,
  type GranolaTradeTerms,
  type OpenedTradeMessage,
  type WrappedTradeRumor
} from "./messages.js";
import type {
  CashuOperationResult,
  PersistedMintState,
  TradeSession
} from "./session.js";
import {
  reconcileExactProofOutputs,
  reconcileProofReplacement
} from "./wallet-reconcile.js";
import { verifyEvent } from "nostr-tools/pure";
import {
  parseProjectionEvent,
  parseTransitionEvent
} from "../order/events.js";
import { fillOrder } from "../order/model.js";

type WithWalletLock = <T>(action: () => Promise<T>) => Promise<T>;

export interface CoordinatorMakerIdentity {
  publicKey(): Promise<string>;
  useSecretKey<T>(action: (secretKey: Uint8Array) => Promise<T>): Promise<T>;
}

export interface CoordinatorEffectsEntropy {
  messageId(): string;
  operationId(): string;
  ephemeralSecretKey(): Uint8Array;
  nonce(purpose: "seal" | "wrapper"): Uint8Array;
  randomizedTimestamp(now: number, purpose: "seal" | "wrapper"): number;
  outerExpiration(messageExpiration: number): number;
}

export type { PublishedOrderHead } from "../order/service.js";

export interface CoordinatorOrderReadPort {
  loadPublishedHead(
    address: string,
    expectedHeadId: string
  ): Promise<PublishedOrderHead>;
}

export interface GranolaCoordinatorEffectsOptions {
  orderApi: Pick<
    OrderApi,
    | "ensureReserveStaged"
    | "ensureFillStaged"
    | "ensureReleaseStaged"
    | "publishNextStage"
    | "clearAcknowledgedOrderPublication"
    | "pruneCommittedOrderPublication"
  >;
  orderOutbox: Pick<OrderOutboxPort, "load">;
  orderReader: CoordinatorOrderReadPort;
  nostr: Pick<
    NostrTradeTransport,
    | "createRegistration"
    | "publishRegistration"
    | "discoverInbox"
    | "send"
    | "read"
  >;
  cashu: Pick<
    CashuTradeClient,
    | "prepareOutgoingLock"
    | "completeOutgoingLock"
    | "validateIncomingLock"
    | "prepareClaim"
    | "completeClaim"
    | "prepareRefund"
    | "completeRefund"
    | "observeSpentInternal"
  >;
  wallet: Pick<WalletRepository, "load" | "save">;
  reservations: Pick<ProofReservationRepository, "load" | "reserve" | "release">;
  makerIdentity: CoordinatorMakerIdentity;
  discoveryRelays: readonly string[];
  withWalletLock: WithWalletLock;
  entropy?: CoordinatorEffectsEntropy;
  commitment?: (value: string) => Promise<string>;
}

const EXTERNAL_ACTIONS = new Set<CoordinatorAction["kind"]>([
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
]);

const OUTGOING_ACTIONS = new Map<CoordinatorAction["kind"], AtomicSwapMessageType>([
  ["stage_reserve_propose", "reserve_propose"],
  ["stage_reserve_accept", "reserve_accept"],
  ["stage_session_ack", "session_ack"],
  ["stage_base_lock", "base_lock"],
  ["stage_base_lock_ack", "base_lock_ack"],
  ["stage_quote_lock", "quote_lock"],
  ["stage_quote_lock_ack", "quote_lock_ack"],
  ["stage_claim_notice", "claim_notice"],
  ["stage_fill_request", "fill_request"],
  ["stage_settlement_ack", "settlement_ack"]
]);

const HEX_32 = /^[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NIP17_TIMESTAMP_LOOKBACK_SECONDS = 172_800;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Coordinator value is not canonical");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function bytes(hex: string, label: string): Uint8Array {
  if (!HEX_32.test(hex)) throw new Error(`${label} is not a 32-byte key`);
  return Uint8Array.from(hex.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

const defaultEntropy: CoordinatorEffectsEntropy = {
  messageId: () => crypto.randomUUID(),
  operationId: () => crypto.randomUUID(),
  ephemeralSecretKey: () => generateSecretKey(),
  nonce: () => crypto.getRandomValues(new Uint8Array(32)),
  randomizedTimestamp: (now) => now -
    Math.floor(crypto.getRandomValues(new Uint32Array(1))[0]! % 172_801),
  outerExpiration: (expiration) => expiration + 3_600
};

function bump(session: TradeSession, now: number): TradeSession {
  if (!Number.isSafeInteger(now) || now < session.updatedAt) {
    throw new Error("Coordinator effect time regressed");
  }
  const next = clone(session);
  next.revision += 1;
  next.updatedAt = now;
  return next;
}

function orderId(session: TradeSession): string {
  const id = session.orderAddress.split(":").at(-1);
  if (!id || !UUID_V4.test(id)) throw new Error("Trade order address lacks its order ID");
  return id;
}

function granolaTerms(session: TradeSession): GranolaTradeTerms {
  return {
    base_unit: session.terms.baseUnit,
    base_mint: session.terms.baseMint,
    base_keyset: session.terms.baseKeyset,
    quote_unit: session.terms.quoteUnit,
    quote_mint: session.terms.quoteMint,
    quote_keyset: session.terms.quoteKeyset,
    base_amount: session.terms.baseAmount,
    quote_amount: session.terms.quoteAmount,
    limit_price: clone(session.terms.price)
  };
}

function participant(
  session: TradeSession,
  field: "makerSessionPubkey" | "takerSessionPubkey" |
    "makerCashuPubkey" | "takerCashuPubkey" |
    "makerRefundPubkey" | "takerRefundPubkey"
): string {
  const value = session.privateState.transcript.choreography.participants[field];
  if (!value) throw new Error(`Trade participant ${field} is not checkpointed`);
  return value;
}

function localNostrPubkey(session: TradeSession): string {
  const key = bytes(session.privateState.nostrPrivateKey, "Trade Nostr private key");
  try {
    return getPublicKey(key);
  } finally {
    key.fill(0);
  }
}

function localCashuPubkey(session: TradeSession, kind: "cashu" | "refund"): string {
  const privateKey = kind === "cashu"
    ? session.privateState.cashuPrivateKey
    : session.privateState.refundPrivateKey;
  const key = bytes(privateKey, `Trade ${kind} private key`);
  try {
    return hex(getPubKeyFromPrivKey(key));
  } finally {
    key.fill(0);
  }
}

function expectedLock(session: TradeSession, leg: "base" | "quote"): ExpectedHtlcLock {
  const transcriptHash = session.privateState.settlementTranscriptHash;
  const hash = session.privateState.htlcHash;
  if (!transcriptHash || !hash) {
    throw new Error("Trade lock requires checkpointed settlement and HTLC hashes");
  }
  const base = leg === "base";
  const receiverPubkey = base
    ? participant(session, "takerCashuPubkey")
    : participant(session, "makerCashuPubkey");
  const refundPubkey = base
    ? participant(session, "makerRefundPubkey")
    : participant(session, "takerRefundPubkey");
  const locktime = base ? session.plan.longLocktime : session.plan.shortLocktime;
  return {
    mintUrl: base ? session.terms.baseMint : session.terms.quoteMint,
    unit: base ? session.terms.baseUnit : session.terms.quoteUnit,
    binding: {
      protocolVersion: "1",
      network: "cashu-testnet-v1",
      orderId: orderId(session),
      reservationId: session.reservationId,
      sessionId: session.sessionId,
      direction: leg,
      transcriptHash
    },
    amount: base ? session.terms.baseAmount : session.terms.quoteAmount,
    hash,
    receiverPubkey,
    refundPubkey,
    locktime,
    leg,
    refundHorizon: locktime + session.plan.refundGuardSeconds,
    deadlines: {
      short: session.plan.shortLocktime,
      long: session.plan.longLocktime,
      minimumGap: session.plan.longLocktime - session.plan.shortLocktime
    }
  };
}

function rootPhase(
  choreography: TradeSession["privateState"]["transcript"]["choreography"]
): TradeSession["phase"] {
  const phases: Record<typeof choreography.phase, TradeSession["phase"]> = {
    awaiting_reserve_propose: "negotiating",
    awaiting_reserve_accept: "negotiating",
    awaiting_session_ack: "reserved",
    awaiting_base_lock: "reserved",
    awaiting_base_lock_ack: "base_locked",
    awaiting_quote_lock: "base_locked",
    awaiting_quote_lock_ack: "quote_locked",
    awaiting_claim_notice: "quote_locked",
    awaiting_fill_request: "quote_claimed",
    awaiting_settlement_ack: "base_claimed",
    settled: "filled",
    refunding: "waiting_base_refund",
    failed: "frozen"
  };
  return phases[choreography.phase];
}

function publicationTimes(
  entry: OrderOutboxEntry,
  previous: TradeSession["pendingOrderPublication"],
  now: number
): Pick<
  NonNullable<TradeSession["pendingOrderPublication"]>,
  "stagedAt" | "transitionAcknowledgedAt" | "projectionAcknowledgedAt" | "committedAt"
> {
  const rank: Record<OrderPublicationStatus, number> = {
    staged: 0,
    transition_acknowledged: 1,
    projection_acknowledged: 2,
    committed: 3
  };
  return {
    stagedAt: previous?.stagedAt ?? entry.intent.createdAt,
    transitionAcknowledgedAt: rank[entry.status] >= 1
      ? previous?.transitionAcknowledgedAt ?? now
      : null,
    projectionAcknowledgedAt: rank[entry.status] >= 2
      ? previous?.projectionAcknowledgedAt ?? now
      : null,
    committedAt: rank[entry.status] >= 3
      ? previous?.committedAt ?? now
      : null
  };
}

function exactPendingPublication(
  session: TradeSession,
  entry: OrderOutboxEntry,
  now: number
): NonNullable<TradeSession["pendingOrderPublication"]> {
  const previous = session.pendingOrderPublication;
  if (
    entry.intent.address !== session.orderAddress ||
    entry.intent.orderId !== orderId(session) ||
    (entry.intent.operation !== "reserve" &&
      entry.intent.operation !== "fill" &&
      entry.intent.operation !== "release") ||
    (previous !== null && (
      previous.orderId !== entry.intent.orderId ||
      previous.transition.id !== entry.publication.transition.id ||
      previous.projection.id !== entry.publication.projection.id
    ))
  ) throw new Error("Order outbox entry conflicts with the trade session");
  return {
    operation: entry.intent.operation,
    orderId: entry.intent.orderId,
    transition: clone(entry.publication.transition),
    projection: clone(entry.publication.projection),
    transitionReceipts: clone(entry.publication.transitionReceipts),
    projectionReceipts: clone(entry.publication.projectionReceipts),
    status: entry.status,
    ...publicationTimes(entry, previous, now)
  };
}

function cashuResult(
  operation: PreparedTradeOperation,
  completed: CompletedLock | CompletedHtlcSpend
): CashuOperationResult {
  const proofs = (
    "lockedToken" in completed ? completed.change.proofs : completed.pocket.proofs
  ).map((proof): CashuOperationResult["proofs"][number] => {
    const base = {
      amount: proof.amount,
      id: proof.id,
      secret: proof.secret,
      C: proof.C
    };
    if (proof.dleq === undefined) return base;
    const dleq = proof.dleq as { e?: unknown; s?: unknown; r?: unknown };
    if (
      typeof dleq.e !== "string" ||
      typeof dleq.s !== "string" ||
      typeof dleq.r !== "string"
    ) throw new Error("Completed Cashu proof contains invalid DLEQ evidence");
    return { ...base, dleq: { e: dleq.e, s: dleq.s, r: dleq.r } };
  });
  if ("lockedToken" in completed) {
    return {
      walletMutation: "replace",
      mintUrl: completed.change.mintUrl,
      unit: completed.change.unit,
      proofs,
      lockedToken: completed.lockedToken,
      amount: completed.summary.amount,
      proofCount: completed.summary.proofCount
    };
  }
  return {
    walletMutation: "receive",
    mintUrl: completed.pocket.mintUrl,
    unit: completed.pocket.unit,
    proofs,
    lockedToken: null,
    amount: completed.summary.amount,
    proofCount: completed.summary.proofCount
  };
}

export class GranolaCoordinatorEffects implements CoordinatorEffectPort {
  private readonly orderApi: GranolaCoordinatorEffectsOptions["orderApi"];
  private readonly orderOutbox: GranolaCoordinatorEffectsOptions["orderOutbox"];
  private readonly orderReader: CoordinatorOrderReadPort;
  private readonly nostr: GranolaCoordinatorEffectsOptions["nostr"];
  private readonly cashu: GranolaCoordinatorEffectsOptions["cashu"];
  private readonly wallet: GranolaCoordinatorEffectsOptions["wallet"];
  private readonly reservations: GranolaCoordinatorEffectsOptions["reservations"];
  private readonly makerIdentity: CoordinatorMakerIdentity;
  private readonly discoveryRelays: string[];
  private readonly withWalletLock: WithWalletLock;
  private readonly entropy: CoordinatorEffectsEntropy;
  private readonly commitment: (value: string) => Promise<string>;

  constructor(options: GranolaCoordinatorEffectsOptions) {
    this.orderApi = options.orderApi;
    this.orderOutbox = options.orderOutbox;
    this.orderReader = options.orderReader;
    this.nostr = options.nostr;
    this.cashu = options.cashu;
    this.wallet = options.wallet;
    this.reservations = options.reservations;
    this.makerIdentity = options.makerIdentity;
    this.discoveryRelays = [...options.discoveryRelays];
    this.withWalletLock = options.withWalletLock;
    this.entropy = options.entropy ?? defaultEntropy;
    this.commitment = options.commitment ?? sha256;
  }

  classify(action: CoordinatorAction): "local" | "external" {
    return EXTERNAL_ACTIONS.has(action.kind) ? "external" : "local";
  }

  async externalFingerprintMaterial(
    action: CoordinatorAction,
    session: TradeSession
  ): Promise<unknown> {
    if (!action.kind.startsWith("prepare_")) return null;
    return this.withWalletLock(async () => {
      const wallet = await this.wallet.load();
      const reservations = await this.reservations.load();
      const leg = action.kind.includes("base") ? "base" : "quote";
      if (action.kind.endsWith("_lock")) {
        const pocket = unreservedPocket(
          wallet,
          reservations,
          leg === "base" ? session.terms.baseMint : session.terms.quoteMint,
          leg === "base" ? session.terms.baseUnit : session.terms.quoteUnit
        );
        return {
          walletRevision: wallet.revision,
          reservationRevision: reservations.revision,
          inputCommitment: await this.commitment(canonicalJson(
            pocket.proofs.map(({ amount, id, secret, C }) => ({ amount, id, secret, C }))
          )),
          expected: expectedLock(session, leg)
        };
      }
      const privateLeg = session.privateState.legs[leg];
      if (!privateLeg.token) throw new Error("Cashu spend preparation lacks its locked token");
      return {
        walletRevision: wallet.revision,
        reservationRevision: reservations.revision,
        tokenCommitment: session.evidence.legs[leg].tokenCommitment,
        expected: expectedLock(session, leg)
      };
    });
  }

  async applyLocal(input: CoordinatorStepInput): Promise<TradeSession> {
    const { action, session, now } = input;
    switch (action.kind) {
      case "stage_inbox_registration": {
        const key = bytes(session.privateState.nostrPrivateKey, "Trade Nostr private key");
        try {
          const event = this.nostr.createRegistration(key);
          const next = bump(session, now);
          next.privateState.inbox = {
            status: "staged",
            quorum: session.privateState.inbox.quorum,
            event,
            discoveryRelays: [...this.discoveryRelays],
            inboxRelays: event.tags.map((tag) => tag[1]!),
            receipts: [],
            readbacks: [],
            stagedAt: now,
            acknowledgedAt: null,
            registeredAt: null
          };
          return next;
        } finally {
          key.fill(0);
        }
      }
      case "commit_outbox":
        return this.commitOutbox(session, now);
      case "commit_incoming":
        return this.commitIncoming(session, now);
      case "clear_cashu_operation": {
        const operation = session.privateState.cashuOperation;
        if (operation?.status !== "wallet_applied") {
          throw new Error("Cashu operation is not reconciled");
        }
        const next = bump(session, now);
        next.privateState.cashuOperation = null;
        return next;
      }
      case "enter_recovery": {
        const next = bump(session, now);
        next.privateState.transcript.choreography.phase = "refunding";
        if (session.role === "maker" && session.privateState.legs.base.token !== null) {
          next.phase = "waiting_base_refund";
        } else if (
          session.role === "taker" &&
          session.privateState.legs.quote.token !== null
        ) {
          next.phase = "waiting_quote_refund";
        } else {
          next.phase = "frozen";
          next.privateState.transcript.choreography.phase = "failed";
        }
        return next;
      }
      default:
        throw new Error(`Coordinator action ${action.kind} is not a local effect`);
    }
  }

  async performExternal(input: CoordinatorExternalEffectInput): Promise<TradeSession> {
    const outgoingType = OUTGOING_ACTIONS.get(input.action.kind);
    if (outgoingType !== undefined) {
      return this.stageOutgoing(input.session, outgoingType, input.now);
    }
    switch (input.action.kind) {
      case "stage_order_reserve":
      case "stage_order_fill":
      case "stage_order_release":
        return this.stageOrder(input.session, input.action.kind, input.now);
      case "verify_order_fill":
        return this.verifyOrderFill(input.session, input.now);
      case "publish_order_transition":
      case "publish_order_projection":
        return this.publishOrderStage(input.session, input.now);
      case "commit_order_publication":
        return this.commitOrderPublication(input.session, input.now);
      case "clear_order_publication":
        return this.clearOrderPublication(input.session, input.now);
      case "publish_inbox_registration":
        return this.publishInbox(input.session, input.now, false);
      case "verify_inbox_registration":
        return this.publishInbox(input.session, input.now, true);
      case "deliver_outbox":
        return this.deliverOutbox(input.session, input.now);
      case "poll_inbox":
        return this.pollInbox(input.session, input.now);
      case "validate_incoming":
        return this.validateIncoming(input.session, input.now);
      case "reserve_cashu_inputs":
        return this.reserveCashuInputs(input.session, input.now);
      case "prepare_base_lock":
      case "prepare_quote_lock":
      case "prepare_base_claim":
      case "prepare_quote_claim":
      case "prepare_base_refund":
      case "prepare_quote_refund":
        return this.prepareCashu(input.session, input.action.kind, input.now);
      case "execute_cashu_operation":
        return this.executeCashu(input.session, input.now);
      case "reconcile_wallet":
        return this.reconcileWallet(input.session, input.now);
      case "observe_base":
      case "observe_quote":
        return this.observeLeg(
          input.session,
          input.action.kind === "observe_base" ? "base" : "quote",
          input.now
        );
      default:
        throw new Error(`Coordinator action ${input.action.kind} is not an external effect`);
    }
  }

  private async verifyOrderFill(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    if (
      session.role !== "taker" ||
      session.privateState.transcript.choreography.phase !== "settled" ||
      session.fillTransitionId === null ||
      session.evidence.fillTransitionId !== null
    ) {
      throw new Error("Taker fill verification is not checkpoint-ready");
    }
    const expectedFillId = session.fillTransitionId;
    const published = await this.orderReader.loadPublishedHead(
      session.orderAddress,
      expectedFillId
    );
    if (
      published.headEventId !== expectedFillId ||
      published.transition.id !== expectedFillId
    ) {
      throw new Error("Published order head does not match the announced fill");
    }

    const predecessor = await parseTransitionEvent(
      published.predecessor,
      verifyEvent
    );
    const transition = await parseTransitionEvent(
      published.transition,
      verifyEvent
    );
    const projection = await parseProjectionEvent(
      published.projection,
      verifyEvent
    );
    if (
      predecessor.makerPubkey !== session.evidence.makerPubkey ||
      transition.makerPubkey !== session.evidence.makerPubkey ||
      projection.makerPubkey !== session.evidence.makerPubkey ||
      predecessor.address !== session.orderAddress ||
      transition.address !== session.orderAddress ||
      projection.address !== session.orderAddress
    ) {
      throw new Error("Published fill maker or address does not match the trade");
    }
    const reservation = predecessor.state.reservation;
    if (
      predecessor.eventId !== session.reserveTransitionId ||
      predecessor.operation !== "reserve" ||
      reservation === null ||
      reservation.id !== session.reservationId ||
      reservation.amount !== session.terms.baseAmount
    ) {
      throw new Error("Published fill does not spend the exact reservation");
    }
    if (transition.operation !== "fill") {
      throw new Error("Published order head is not a fill");
    }
    const fillEvidence = transition.evidence as FillTransitionEvidence;
    if (
      transition.previous !== predecessor.eventId ||
      fillEvidence.settlement_hash !== session.privateState.htlcHash ||
      fillEvidence.base_token_commitment !==
        session.evidence.legs.base.tokenCommitment ||
      fillEvidence.quote_token_commitment !==
        session.evidence.legs.quote.tokenCommitment
    ) {
      throw new Error("Published fill does not match the exact settlement");
    }
    const expectedState = fillOrder(predecessor.state, {
      reservationId: session.reservationId,
      amount: session.terms.baseAmount
    });
    if (
      canonicalJson(transition.state) !== canonicalJson(expectedState) ||
      projection.headEventId !== transition.eventId ||
      canonicalJson(projection.state) !== canonicalJson(transition.state)
    ) {
      throw new Error("Published fill projection is not the exact current head");
    }

    const next = bump(session, now);
    next.evidence.fillTransitionId = expectedFillId;
    return next;
  }

  private async stageOrder(
    session: TradeSession,
    action: "stage_order_reserve" | "stage_order_fill" | "stage_order_release",
    now: number
  ): Promise<TradeSession> {
    if (session.pendingOrderPublication !== null) {
      throw new Error("Order publication is already checkpointed");
    }
    let progress: { orderId: string };
    if (action === "stage_order_reserve") {
      const proposalEventId = session.evidence.reservation.proposalSealId;
      const taker = participant(session, "takerSessionPubkey");
      if (!proposalEventId) throw new Error("Reserve staging lacks proposal evidence");
      const takerCommitment = await this.commitment(
        `granola-taker-v1:${session.sessionId}:${proposalEventId}:${taker}`
      );
      const request: PublishReserveInput = {
        address: session.orderAddress,
        expectedHeadId: session.offeredOrderHead,
        reservationId: session.reservationId,
        amount: session.terms.baseAmount,
        expiresAt: session.plan.reservationExpiresAt,
        proposalEventId,
        takerCommitment
      };
      progress = await this.orderApi.ensureReserveStaged(request);
    } else if (action === "stage_order_fill") {
      const settlementHash = session.privateState.htlcHash;
      const base = session.evidence.legs.base.tokenCommitment;
      const quote = session.evidence.legs.quote.tokenCommitment;
      if (!session.reserveTransitionId || !settlementHash || !base || !quote) {
        throw new Error("Fill staging lacks exact settlement evidence");
      }
      const request: PublishFillInput = {
        address: session.orderAddress,
        expectedHeadId: session.reserveTransitionId,
        reservationId: session.reservationId,
        amount: session.terms.baseAmount,
        evidence: {
          settlement_hash: settlementHash,
          base_token_commitment: base,
          quote_token_commitment: quote
        }
      };
      progress = await this.orderApi.ensureFillStaged(request);
    } else {
      if (!session.reserveTransitionId) {
        throw new Error("Release staging lacks the reserve head");
      }
      const request: PublishReleaseInput = {
        address: session.orderAddress,
        expectedHeadId: session.reserveTransitionId,
        reservationId: session.reservationId,
        reason: "expired"
      };
      progress = await this.orderApi.ensureReleaseStaged(request);
    }
    const entry = await this.requiredOrderEntry(progress.orderId);
    const next = bump(session, Math.max(now, entry.intent.createdAt));
    next.pendingOrderPublication = exactPendingPublication(session, entry, now);
    if (entry.intent.operation === "reserve") {
      const takerCommitment =
        (entry.intent.state.reservation as { taker_commitment?: string } | null)
          ?.taker_commitment;
      if (!takerCommitment || !HEX_32.test(takerCommitment)) {
        throw new Error("Staged reserve lacks the taker commitment");
      }
      next.reserveTransitionId = entry.publication.transition.id;
      next.evidence.reserveTransitionId = entry.publication.transition.id;
      next.evidence.reservation.takerCommitment = takerCommitment;
    } else if (entry.intent.operation === "fill") {
      next.fillTransitionId = entry.publication.transition.id;
      next.evidence.fillTransitionId = entry.publication.transition.id;
    }
    return next;
  }

  private async publishOrderStage(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const pending = session.pendingOrderPublication;
    if (!pending) throw new Error("Order publication is not checkpointed");
    const before = await this.requiredOrderEntry(pending.orderId);
    if (before.status !== pending.status) {
      const next = bump(session, now);
      next.pendingOrderPublication = exactPendingPublication(session, before, now);
      return next;
    }
    await this.orderApi.publishNextStage(pending.orderId);
    const entry = await this.requiredOrderEntry(pending.orderId);
    const next = bump(session, now);
    next.pendingOrderPublication = exactPendingPublication(session, entry, now);
    return next;
  }

  private async commitOrderPublication(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const pending = session.pendingOrderPublication;
    if (!pending || pending.status !== "projection_acknowledged") {
      throw new Error("Order projection is not acknowledged");
    }
    await this.orderApi.clearAcknowledgedOrderPublication(pending.orderId);
    const entry = await this.requiredOrderEntry(pending.orderId);
    const next = bump(session, now);
    next.pendingOrderPublication = exactPendingPublication(session, entry, now);
    if (entry.intent.operation === "reserve") {
      const takerCommitment =
        (entry.intent.state.reservation as { taker_commitment?: string } | null)
          ?.taker_commitment;
      if (!takerCommitment || !HEX_32.test(takerCommitment)) {
        throw new Error("Committed reserve lacks the taker commitment");
      }
      next.reserveTransitionId = entry.publication.transition.id;
      next.evidence.reserveTransitionId = entry.publication.transition.id;
      next.evidence.reservation.takerCommitment = takerCommitment;
    } else if (entry.intent.operation === "fill") {
      next.fillTransitionId = entry.publication.transition.id;
      next.evidence.fillTransitionId = entry.publication.transition.id;
    } else {
      next.phase = "released";
    }
    return next;
  }

  private async clearOrderPublication(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const pending = session.pendingOrderPublication;
    if (!pending || pending.status !== "committed") {
      throw new Error("Order publication is not committed");
    }
    await this.orderApi.pruneCommittedOrderPublication(pending.orderId);
    const next = bump(session, now);
    next.pendingOrderPublication = null;
    return next;
  }

  private async requiredOrderEntry(id: string): Promise<OrderOutboxEntry> {
    const entry = await this.orderOutbox.load(id);
    if (!entry) throw new Error("Shared order outbox lost its exact publication");
    return entry;
  }

  private async publishInbox(
    session: TradeSession,
    now: number,
    verify: boolean
  ): Promise<TradeSession> {
    const inbox = session.privateState.inbox;
    if (!inbox.event) throw new Error("Inbox registration is not checkpointed");
    const key = bytes(session.privateState.nostrPrivateKey, "Trade Nostr private key");
    try {
      const result = await this.nostr.publishRegistration(inbox.event, key);
      if (result.event.id !== inbox.event.id) {
        throw new Error("Inbox transport returned a replacement registration");
      }
      const next = bump(session, now);
      next.privateState.inbox = verify
        ? {
            ...clone(inbox),
            status: "registered",
            receipts: clone(result.receipts),
            readbacks: clone(result.readback),
            acknowledgedAt: inbox.acknowledgedAt ?? now,
            registeredAt: now
          }
        : {
            ...clone(inbox),
            status: "acknowledged",
            receipts: clone(result.receipts),
            readbacks: [],
            acknowledgedAt: now,
            registeredAt: null
          };
      return next;
    } finally {
      key.fill(0);
    }
  }

  private async stageOutgoing(
    session: TradeSession,
    type: AtomicSwapMessageType,
    now: number
  ): Promise<TradeSession> {
    if (session.privateState.outbox !== null) {
      throw new Error("An exact outgoing envelope is already checkpointed");
    }
    const recipient = this.outgoingRecipient(session, type);
    const requesterKey = bytes(
      session.privateState.nostrPrivateKey,
      "Trade Nostr private key"
    );
    let discovered: DiscoveredTradeInbox;
    try {
      discovered = await this.nostr.discoverInbox(recipient, requesterKey);
    } finally {
      requesterKey.fill(0);
    }
    const terms = granolaTerms(session);
    const hash = await termsHash(terms);
    const body = await this.outgoingBody(session, type, now);
    const expiresAt = Math.min(session.plan.reservationExpiresAt, now + 3_600);
    if (expiresAt <= now) throw new Error("Trade message deadline has passed");

    const stageWithKey = async (authorKey: Uint8Array): Promise<{
      message: GranolaTradeMessage;
      wrapped: WrappedTradeRumor;
      nextChoreography: TradeSession["privateState"]["transcript"]["choreography"];
      nextTranscriptHash: string;
    }> => {
      const message: GranolaTradeMessage = {
        schema: "granola/dm/v1",
        deployment: "cashu-testnet-v1",
        type,
        message_id: this.entropy.messageId(),
        session_id: session.sessionId,
        reservation_id: session.reservationId,
        order_address: session.orderAddress,
        order_head: session.reserveTransitionId ?? session.offeredOrderHead,
        maker_order_pubkey: session.evidence.makerPubkey,
        author_pubkey: getPublicKey(authorKey),
        recipient_pubkey: recipient,
        sequence: session.privateState.transcript.nextSequence,
        previous_message_id: session.privateState.transcript.lastMessageId,
        previous_transcript_hash:
          session.privateState.transcript.lastTranscriptHash,
        sent_at: now,
        expires_at: expiresAt,
        terms_hash: hash,
        ...(type === "reserve_propose" || type === "reserve_accept"
          ? { terms }
          : {}),
        body
      };
      const checked = await validateAtomicSwapMessage(message);
      const nextChoreography = await advanceAtomicSwapChoreography(
        session.privateState.transcript.choreography,
        checked
      );
      const rumor = await createTradeRumor(
        message,
        authorKey,
        session.privateState.transcript.lastRumorId ?? undefined
      );
      const wrapped = wrapTradeRumor(rumor, authorKey, {
        ephemeralSecretKey: this.entropy.ephemeralSecretKey(),
        sealCreatedAt: this.entropy.randomizedTimestamp(now, "seal"),
        wrapperCreatedAt: this.entropy.randomizedTimestamp(now, "wrapper"),
        outerExpiration: this.entropy.outerExpiration(expiresAt),
        sealNonce: this.entropy.nonce("seal"),
        wrapperNonce: this.entropy.nonce("wrapper")
      });
      return {
        message,
        wrapped,
        nextChoreography,
        nextTranscriptHash: await transcriptHash(
          session.privateState.transcript.lastTranscriptHash,
          rumor.id
        )
      };
    };

    const staged = type === "reserve_accept"
      ? await this.makerIdentity.useSecretKey(stageWithKey)
      : await this.withSessionKey(session, stageWithKey);
    const next = bump(session, now);
    next.privateState.outbox = {
      message: staged.message,
      rumor: staged.wrapped.rumor,
      seal: staged.wrapped.seal,
      wrapper: staged.wrapped.wrapper,
      recipientInboxListId: discovered.eventId,
      recipientRelays: [...discovered.relays],
      receipts: [],
      nextChoreography: staged.nextChoreography,
      status: "staged"
    };
    if (type === "reserve_accept") {
      next.privateState.htlcHash = session.privateState.htlcHash;
    }
    return next;
  }

  private outgoingRecipient(
    session: TradeSession,
    type: AtomicSwapMessageType
  ): string {
    if (type === "reserve_propose") return session.evidence.makerPubkey;
    if (type === "reserve_accept") return participant(session, "takerSessionPubkey");
    return session.role === "maker"
      ? participant(session, "takerSessionPubkey")
      : participant(session, "makerSessionPubkey");
  }

  private async outgoingBody(
    session: TradeSession,
    type: AtomicSwapMessageType,
    now: number
  ): Promise<AtomicSwapBody> {
    const schema = "granola/atomic-swap-body/v1" as const;
    const transcript = session.privateState.transcript;
    const htlcHash = session.privateState.htlcHash;
    const base = session.evidence.legs.base;
    const quote = session.evidence.legs.quote;
    switch (type) {
      case "reserve_propose":
        return {
          schema,
          taker_session_pubkey: localNostrPubkey(session),
          taker_cashu_pubkey: localCashuPubkey(session, "cashu"),
          taker_refund_pubkey: localCashuPubkey(session, "refund"),
          fill_amount: session.terms.baseAmount
        };
      case "reserve_accept":
        if (!session.reserveTransitionId || !htlcHash) {
          throw new Error("Reserve acceptance lacks committed reserve and settlement hash");
        }
        return {
          schema,
          taker_session_pubkey: participant(session, "takerSessionPubkey"),
          maker_session_pubkey: localNostrPubkey(session),
          maker_cashu_pubkey: localCashuPubkey(session, "cashu"),
          maker_refund_pubkey: localCashuPubkey(session, "refund"),
          reserve_transition_id: session.reserveTransitionId,
          settlement_hash: htlcHash,
          short_locktime: session.plan.shortLocktime,
          maker_claim_cutoff: session.plan.makerClaimCutoff,
          long_locktime: session.plan.longLocktime,
          taker_claim_cutoff: session.plan.takerClaimCutoff,
          reservation_expires_at: session.plan.reservationExpiresAt
        };
      case "session_ack":
        if (!session.reserveTransitionId || !htlcHash ||
          !transcript.lastMessageId || !transcript.lastTranscriptHash) {
          throw new Error("Session acknowledgement lacks reserve evidence");
        }
        return {
          schema,
          reserve_accept_message_id: transcript.lastMessageId,
          reserve_accept_transcript_hash: transcript.lastTranscriptHash,
          reserve_transition_id: session.reserveTransitionId,
          settlement_hash: htlcHash
        };
      case "base_lock":
      case "quote_lock": {
        const leg = type === "base_lock" ? "base" : "quote";
        const evidence = session.evidence.legs[leg];
        const privateLeg = session.privateState.legs[leg];
        const expected = privateLeg.expected;
        if (!privateLeg.token || !expected || !evidence.tokenCommitment ||
          !evidence.validationCommitment || !htlcHash) {
          throw new Error(`${leg} lock lacks completed Cashu evidence`);
        }
        return {
          schema,
          cashu_token: privateLeg.token,
          token_commitment: evidence.tokenCommitment,
          validation_commitment: evidence.validationCommitment,
          settlement_hash: htlcHash,
          mint: expected.mintUrl,
          unit: expected.unit,
          keyset: evidence.keysetId,
          amount: expected.amount,
          receiver_cashu_pubkey: expected.receiverPubkey,
          refund_cashu_pubkey: expected.refundPubkey,
          locktime: expected.locktime
        };
      }
      case "base_lock_ack":
      case "quote_lock_ack": {
        const leg = type === "base_lock_ack" ? "base" : "quote";
        const evidence = session.evidence.legs[leg];
        if (!transcript.lastMessageId || !transcript.lastTranscriptHash ||
          !evidence.tokenCommitment || !evidence.validationCommitment || !htlcHash) {
          throw new Error(`${leg} lock acknowledgement lacks exact evidence`);
        }
        return {
          schema,
          lock_message_id: transcript.lastMessageId,
          lock_transcript_hash: transcript.lastTranscriptHash,
          token_commitment: evidence.tokenCommitment,
          validation_commitment: evidence.validationCommitment,
          settlement_hash: htlcHash
        };
      }
      case "claim_notice":
        if (!quote.tokenCommitment || !quote.claimOperationCommitment || !htlcHash) {
          throw new Error("Claim notice lacks quote claim evidence");
        }
        return {
          schema,
          quote_token_commitment: quote.tokenCommitment,
          claim_operation_commitment: quote.claimOperationCommitment,
          settlement_hash: htlcHash,
          claimed_at: now
        };
      case "fill_request":
        if (!base.tokenCommitment || !quote.tokenCommitment ||
          !base.spendCommitment || !quote.spendCommitment || !htlcHash) {
          throw new Error("Fill request lacks independently observed spends");
        }
        return {
          schema,
          base_token_commitment: base.tokenCommitment,
          quote_token_commitment: quote.tokenCommitment,
          base_spend_commitment: base.spendCommitment,
          quote_spend_commitment: quote.spendCommitment,
          settlement_hash: htlcHash
        };
      case "settlement_ack":
        if (!session.fillTransitionId || !base.tokenCommitment ||
          !quote.tokenCommitment || !htlcHash) {
          throw new Error("Settlement acknowledgement lacks the committed fill");
        }
        return {
          schema,
          fill_transition_id: session.fillTransitionId,
          base_token_commitment: base.tokenCommitment,
          quote_token_commitment: quote.tokenCommitment,
          settlement_hash: htlcHash
        };
      default:
        throw new Error(`No happy-path body exists for ${type}`);
    }
  }

  private async deliverOutbox(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const outbox = session.privateState.outbox;
    if (!outbox || outbox.status !== "staged") {
      throw new Error("Outgoing envelope is not staged");
    }
    const keyHex = outbox.message.type === "reserve_accept"
      ? null
      : session.privateState.nostrPrivateKey;
    const send = async (key: Uint8Array) =>
      this.nostr.send(outbox.wrapper, outbox.recipientRelays, key);
    const receipts = keyHex === null
      ? await this.makerIdentity.useSecretKey(send)
      : await this.withSessionKey(session, send);
    const next = bump(session, now);
    next.privateState.outbox = {
      ...clone(outbox),
      receipts: clone(receipts),
      status: "acknowledged"
    };
    return next;
  }

  private async pollInbox(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    if (session.privateState.pendingIncoming !== null) {
      throw new Error("An incoming message is already checkpointed");
    }
    const recipient = localNostrPubkey(session);
    const key = bytes(session.privateState.nostrPrivateKey, "Trade Nostr private key");
    let wrappers: NostrEvent[];
    try {
      wrappers = await this.nostr.read(
        recipient,
        key,
        Math.max(0, session.updatedAt - NIP17_TIMESTAMP_LOOKBACK_SECONDS)
      );
    } finally {
      key.fill(0);
    }
    if (wrappers.length === 0) {
      throw new Error("No private trade message is available");
    }
    let opened: OpenedTradeMessage | null = null;
    for (const wrapper of wrappers) {
      try {
        const candidate = await this.openIncoming(session, wrapper, now);
        if (session.privateState.transcript.accepted.some(
          ({ messageId, rumorId }) =>
            messageId === candidate.message.message_id ||
            rumorId === candidate.rumor.id
        )) continue;
        opened = candidate;
        break;
      } catch {
        // NIP-17 timestamp randomization requires a lookback, so old and noisy
        // wrappers are expected. Only the exact next transcript message wins.
      }
    }
    if (opened === null) {
      throw new Error("No next private trade message is available");
    }
    const next = bump(session, now);
    next.privateState.pendingIncoming = {
      wrapper: opened.wrapper,
      seal: opened.seal,
      rumor: opened.rumor,
      message: opened.message,
      transcriptHash: opened.transcriptHash,
      receivedAt: now,
      validation: { status: "unvalidated", checkedAt: null, error: null }
    };
    return next;
  }

  private async openIncoming(
    session: TradeSession,
    wrapper: NostrEvent,
    now: number
  ): Promise<OpenedTradeMessage> {
    const transcript = session.privateState.transcript;
    const key = bytes(session.privateState.nostrPrivateKey, "Trade Nostr private key");
    try {
      const expectedTermsHash = await termsHash(granolaTerms(session));
      if (
        session.role === "taker" &&
        transcript.choreography.phase === "awaiting_reserve_accept"
      ) {
        return unwrapReserveAcceptance(wrapper, key, {
          now,
          expectedAuthorPubkey: session.evidence.makerPubkey,
          expectedOrderAddress: session.orderAddress,
          expectedTermsHash,
          expectedPreviousRumorId: transcript.lastRumorId!,
          expectedPreviousMessageId: transcript.lastMessageId!,
          expectedPreviousTranscriptHash: transcript.lastTranscriptHash!
        });
      }
      const counterparty = session.role === "maker"
        ? participant(session, "takerSessionPubkey")
        : participant(session, "makerSessionPubkey");
      return unwrapTradeMessage(wrapper, key, {
        now,
        expectedAuthorPubkey: counterparty,
        expectedOrderAddress: session.orderAddress,
        expectedOrderHead: session.reserveTransitionId ?? session.offeredOrderHead,
        expectedTermsHash,
        expectedSequence: transcript.nextSequence,
        ...(transcript.lastRumorId === null
          ? {}
          : { expectedPreviousRumorId: transcript.lastRumorId }),
        ...(transcript.lastMessageId === null
          ? {}
          : { expectedPreviousMessageId: transcript.lastMessageId }),
        ...(transcript.lastTranscriptHash === null
          ? {}
          : { expectedPreviousTranscriptHash: transcript.lastTranscriptHash })
      });
    } finally {
      key.fill(0);
    }
  }

  private async validateIncoming(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const pending = session.privateState.pendingIncoming;
    if (!pending || pending.validation.status !== "unvalidated") {
      throw new Error("Incoming message is not awaiting validation");
    }
    const opened = await this.openIncoming(session, pending.wrapper, now);
    if (
      opened.seal.id !== pending.seal.id ||
      opened.rumor.id !== pending.rumor.id ||
      opened.message.message_id !== pending.message.message_id ||
      opened.transcriptHash !== pending.transcriptHash
    ) throw new Error("Incoming retry opened a different exact message");
    const checked = await validateAtomicSwapMessage(opened.message);
    await advanceAtomicSwapChoreography(
      session.privateState.transcript.choreography,
      checked
    );
    const next = bump(session, now);
    next.privateState.pendingIncoming = {
      ...clone(pending),
      validation: { status: "validated", checkedAt: now, error: null }
    };
    if (checked.type === "base_lock" || checked.type === "quote_lock") {
      const leg = checked.type === "base_lock" ? "base" : "quote";
      const body = checked.body as AtomicSwapBody<"base_lock">;
      const expected = expectedLock({
        ...session,
        privateState: {
          ...session.privateState,
          htlcHash: session.privateState.htlcHash ?? body.settlement_hash
        }
      }, leg);
      const summary = await this.cashu.validateIncomingLock(body.cashu_token, expected);
      if (
        summary.commitment !== body.validation_commitment ||
        summary.keysetId !== body.keyset ||
        summary.amount !== body.amount
      ) throw new Error("Incoming Cashu validation differs from the signed lock body");
      next.privateState.htlcHash ??= body.settlement_hash;
      next.privateState.legs[leg] = {
        ...next.privateState.legs[leg],
        token: body.cashu_token,
        expected,
        observations: [
          ...next.privateState.legs[leg].observations,
          {
            observedAt: now,
            state: "UNSPENT",
            proofCount: summary.proofCount,
            witnessCommitment: null
          }
        ]
      };
      next.evidence.legs[leg] = {
        ...next.evidence.legs[leg],
        tokenCommitment: body.token_commitment,
        validationCommitment: body.validation_commitment,
        proofCount: summary.proofCount,
        fee: summary.fee,
        mintState: "UNSPENT",
        observedAt: now
      };
    }
    return next;
  }

  private async commitIncoming(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const pending = session.privateState.pendingIncoming;
    if (!pending || pending.validation.status !== "validated") {
      throw new Error("Incoming message is not validated");
    }
    const message = await validateAtomicSwapMessage(pending.message);
    const choreography = await advanceAtomicSwapChoreography(
      session.privateState.transcript.choreography,
      message
    );
    const next = bump(session, now);
    next.privateState.transcript = {
      choreography,
      nextSequence: (BigInt(session.privateState.transcript.nextSequence) + 1n)
        .toString(),
      lastRumorId: pending.rumor.id,
      lastMessageId: pending.message.message_id,
      lastTranscriptHash: pending.transcriptHash,
      accepted: [
        ...clone(session.privateState.transcript.accepted),
        {
          sequence: pending.message.sequence,
          messageId: pending.message.message_id,
          rumorId: pending.rumor.id,
          transcriptHash: pending.transcriptHash
        }
      ]
    };
    next.privateState.pendingIncoming = null;
    next.phase = rootPhase(choreography);
    if (message.type === "reserve_accept") {
      const body = message.body as AtomicSwapBody<"reserve_accept">;
      next.reserveTransitionId = body.reserve_transition_id;
      next.evidence.reserveTransitionId = body.reserve_transition_id;
      next.evidence.reservation.takerCommitment ??=
        await this.commitment(
          `granola-taker-v1:${session.sessionId}:` +
          `${session.evidence.reservation.proposalSealId ?? ""}:` +
          `${participant(session, "takerSessionPubkey")}`
        );
      next.privateState.htlcHash = body.settlement_hash;
      if (!next.evidence.commitments.includes(body.settlement_hash)) {
        next.evidence.commitments.push(body.settlement_hash);
      }
    }
    if (message.type === "session_ack") {
      next.privateState.settlementTranscriptHash = pending.transcriptHash;
    }
    if (message.type === "settlement_ack") {
      const body = message.body as AtomicSwapBody<"settlement_ack">;
      next.fillTransitionId = body.fill_transition_id;
    }
    return next;
  }

  private async commitOutbox(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const outbox = session.privateState.outbox;
    if (!outbox || outbox.status !== "acknowledged") {
      throw new Error("Outgoing message is not acknowledged");
    }
    const hash = await transcriptHash(
      session.privateState.transcript.lastTranscriptHash,
      outbox.rumor.id
    );
    const next = bump(session, now);
    next.privateState.transcript = {
      choreography: clone(outbox.nextChoreography),
      nextSequence: (BigInt(session.privateState.transcript.nextSequence) + 1n)
        .toString(),
      lastRumorId: outbox.rumor.id,
      lastMessageId: outbox.message.message_id,
      lastTranscriptHash: hash,
      accepted: [
        ...clone(session.privateState.transcript.accepted),
        {
          sequence: outbox.message.sequence,
          messageId: outbox.message.message_id,
          rumorId: outbox.rumor.id,
          transcriptHash: hash
        }
      ]
    };
    next.privateState.outbox = null;
    next.phase = rootPhase(outbox.nextChoreography);
    if (outbox.message.type === "session_ack") {
      next.privateState.settlementTranscriptHash = hash;
    }
    if (outbox.message.type === "reserve_propose") {
      next.evidence.reservation.proposalSealId = outbox.seal.id;
    }
    return next;
  }

  private async prepareCashu(
    session: TradeSession,
    action:
      | "prepare_base_lock" | "prepare_quote_lock"
      | "prepare_base_claim" | "prepare_quote_claim"
      | "prepare_base_refund" | "prepare_quote_refund",
    now: number
  ): Promise<TradeSession> {
    const leg = action.includes("base") ? "base" : "quote";
    const expected = expectedLock(session, leg);
    return this.withWalletLock(async () => {
      const walletBefore = await this.wallet.load();
      const reservations = await this.reservations.load();
      let artifact: PreparedTradeOperation;
      if (action.endsWith("_lock")) {
        const pocket = unreservedPocket(
          walletBefore,
          reservations,
          expected.mintUrl,
          expected.unit
        );
        artifact = await this.cashu.prepareOutgoingLock({ pocket, expected, now });
      } else {
        const token = session.privateState.legs[leg].token;
        if (!token) throw new Error("Cashu spend preparation lacks its locked token");
        if (action.endsWith("_claim")) {
          const preimage = session.privateState.preimage;
          if (!preimage) throw new Error("Cashu claim lacks its preimage");
          artifact = await this.cashu.prepareClaim({
            token,
            expected,
            preimage,
            settlementPrivateKey: session.privateState.cashuPrivateKey,
            now,
            claimCutoff: leg === "base"
              ? session.plan.takerClaimCutoff
              : session.plan.makerClaimCutoff
          });
        } else {
          artifact = await this.cashu.prepareRefund({
            token,
            expected,
            refundPrivateKey: session.privateState.refundPrivateKey,
            locktime: expected.locktime,
            now,
            expiryGrace: session.plan.refundGuardSeconds
          });
        }
      }
      const walletAfter = await this.wallet.load();
      if (canonicalJson(walletAfter) !== canonicalJson(walletBefore)) {
        throw new Error("Cashu preparation mutated the wallet before checkpointing");
      }
      const next = bump(session, now);
      next.privateState.legs[leg].expected = expected;
      next.privateState.cashuOperation = {
        operationId: this.entropy.operationId(),
        leg,
        kind: artifact.kind,
        status: "prepared",
        preparedAt: now,
        inputsReserved: false,
        artifact,
        result: null
      };
      if (artifact.kind === "claim") {
        next.evidence.legs[leg].claimOperationCommitment =
          artifact.operationCommitment;
      } else if (artifact.kind === "refund") {
        next.evidence.legs[leg].refundOperationCommitment =
          artifact.operationCommitment;
      }
      return next;
    });
  }

  private async reserveCashuInputs(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const operation = session.privateState.cashuOperation;
    if (!operation || operation.status !== "prepared" || operation.inputsReserved) {
      throw new Error("Cashu inputs are not awaiting reservation");
    }
    await this.withWalletLock(async () => {
      const reservations = await this.reservations.load();
      await this.reservations.reserve(reservations.revision, {
        sessionId: session.sessionId,
        mintUrl: operation.artifact.mintUrl,
        unit: operation.artifact.unit,
        proofSecrets: operation.artifact.spentSecrets,
        reservedAt: operation.preparedAt
      });
    });
    const next = bump(session, now);
    next.privateState.cashuOperation!.inputsReserved = true;
    return next;
  }

  private async executeCashu(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const operation = session.privateState.cashuOperation;
    if (!operation || operation.status !== "prepared" || !operation.inputsReserved) {
      throw new Error("Cashu operation is not checkpointed for execution");
    }
    let completed: CompletedLock | CompletedHtlcSpend;
    if (operation.kind === "outgoing-lock") {
      completed = await this.cashu.completeOutgoingLock(
        operation.artifact,
        operation.artifact.expected
      );
    } else if (operation.kind === "claim") {
      completed = await this.cashu.completeClaim(
        operation.artifact,
        session.privateState.cashuPrivateKey,
        operation.artifact.expected
      );
    } else {
      completed = await this.cashu.completeRefund(
        operation.artifact,
        session.privateState.refundPrivateKey,
        operation.artifact.expected
      );
    }
    const next = bump(session, now);
    next.privateState.cashuOperation = {
      ...clone(operation),
      status: "completed",
      result: cashuResult(operation.artifact, completed)
    };
    if ("lockedToken" in completed) {
      const leg = operation.leg;
      const tokenCommitment = await this.commitment(completed.lockedToken);
      next.privateState.legs[leg].token = completed.lockedToken;
      next.privateState.legs[leg].observations.push({
        observedAt: now,
        state: "UNSPENT",
        proofCount: completed.summary.proofCount,
        witnessCommitment: null
      });
      next.evidence.legs[leg] = {
        ...next.evidence.legs[leg],
        tokenCommitment,
        validationCommitment: completed.summary.commitment,
        proofCount: completed.summary.proofCount,
        fee: completed.summary.fee,
        mintState: "UNSPENT",
        observedAt: now
      };
    }
    return next;
  }

  private async reconcileWallet(
    session: TradeSession,
    now: number
  ): Promise<TradeSession> {
    const operation = session.privateState.cashuOperation;
    if (!operation || operation.status !== "completed" || operation.result === null) {
      throw new Error("Cashu result is not checkpointed for reconciliation");
    }
    await this.withWalletLock(async () => {
      const wallet = await this.wallet.load();
      const output = {
        mintUrl: operation.result!.mintUrl,
        unit: operation.result!.unit,
        proofs: clone(operation.result!.proofs)
      };
      const reconciled = operation.result!.walletMutation === "replace"
        ? reconcileProofReplacement(wallet, {
            ...output,
            spentSecrets: operation.artifact.spentSecrets
          })
        : reconcileExactProofOutputs(wallet, output);
      if (reconciled !== wallet) await this.wallet.save(reconciled);
      const reservations = await this.reservations.load();
      await this.reservations.release(reservations.revision, {
        sessionId: session.sessionId,
        proofSecrets: operation.artifact.spentSecrets
      });
    });
    const next = bump(session, now);
    next.privateState.cashuOperation!.status = "wallet_applied";
    return next;
  }

  private async observeLeg(
    session: TradeSession,
    leg: "base" | "quote",
    now: number
  ): Promise<TradeSession> {
    const privateLeg = session.privateState.legs[leg];
    const evidence = session.evidence.legs[leg];
    if (!privateLeg.token || !privateLeg.expected || !evidence.tokenCommitment) {
      throw new Error(`Trade ${leg} leg lacks its exact locked token`);
    }
    const observed = await this.cashu.observeSpentInternal(
      privateLeg.token,
      privateLeg.expected,
      evidence.tokenCommitment
    );
    let witnessCommitment: string | null = null;
    if (observed.status === "SPENT") {
      if (!verifyHTLCHash(observed.preimage, privateLeg.expected.hash)) {
        throw new Error("Observed Cashu preimage does not match the locked hash");
      }
      witnessCommitment = await this.commitment(
        `granola-spend-v1:${leg}:${observed.preimage}`
      );
    }
    const next = bump(session, now);
    next.privateState.legs[leg].observations.push({
      observedAt: now,
      state: observed.status as PersistedMintState,
      proofCount: observed.proofCount,
      witnessCommitment
    });
    next.evidence.legs[leg] = {
      ...next.evidence.legs[leg],
      mintState: observed.status,
      observedAt: now,
      proofCount: observed.proofCount,
      spendCommitment: witnessCommitment
    };
    if (observed.status === "SPENT" && session.role === "taker" && leg === "quote") {
      next.privateState.preimage = observed.preimage;
    }
    return next;
  }

  private async withSessionKey<T>(
    session: TradeSession,
    action: (key: Uint8Array) => Promise<T>
  ): Promise<T> {
    const key = bytes(session.privateState.nostrPrivateKey, "Trade Nostr private key");
    try {
      return await action(key);
    } finally {
      key.fill(0);
    }
  }
}
