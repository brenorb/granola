import { describe, expect, it } from "vitest";

import type { NostrEvent } from "../order/events.js";
import { RelayClient, type RelayPoolPort } from "./relay.js";

const EVENT: NostrEvent = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  sig: "c".repeat(128),
  kind: 30078,
  created_at: 1_700_000_000,
  tags: [["m", "d".repeat(64)]],
  content: "{}"
};
const TRANSITION: NostrEvent = { ...EVENT, id: "e".repeat(64), kind: 78 };
const ADDRESS = `30078:${"b".repeat(64)}:granola:order:v2:11111111-1111-4111-8111-111111111111`;

class FakePool implements RelayPoolPort {
  destroyed = false;
  readonly queries: Array<{ relays: string[]; filter: Record<string, unknown>; maxWait: number }> = [];

  async ensureRelay(url: string): Promise<{ publish(event: NostrEvent): Promise<string> }> {
    return {
      publish: async () => {
        if (url.includes("two")) throw new Error("blocked");
        return "stored";
      }
    };
  }

  async querySync(
    relays: string[],
    filter: Record<string, unknown>,
    options: { maxWait: number }
  ): Promise<NostrEvent[]> {
    this.queries.push({ relays, filter, maxWait: options.maxWait });
    if (relays[0]?.includes("two")) return [];
    if (Array.isArray(filter.kinds) && filter.kinds.includes(78)) return [TRANSITION, TRANSITION];
    return [EVENT, EVENT];
  }

  destroy(): void {
    this.destroyed = true;
  }
}

describe("relay client", () => {
  it("records an unambiguous receipt for every allowlisted relay", async () => {
    const pool = new FakePool();
    const client = new RelayClient({
      relays: ["wss://one.example", "wss://two.example", "wss://three.example"],
      pool
    });

    await expect(client.publish(EVENT)).resolves.toEqual([
      { relay: "wss://one.example", ok: true, message: "stored" },
      { relay: "wss://two.example", ok: false, message: "blocked" },
      { relay: "wss://three.example", ok: true, message: "stored" }
    ]);
  });

  it("queries only current projections in the exact issuer-specific market", async () => {
    const pool = new FakePool();
    const client = new RelayClient({ relays: ["wss://one.example"], pool, maxWait: 3210 });

    const events = await client.queryProjections("d".repeat(64), 1_699_000_000);

    expect(events).toEqual([EVENT]);
    expect(pool.queries).toEqual([{
      relays: ["wss://one.example"],
      filter: {
        kinds: [30078],
        "#t": ["granola-order"],
        "#m": ["d".repeat(64)],
        since: 1_699_000_000,
        limit: 500
      },
      maxWait: 3210
    }]);
  });

  it("verifies publication readback independently on each relay", async () => {
    const pool = new FakePool();
    const client = new RelayClient({
      relays: ["wss://one.example", "wss://two.example", "wss://three.example"],
      pool
    });

    await expect(client.readback(EVENT)).resolves.toEqual([
      { relay: "wss://one.example", found: true },
      { relay: "wss://two.example", found: false },
      { relay: "wss://three.example", found: true }
    ]);
  });

  it("queries authoritative transitions by exact order address", async () => {
    const pool = new FakePool();
    const client = new RelayClient({ relays: ["wss://one.example"], pool, maxWait: 3210 });

    await expect(client.queryTransitions([ADDRESS])).resolves.toEqual([TRANSITION]);
    expect(pool.queries).toEqual([{
      relays: ["wss://one.example"],
      filter: {
        kinds: [78],
        "#t": ["granola-order-transition"],
        "#a": [ADDRESS],
        limit: 500
      },
      maxWait: 3210
    }]);
  });

  it("destroys pooled sockets when disposed", () => {
    const pool = new FakePool();
    const client = new RelayClient({ relays: ["wss://one.example"], pool });

    client.dispose();

    expect(pool.destroyed).toBe(true);
  });
});
