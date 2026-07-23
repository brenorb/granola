import { verifyEvent } from "nostr-tools/pure";

import {
  createOrderState,
  fillOrder as fillOrderState,
  releaseOrder as releaseOrderState,
  reserveOrder as reserveOrderState,
  type CreateOrderInput,
  type ExactMarket,
  type FillOrderInput,
  type OrderState,
  type ReserveOrderInput
} from "../order/model.js";
import {
  parseTransitionEvent,
  type FillTransitionEvidence,
  type NostrEvent,
  type TransitionEvidence,
  type TransitionRecord
} from "../order/events.js";
import type {
  LoadedOrderBook,
  SuccessorOperation,
  StagedOrderPublication
} from "../order/service.js";
import {
  canonicalOrderPublicationCompatibility,
  type OrderOutboxEntry,
  type OrderOutboxPort,
  type OrderPublicationIntent,
  type OrderPublicationStatus
} from "../storage/order-outbox.js";
import {
  assertAuthenticatedOpenedTradeMessage,
  assertVerifiedInitialReserveProposal,
  type OpenedTradeMessage,
  type VerifiedInitialReserveProposal
} from "../trade/messages.js";

export const TEST_MARKET: ExactMarket = {
  baseUnit: "sat",
  baseMint: "https://testnut.cashu.space",
  quoteUnit: "usd",
  quoteMint: "https://nofee.testnut.cashu.space"
};

export interface MakerIdentityPort {
  publicKey(): Promise<string>;
}

export interface OrderServicePort {
  stage(state: OrderState): Promise<StagedOrderPublication>;
  stageSuccessor(
    state: OrderState,
    operation: SuccessorOperation,
    previous: NostrEvent,
    evidence?: TransitionEvidence,
    createdAt?: number
  ): Promise<StagedOrderPublication>;
  publishNextStage(entry: OrderOutboxEntry): Promise<OrderOutboxEntry>;
  publicationQuorum(): number;
  loadCurrentTransition(address: string, expectedHeadId: string): Promise<NostrEvent>;
  loadBook(market: ExactMarket, now: number): Promise<LoadedOrderBook>;
}

export interface PublishOrderInput {
  side: "buy" | "sell";
  amount: string;
  priceCentsPerBtc: string;
  expiresAt?: number;
  execution?: "all_or_none" | "partial";
  minimumFillAmount?: string;
}

export interface PublicOrderPublication {
  orderId: string;
  makerPubkey: string;
  transitionId: string;
  projectionId: string;
  transitionReceipts: StagedOrderPublication["transitionReceipts"];
  projectionReceipts: StagedOrderPublication["projectionReceipts"];
}

export interface PublishReserveInput extends Omit<ReserveOrderInput, "acceptedAt"> {
  address: string;
  expectedHeadId: string;
}

export interface PublishFillInput extends FillOrderInput {
  address: string;
  expectedHeadId: string;
  evidence: FillTransitionEvidence;
}

interface PublishReleaseHead {
  address: string;
  expectedHeadId: string;
}

export type PublishReleaseInput = PublishReleaseHead & (
  | {
      reservationId: string;
      reason: "expired";
      abortEventId?: never;
    }
  | {
      reservationId: string;
      reason: "abort";
      proposalMessage: VerifiedInitialReserveProposal;
      abortMessage: OpenedTradeMessage;
    }
);

function publicPublication(publication: StagedOrderPublication): PublicOrderPublication {
  return {
    orderId: publication.state.order_id,
    makerPubkey: publication.projection.pubkey,
    transitionId: publication.transition.id,
    projectionId: publication.projection.id,
    transitionReceipts: publication.transitionReceipts,
    projectionReceipts: publication.projectionReceipts
  };
}

export interface OrderPublicationProgress extends PublicOrderPublication {
  status: OrderPublicationStatus;
}

function publicProgress(entry: OrderOutboxEntry): OrderPublicationProgress {
  return { ...publicPublication(entry.publication), status: entry.status };
}

function orderAssets(side: PublishOrderInput["side"]): Pick<CreateOrderInput, "offered" | "requested"> {
  return side === "sell"
    ? {
        offered: { unit: TEST_MARKET.baseUnit, mint: TEST_MARKET.baseMint },
        requested: {
          unit: TEST_MARKET.quoteUnit,
          acceptableMints: [TEST_MARKET.quoteMint]
        }
      }
    : {
        offered: { unit: TEST_MARKET.quoteUnit, mint: TEST_MARKET.quoteMint },
        requested: {
          unit: TEST_MARKET.baseUnit,
          acceptableMints: [TEST_MARKET.baseMint]
        }
      };
}

function reserveCompatibility(input: PublishReserveInput): string {
  return canonicalOrderPublicationCompatibility({
    operation: "reserve",
    reservationId: input.reservationId,
    amount: input.amount,
    expiresAt: input.expiresAt,
    proposalEventId: input.proposalEventId,
    takerCommitment: input.takerCommitment
  });
}

function fillCompatibility(input: PublishFillInput): string {
  return canonicalOrderPublicationCompatibility({
    operation: "fill",
    reservationId: input.reservationId,
    amount: input.amount,
    evidence: input.evidence
  });
}

function releaseCompatibility(input: PublishReleaseInput): string {
  if (input.reason === "expired") {
    return canonicalOrderPublicationCompatibility({
      operation: "release",
      reservationId: input.reservationId,
      reason: input.reason
    });
  }
  assertVerifiedInitialReserveProposal(input.proposalMessage);
  assertAuthenticatedOpenedTradeMessage(input.abortMessage);
  return canonicalOrderPublicationCompatibility({
    operation: "release",
    reservationId: input.reservationId,
    reason: input.reason,
    proposalEventId: input.proposalMessage.seal.id,
    abortEventId: input.abortMessage.seal.id
  });
}

export class OrderApi {
  private readonly successorQueues = new Map<string, Promise<void>>();
  private readonly outbox: OrderOutboxPort;

  constructor(
    private readonly identity: MakerIdentityPort,
    private readonly orders: OrderServicePort,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly orderId: () => string = () => crypto.randomUUID(),
    outbox: OrderOutboxPort | undefined = undefined,
    private readonly verify: (event: NostrEvent) => boolean = (event) => verifyEvent(event)
  ) {
    if (!outbox) throw new Error("Order API requires a durable publication outbox");
    this.outbox = outbox;
  }

  async getMakerIdentity(): Promise<{ publicKey: string }> {
    return { publicKey: await this.identity.publicKey() };
  }

  async getOrderBook(): Promise<LoadedOrderBook> {
    return this.orders.loadBook(TEST_MARKET, this.now());
  }

  async getPendingOrderPublications(): Promise<PublicOrderPublication[]> {
    return (await this.outbox.list())
      .filter((entry) => entry.status !== "committed")
      .map((entry) => publicPublication(entry.publication));
  }

  private async existingCompatible(
    operation: OrderPublicationIntent["operation"],
    address: string,
    expectedHeadId: string | null,
    compatibility: string
  ): Promise<OrderOutboxEntry | undefined> {
    const entries = (await this.outbox.list()).filter(
      (entry) => entry.intent.address === address
    );
    if (entries.length > 1) throw new Error("Order has conflicting pending publications");
    const existing = entries[0];
    if (!existing) return undefined;
    if (
      existing.intent.operation !== operation ||
      existing.intent.expectedHeadId !== expectedHeadId ||
      existing.intent.compatibility !== compatibility
    ) {
      if (existing.status === "committed") return undefined;
      throw new Error("Order publication intent conflicts with the durable outbox");
    }
    return existing;
  }

  async publishNextStage(orderId: string): Promise<OrderPublicationProgress> {
    const initial = await this.outbox.load(orderId);
    if (!initial || initial.status === "committed") {
      throw new Error("No pending publication exists for this order ID");
    }
    return this.serializeSuccessor(initial.intent.address, async () => {
      const current = await this.outbox.load(orderId);
      if (!current || current.status === "committed") {
        throw new Error("No pending publication exists for this order ID");
      }
      if (
        current.publication.transition.id !== initial.publication.transition.id ||
        current.publication.projection.id !== initial.publication.projection.id
      ) {
        throw new Error("Pending publication changed while waiting to advance");
      }
      const advanced = await this.orders.publishNextStage(current);
      return publicProgress(await this.outbox.recordProgress(advanced));
    });
  }

  async loadAcknowledgedOrderPublication(
    orderId: string
  ): Promise<OrderPublicationProgress | undefined> {
    const entry = await this.outbox.loadAcknowledged(orderId);
    return entry ? publicProgress(entry) : undefined;
  }

  async clearAcknowledgedOrderPublication(
    orderId: string
  ): Promise<OrderPublicationProgress> {
    return publicProgress(await this.outbox.clearAcknowledged(orderId));
  }

  async pruneCommittedOrderPublication(orderId: string): Promise<void> {
    await this.outbox.pruneCommitted(orderId);
  }

  private async serializeSuccessor<T>(
    address: string,
    action: () => Promise<T>
  ): Promise<T> {
    const previous = this.successorQueues.get(address) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.successorQueues.set(address, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.successorQueues.get(address) === queued) {
        this.successorQueues.delete(address);
      }
    }
  }

  private async loadMakerHead(
    address: string,
    expectedHeadId: string
  ): Promise<{ previous: NostrEvent; state: OrderState; record: TransitionRecord }> {
    const previous = await this.orders.loadCurrentTransition(address, expectedHeadId);
    if (previous.id !== expectedHeadId) {
      throw new Error("Order service returned a different transition head");
    }
    const record = parseTransitionEvent(previous, this.verify);
    if (record.address !== address) {
      throw new Error("Order service returned a transition for another address");
    }
    if (record.makerPubkey !== await this.identity.publicKey()) {
      throw new Error("Order transition belongs to another maker");
    }
    const pending = await this.outbox.load(record.state.order_id);
    if (pending && pending.status !== "committed") {
      throw new Error("Order has a pending publication; retry it before publishing a successor");
    }
    return { previous, state: record.state, record };
  }

  async retryOrderPublication(orderId: string): Promise<OrderPublicationProgress> {
    const acknowledged = await this.loadAcknowledgedOrderPublication(orderId);
    if (acknowledged) {
      return this.clearAcknowledgedOrderPublication(orderId);
    }
    return this.publishNextStage(orderId);
  }

  async publishOrder(input: PublishOrderInput): Promise<OrderPublicationProgress> {
    const createdAt = this.now();
    const state = createOrderState({
      orderId: this.orderId(),
      createdAt,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      side: input.side,
      baseUnit: TEST_MARKET.baseUnit,
      quoteUnit: TEST_MARKET.quoteUnit,
      ...orderAssets(input.side),
      amount: input.amount,
      priceCentsPerBtc: input.priceCentsPerBtc,
      ...(input.execution === undefined ? {} : { execution: input.execution }),
      ...(input.minimumFillAmount === undefined
        ? {}
        : { minimumFillAmount: input.minimumFillAmount })
    });
    const maker = await this.identity.publicKey();
    const entry = await this.outbox.ensureStaged({
      operation: "create",
      orderId: state.order_id,
      address: `30078:${maker}:granola:order:v2:${state.order_id}`,
      expectedHeadId: null,
      quorum: this.orders.publicationQuorum(),
      compatibility: canonicalOrderPublicationCompatibility({
        operation: "create",
        side: input.side,
        amount: input.amount,
        priceCentsPerBtc: input.priceCentsPerBtc,
        expiresAt: state.expires_at,
        execution: state.execution,
        minimumFillAmount: state.minimum_fill_amount
      }),
      state,
      evidence: null,
      createdAt
    }, () => this.orders.stage(state));
    return this.publishNextStage(entry.intent.orderId);
  }

  private async stageReserve(input: PublishReserveInput): Promise<OrderOutboxEntry> {
    return this.serializeSuccessor(input.address, async () => {
      const compatibility = reserveCompatibility(input);
      const existing = await this.existingCompatible(
        "reserve",
        input.address,
        input.expectedHeadId,
        compatibility
      );
      if (existing) return existing;
      const { previous, state } = await this.loadMakerHead(
        input.address,
        input.expectedHeadId
      );
      const acceptedAt = this.now();
      const next = reserveOrderState(state, {
        reservationId: input.reservationId,
        amount: input.amount,
        acceptedAt,
        expiresAt: input.expiresAt,
        proposalEventId: input.proposalEventId,
        takerCommitment: input.takerCommitment
      });
      const entry = await this.outbox.ensureStaged({
        operation: "reserve",
        orderId: next.order_id,
        address: input.address,
        expectedHeadId: previous.id,
        quorum: this.orders.publicationQuorum(),
        compatibility,
        state: next,
        evidence: null,
        createdAt: acceptedAt
      }, () => this.orders.stageSuccessor(
        next,
        "reserve",
        previous,
        undefined,
        acceptedAt
      ));
      return entry;
    });
  }

  async ensureReserveStaged(input: PublishReserveInput): Promise<OrderPublicationProgress> {
    return publicProgress(await this.stageReserve(input));
  }

  async reserveOrder(input: PublishReserveInput): Promise<OrderPublicationProgress> {
    const entry = await this.stageReserve(input);
    return this.publishNextStage(entry.intent.orderId);
  }

  private async stageFill(input: PublishFillInput): Promise<OrderOutboxEntry> {
    return this.serializeSuccessor(input.address, async () => {
      const compatibility = fillCompatibility(input);
      const existing = await this.existingCompatible(
        "fill",
        input.address,
        input.expectedHeadId,
        compatibility
      );
      if (existing) return existing;
      const { previous, state } = await this.loadMakerHead(
        input.address,
        input.expectedHeadId
      );
      const createdAt = this.now();
      const next = fillOrderState(state, {
        reservationId: input.reservationId,
        amount: input.amount
      });
      const entry = await this.outbox.ensureStaged({
        operation: "fill",
        orderId: next.order_id,
        address: input.address,
        expectedHeadId: previous.id,
        quorum: this.orders.publicationQuorum(),
        compatibility,
        state: next,
        evidence: input.evidence,
        createdAt
      }, () => this.orders.stageSuccessor(
        next,
        "fill",
        previous,
        input.evidence,
        createdAt
      ));
      return entry;
    });
  }

  async ensureFillStaged(input: PublishFillInput): Promise<OrderPublicationProgress> {
    return publicProgress(await this.stageFill(input));
  }

  async fillOrder(input: PublishFillInput): Promise<OrderPublicationProgress> {
    const entry = await this.stageFill(input);
    return this.publishNextStage(entry.intent.orderId);
  }

  private async stageRelease(input: PublishReleaseInput): Promise<OrderOutboxEntry> {
    return this.serializeSuccessor(input.address, async () => {
      const compatibility = releaseCompatibility(input);
      const existing = await this.existingCompatible(
        "release",
        input.address,
        input.expectedHeadId,
        compatibility
      );
      if (existing) return existing;
      const { previous, state, record } = await this.loadMakerHead(
        input.address,
        input.expectedHeadId
      );
      const releasedAt = this.now();
      let abortEventId: string | undefined;
      if (input.reason === "abort") {
        assertVerifiedInitialReserveProposal(input.proposalMessage);
        assertAuthenticatedOpenedTradeMessage(input.abortMessage);
        const reservation = state.reservation;
        if (!reservation || record.operation !== "reserve" || record.previous === null) {
          throw new Error("Abort release requires the authoritative reserve transition");
        }
        const proposal = input.proposalMessage.message;
        const abort = input.abortMessage.message;
        if (
          input.proposalMessage.seal.id !== reservation.proposal_event_id ||
          proposal.type !== "reserve_propose" ||
          proposal.order_address !== input.address ||
          proposal.order_head !== record.previous ||
          proposal.reservation_id !== reservation.id ||
          proposal.maker_order_pubkey !== record.makerPubkey
        ) {
          throw new Error("Reservation proposal does not match the authoritative reserve");
        }
        if (
          abort.type !== "abort" ||
          abort.order_address !== input.address ||
          abort.order_head !== previous.id ||
          abort.reservation_id !== reservation.id ||
          abort.maker_order_pubkey !== record.makerPubkey ||
          abort.author_pubkey !== proposal.author_pubkey ||
          abort.session_id !== proposal.session_id ||
          abort.terms_hash !== proposal.terms_hash ||
          BigInt(abort.sequence) <= BigInt(proposal.sequence) ||
          proposal.author_pubkey === record.makerPubkey
        ) {
          throw new Error("Abort message does not match the reserved taker session");
        }
        abortEventId = input.abortMessage.seal.id;
      }
      const next = releaseOrderState(state, {
        reservationId: input.reservationId,
        reason: input.reason,
        releasedAt,
        ...(abortEventId === undefined ? {} : { abortEventId })
      });
      const evidence: TransitionEvidence = input.reason === "expired"
        ? { release_reason: "expired" }
        : { release_reason: "abort", abort_event_id: abortEventId! };
      const entry = await this.outbox.ensureStaged({
        operation: "release",
        orderId: next.order_id,
        address: input.address,
        expectedHeadId: previous.id,
        quorum: this.orders.publicationQuorum(),
        compatibility,
        state: next,
        evidence,
        createdAt: releasedAt
      }, () => this.orders.stageSuccessor(
        next,
        "release",
        previous,
        evidence,
        releasedAt
      ));
      return entry;
    });
  }

  async ensureReleaseStaged(input: PublishReleaseInput): Promise<OrderPublicationProgress> {
    return publicProgress(await this.stageRelease(input));
  }

  async releaseOrder(input: PublishReleaseInput): Promise<OrderPublicationProgress> {
    const entry = await this.stageRelease(input);
    return this.publishNextStage(entry.intent.orderId);
  }
}
