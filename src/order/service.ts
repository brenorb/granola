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
  reserveOrder,
  type ExactMarket,
  type OrderBook,
  type OrderRecord,
  type OrderState
} from "./model.js";

export type SuccessorOperation = "reserve" | "fill";

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

export type OrderPublication = StagedOrderPublication;

export interface LoadedOrderBook {
  book: OrderBook;
  rejected: number;
}

export class PublicationQuorumError extends Error {
  constructor(
    readonly stage: "transition" | "projection",
    readonly publication: StagedOrderPublication,
    readonly required: number
  ) {
    const receipts = stage === "transition"
      ? publication.transitionReceipts
      : publication.projectionReceipts;
    const accepted = receipts.filter((receipt) => receipt.ok).length;
    super(`${stage} reached ${accepted}/${required} required relay acknowledgements`);
    this.name = "PublicationQuorumError";
  }
}

function assertMaker(event: NostrEvent, expected: string): void {
  if (event.pubkey !== expected) throw new Error("Signer returned the wrong maker public key");
}

function hasQuorum(receipts: RelayReceipt[], required: number): boolean {
  return receipts.filter((receipt) => receipt.ok).length >= required;
}

function mergeReceipts(previous: RelayReceipt[], current: RelayReceipt[]): RelayReceipt[] {
  const byRelay = new Map(previous.map((receipt) => [receipt.relay, receipt]));
  for (const receipt of current) {
    const existing = byRelay.get(receipt.relay);
    if (!existing?.ok || receipt.ok) byRelay.set(receipt.relay, receipt);
  }
  return [...byRelay.values()];
}

function sameState(left: OrderState, right: OrderState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertSuccessorState(
  previous: TransitionRecord,
  operation: SuccessorOperation,
  state: OrderState
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
  } else {
    const reservation = previous.state.reservation;
    if (!reservation) throw new Error("Fill predecessor has no reservation");
    expected = fillOrder(previous.state, {
      reservationId: reservation.id,
      amount: reservation.amount
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
  if (current.record.operation !== "reserve" && current.record.operation !== "fill") {
    throw new Error("Unsupported successor transition operation");
  }
  assertSuccessorState(previous.record, current.record.operation, current.record.state);
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
    assertSuccessorState(previousRecord, operation, state);
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

  async publishStaged(staged: StagedOrderPublication): Promise<OrderPublication> {
    const transitionRecord = parseTransitionEvent(staged.transition, this.verify);
    const projectionRecord = await parseProjectionEvent(staged.projection, this.verify);
    if (
      staged.schema !== "granola/order-publication/v1" ||
      transitionRecord.eventId !== staged.projection.tags.find((tag) => tag[0] === "e")?.[1] ||
      transitionRecord.makerPubkey !== projectionRecord.makerPubkey ||
      !sameState(transitionRecord.state, staged.state) ||
      !sameState(projectionRecord.state, staged.state)
    ) {
      throw new Error("Staged order publication is inconsistent");
    }

    let publication: StagedOrderPublication = structuredClone(staged);
    if (!hasQuorum(publication.transitionReceipts, this.quorum)) {
      publication = {
        ...publication,
        transitionReceipts: mergeReceipts(
          publication.transitionReceipts,
          await this.relays.publish(publication.transition)
        )
      };
    }
    if (!hasQuorum(publication.transitionReceipts, this.quorum)) {
      throw new PublicationQuorumError("transition", publication, this.quorum);
    }

    if (!hasQuorum(publication.projectionReceipts, this.quorum)) {
      publication = {
        ...publication,
        projectionReceipts: mergeReceipts(
          publication.projectionReceipts,
          await this.relays.publish(publication.projection)
        )
      };
    }
    if (!hasQuorum(publication.projectionReceipts, this.quorum)) {
      throw new PublicationQuorumError("projection", publication, this.quorum);
    }
    return publication;
  }

  async publish(state: OrderState): Promise<OrderPublication> {
    return this.publishStaged(await this.stage(state));
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
