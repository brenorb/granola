import { getPublicKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import { OrderApi, TEST_MARKET } from "../api/order-api.js";
import { MakerIdentity } from "../nostr/identity.js";
import type {
  AuthHandler,
  InboxRelayCapabilities,
  InboxRelayPort
} from "../nostr/inbox.js";
import type { PersistentInboxSubscription } from "../nostr/inbox-relay.js";
import type { TradeSubscriptionCallbacks } from "../nostr/trade-subscription.js";
import type { NostrEvent } from "../order/events.js";
import { NostrOrderService, type OrderRelayPort } from "../order/service.js";
import { OrderOutboxRepository } from "../storage/order-outbox.js";
import {
  MemoryStorageDriver,
  WalletRepository
} from "../storage/wallet-repository.js";
import {
  createBrowserTradeRuntime,
  probeTradeInboxRelay
} from "./trade-runtime.js";

const now = 1_800_000_000;
const relay = "wss://inbox.example";

function key(last: number): Uint8Array {
  const value = new Uint8Array(32);
  value[31] = last;
  return value;
}

class ProbePort implements InboxRelayPort {
  readonly stored: NostrEvent[] = [];
  readonly authPubkeys: string[] = [];

  async info(): Promise<InboxRelayCapabilities> {
    return { supportedNips: [17, 40, 42], authRequired: true };
  }

  async publish(
    _relay: string,
    event: NostrEvent,
    auth: AuthHandler
  ): Promise<string> {
    this.authPubkeys.push((await auth("publish")).pubkey);
    this.stored.push(structuredClone(event));
    return "saved";
  }

  async query(
    _relay: string,
    filter: Record<string, unknown>,
    auth: AuthHandler
  ): Promise<NostrEvent[]> {
    const requester = (await auth("query")).pubkey;
    this.authPubkeys.push(requester);
    const ids = filter.ids as string[] | undefined;
    const authors = filter.authors as string[] | undefined;
    const recipients = filter["#p"] as string[] | undefined;
    if (recipients?.[0] && requester !== recipients[0]) return [];
    return this.stored.filter((event) =>
      (!ids || ids.includes(event.id)) &&
      (!authors || authors.includes(event.pubkey)) &&
      (!recipients || event.tags.some(
        (tag) => tag[0] === "p" && recipients.includes(tag[1] ?? "")
      ))
    );
  }

  async subscribe(
    _relay: string,
    _filter: Record<string, unknown>,
    _auth: AuthHandler,
    _callbacks: TradeSubscriptionCallbacks
  ): Promise<PersistentInboxSubscription> {
    return { close: () => undefined };
  }
}

const silentOrderRelays: OrderRelayPort = {
  publish: vi.fn(async () => []),
  queryProjections: vi.fn(async () => []),
  queryTransitions: vi.fn(async () => [])
};

describe("browser trade runtime", () => {
  it("proves recipient-only authenticated relay storage and zeroizes probe keys", async () => {
    const port = new ProbePort();
    const generated = [key(1), key(2), key(3), key(4)];
    const queue = [...generated];
    const evidence = await probeTradeInboxRelay({
      relay,
      port,
      now,
      generateSecretKey: () => queue.shift()!
    });

    expect(evidence).toMatchObject({
      relay,
      checkedAt: now,
      listReadback: true,
      recipientReadback: true,
      otherKeyExcluded: true
    });
    expect(port.stored.map((event) => event.kind)).toEqual([10050, 1059]);
    expect(port.authPubkeys).toContain(getPublicKey(key(1)));
    expect(queue).toEqual([]);
    expect(generated.every((value) => value.every((byte) => byte === 0))).toBe(true);
  });

  it("constructs one durable redacted coordinator for an isolated profile", async () => {
    const driver = new MemoryStorageDriver();
    const wallet = new WalletRepository(driver);
    const identity = new MakerIdentity(driver, async (action) => action(), () => key(9));
    const orderService = new NostrOrderService(identity, silentOrderRelays);
    const orderOutbox = new OrderOutboxRepository(driver);
    const orderApi = new OrderApi(
      identity,
      orderService,
      () => now,
      () => "11111111-1111-4111-8111-111111111111",
      orderOutbox
    );

    const runtime = await createBrowserTradeRuntime({
      profile: "maker",
      driver,
      wallet,
      makerIdentity: identity,
      orderApi,
      orderService,
      orderOutbox,
      inboxPort: new ProbePort(),
      inboxRelay: relay,
      discoveryRelays: [
        "wss://one.example",
        "wss://two.example",
        "wss://three.example"
      ],
      now: () => now,
      generateSecretKey: (() => {
        let next = 10;
        return () => key(next++);
      })()
    });

    expect(await runtime.api.listTrades()).toEqual([]);
    expect(runtime.market).toEqual(TEST_MARKET);
    expect(runtime.inboxRelay).toBe(relay);
    expect(runtime.sessions).toBeDefined();
    expect(runtime.transport).toBeDefined();
  });
});
