import { getPublicKey } from "nostr-tools";

import type { NostrEvent } from "../order/events.js";
import {
  createInboxList,
  createNip42AuthEvent,
  publishGiftWrap,
  publishInboxList,
  queryGiftWraps,
  selectInboxList,
  type InboxObservation,
  type InboxPublicationResult,
  type InboxReceipt,
  type InboxRelayPort
} from "./inbox.js";

export class NostrTradeTransport {
  constructor(
    private readonly port: InboxRelayPort,
    private readonly discoveryRelays: readonly string[],
    private readonly inboxRelays: readonly string[],
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000)
  ) {}

  async register(protocolSecretKey: Uint8Array): Promise<InboxPublicationResult> {
    const now = this.now();
    const event = createInboxList(this.inboxRelays, protocolSecretKey, now);
    return publishInboxList(
      event,
      this.discoveryRelays,
      protocolSecretKey,
      this.port,
      now,
      2
    );
  }

  async discover(authorPubkey: string, requesterSecretKey: Uint8Array): Promise<string[]> {
    const now = this.now();
    const observations = await Promise.all(this.discoveryRelays.map(async (relay) => {
      try {
        const events = await this.port.query(relay, {
          authors: [authorPubkey],
          kinds: [10050],
          limit: 20
        }, async (challenge) => createNip42AuthEvent(relay, challenge, requesterSecretKey, now));
        return events.map((event): InboxObservation => ({ relay, event }));
      } catch {
        return [];
      }
    }));
    return selectInboxList(observations.flat(), authorPubkey, now, 2).relays;
  }

  async send(
    wrapper: NostrEvent,
    recipientInboxRelays: readonly string[],
    senderSecretKey: Uint8Array
  ): Promise<InboxReceipt[]> {
    const receipts = await publishGiftWrap(
      wrapper,
      recipientInboxRelays,
      senderSecretKey,
      this.port,
      this.now()
    );
    if (!receipts.some((receipt) => receipt.ok)) {
      throw new Error("Private trade message received no authenticated inbox acknowledgement");
    }
    return receipts;
  }

  async read(
    recipientPubkey: string,
    recipientSecretKey: Uint8Array,
    since: number
  ): Promise<NostrEvent[]> {
    if (getPublicKey(recipientSecretKey) !== recipientPubkey) {
      throw new Error("Trade inbox read requires the exact recipient key");
    }
    return queryGiftWraps(
      recipientPubkey,
      this.inboxRelays,
      recipientSecretKey,
      this.port,
      since,
      this.now()
    );
  }
}
