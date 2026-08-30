import { finalizeEvent, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import type { NostrEvent } from "../order/events.js";
import {
  publishGiftWrap,
  queryGiftWraps,
  type AuthHandler,
  type InboxRelayPort
} from "./inbox.js";

const now = 1_800_000_000;

const key = (last: number): Uint8Array => {
  const value = new Uint8Array(32);
  value[31] = last;
  return value;
};

type Topology = "split" | "shared";

class RelayTopologyPort implements InboxRelayPort {
  readonly calls: Array<{ operation: string; relay: string }> = [];
  readonly down = new Set<string>();
  elapsed = 0;
  private readonly events = new Map<string, NostrEvent[]>();

  constructor(private readonly latencyMs: ReadonlyMap<string, number>) {}

  private visit(operation: string, relay: string): void {
    this.calls.push({ operation, relay });
    if (this.down.has(relay)) throw new Error(`${relay} unavailable`);
    this.elapsed += this.latencyMs.get(relay) ?? 0;
  }

  async info(relay: string): Promise<{ supportedNips: number[]; authRequired: boolean }> {
    this.visit("info", relay);
    return { supportedNips: [17, 40, 42], authRequired: true };
  }

  async publish(relay: string, event: NostrEvent, auth: AuthHandler): Promise<string> {
    this.visit("publish", relay);
    await auth(`challenge:${relay}`);
    this.events.set(relay, [...(this.events.get(relay) ?? []), structuredClone(event)]);
    return "stored";
  }

  async query(relay: string, filter: Record<string, unknown>, auth: AuthHandler): Promise<NostrEvent[]> {
    this.visit("query", relay);
    const authEvent = await auth(`challenge:${relay}`);
    const recipients = filter["#p"] as string[] | undefined;
    return (this.events.get(relay) ?? []).filter((event) =>
      (!recipients || event.tags.some((tag) => tag[0] === "p" && recipients.includes(tag[1] ?? ""))) &&
      (!filter.ids || (filter.ids as string[]).includes(event.id)) &&
      authEvent.pubkey === recipients?.[0]
    ).map((event) => structuredClone(event));
  }
}

async function attempt<T>(operation: () => Promise<T>): Promise<T | Error> {
  try {
    return await operation();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function gift(recipient: string, signer: Uint8Array, last: number): NostrEvent {
  return finalizeEvent({
    kind: 1059,
    created_at: now - 1,
    tags: [["p", recipient], ["expiration", String(now + 300)]],
    content: `opaque-wrapper-${last}`
  }, signer);
}

async function roundTrip(topology: Topology, down: string[] = []) {
  const makerKey = key(1);
  const takerKey = key(2);
  const maker = getPublicKey(makerKey);
  const taker = getPublicKey(takerKey);
  const makerRelay = "wss://maker.example";
  const takerRelay = "wss://taker.example";
  const sharedRelay = "wss://shared.example";
  const makerInbox = topology === "shared" ? [sharedRelay] : [makerRelay];
  const takerInbox = topology === "shared" ? [sharedRelay] : [takerRelay];
  const port = new RelayTopologyPort(new Map([
    [makerRelay, 40], [takerRelay, 40], [sharedRelay, 40]
  ]));
  down.forEach((relay) => port.down.add(relay));
  const takerToMaker = await attempt(() =>
    publishGiftWrap(gift(maker, takerKey, 3), makerInbox, takerKey, port, now));
  const makerReceived = await attempt(() =>
    queryGiftWraps(maker, makerInbox, makerKey, port, now - 10, now));
  const makerToTaker = await attempt(() =>
    publishGiftWrap(gift(taker, makerKey, 4), takerInbox, makerKey, port, now));
  const takerReceived = await attempt(() =>
    queryGiftWraps(taker, takerInbox, takerKey, port, now - 10, now));

  return { port, makerInbox, takerInbox, takerToMaker, makerToTaker, makerReceived, takerReceived };
}

describe("same-relay NIP-17 routing experiment", () => {
  it("has no latency win in the current per-operation transport", async () => {
    const split = await roundTrip("split");
    const shared = await roundTrip("shared");

    expect(split.makerReceived).toEqual([expect.any(Object)]);
    expect(split.takerReceived).toEqual([expect.any(Object)]);
    expect(shared.makerReceived).toEqual([expect.any(Object)]);
    expect(shared.takerReceived).toEqual([expect.any(Object)]);
    expect(split.port.elapsed).toBe(320);
    expect(shared.port.elapsed).toBe(split.port.elapsed);
    expect(shared.port.calls).toHaveLength(split.port.calls.length);
    expect(shared.port.calls.filter(({ operation }) => operation === "info")).toHaveLength(4);
    expect(shared.port.calls.filter(({ operation }) => operation === "publish")).toHaveLength(2);
    expect(shared.port.calls.filter(({ operation }) => operation === "query")).toHaveLength(2);
  });

  it("keeps split inboxes independently available when one relay fails", async () => {
    const result = await roundTrip("split", ["wss://maker.example"]);

    expect(result.takerToMaker).toMatchObject([{ ok: false, relay: "wss://maker.example" }]);
    expect(result.makerToTaker).toMatchObject([{ ok: true, relay: "wss://taker.example" }]);
    expect(result.takerReceived).toEqual([expect.any(Object)]);
  });

  it("makes a shared relay outage a two-way delivery failure", async () => {
    const result = await roundTrip("shared", ["wss://shared.example"]);

    expect(result.takerToMaker).toMatchObject([{ ok: false, relay: "wss://shared.example" }]);
    expect(result.makerReceived).toEqual(expect.any(Error));
    expect(result.makerToTaker).toMatchObject([{ ok: false, relay: "wss://shared.example" }]);
  });
});
