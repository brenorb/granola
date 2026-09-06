import { getPublicKey } from "nostr-tools";

import type { NostrEvent } from "../order/events.js";
import {
  createInboxList,
  createNip42AuthEvent,
  assertVerifiedInboxLiveProbe,
  normalizeDiscoveryRelays,
  normalizeInboxListRelays,
  publishGiftWrap,
  publishInboxList,
  queryGiftWraps,
  selectInboxList,
  snapshotNostrEvent,
  validateInboxList,
  type InboxObservation,
  type InboxPublicationResult,
  type InboxReceipt,
  type InboxRelayPort,
  type VerifiedInboxLiveProbeResult
} from "./inbox.js";

export interface DiscoveredTradeInbox {
  event: NostrEvent | null;
  eventId: string | null;
  relays: string[];
}

const LIVE_INBOX_BUFFER_LIMIT = 64;

export class NostrTradeTransport {
  private readonly discoveryRelays: readonly string[];
  private readonly inboxRelays: readonly string[];
  private readonly probeEvidence: ReadonlyMap<string, VerifiedInboxLiveProbeResult>;
  private readonly liveInboxEvents = new Map<string, NostrEvent[]>();

  constructor(
    private readonly port: InboxRelayPort,
    discoveryRelays: readonly string[],
    inboxRelays: readonly string[],
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
    probeEvidence: readonly VerifiedInboxLiveProbeResult[] = []
  ) {
    this.discoveryRelays = Object.freeze(normalizeDiscoveryRelays(discoveryRelays));
    this.inboxRelays = Object.freeze(normalizeInboxListRelays(inboxRelays));
    const entries = probeEvidence.map((evidence) => {
      assertVerifiedInboxLiveProbe(evidence);
      const relay = normalizeInboxListRelays([evidence.relay])[0]!;
      if (
        !Number.isSafeInteger(evidence.checkedAt) ||
        evidence.checkedAt < 0 ||
        !evidence.listReadback ||
        !evidence.recipientReadback ||
        !evidence.otherKeyExcluded
      ) throw new Error("Inbox relay live probe evidence is invalid");
      if (evidence.relay !== relay) {
        throw new Error("Verified inbox relay evidence is not canonical");
      }
      return [relay, evidence] as const;
    });
    if (new Set(entries.map(([relay]) => relay)).size !== entries.length) {
      throw new Error("Inbox relay live probe evidence contains a duplicate relay");
    }
    this.probeEvidence = new Map(entries);
  }

  bufferLiveEvent(recipientPubkey: string, event: NostrEvent): void {
    if (!/^[0-9a-f]{64}$/.test(recipientPubkey)) {
      throw new Error("Live inbox recipient pubkey is malformed");
    }
    if (
      event.kind !== 1059 ||
      !event.tags.some((tag) => tag[0] === "p" && tag[1] === recipientPubkey)
    ) {
      throw new Error("Live inbox event does not target the recipient");
    }
    const pending = this.liveInboxEvents.get(recipientPubkey) ?? [];
    if (pending.some((candidate) => candidate.id === event.id)) return;
    if (pending.length === LIVE_INBOX_BUFFER_LIMIT) pending.shift();
    pending.push(snapshotNostrEvent(event));
    this.liveInboxEvents.set(recipientPubkey, pending);
  }

  hasBufferedLiveEvent(recipientPubkey: string): boolean {
    return (this.liveInboxEvents.get(recipientPubkey)?.length ?? 0) > 0;
  }

  private assertFreshProbeEvidence(relayValues: readonly string[], now: number): string[] {
    const relays = normalizeInboxListRelays(relayValues);
    for (const relay of relays) {
      const evidence = this.probeEvidence.get(relay);
      if (
        !evidence ||
        evidence.checkedAt > now + 300 ||
        now - evidence.checkedAt > 86_400
      ) {
        throw new Error(`Inbox relay ${relay} lacks a fresh recipient-only live probe`);
      }
    }
    return relays;
  }

  createRegistration(protocolSecretKey: Uint8Array): NostrEvent {
    const now = this.now();
    this.assertFreshProbeEvidence(this.inboxRelays, now);
    return createInboxList(this.inboxRelays, protocolSecretKey, now);
  }

  async publishRegistration(
    event: NostrEvent,
    protocolSecretKey: Uint8Array
  ): Promise<InboxPublicationResult> {
    const eventSnapshot = snapshotNostrEvent(event);
    const keySnapshot = Uint8Array.from(protocolSecretKey);
    try {
      const now = this.now();
      this.assertFreshProbeEvidence(this.inboxRelays, now);
      const validated = validateInboxList(
        eventSnapshot,
        getPublicKey(keySnapshot),
        now
      );
      if (
        validated.relays.length !== this.inboxRelays.length ||
        validated.relays.some((relay, index) => relay !== this.inboxRelays[index])
      ) {
        throw new Error("Inbox registration does not match the configured inbox relays");
      }
      return await publishInboxList(
        eventSnapshot,
        this.discoveryRelays,
        keySnapshot,
        this.port,
        now,
        1
      );
    } finally {
      keySnapshot.fill(0);
    }
  }

  async discoverInbox(
    authorPubkey: string,
    requesterSecretKey: Uint8Array,
    responseRelays?: readonly string[]
  ): Promise<DiscoveredTradeInbox> {
    const keySnapshot = Uint8Array.from(requesterSecretKey);
    try {
      const now = this.now();
      if (responseRelays) {
        try {
          return { event: null, eventId: null, relays: this.assertFreshProbeEvidence(responseRelays, now) };
        } catch { /* Unsupported direct routes use signed inbox discovery. */ }
      }
      const observations = await Promise.all(this.discoveryRelays.map(async (relay) => {
        try {
          const events = await this.port.query(relay, {
            authors: [authorPubkey],
            kinds: [10050],
            limit: 20
          }, async (challenge) => createNip42AuthEvent(relay, challenge, keySnapshot, now));
          return events.map((event): InboxObservation => ({
            relay,
            event: snapshotNostrEvent(event)
          }));
        } catch {
          return [];
        }
      }));
      const selected = selectInboxList(observations.flat(), authorPubkey, now, 1);
      return {
        event: snapshotNostrEvent(selected.event),
        eventId: selected.event.id,
        relays: [...this.assertFreshProbeEvidence(selected.relays, now)]
      };
    } finally {
      keySnapshot.fill(0);
    }
  }

  async discover(authorPubkey: string, requesterSecretKey: Uint8Array): Promise<string[]> {
    return (await this.discoverInbox(authorPubkey, requesterSecretKey)).relays;
  }

  async send(
    wrapper: NostrEvent,
    recipientInboxRelays: readonly string[],
    senderSecretKey: Uint8Array
  ): Promise<InboxReceipt[]> {
    const wrapperSnapshot = snapshotNostrEvent(wrapper);
    const keySnapshot = Uint8Array.from(senderSecretKey);
    try {
      const now = this.now();
      const recipientRelays = this.assertFreshProbeEvidence(recipientInboxRelays, now);
      const receipts = await publishGiftWrap(
        wrapperSnapshot,
        recipientRelays,
        keySnapshot,
        this.port,
        now
      );
      if (!receipts.some((receipt) => receipt.ok)) {
        throw new Error("Private trade message received no authenticated inbox acknowledgement");
      }
      return receipts;
    } finally {
      keySnapshot.fill(0);
    }
  }

  async read(
    recipientPubkey: string,
    recipientSecretKey: Uint8Array,
    since: number
  ): Promise<NostrEvent[]> {
    const keySnapshot = Uint8Array.from(recipientSecretKey);
    try {
      const now = this.now();
      this.assertFreshProbeEvidence(this.inboxRelays, now);
      if (getPublicKey(keySnapshot) !== recipientPubkey) {
        throw new Error("Trade inbox read requires the exact recipient key");
      }
      const buffered = this.liveInboxEvents.get(recipientPubkey);
      if (buffered?.length) {
        this.liveInboxEvents.delete(recipientPubkey);
        return buffered.map(snapshotNostrEvent);
      }
      return await queryGiftWraps(
        recipientPubkey,
        this.inboxRelays,
        keySnapshot,
        this.port,
        since,
        now
      );
    } finally {
      keySnapshot.fill(0);
    }
  }
}
