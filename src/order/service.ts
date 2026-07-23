import { verifyEvent } from "nostr-tools/pure";

import type { RelayReceipt } from "../nostr/relay.js";
import {
  createProjectionTemplate,
  createTransitionTemplate,
  parseCreateTransitionEvent,
  parseProjectionEvent,
  type NostrEvent,
  type UnsignedNostrEvent
} from "./events.js";
import {
  buildOrderBook,
  marketId,
  type ExactMarket,
  type OrderBook,
  type OrderRecord,
  type OrderState
} from "./model.js";

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

  async publishStaged(staged: StagedOrderPublication): Promise<OrderPublication> {
    const transitionRecord = parseCreateTransitionEvent(staged.transition, this.verify);
    const projectionRecord = await parseProjectionEvent(staged.projection, this.verify);
    if (
      staged.schema !== "granola/order-publication/v1" ||
      transitionRecord.eventId !== staged.projection.tags.find((tag) => tag[0] === "e")?.[1] ||
      transitionRecord.makerPubkey !== projectionRecord.makerPubkey ||
      JSON.stringify(transitionRecord.state) !== JSON.stringify(staged.state) ||
      JSON.stringify(projectionRecord.state) !== JSON.stringify(staged.state)
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
      Map<string, ReturnType<typeof parseCreateTransitionEvent>>
    >();
    for (const event of transitionEvents) {
      try {
        const transition = parseCreateTransitionEvent(event, this.verify);
        const roots = transitions.get(transition.address) ?? new Map();
        roots.set(transition.eventId, transition);
        transitions.set(transition.address, roots);
      } catch {
        rejected += 1;
      }
    }

    const records: OrderRecord[] = [];
    for (const candidate of candidates) {
      const roots = transitions.get(candidate.record.address) ?? new Map();
      if (roots.size !== 1) {
        rejected += Math.max(1, roots.size);
        continue;
      }
      const transition = roots.values().next().value;
      if (
        !transition ||
        transition.eventId !== candidate.head ||
        transition.makerPubkey !== candidate.record.makerPubkey ||
        JSON.stringify(transition.state) !== JSON.stringify(candidate.record.state)
      ) {
        rejected += 1;
        continue;
      }
      records.push({ ...candidate.record, verified: true });
    }

    return {
      book: await buildOrderBook(records, market, now),
      rejected
    };
  }
}
