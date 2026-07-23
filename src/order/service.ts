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

export interface OrderPublication {
  transition: NostrEvent;
  transitionReceipts: RelayReceipt[];
  projection: NostrEvent;
  projectionReceipts: RelayReceipt[];
}

export interface LoadedOrderBook {
  book: OrderBook;
  rejected: number;
}

export class PublicationQuorumError extends Error {
  constructor(
    readonly stage: "transition" | "projection",
    readonly receipts: RelayReceipt[],
    readonly required: number
  ) {
    const accepted = receipts.filter((receipt) => receipt.ok).length;
    super(`${stage} reached ${accepted}/${required} required relay acknowledgements`);
    this.name = "PublicationQuorumError";
  }
}

function assertMaker(event: NostrEvent, expected: string): void {
  if (event.pubkey !== expected) throw new Error("Signer returned the wrong maker public key");
}

function requireQuorum(
  stage: "transition" | "projection",
  receipts: RelayReceipt[],
  required: number
): void {
  if (receipts.filter((receipt) => receipt.ok).length < required) {
    throw new PublicationQuorumError(stage, receipts, required);
  }
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

  async publish(state: OrderState): Promise<OrderPublication> {
    const maker = await this.signer.publicKey();
    const transition = await this.signer.sign(
      createTransitionTemplate(state, maker, this.operationId())
    );
    assertMaker(transition, maker);
    const transitionReceipts = await this.relays.publish(transition);
    requireQuorum("transition", transitionReceipts, this.quorum);

    const projection = await this.signer.sign(
      await createProjectionTemplate(state, transition)
    );
    assertMaker(projection, maker);
    const projectionReceipts = await this.relays.publish(projection);
    requireQuorum("projection", projectionReceipts, this.quorum);

    return { transition, transitionReceipts, projection, projectionReceipts };
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
