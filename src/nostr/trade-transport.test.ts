import { finalizeEvent, getPublicKey } from "nostr-tools";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createTradeRumor, termsHash, wrapTradeRumor, type GranolaTradeMessage } from "../trade/messages.js";
import type { NostrEvent } from "../order/events.js";
import {
  createInboxList,
  probeInboxRelayLive,
  type AuthHandler,
  type InboxRelayPort,
  type VerifiedInboxLiveProbeResult
} from "./inbox.js";
import { NostrTradeTransport } from "./trade-transport.js";

const key = (last: number): Uint8Array => {
  const value = new Uint8Array(32);
  value[31] = last;
  return value;
};

class MemoryInboxPort implements InboxRelayPort {
  readonly events = new Map<string, NostrEvent[]>();
  readonly publications: Array<{
    relay: string;
    event: NostrEvent;
    authPubkey: string;
  }> = [];
  readonly queries: Array<{
    relay: string;
    filter: Record<string, unknown>;
    authPubkey: string;
  }> = [];
  rejectPublications = false;
  hideReadback = false;
  publicationGate: Promise<void> | null = null;
  queryGate: Promise<void> | null = null;

  async info(): Promise<{ supportedNips: number[]; authRequired: boolean }> {
    return { supportedNips: [17, 40, 42], authRequired: true };
  }

  async publish(relay: string, event: NostrEvent, auth: AuthHandler): Promise<string> {
    if (this.publicationGate) await this.publicationGate;
    const authEvent = await auth(`challenge:${relay}`);
    this.publications.push({ relay, event, authPubkey: authEvent.pubkey });
    if (this.rejectPublications) throw new Error("rejected");
    this.events.set(relay, [...(this.events.get(relay) ?? []), event]);
    return "saved";
  }

  async query(relay: string, filter: Record<string, unknown>, auth: AuthHandler): Promise<NostrEvent[]> {
    if (this.queryGate) await this.queryGate;
    const authEvent = await auth(`challenge:${relay}`);
    this.queries.push({ relay, filter: structuredClone(filter), authPubkey: authEvent.pubkey });
    if (this.hideReadback && Array.isArray(filter.ids)) return [];
    const kinds = filter.kinds as number[] | undefined;
    const authors = filter.authors as string[] | undefined;
    const recipients = filter["#p"] as string[] | undefined;
    if (recipients && authEvent.pubkey !== recipients[0]) return [];
    return (this.events.get(relay) ?? []).filter((event) =>
      (!kinds || kinds.includes(event.kind)) &&
      (!authors || authors.includes(event.pubkey)) &&
      (!recipients || event.tags.some((tag) => tag[0] === "p" && recipients.includes(tag[1] ?? "")))
    );
  }
}

const discovery = ["wss://one.example", "wss://two.example", "wss://three.example"];
const inboxes = ["wss://inbox.example"];
const now = 1_800_000_000;

let verifiedProbeEvidence: VerifiedInboxLiveProbeResult[] = [];

beforeAll(async () => {
  const relays = [...inboxes, "wss://different-inbox.example"];
  verifiedProbeEvidence = await Promise.all(relays.map(async (relay) => {
    const port = new MemoryInboxPort();
    const recipientKey = key(10);
    const list = createInboxList([relay], recipientKey, now);
    return probeInboxRelayLive({
      relay,
      inboxList: list,
      wrapper: finalizeGift(getPublicKey(recipientKey)),
      recipientProtocolSecretKey: recipientKey,
      senderProtocolSecretKey: key(11),
      otherProtocolSecretKey: key(12),
      port,
      now
    });
  }));
});

function probeEvidence(relays: readonly string[] = inboxes): VerifiedInboxLiveProbeResult[] {
  return relays.map((relay) => {
    const evidence = verifiedProbeEvidence.find((item) => item.relay === relay);
    if (!evidence) throw new Error(`Missing test probe evidence for ${relay}`);
    return evidence;
  });
}

function finalizeGift(recipient: string): NostrEvent {
  return finalizeEvent({
    kind: 1059,
    created_at: now - 30,
    tags: [["p", recipient], ["expiration", String(now + 3_600)]],
    content: "encrypted-test-vector"
  }, key(9));
}

describe("Nostr trade transport", () => {
  it("requires fresh recipient-only probe evidence before advertising or using inboxes", () => {
    const port = new MemoryInboxPort();
    const missing = new NostrTradeTransport(port, discovery, inboxes, () => now);
    expect(() => missing.createRegistration(key(1))).toThrow(/live probe/i);

    const stale = new NostrTradeTransport(
      port,
      discovery,
      inboxes,
      () => now + 86_401,
      probeEvidence()
    );
    expect(() => stale.createRegistration(key(1))).toThrow(/live probe/i);

    const fresh = new NostrTradeTransport(
      port,
      discovery,
      inboxes,
      () => now,
      probeEvidence()
    );
    expect(fresh.createRegistration(key(1)).kind).toBe(10050);

    expect(() => new NostrTradeTransport(
      port,
      discovery,
      inboxes,
      () => now,
      [{
        relay: inboxes[0]!,
        checkedAt: now,
        listReadback: true,
        recipientReadback: true,
        otherKeyExcluded: true
      } as VerifiedInboxLiveProbeResult]
    )).toThrow(/verified live probe/i);
  });

  it("zeroizes transport key copies when the injected clock throws", async () => {
    const originalFrom = Uint8Array.from.bind(Uint8Array);
    const copies: Uint8Array[] = [];
    const from = vi.spyOn(Uint8Array, "from").mockImplementation((value) => {
      const copy = originalFrom(value);
      if (copy.length === 32) copies.push(copy);
      return copy;
    });
    const transport = new NostrTradeTransport(
      new MemoryInboxPort(),
      discovery,
      inboxes,
      () => {
        throw new Error("clock failed");
      },
      probeEvidence()
    );
    const recipientKey = key(3);
    const recipient = getPublicKey(recipientKey);
    const gift = finalizeGift(recipient);

    await expect(transport.discover(recipient, key(4))).rejects.toThrow("clock failed");
    await expect(transport.send(gift, inboxes, key(4))).rejects.toThrow("clock failed");
    await expect(transport.read(recipient, recipientKey, now - 60)).rejects.toThrow("clock failed");

    expect(copies).toHaveLength(3);
    expect(copies.every((copy) => copy.every((byte) => byte === 0))).toBe(true);
    from.mockRestore();
  });

  it("rejects insecure, credentialed, duplicate, or noncanonical discovery relays", () => {
    const port = new MemoryInboxPort();
    expect(() => new NostrTradeTransport(
      port,
      ["ws://one.example", discovery[1]!, discovery[2]!],
      inboxes
    )).toThrow(/wss/i);
    expect(() => new NostrTradeTransport(
      port,
      ["wss://user:pass@one.example", discovery[1]!, discovery[2]!],
      inboxes
    )).toThrow(/credential/i);
    expect(() => new NostrTradeTransport(
      port,
      ["wss://one.example", "wss://one.example/", discovery[2]!],
      inboxes
    )).toThrow(/duplicate/i);
    expect(() => new NostrTradeTransport(
      port,
      ["wss://one.example?x=1", discovery[1]!, discovery[2]!],
      inboxes
    )).toThrow(/query|fragment/i);
  });

  it("creates an exact registration locally and publishes that persisted event later", async () => {
    const port = new MemoryInboxPort();
    let clock = now;
    const transport = new NostrTradeTransport(
      port,
      discovery,
      inboxes,
      () => clock,
      probeEvidence()
    );
    const recipientKey = key(1);

    const staged = transport.createRegistration(recipientKey);
    const persisted = structuredClone(staged);
    clock += 90;
    const registration = await transport.publishRegistration(persisted, recipientKey);

    expect(port.publications.map(({ event }) => event)).toEqual([
      persisted,
      persisted,
      persisted
    ]);
    expect(registration.event).toEqual(persisted);
    expect(registration.confirmed).toHaveLength(3);
  });

  it("rejects a tampered, wrongly signed, or differently configured registration before I/O", async () => {
    const port = new MemoryInboxPort();
    const transport = new NostrTradeTransport(
      port,
      discovery,
      inboxes,
      () => now,
      probeEvidence()
    );
    const recipientKey = key(1);
    const staged = transport.createRegistration(recipientKey);

    await expect(transport.publishRegistration(
      { ...staged, content: "tampered" },
      recipientKey
    )).rejects.toThrow(/signature|content/i);
    await expect(transport.publishRegistration(
      { ...staged, pubkey: getPublicKey(key(9)) },
      recipientKey
    )).rejects.toThrow(/signature|author|pubkey/i);
    await expect(transport.publishRegistration(staged, key(9)))
      .rejects.toThrow(/author|signer|key/i);

    const differentRelays = new NostrTradeTransport(
      port,
      discovery,
      ["wss://different-inbox.example"],
      () => now,
      probeEvidence(["wss://different-inbox.example"])
    );
    await expect(differentRelays.publishRegistration(staged, recipientKey))
      .rejects.toThrow(/configured inbox relays/i);
    expect(port.publications).toHaveLength(0);
  });

  it("requires the configured ACK and exact readback quorum", async () => {
    const port = new MemoryInboxPort();
    const transport = new NostrTradeTransport(
      port,
      discovery,
      inboxes,
      () => now,
      probeEvidence()
    );
    const recipientKey = key(1);
    const staged = transport.createRegistration(recipientKey);

    port.rejectPublications = true;
    await expect(transport.publishRegistration(staged, recipientKey))
      .rejects.toThrow(/ACK and readback quorum/i);

    port.rejectPublications = false;
    port.hideReadback = true;
    await expect(transport.publishRegistration(staged, recipientKey))
      .rejects.toThrow(/ACK and readback quorum/i);
  });

  it("retries one persisted registration without changing identity, signature, timestamp, or relays", async () => {
    const port = new MemoryInboxPort();
    let clock = now;
    const transport = new NostrTradeTransport(
      port,
      discovery,
      inboxes,
      () => clock,
      probeEvidence()
    );
    const recipientKey = key(1);
    const staged = transport.createRegistration(recipientKey);

    await transport.publishRegistration(staged, recipientKey);
    clock += 60;
    await transport.publishRegistration(staged, recipientKey);

    expect(port.publications).toHaveLength(6);
    expect(new Set(port.publications.map(({ event }) => event.id))).toEqual(new Set([staged.id]));
    expect(new Set(port.publications.map(({ event }) => event.sig))).toEqual(new Set([staged.sig]));
    expect(new Set(port.publications.map(({ event }) => event.created_at))).toEqual(
      new Set([staged.created_at])
    );
    const firstAttemptRelays = port.publications.slice(0, 3).map(({ relay }) => relay);
    const retryRelays = port.publications.slice(3).map(({ relay }) => relay);
    expect(retryRelays).toEqual(firstAttemptRelays);
    expect(new Set(firstAttemptRelays)).toEqual(new Set(discovery));
    expect(port.publications.every(({ authPubkey }) =>
      authPubkey === getPublicKey(recipientKey)
    )).toBe(true);
  });

  it("snapshots the exact event and signer bytes before delayed relay I/O", async () => {
    const port = new MemoryInboxPort();
    let releasePublication!: () => void;
    port.publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const transport = new NostrTradeTransport(
      port,
      discovery,
      inboxes,
      () => now,
      probeEvidence()
    );
    const recipientKey = key(1);
    const expectedSigner = getPublicKey(recipientKey);
    const staged = transport.createRegistration(recipientKey);
    const persisted = structuredClone(staged);

    const pending = transport.publishRegistration(staged, recipientKey);
    staged.content = "mutated-after-invocation";
    staged.tags[0]![1] = "wss://mutated.example";
    recipientKey.fill(0);
    releasePublication();
    const result = await pending;

    expect(result.event).toEqual(persisted);
    expect(result.readback.filter(({ found }) => found).map(({ event }) => event))
      .toEqual([persisted, persisted, persisted]);
    expect(port.publications.map(({ event }) => event))
      .toEqual([persisted, persisted, persisted]);
    expect(port.publications.every(({ authPubkey }) => authPubkey === expectedSigner)).toBe(true);
  });

  it("publishes and discovers the exact quorum-backed inbox list", async () => {
    const port = new MemoryInboxPort();
    const transport = new NostrTradeTransport(
      port,
      discovery,
      inboxes,
      () => now,
      probeEvidence()
    );
    const recipientKey = key(1);

    const staged = transport.createRegistration(recipientKey);
    const persisted = structuredClone(staged);
    const registration = await transport.publishRegistration(persisted, recipientKey);
    const exact = await transport.discoverInbox(getPublicKey(recipientKey), key(2));
    const selected = await transport.discover(getPublicKey(recipientKey), key(2));

    expect(registration.event).toEqual(persisted);
    expect(registration.confirmed).toHaveLength(3);
    expect(exact).toEqual({ event: persisted, eventId: persisted.id, relays: inboxes });
    expect(selected).toEqual(inboxes);
  });

  it("requires at least one authenticated inbox acknowledgement and reads deduplicated wraps", async () => {
    const port = new MemoryInboxPort();
    const transport = new NostrTradeTransport(
      port,
      discovery,
      inboxes,
      () => now,
      probeEvidence()
    );
    const makerKey = key(3);
    const takerKey = key(4);
    const maker = getPublicKey(makerKey);
    const taker = getPublicKey(takerKey);
    const tradeTerms = {
      base_unit: "sat",
      base_mint: "https://testnut.cashu.space",
      base_keyset: "00ba2e3e5779e035",
      quote_unit: "usd",
      quote_mint: "https://nofee.testnut.cashu.space",
      quote_keyset: "00ca2e3e5779e035",
      base_amount: "20",
      quote_amount: "1",
      price_cents_per_btc: "5000000"
    };
    const message: GranolaTradeMessage = {
      schema: "granola/dm/v2",
      deployment: "cashu-testnet-v1",
      type: "reserve_propose",
      message_id: "11111111-1111-4111-8111-111111111111",
      session_id: "11".repeat(32),
      reservation_id: "22222222-2222-4222-8222-222222222222",
      order_address: `30078:${maker}:granola:order:v2:33333333-3333-4333-8333-333333333333`,
      order_head: "44".repeat(32),
      maker_order_pubkey: maker,
      author_pubkey: taker,
      recipient_pubkey: maker,
      sequence: "0",
      previous_message_id: null,
      previous_transcript_hash: null,
      sent_at: now - 1,
      expires_at: now + 300,
      terms_hash: await termsHash(tradeTerms),
      terms: tradeTerms,
      body: { taker_cashu_pubkey: `02${"55".repeat(32)}` }
    };
    const rumor = await createTradeRumor(message, takerKey);
    const wrapped = wrapTradeRumor(rumor, takerKey, {
      ephemeralSecretKey: key(5),
      sealCreatedAt: now - 2,
      wrapperCreatedAt: now - 3,
      outerExpiration: message.expires_at + 3_600,
      sealNonce: new Uint8Array(32).fill(6),
      wrapperNonce: new Uint8Array(32).fill(7)
    });

    const receipts = await transport.send(wrapped.wrapper, inboxes, takerKey);
    await transport.send(wrapped.wrapper, inboxes, takerKey);
    const received = await transport.read(maker, makerKey, now - 60);

    expect(receipts.filter((receipt) => receipt.ok)).toHaveLength(1);
    expect(received.map((event) => event.id)).toEqual([wrapped.wrapper.id]);
  });

  it("snapshots transport send, discovery, and read inputs before delayed I/O", async () => {
    const sendPort = new MemoryInboxPort();
    let releaseSend!: () => void;
    sendPort.publicationGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendTransport = new NostrTradeTransport(
      sendPort,
      discovery,
      inboxes,
      () => now,
      probeEvidence()
    );
    const mutableSender = key(4);
    const expectedSender = getPublicKey(mutableSender);
    const gift = finalizeGift(getPublicKey(key(3)));
    const persistedGift = structuredClone(gift);
    const sending = sendTransport.send(gift, inboxes, mutableSender);
    gift.content = "mutated-after-invocation";
    mutableSender.fill(0);
    releaseSend();
    await expect(sending).resolves.toHaveLength(1);
    expect(sendPort.publications[0]).toMatchObject({
      event: persistedGift,
      authPubkey: expectedSender
    });

    const discoverPort = new MemoryInboxPort();
    let releaseDiscovery!: () => void;
    discoverPort.queryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const recipientKey = key(6);
    const recipient = getPublicKey(recipientKey);
    const requester = key(7);
    const expectedRequester = getPublicKey(requester);
    const discoverTransport = new NostrTradeTransport(
      discoverPort,
      discovery,
      inboxes,
      () => now,
      probeEvidence()
    );
    const list = discoverTransport.createRegistration(recipientKey);
    for (const relay of discovery) discoverPort.events.set(relay, [list]);
    const discovering = discoverTransport.discover(recipient, requester);
    requester.fill(0);
    releaseDiscovery();
    await expect(discovering).resolves.toEqual(inboxes);
    expect(discoverPort.queries.every(({ authPubkey }) =>
      authPubkey === expectedRequester
    )).toBe(true);

    const readPort = new MemoryInboxPort();
    let releaseRead!: () => void;
    readPort.queryGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readKey = key(3);
    const readRecipient = getPublicKey(readKey);
    const readGift = finalizeGift(readRecipient);
    readPort.events.set(inboxes[0]!, [readGift]);
    const readTransport = new NostrTradeTransport(
      readPort,
      discovery,
      inboxes,
      () => now,
      probeEvidence()
    );
    const reading = readTransport.read(readRecipient, readKey, now - 60);
    readKey.fill(0);
    releaseRead();
    await expect(reading).resolves.toEqual([structuredClone(readGift)]);
    expect(readPort.queries.every(({ authPubkey }) =>
      authPubkey === readRecipient
    )).toBe(true);
  });
});
