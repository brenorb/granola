import { verifyEvent } from "nostr-tools/pure";

import {
  cancelOrder as cancelOrderState,
  createOrderState,
  expireOrder as expireOrderState,
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
  parseProjectionEvent,
  type FillOrderEvidence,
  type NostrEvent,
  type OrderOperationEvidence
} from "../order/events.js";
import type {
  LoadedOrderBook,
  StagedOrderPublication,
  SuccessorOperation
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
  publicKey(orderId: string): Promise<string>;
  existingPublicKey?(orderId: string): Promise<string | undefined>;
  listPublicKeys?(): Promise<string[]>;
  destroy?(orderId: string): Promise<void>;
}

export interface OrderServicePort {
  stage(state: OrderState): Promise<StagedOrderPublication>;
  stageSuccessor(
    state: OrderState,
    operation: SuccessorOperation,
    previous: NostrEvent,
    createdAt: number
  ): Promise<StagedOrderPublication>;
  publishNextStage(entry: OrderOutboxEntry): Promise<OrderOutboxEntry>;
  loadCurrentProjection(
    address: string,
    expectedProjectionId: string,
    expectedRevision: string
  ): Promise<NostrEvent>;
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
  projectionId: string;
  revision: string;
  receipts: StagedOrderPublication["receipts"];
}

interface CurrentProjectionBinding {
  address: string;
  expectedProjectionId: string;
  expectedRevision: string;
}

export interface PublishReserveInput
  extends Omit<ReserveOrderInput, "acceptedAt">,
    CurrentProjectionBinding {}

export interface PublishFillInput
  extends FillOrderInput,
    CurrentProjectionBinding {
  evidence: FillOrderEvidence;
}

export type PublishReleaseInput = CurrentProjectionBinding & {
  reservationId: string;
} & (
  | {
      reason: "expired";
      abortEventId?: never;
    }
  | {
      reason: "abort";
      proposalMessage: VerifiedInitialReserveProposal;
      abortMessage: OpenedTradeMessage;
    }
);

export type PublishCancelInput = CurrentProjectionBinding;
export type PublishExpireInput = CurrentProjectionBinding;

function publicPublication(publication: StagedOrderPublication): PublicOrderPublication {
  return {
    orderId: publication.state.order_id,
    makerPubkey: publication.projection.pubkey,
    projectionId: publication.projection.id,
    revision: publication.state.revision,
    receipts: publication.receipts
  };
}

export interface OrderPublicationProgress extends PublicOrderPublication {
  status: OrderPublicationStatus;
}

function publicProgress(entry: OrderOutboxEntry): OrderPublicationProgress {
  return { ...publicPublication(entry.publication), status: entry.status };
}

function orderAssets(
  side: PublishOrderInput["side"]
): Pick<CreateOrderInput, "offered" | "requested"> {
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

function bindingCompatibility(
  operation: OrderPublicationIntent["operation"],
  input: CurrentProjectionBinding,
  details: Record<string, unknown> = {}
): string {
  return canonicalOrderPublicationCompatibility({
    operation,
    expectedProjectionId: input.expectedProjectionId,
    expectedRevision: input.expectedRevision,
    ...details
  });
}

export class OrderApi {
  private readonly successorQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly identity: MakerIdentityPort,
    private readonly orders: OrderServicePort,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly orderId: () => string = () => crypto.randomUUID(),
    private readonly outbox: OrderOutboxPort,
    private readonly verify: (event: NostrEvent) => boolean =
      (event) => verifyEvent(event)
  ) {
    if (!outbox) throw new Error("Order API requires a durable projection outbox");
  }

  async getMakerPublicKeys(): Promise<string[]> {
    return this.identity.listPublicKeys ? this.identity.listPublicKeys() : [];
  }

  async getOrderBook(): Promise<LoadedOrderBook> {
    return this.orders.loadBook(TEST_MARKET, this.now());
  }

  async getPendingOrderPublications(): Promise<PublicOrderPublication[]> {
    return (await this.outbox.list())
      .filter((entry) => entry.status !== "committed")
      .map((entry) => publicPublication(entry.publication));
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

  private async existingCompatible(
    operation: OrderPublicationIntent["operation"],
    binding: CurrentProjectionBinding,
    compatibility: string
  ): Promise<OrderOutboxEntry | undefined> {
    const entries = (await this.outbox.list()).filter(
      (entry) => entry.intent.address === binding.address
    );
    if (entries.length > 1) {
      throw new Error("Order has conflicting pending projections");
    }
    const existing = entries[0];
    if (!existing) return undefined;
    if (
      existing.intent.operation !== operation ||
      existing.intent.expectedProjectionId !== binding.expectedProjectionId ||
      existing.intent.expectedRevision !== binding.expectedRevision ||
      existing.intent.compatibility !== compatibility
    ) {
      if (existing.status === "committed") return undefined;
      throw new Error("Order projection intent conflicts with the durable outbox");
    }
    return existing;
  }

  private async loadMakerProjection(
    binding: CurrentProjectionBinding
  ): Promise<{ projection: NostrEvent; state: OrderState }> {
    const projection = await this.orders.loadCurrentProjection(
      binding.address,
      binding.expectedProjectionId,
      binding.expectedRevision
    );
    const record = await parseProjectionEvent(projection, this.verify);
    if (record.address !== binding.address) {
      throw new Error("Order service returned a projection for another address");
    }
    const expectedMaker = this.identity.existingPublicKey
      ? await this.identity.existingPublicKey(record.state.order_id)
      : await this.identity.publicKey(record.state.order_id);
    if (!expectedMaker || record.makerPubkey !== expectedMaker) {
      throw new Error("Order projection belongs to another maker");
    }
    if (record.state.revision !== binding.expectedRevision) {
      throw new Error("Order projection revision is stale");
    }
    const pending = await this.outbox.load(record.state.order_id);
    if (pending && pending.status !== "committed") {
      throw new Error("Order has a pending projection; retry it first");
    }
    return { projection, state: record.state };
  }

  async publishNextStage(orderId: string): Promise<OrderPublicationProgress> {
    const initial = await this.outbox.load(orderId);
    if (!initial || initial.status === "committed") {
      throw new Error("No pending projection exists for this order ID");
    }
    return this.serializeSuccessor(initial.intent.address, async () => {
      const current = await this.outbox.load(orderId);
      if (!current || current.status === "committed") {
        throw new Error("No pending projection exists for this order ID");
      }
      if (
        current.publication.projection.id !==
        initial.publication.projection.id
      ) {
        throw new Error("Pending projection changed while waiting to publish");
      }
      const advanced = await this.orders.publishNextStage(current);
      const saved = await this.outbox.recordProgress(advanced);
      if (
        saved.status === "acknowledged" &&
        ["filled", "canceled", "expired"].includes(saved.publication.state.status)
      ) {
        await this.identity.destroy?.(orderId);
      }
      return publicProgress(saved);
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
    const cleared = await this.outbox.clearAcknowledged(orderId);
    if (
      ["filled", "canceled", "expired"].includes(cleared.publication.state.status)
    ) {
      await this.identity.destroy?.(orderId);
    }
    return publicProgress(cleared);
  }

  async pruneCommittedOrderPublication(orderId: string): Promise<void> {
    await this.outbox.pruneCommitted(orderId);
  }

  async retryOrderPublication(orderId: string): Promise<OrderPublicationProgress> {
    const acknowledged = await this.loadAcknowledgedOrderPublication(orderId);
    return acknowledged
      ? this.clearAcknowledgedOrderPublication(orderId)
      : this.publishNextStage(orderId);
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
    const maker = await this.identity.publicKey(state.order_id);
    const entry = await this.outbox.ensureStaged({
      operation: "create",
      orderId: state.order_id,
      address: `30078:${maker}:granola:order:v1:${state.order_id}`,
      expectedProjectionId: null,
      expectedRevision: null,
      compatibility: canonicalOrderPublicationCompatibility({
        operation: "create",
        state
      }),
      state,
      evidence: null,
      createdAt
    }, () => this.orders.stage(state));
    return this.publishNextStage(entry.intent.orderId);
  }

  private async stageSuccessor(
    operation: SuccessorOperation,
    binding: CurrentProjectionBinding,
    compatibility: string,
    nextState: (
      state: OrderState,
      projection: NostrEvent,
      createdAt: number
    ) => OrderState,
    evidence: OrderOperationEvidence | null = null
  ): Promise<OrderOutboxEntry> {
    return this.serializeSuccessor(binding.address, async () => {
      const existing = await this.existingCompatible(
        operation,
        binding,
        compatibility
      );
      if (existing) return existing;
      const { projection, state } = await this.loadMakerProjection(binding);
      const createdAt = Math.max(this.now(), projection.created_at + 1);
      const next = nextState(state, projection, createdAt);
      return this.outbox.ensureStaged({
        operation,
        orderId: next.order_id,
        address: binding.address,
        expectedProjectionId: projection.id,
        expectedRevision: state.revision,
        compatibility,
        state: next,
        evidence,
        createdAt
      }, () => this.orders.stageSuccessor(
        next,
        operation,
        projection,
        createdAt
      ));
    });
  }

  private async stageReserve(input: PublishReserveInput): Promise<OrderOutboxEntry> {
    const compatibility = bindingCompatibility("reserve", input, {
      reservationId: input.reservationId,
      amount: input.amount,
      expiresAt: input.expiresAt,
      proposalEventId: input.proposalEventId,
      takerCommitment: input.takerCommitment
    });
    return this.stageSuccessor(
      "reserve",
      input,
      compatibility,
      (state, _projection, acceptedAt) => reserveOrderState(state, {
        reservationId: input.reservationId,
        amount: input.amount,
        acceptedAt,
        expiresAt: input.expiresAt,
        proposalEventId: input.proposalEventId,
        takerCommitment: input.takerCommitment
      })
    );
  }

  async ensureReserveStaged(input: PublishReserveInput): Promise<OrderPublicationProgress> {
    return publicProgress(await this.stageReserve(input));
  }

  async reserveOrder(input: PublishReserveInput): Promise<OrderPublicationProgress> {
    const entry = await this.stageReserve(input);
    return this.publishNextStage(entry.intent.orderId);
  }

  private async stageFill(input: PublishFillInput): Promise<OrderOutboxEntry> {
    const compatibility = bindingCompatibility("fill", input, {
      reservationId: input.reservationId,
      amount: input.amount,
      evidence: input.evidence
    });
    return this.stageSuccessor(
      "fill",
      input,
      compatibility,
      (state) => fillOrderState(state, {
        reservationId: input.reservationId,
        amount: input.amount
      }),
      input.evidence
    );
  }

  async ensureFillStaged(input: PublishFillInput): Promise<OrderPublicationProgress> {
    return publicProgress(await this.stageFill(input));
  }

  async fillOrder(input: PublishFillInput): Promise<OrderPublicationProgress> {
    const entry = await this.stageFill(input);
    return this.publishNextStage(entry.intent.orderId);
  }

  private async stageRelease(input: PublishReleaseInput): Promise<OrderOutboxEntry> {
    let abortEventId: string | undefined;
    if (input.reason === "abort") {
      assertVerifiedInitialReserveProposal(input.proposalMessage);
      assertAuthenticatedOpenedTradeMessage(input.abortMessage);
      const proposal = input.proposalMessage.message;
      const abort = input.abortMessage.message;
      if (
        proposal.order_address !== input.address ||
        abort.order_address !== input.address ||
        abort.order_projection_id !== input.expectedProjectionId ||
        abort.order_revision !== input.expectedRevision ||
        abort.author_pubkey !== proposal.author_pubkey ||
        abort.session_id !== proposal.session_id ||
        abort.reservation_id !== input.reservationId ||
        proposal.reservation_id !== input.reservationId ||
        abort.terms_hash !== proposal.terms_hash ||
        BigInt(abort.sequence) <= BigInt(proposal.sequence)
      ) {
        throw new Error("Abort message does not match the reserved taker session");
      }
      abortEventId = input.abortMessage.seal.id;
    }
    const evidence: OrderOperationEvidence = input.reason === "expired"
      ? { release_reason: "expired" }
      : { release_reason: "abort", abort_event_id: abortEventId! };
    const compatibility = bindingCompatibility("release", input, {
      reservationId: input.reservationId,
      reason: input.reason,
      ...(abortEventId ? { abortEventId } : {})
    });
    return this.stageSuccessor(
      "release",
      input,
      compatibility,
      (state, _projection, releasedAt) => releaseOrderState(state, {
        reservationId: input.reservationId,
        reason: input.reason,
        releasedAt,
        ...(abortEventId ? { abortEventId } : {})
      }),
      evidence
    );
  }

  async ensureReleaseStaged(input: PublishReleaseInput): Promise<OrderPublicationProgress> {
    return publicProgress(await this.stageRelease(input));
  }

  async releaseOrder(input: PublishReleaseInput): Promise<OrderPublicationProgress> {
    const entry = await this.stageRelease(input);
    return this.publishNextStage(entry.intent.orderId);
  }

  async cancelOrder(input: PublishCancelInput): Promise<OrderPublicationProgress> {
    const entry = await this.stageSuccessor(
      "cancel",
      input,
      bindingCompatibility("cancel", input),
      (state) => cancelOrderState(state)
    );
    return this.publishNextStage(entry.intent.orderId);
  }

  async expireOrder(input: PublishExpireInput): Promise<OrderPublicationProgress> {
    const entry = await this.stageSuccessor(
      "expire",
      input,
      bindingCompatibility("expire", input),
      (state, _projection, expiredAt) => expireOrderState(state, expiredAt)
    );
    return this.publishNextStage(entry.intent.orderId);
  }
}
