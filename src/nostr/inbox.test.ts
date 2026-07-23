import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools";

import type { NostrEvent } from "../order/events.js";
import {
  createInboxList,
  createNip42AuthEvent,
  publishGiftWrap,
  publishInboxList,
  probeInboxRelayLive,
  queryGiftWraps,
  selectInboxList,
  validateInboxList,
  type AuthHandler,
  type InboxRelayCapabilities,
  type InboxRelayPort
} from "./inbox.js";

const key = (last: number): Uint8Array => {
  const bytes = new Uint8Array(32);
  bytes[31] = last;
  return bytes;
};

const recipientKey = key(1);
const senderKey = key(2);
const wrongKey = key(3);
const wrapperKey = key(4);
const recipient = getPublicKey(recipientKey);
const now = 1_800_000_000;
const discoveryRelays = ["wss://discovery-one.example", "wss://discovery-two.example", "wss://discovery-three.example"];
const inboxRelays = ["wss://inbox-one.example", "wss://inbox-two.example"];

function wrapper(): NostrEvent {
  return finalizeEvent({
    kind: 1059,
    created_at: now - 30,
    tags: [["p", recipient], ["expiration", String(now + 3600)]],
    content: "encrypted-test-vector"
  }, wrapperKey);
}

class FakeRelayPort implements InboxRelayPort {
  readonly published: Array<{
    relay: string;
    id: string;
    event: NostrEvent;
    authPubkey: string;
  }> = [];
  readonly queried: Array<{ relay: string; authPubkey: string; filter: Record<string, unknown> }> = [];
  readonly stored = new Map<string, NostrEvent[]>();
  failPublishOnce = new Set<string>();
  hideReadback = new Set<string>();
  readbackOverride = new Map<string, NostrEvent[]>();
  queryOverrideQueue: NostrEvent[][] = [];
  failQuery = new Set<string>();
  publicationGate: Promise<void> | null = null;
  infoGate: Promise<void> | null = null;
  capabilities: InboxRelayCapabilities = {
    supportedNips: [17, 40, 42],
    authRequired: true
  };

  async info(): Promise<InboxRelayCapabilities> {
    if (this.infoGate) await this.infoGate;
    return this.capabilities;
  }

  private async authenticate(relay: string, auth: AuthHandler): Promise<NostrEvent> {
    return auth(`challenge:${relay}`);
  }

  async publish(relay: string, event: NostrEvent, auth: AuthHandler): Promise<string> {
    if (this.publicationGate) await this.publicationGate;
    const authEvent = await this.authenticate(relay, auth);
    this.published.push({
      relay,
      id: event.id,
      event: structuredClone(event),
      authPubkey: authEvent.pubkey
    });
    if (this.failPublishOnce.delete(relay)) throw new Error("temporary rejection");
    this.stored.set(relay, [...(this.stored.get(relay) ?? []), event]);
    return "stored";
  }

  async query(
    relay: string,
    filter: Record<string, unknown>,
    auth: AuthHandler
  ): Promise<NostrEvent[]> {
    if (this.failQuery.has(relay)) throw new Error("relay unavailable");
    const authEvent = await this.authenticate(relay, auth);
    this.queried.push({ relay, authPubkey: authEvent.pubkey, filter });
    if (this.queryOverrideQueue.length > 0 && Array.isArray(filter.ids)) {
      return this.queryOverrideQueue.shift()!;
    }
    if (this.hideReadback.has(relay)) return [];
    if (filter.ids && this.readbackOverride.has(relay)) {
      return this.readbackOverride.get(relay)!;
    }
    const stored = this.stored.get(relay) ?? [];
    const ids = filter.ids as string[] | undefined;
    const kinds = filter.kinds as number[] | undefined;
    const recipients = filter["#p"] as string[] | undefined;
    if (recipients && authEvent.pubkey !== recipients[0]) return [];
    return stored.filter((event) =>
      (!ids || ids.includes(event.id)) &&
      (!kinds || kinds.includes(event.kind)) &&
      (!recipients || event.tags.some((tag) => tag[0] === "p" && recipients.includes(tag[1]!)))
    );
  }
}

describe("strict NIP-17 inbox transport", () => {
  it("creates and validates a normalized, sorted kind 10050 list", () => {
    const event = createInboxList([
      "wss://z.example/path/",
      "wss://a.example"
    ], recipientKey, now);

    expect(event.kind).toBe(10050);
    expect(event.content).toBe("");
    expect(event.tags).toEqual([
      ["relay", "wss://a.example"],
      ["relay", "wss://z.example/path"]
    ]);
    expect(validateInboxList(event, recipient, now)).toEqual({
      event: structuredClone(event),
      relays: ["wss://a.example", "wss://z.example/path"]
    });
  });

  it("rejects malformed, stale, future, duplicate, and wrongly authored lists", () => {
    expect(() => createInboxList(["wss://same.example", "wss://same.example/"], recipientKey, now))
      .toThrow(/duplicate/i);
    expect(() => createInboxList(["ws://insecure.example"], recipientKey, now)).toThrow(/wss/i);

    const valid = createInboxList(inboxRelays, recipientKey, now);
    expect(() => validateInboxList(valid, getPublicKey(wrongKey), now)).toThrow(/author/i);
    expect(() => validateInboxList({ ...valid, content: "not empty" }, recipient, now)).toThrow(/signature|content/i);
    const stale = createInboxList(inboxRelays, recipientKey, now - 7 * 24 * 60 * 60 - 1);
    expect(() => validateInboxList(stale, recipient, now)).toThrow(/stale/i);
    const future = createInboxList(inboxRelays, recipientKey, now + 301);
    expect(() => validateInboxList(future, recipient, now)).toThrow(/future/i);
  });

  it("selects the NIP-01 latest list only when that exact ID has discovery quorum", () => {
    const older = createInboxList(["wss://old.example"], recipientKey, now - 10);
    const latest = createInboxList(inboxRelays, recipientKey, now);
    expect(selectInboxList([
      { relay: discoveryRelays[0]!, event: older },
      { relay: discoveryRelays[0]!, event: latest },
      { relay: discoveryRelays[1]!, event: latest },
      { relay: discoveryRelays[2]!, event: older }
    ], recipient, now, 2).event.id).toBe(latest.id);

    expect(() => selectInboxList([
      { relay: discoveryRelays[0]!, event: latest },
      { relay: discoveryRelays[1]!, event: older },
      { relay: discoveryRelays[2]!, event: older }
    ], recipient, now, 2)).toThrow(/quorum|split/i);
  });

  it("accepts one matching discovery relay by default", () => {
    const latest = createInboxList(inboxRelays, recipientKey, now);

    const selected = selectInboxList([
      { relay: discoveryRelays[0]!, event: latest }
    ], recipient, now);

    expect(selected.event.id).toBe(latest.id);
    expect(selected.relays).toEqual(inboxRelays);
  });

  it("returns immutable validated inbox-list snapshots isolated from relay mutation", () => {
    const candidate = createInboxList(inboxRelays, recipientKey, now);
    const validated = validateInboxList(candidate, recipient, now);
    const selected = selectInboxList([
      { relay: discoveryRelays[0]!, event: candidate },
      { relay: discoveryRelays[1]!, event: candidate }
    ], recipient, now, 2);
    candidate.content = "mutated-after-validation";
    candidate.tags[0]![1] = "wss://attacker.example";

    expect(validated.event.content).toBe("");
    expect(selected.event.content).toBe("");
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.event)).toBe(true);
    expect(Object.isFrozen(validated.relays)).toBe(true);
  });

  it("signs NIP-42 AUTH with the exact protocol key and relay challenge", () => {
    const auth = createNip42AuthEvent("wss://inbox-one.example/", "challenge-value", recipientKey, now);
    expect(auth).toMatchObject({
      kind: 22242,
      pubkey: recipient,
      created_at: now,
      content: "",
      tags: [["relay", "wss://inbox-one.example"], ["challenge", "challenge-value"]]
    });
  });

  it("requires ACK and exact readback quorum when publishing discovery", async () => {
    const port = new FakeRelayPort();
    port.hideReadback.add(discoveryRelays[2]!);
    const list = createInboxList(inboxRelays, recipientKey, now);

    const result = await publishInboxList(list, discoveryRelays, recipientKey, port, now, 2);

    expect(result.confirmed).toHaveLength(2);
    expect(result.readback.filter(({ found }) => found).every(({ event, observedAt }) =>
      event?.id === list.id && observedAt === now
    )).toBe(true);
    expect(port.published.every((call) => call.id === list.id && call.authPubkey === recipient)).toBe(true);
    expect(port.queried.every((call) => call.authPubkey === recipient)).toBe(true);
  });

  it("accepts one authenticated ACK and exact readback by default", async () => {
    const port = new FakeRelayPort();
    port.hideReadback.add(discoveryRelays[1]!);
    port.hideReadback.add(discoveryRelays[2]!);
    const list = createInboxList(inboxRelays, recipientKey, now);

    const result = await publishInboxList(list, discoveryRelays, recipientKey, port, now);

    expect(result.confirmed).toEqual([discoveryRelays[0]]);
  });

  it("does not count a malformed relay substitution as exact readback", async () => {
    const port = new FakeRelayPort();
    const list = createInboxList(inboxRelays, recipientKey, now);
    port.readbackOverride.set(discoveryRelays[1]!, [{ ...list, content: "tampered" }]);
    port.hideReadback.add(discoveryRelays[2]!);

    await expect(publishInboxList(list, discoveryRelays, recipientKey, port, now, 2))
      .rejects.toThrow(/ACK and readback quorum/i);
  });

  it("returns immutable quorum evidence isolated from relay-owned candidates", async () => {
    const port = new FakeRelayPort();
    const list = createInboxList(inboxRelays, recipientKey, now);
    const relayCandidate = structuredClone(list);
    port.readbackOverride.set(discoveryRelays[0]!, [relayCandidate]);

    const result = await publishInboxList(list, discoveryRelays, recipientKey, port, now, 2);
    relayCandidate.content = "mutated-after-validation";
    relayCandidate.tags[0]![1] = "wss://attacker.example";

    expect(result.readback[0]?.event).toEqual(structuredClone(list));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.readback)).toBe(true);
    expect(Object.isFrozen(result.readback[0]?.event)).toBe(true);
    expect(() => {
      result.receipts[0]!.message = "mutated";
    }).toThrow(TypeError);
  });

  it("snapshots the event and signer bytes before direct publication awaits relay I/O", async () => {
    const port = new FakeRelayPort();
    let releasePublication!: () => void;
    port.publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const mutableKey = key(8);
    const expectedSigner = getPublicKey(mutableKey);
    const list = createInboxList(inboxRelays, mutableKey, now);
    const persisted = structuredClone(list);

    const pending = publishInboxList(list, discoveryRelays, mutableKey, port, now, 2);
    list.content = "mutated-after-invocation";
    list.tags[0]![1] = "wss://mutated.example";
    mutableKey.fill(0);
    releasePublication();
    const result = await pending;

    expect(result.event).toEqual(persisted);
    expect(result.readback.filter(({ found }) => found).map(({ event }) => event))
      .toEqual([persisted, persisted, persisted]);
    expect(port.published.every(({ id, authPubkey }) =>
      id === persisted.id && authPubkey === expectedSigner
    )).toBe(true);
  });

  it("retries the exact kind 1059 wrapper and authenticates as the sealed sender key", async () => {
    const port = new FakeRelayPort();
    port.failPublishOnce.add(inboxRelays[0]!);
    const gift = wrapper();

    const first = await publishGiftWrap(gift, inboxRelays, senderKey, port, now);
    const second = await publishGiftWrap(gift, inboxRelays, senderKey, port, now);

    expect(first.some((receipt) => !receipt.ok)).toBe(true);
    expect(second.every((receipt) => receipt.ok)).toBe(true);
    expect(port.published.map((call) => call.id)).toEqual([gift.id, gift.id, gift.id, gift.id]);
    expect(port.published.every((call) => call.authPubkey === getPublicKey(senderKey))).toBe(true);
  });

  it("snapshots a gift wrap and sender key before delayed relay capability I/O", async () => {
    const port = new FakeRelayPort();
    let releaseInfo!: () => void;
    port.infoGate = new Promise<void>((resolve) => {
      releaseInfo = resolve;
    });
    const mutableWrapper = wrapper();
    const persisted = structuredClone(mutableWrapper);
    const mutableSender = key(8);
    const expectedSigner = getPublicKey(mutableSender);

    const pending = publishGiftWrap(
      mutableWrapper,
      inboxRelays,
      mutableSender,
      port,
      now
    );
    mutableWrapper.content = "mutated-after-invocation";
    mutableWrapper.tags[0]![1] = getPublicKey(wrongKey);
    mutableSender.fill(0);
    releaseInfo();
    const receipts = await pending;

    expect(receipts.every(({ ok }) => ok)).toBe(true);
    expect(port.published.map(({ event }) => event)).toEqual([persisted, persisted]);
    expect(port.published.every(({ authPubkey }) => authPubkey === expectedSigner)).toBe(true);
  });

  it("queries gift wraps only with the exact recipient protocol key", async () => {
    const port = new FakeRelayPort();
    const gift = wrapper();
    port.stored.set(inboxRelays[0]!, [gift]);

    await expect(queryGiftWraps(recipient, inboxRelays, recipientKey, port, now - 100, now))
      .resolves.toEqual([structuredClone(gift)]);
    expect(port.queried[0]?.authPubkey).toBe(recipient);
    await expect(queryGiftWraps(recipient, inboxRelays, wrongKey, port, now - 100, now))
      .rejects.toThrow(/recipient protocol key/i);
  });

  it("snapshots the recipient key before a delayed gift-wrap query", async () => {
    const port = new FakeRelayPort();
    let releaseInfo!: () => void;
    port.infoGate = new Promise<void>((resolve) => {
      releaseInfo = resolve;
    });
    const gift = wrapper();
    port.stored.set(inboxRelays[0]!, [gift]);
    const mutableRecipient = key(1);
    const expectedRecipient = getPublicKey(mutableRecipient);

    const pending = queryGiftWraps(
      expectedRecipient,
      inboxRelays,
      mutableRecipient,
      port,
      now - 100,
      now
    );
    mutableRecipient.fill(0);
    releaseInfo();

    await expect(pending).resolves.toEqual([structuredClone(gift)]);
    expect(port.queried.every(({ authPubkey }) => authPubkey === expectedRecipient)).toBe(true);
  });

  it("snapshots every live-probe artifact and key before relay capability I/O", async () => {
    const port = new FakeRelayPort();
    let releaseInfo!: () => void;
    port.infoGate = new Promise<void>((resolve) => {
      releaseInfo = resolve;
    });
    const mutableRecipient = key(1);
    const mutableSender = key(2);
    const mutableOther = key(3);
    const expectedRecipient = getPublicKey(mutableRecipient);
    const expectedSender = getPublicKey(mutableSender);
    const expectedOther = getPublicKey(mutableOther);
    const list = createInboxList(inboxRelays, mutableRecipient, now);
    const gift = wrapper();
    const listId = list.id;
    const giftId = gift.id;

    const pending = probeInboxRelayLive({
      relay: inboxRelays[0]!,
      inboxList: list,
      wrapper: gift,
      recipientProtocolSecretKey: mutableRecipient,
      senderProtocolSecretKey: mutableSender,
      otherProtocolSecretKey: mutableOther,
      port,
      now
    });
    list.content = "mutated-after-invocation";
    gift.content = "mutated-after-invocation";
    mutableRecipient.fill(0);
    mutableSender.fill(0);
    mutableOther.fill(0);
    releaseInfo();
    await expect(pending).resolves.toMatchObject({
      listReadback: true,
      recipientReadback: true,
      otherKeyExcluded: true
    });

    expect(port.published.map(({ id }) => id)).toEqual([listId, giftId]);
    expect(port.published.map(({ authPubkey }) => authPubkey))
      .toEqual([expectedRecipient, expectedSender]);
    expect(port.queried.map(({ authPubkey }) => authPubkey))
      .toEqual([expectedRecipient, expectedRecipient, expectedOther]);
  });

  it("rejects malformed same-ID substitutions in live-probe readback", async () => {
    const list = createInboxList(inboxRelays, recipientKey, now);
    const gift = wrapper();
    const input = {
      relay: inboxRelays[0]!,
      inboxList: list,
      wrapper: gift,
      recipientProtocolSecretKey: recipientKey,
      senderProtocolSecretKey: senderKey,
      otherProtocolSecretKey: wrongKey,
      now
    };

    const badListPort = new FakeRelayPort();
    badListPort.queryOverrideQueue.push(
      [{ ...list, content: "tampered" }],
      [gift],
      []
    );
    await expect(probeInboxRelayLive({ ...input, port: badListPort }))
      .rejects.toThrow(/live probe/i);

    const badGiftPort = new FakeRelayPort();
    badGiftPort.queryOverrideQueue.push(
      [list],
      [{ ...gift, content: "tampered" }],
      []
    );
    await expect(probeInboxRelayLive({ ...input, port: badGiftPort }))
      .rejects.toThrow(/live probe/i);
  });

  it("zeroizes every copied live-probe key when timestamp validation fails", async () => {
    const originalFrom = Uint8Array.from.bind(Uint8Array);
    const copies: Uint8Array[] = [];
    const from = vi.spyOn(Uint8Array, "from").mockImplementation((value) => {
      const copy = originalFrom(value);
      if (copy.length === 32) copies.push(copy);
      return copy;
    });
    await expect(probeInboxRelayLive({
      relay: inboxRelays[0]!,
      inboxList: createInboxList(inboxRelays, recipientKey, now),
      wrapper: wrapper(),
      recipientProtocolSecretKey: recipientKey,
      senderProtocolSecretKey: senderKey,
      otherProtocolSecretKey: wrongKey,
      port: new FakeRelayPort(),
      now: -1
    })).rejects.toThrow(/timestamp|time/i);

    expect(copies).toHaveLength(3);
    expect(copies.every((copy) => copy.every((byte) => byte === 0))).toBe(true);
    from.mockRestore();
  });

  it("keeps reading when one inbox relay is unavailable but fails when all are", async () => {
    const port = new FakeRelayPort();
    const gift = wrapper();
    port.failQuery.add(inboxRelays[0]!);
    port.stored.set(inboxRelays[1]!, [gift]);

    await expect(queryGiftWraps(recipient, inboxRelays, recipientKey, port, now - 100, now))
      .resolves.toEqual([structuredClone(gift)]);

    port.failQuery.add(inboxRelays[1]!);
    await expect(queryGiftWraps(recipient, inboxRelays, recipientKey, port, now - 100, now))
      .rejects.toThrow(/all inbox relays/i);
  });

  it("rejects an expiration outside JavaScript's safe integer range", async () => {
    const port = new FakeRelayPort();
    const unsafe = finalizeEvent({
      kind: 1059,
      created_at: now - 30,
      tags: [["p", recipient], ["expiration", "9007199254740992"]],
      content: "encrypted-test-vector"
    }, wrapperKey);

    await expect(publishGiftWrap(unsafe, inboxRelays, senderKey, port, now))
      .rejects.toThrow(/expiration/i);
  });
});
