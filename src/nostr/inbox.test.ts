import { describe, expect, it } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools";

import type { NostrEvent } from "../order/events.js";
import {
  createInboxList,
  createNip42AuthEvent,
  publishGiftWrap,
  publishInboxList,
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
  readonly published: Array<{ relay: string; id: string; authPubkey: string }> = [];
  readonly queried: Array<{ relay: string; authPubkey: string; filter: Record<string, unknown> }> = [];
  readonly stored = new Map<string, NostrEvent[]>();
  failPublishOnce = new Set<string>();
  hideReadback = new Set<string>();
  failQuery = new Set<string>();
  capabilities: InboxRelayCapabilities = {
    supportedNips: [17, 40, 42],
    authRequired: true
  };

  async info(): Promise<InboxRelayCapabilities> {
    return this.capabilities;
  }

  private async authenticate(relay: string, auth: AuthHandler): Promise<NostrEvent> {
    return auth(`challenge:${relay}`);
  }

  async publish(relay: string, event: NostrEvent, auth: AuthHandler): Promise<string> {
    const authEvent = await this.authenticate(relay, auth);
    this.published.push({ relay, id: event.id, authPubkey: authEvent.pubkey });
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
    if (this.hideReadback.has(relay)) return [];
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
      event,
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
    expect(port.published.every((call) => call.id === list.id && call.authPubkey === recipient)).toBe(true);
    expect(port.queried.every((call) => call.authPubkey === recipient)).toBe(true);
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

  it("queries gift wraps only with the exact recipient protocol key", async () => {
    const port = new FakeRelayPort();
    const gift = wrapper();
    port.stored.set(inboxRelays[0]!, [gift]);

    await expect(queryGiftWraps(recipient, inboxRelays, recipientKey, port, now - 100, now))
      .resolves.toEqual([gift]);
    expect(port.queried[0]?.authPubkey).toBe(recipient);
    await expect(queryGiftWraps(recipient, inboxRelays, wrongKey, port, now - 100, now))
      .rejects.toThrow(/recipient protocol key/i);
  });

  it("keeps reading when one inbox relay is unavailable but fails when all are", async () => {
    const port = new FakeRelayPort();
    const gift = wrapper();
    port.failQuery.add(inboxRelays[0]!);
    port.stored.set(inboxRelays[1]!, [gift]);

    await expect(queryGiftWraps(recipient, inboxRelays, recipientKey, port, now - 100, now))
      .resolves.toEqual([gift]);

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
