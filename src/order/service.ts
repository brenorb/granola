import { verifyEvent } from "nostr-tools/pure";

import type { RelayReceipt } from "../nostr/relay.js";
import {
  createProjectionTemplate,
  createStateTransitionTemplate,
  createTransitionTemplate,
  parseProjectionEvent,
  parseTransitionEvent,
  type NostrEvent,
  type TransitionEvidence,
  type TransitionRecord,
  type UnsignedNostrEvent
} from "./events.js";
import {
  buildOrderBook,
  fillOrder,
  marketId,
  releaseOrder,
  reserveOrder,
  type ExactMarket,
  type OrderBook,
  type OrderRecord,
  type OrderState
} from "./model.js";
import type { OrderOutboxEntry } from "../storage/order-outbox.js";

export type SuccessorOperation = "reserve" | "release" | "fill";

export interface OrderSigner {
  publicKey(): Promise<string>;
  sign(template: UnsignedNostrEvent): Promise<NostrEvent>;
}

export interface OrderRelayPort {
  publish(event: NostrEvent): Promise<RelayReceipt[]>;
  queryProjections(market: string, since: number): Promise<NostrEvent[]>;
  queryTransitions(addresses: string[]): Promise<NostrEvent[]>;
}

export interface StagedOrderPublication {
  schema: "granola/order-publication/v1";
  state: OrderState;
  transition: NostrEvent;
  transitionReceipts: RelayReceipt[];
  projection: NostrEvent;
  projectionReceipts: RelayReceipt[];
}

export interface LoadedOrderBook {
  book: OrderBook;
  rejected: number;
}

function assertMaker(event: NostrEvent, expected: string): void {
  if (event.pubkey !== expected) throw new Error("Signer returned the wrong maker public key");
}

function hasQuorum(receipts: RelayReceipt[], required: number): boolean {
  return new Set(
    receipts.filter((receipt) => receipt.ok).map((receipt) => receipt.relay)
  ).size >= required;
}

function assertUniqueReceipts(receipts: RelayReceipt[]): void {
  const relays = receipts.map((receipt) => receipt.relay);
  if (new Set(relays).size !== relays.length) {
    throw new Error("Relay publication returned duplicate receipt URLs");
  }
}

function mergeReceipts(previous: RelayReceipt[], current: RelayReceipt[]): RelayReceipt[] {
  const byRelay = new Map(previous.map((receipt) => [receipt.relay, receipt]));
  for (const receipt of current) {
    const existing = byRelay.get(receipt.relay);
    if (!existing?.ok || receipt.ok) byRelay.set(receipt.relay, receipt);
  }
  return [...byRelay.values()];
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Value cannot be canonically encoded");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function sameState(left: OrderState, right: OrderState): boolean {
  return sameValue(left, right);
}

function assertSuccessorState(
  previous: TransitionRecord,
  operation: SuccessorOperation,
  state: OrderState,
  evidence?: TransitionEvidence,
  createdAt?: number
): void {
  if (state.order_id !== previous.state.order_id) throw new Error("Successor order ID changed");
  if (BigInt(state.revision) !== BigInt(previous.revision) + 1n) {
    throw new Error("Successor revision is not monotonic");
  }
  let expected: OrderState;
  if (operation === "reserve") {
    const reservation = state.reservation;
    if (!reservation) throw new Error("Reserve successor is missing reservation state");
    expected = reserveOrder(previous.state, {
      reservationId: reservation.id,
      amount: reservation.amount,
      acceptedAt: reservation.accepted_at,
      expiresAt: reservation.expires_at,
      proposalEventId: reservation.proposal_event_id,
      takerCommitment: reservation.taker_commitment
    });
  } else if (operation === "fill") {
    const reservation = previous.state.reservation;
    if (!reservation) throw new Error("Fill predecessor has no reservation");
    expected = fillOrder(previous.state, {
      reservationId: reservation.id,
      amount: reservation.amount
    });
  } else {
    const reservation = previous.state.reservation;
    if (!reservation) throw new Error("Release predecessor has no reservation");
    if (!evidence || !("release_reason" in evidence)) {
      throw new Error("Release transition requires release evidence");
    }
    if (createdAt === undefined) throw new Error("Release transition requires a release timestamp");
    expected = releaseOrder(previous.state, {
      reservationId: reservation.id,
      reason: evidence.release_reason,
      releasedAt: createdAt,
      ...(evidence.abort_event_id === undefined
        ? {}
        : { abortEventId: evidence.abort_event_id })
    });
  }
  if (!sameState(expected, state)) throw new Error(`Invalid ${operation} state transition`);
}

function assertLinearStep(
  previous: { event: NostrEvent; record: TransitionRecord },
  current: { event: NostrEvent; record: TransitionRecord }
): void {
  if (current.record.previous !== previous.event.id) throw new Error("Transition predecessor is stale");
  if (
    current.record.address !== previous.record.address ||
    current.record.makerPubkey !== previous.record.makerPubkey
  ) {
    throw new Error("Transition authority changed");
  }
  if (current.event.created_at < previous.event.created_at) throw new Error("Transition timestamp regressed");
  if (
    current.record.operation !== "reserve" &&
    current.record.operation !== "release" &&
    current.record.operation !== "fill"
  ) {
    throw new Error("Unsupported successor transition operation");
  }
  assertSuccessorState(
    previous.record,
    current.record.operation,
    current.record.state,
    current.record.evidence,
    current.event.created_at
  );
}

export class NostrOrderService {
  constructor(
    private readonly signer: OrderSigner,
    private readonly relays: OrderRelayPort,
    private readonly operationId: () => string = () => crypto.randomUUID(),
    private readonly quorum = 2,
    private readonly verify: (event: NostrEvent) => boolean = (event) => verifyEvent(event)
  ) {
    if (!Number.isSafeInteger(quorum) || quorum < 1) {
      throw new Error("Relay quorum must be a positive integer");
    }
  }

  publicationQuorum(): number {
    return this.quorum;
  }

  async stage(state: OrderState): Promise<StagedOrderPublication> {
    const maker = await this.signer.publicKey();
    const transition = await this.signer.sign(
      createTransitionTemplate(state, maker, this.operationId())
    );
    assertMaker(transition, maker);
    const projection = await this.signer.sign(
      await createProjectionTemplate(state, transition)
    );
    assertMaker(projection, maker);
    return {
      schema: "granola/order-publication/v1",
      state,
      transition,
      transitionReceipts: [],
      projection,
      projectionReceipts: []
    };
  }

  async stageSuccessor(
    state: OrderState,
    operation: SuccessorOperation,
    previous: NostrEvent,
    evidence?: TransitionEvidence,
    createdAt?: number
  ): Promise<StagedOrderPublication> {
    const maker = await this.signer.publicKey();
    const previousRecord = parseTransitionEvent(previous, this.verify);
    if (previousRecord.makerPubkey !== maker) throw new Error("Previous transition belongs to another maker");
    assertSuccessorState(previousRecord, operation, state, evidence, createdAt);
    const transition = await this.signer.sign(
      createStateTransitionTemplate(
        state,
        maker,
        this.operationId(),
        operation,
        previous,
        evidence,
        createdAt
      )
    );
    assertMaker(transition, maker);
    const projection = await this.signer.sign(
      await createProjectionTemplate(state, transition)
    );
    assertMaker(projection, maker);
    return {
      schema: "granola/order-publication/v1",
      state,
      transition,
      transitionReceipts: [],
      projection,
      projectionReceipts: []
    };
  }

  private async validateOutboxEntry(entry: OrderOutboxEntry): Promise<TransitionRecord> {
    const transition = parseTransitionEvent(entry.publication.transition, this.verify);
    const projection = await parseProjectionEvent(entry.publication.projection, this.verify);
    if (
      entry.schema !== "granola/order-outbox/v2" ||
      entry.publication.schema !== "granola/order-publication/v1" ||
      transition.operation !== entry.intent.operation ||
      transition.address !== entry.intent.address ||
      transition.previous !== entry.intent.expectedHeadId ||
      transition.eventId !== entry.publication.transition.id ||
      transition.makerPubkey !== projection.makerPubkey ||
      projection.address !== transition.address ||
      projection.headEventId !== transition.eventId ||
      entry.intent.orderId !== transition.state.order_id ||
      entry.intent.createdAt !== entry.publication.transition.created_at ||
      entry.publication.projection.created_at !== entry.intent.createdAt ||
      !sameState(transition.state, entry.intent.state) ||
      !sameState(projection.state, entry.intent.state) ||
      !sameState(entry.publication.state, entry.intent.state) ||
      !sameValue(transition.evidence ?? null, entry.intent.evidence)
    ) {
      throw new Error("Durable order publication is inconsistent");
    }
    return transition;
  }

  private async assertPublishPosition(
    entry: OrderOutboxEntry,
    transition: TransitionRecord
  ): Promise<void> {
    if (entry.status === "transition_acknowledged") {
      await this.loadCurrentTransition(transition.address, entry.publication.transition.id);
      return;
    }
    if (entry.status !== "staged") return;
    if (transition.previous === null) {
      const matching = (await this.relays.queryTransitions([transition.address])).filter((event) => {
        try {
          return parseTransitionEvent(event, this.verify).address === transition.address;
        } catch {
          return false;
        }
      });
      if (matching.length === 0) return;
      await this.loadCurrentTransition(transition.address, entry.publication.transition.id);
      return;
    }
    for (const expected of [transition.previous, entry.publication.transition.id]) {
      try {
        await this.loadCurrentTransition(transition.address, expected);
        return;
      } catch {
        // An exact retry can observe either its predecessor or its own transition.
      }
    }
    throw new Error("Staged successor is stale or the authoritative head forked");
  }

  /**
   * Publishes at most one exact signed Nostr event. The caller must durably
   * record the returned entry before invoking this method again.
   */
  async publishNextStage(entry: OrderOutboxEntry): Promise<OrderOutboxEntry> {
    const transition = await this.validateOutboxEntry(entry);
    if (entry.intent.quorum !== this.quorum) {
      throw new Error("Durable order publication quorum does not match the service");
    }
    if (entry.status === "projection_acknowledged" || entry.status === "committed") {
      return structuredClone(entry);
    }
    await this.assertPublishPosition(entry, transition);
    if (entry.status === "staged") {
      const receipts = await this.relays.publish(entry.publication.transition);
      assertUniqueReceipts(receipts);
      const publication = {
        ...structuredClone(entry.publication),
        transitionReceipts: mergeReceipts(
          entry.publication.transitionReceipts,
          receipts
        )
      };
      return {
        ...structuredClone(entry),
        status: hasQuorum(publication.transitionReceipts, this.quorum)
          ? "transition_acknowledged"
          : "staged",
        publication
      };
    }
    const receipts = await this.relays.publish(entry.publication.projection);
    assertUniqueReceipts(receipts);
    const publication = {
      ...structuredClone(entry.publication),
      projectionReceipts: mergeReceipts(
        entry.publication.projectionReceipts,
        receipts
      )
    };
    return {
      ...structuredClone(entry),
      status: hasQuorum(publication.projectionReceipts, this.quorum)
        ? "projection_acknowledged"
        : "transition_acknowledged",
      publication
    };
  }

  async loadCurrentTransition(address: string, expectedHeadId: string): Promise<NostrEvent> {
    const parsed = new Map<string, { event: NostrEvent; record: TransitionRecord }>();
    for (const event of await this.relays.queryTransitions([address])) {
      try {
        const record = parseTransitionEvent(event, this.verify);
        if (record.address === address) parsed.set(event.id, { event, record });
      } catch {
        // Invalid relay data cannot become an authoritative transition.
      }
    }
    const roots = [...parsed.values()].filter(({ record }) => record.previous === null);
    if (roots.length !== 1 || roots[0]?.record.operation !== "create") {
      throw new Error("Order transition chain has competing or invalid roots");
    }
    const children = new Map<string, Array<{ event: NostrEvent; record: TransitionRecord }>>();
    for (const item of parsed.values()) {
      if (item.record.previous === null) continue;
      const successors = children.get(item.record.previous) ?? [];
      successors.push(item);
      children.set(item.record.previous, successors);
    }
    if ([...children.values()].some((successors) => successors.length !== 1)) {
      throw new Error("Order transition chain forked");
    }
    const visited = new Set<string>();
    let current = roots[0]!;
    while (true) {
      if (visited.has(current.event.id)) throw new Error("Order transition chain cycles");
      visited.add(current.event.id);
      const successors = children.get(current.event.id) ?? [];
      if (successors.length === 0) break;
      const next = successors[0]!;
      assertLinearStep(current, next);
      current = next;
    }
    if (visited.size !== parsed.size) throw new Error("Order transition chain is incomplete");
    if (current.event.id !== expectedHeadId) throw new Error("Expected transition is not the current head");
    return structuredClone(current.event);
  }

  async loadBook(market: ExactMarket, now: number): Promise<LoadedOrderBook> {
    const selectedMarket = await marketId(market);
    const events = await this.relays.queryProjections(selectedMarket, 0);
    let rejected = 0;
    const byAddress = new Map<
      string,
      Map<string, { event: NostrEvent; head: string; record: OrderRecord }>
    >();

    for (const event of events) {
      try {
        const record = await parseProjectionEvent(event, this.verify);
        const headTags = event.tags.filter((tag) => tag[0] === "e");
        const head = headTags[0]?.[1];
        if (headTags.length !== 1 || !head) throw new Error("Projection head is missing");
        const revisions = byAddress.get(record.address) ?? new Map();
        revisions.set(record.eventId, { event, head, record });
        byAddress.set(record.address, revisions);
      } catch {
        rejected += 1;
      }
    }

    const candidates: Array<{ event: NostrEvent; head: string; record: OrderRecord }> = [];
    for (const revisions of byAddress.values()) {
      if (revisions.size !== 1) {
        rejected += revisions.size;
        continue;
      }
      const candidate = revisions.values().next().value;
      if (candidate) candidates.push(candidate);
    }

    const transitionEvents = await this.relays.queryTransitions(
      candidates.map((candidate) => candidate.record.address)
    );
    const transitions = new Map<
      string,
      Map<string, { event: NostrEvent; record: TransitionRecord }>
    >();
    for (const event of transitionEvents) {
      try {
        const transition = parseTransitionEvent(event, this.verify);
        const eventsById = transitions.get(transition.address) ?? new Map();
        const existing = eventsById.get(transition.eventId);
        if (existing && JSON.stringify(existing.event) !== JSON.stringify(event)) {
          throw new Error("Conflicting events reuse one transition ID");
        }
        eventsById.set(transition.eventId, { event, record: transition });
        transitions.set(transition.address, eventsById);
      } catch {
        rejected += 1;
      }
    }

    const records: OrderRecord[] = [];
    for (const candidate of candidates) {
      const eventsById = transitions.get(candidate.record.address) ?? new Map();
      try {
        if (eventsById.size === 0) throw new Error("Order transition chain is missing");
        const roots = [...eventsById.values()].filter(({ record }) => record.previous === null);
        if (roots.length !== 1 || roots[0]?.record.operation !== "create") {
          throw new Error("Order transition chain has competing or invalid roots");
        }
        const children = new Map<string, Array<{ event: NostrEvent; record: TransitionRecord }>>();
        for (const item of eventsById.values()) {
          if (item.record.previous === null) continue;
          const successors = children.get(item.record.previous) ?? [];
          successors.push(item);
          children.set(item.record.previous, successors);
        }
        if ([...children.values()].some((successors) => successors.length !== 1)) {
          throw new Error("Order transition chain forked");
        }

        const visited = new Set<string>();
        const operationIds = new Set<string>();
        let current = roots[0]!;
        while (true) {
          if (visited.has(current.event.id)) throw new Error("Order transition chain cycles");
          if (operationIds.has(current.record.operationId)) throw new Error("Order operation ID was replayed");
          visited.add(current.event.id);
          operationIds.add(current.record.operationId);
          const successors = children.get(current.event.id) ?? [];
          if (successors.length === 0) break;
          const next = successors[0]!;
          assertLinearStep(current, next);
          current = next;
        }
        if (visited.size !== eventsById.size) throw new Error("Order transition chain contains an orphan or stale fork");
        if (
          current.event.id !== candidate.head ||
          current.record.makerPubkey !== candidate.record.makerPubkey ||
          !sameState(current.record.state, candidate.record.state)
        ) {
          throw new Error("Projection does not match the authoritative chain head");
        }
        records.push({ ...candidate.record, verified: true });
      } catch {
        rejected += Math.max(1, eventsById.size);
      }
    }

    return {
      book: await buildOrderBook(records, market, now),
      rejected
    };
  }
}
