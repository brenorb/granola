import { describe, expect, it } from "vitest";

import type { NostrEvent } from "../order/events.js";
import { LOCAL_MESH_RELAY, PUBLIC_RELAYS, RelayClient, type RelayPoolPort } from "./relay.js";

const EVENT: NostrEvent = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  sig: "c".repeat(128),
  kind: 30078,
  created_at: 1_700_000_000,
  tags: [["m", "d".repeat(64)]],
  content: "{}"
};
const ADDRESS = `30078:${"b".repeat(64)}:granola:order:v1:11111111-1111-4111-8111-111111111111`;

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
    return [EVENT, EVENT];
  }

  destroy(): void {
    this.destroyed = true;
  }
}

describe("relay client", () => {
  it("includes and accepts the local mesh relay", () => {
    expect(PUBLIC_RELAYS).toContain(LOCAL_MESH_RELAY);

    const client = new RelayClient({
      relays: [`${LOCAL_MESH_RELAY}/`],
      pool: new FakePool()
    });

    expect(client.relays).toEqual([LOCAL_MESH_RELAY]);
  });

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
    expect(pool.queries[0]).toEqual({
      relays: ["wss://one.example"],
      filter: {
        kinds: [30078],
        "#t": ["granola-order"],
        "#m": ["d".repeat(64)],
        since: 1_699_000_000,
        limit: 500
      },
      maxWait: 3210
    });
  });

  it("pages each relay past its per-request cap so old best orders are not dropped", async () => {
    // 1,250 projections, newest first, and a relay that returns at most 500.
    const all = Array.from({ length: 1_250 }, (_, index) => ({
      ...EVENT,
      id: index.toString(16).padStart(64, "0"),
      created_at: 1_700_000_000 - index
    }));
    const queries: Array<Record<string, unknown>> = [];
    const pool: RelayPoolPort = {
      ensureRelay: async () => ({ publish: async () => "stored" }),
      querySync: async (_relays, filter) => {
        queries.push(filter);
        const until = typeof filter.until === "number" ? filter.until : Number.POSITIVE_INFINITY;
        return all.filter((event) => event.created_at <= until).slice(0, 500);
      },
      destroy: () => undefined
    };
    const client = new RelayClient({ relays: ["wss://one.example"], pool });

    const events = await client.queryProjections("d".repeat(64), 0);

    expect(events).toHaveLength(1_250);
    expect(new Set(events.map((event) => event.id)).size).toBe(1_250);
    expect(queries.length).toBeLessThanOrEqual(5);
  });

  it("does not loop forever on a relay that ignores until", async () => {
    let calls = 0;
    const pool: RelayPoolPort = {
      ensureRelay: async () => ({ publish: async () => "stored" }),
      querySync: async () => {
        calls += 1;
        return [EVENT, { ...EVENT, id: "e".repeat(64), created_at: 1_600_000_000 }];
      },
      destroy: () => undefined
    };
    const client = new RelayClient({ relays: ["wss://one.example"], pool });

    await expect(client.queryProjections("d".repeat(64), 0)).resolves.toHaveLength(2);
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("reports an outage instead of an empty book when no relay answers", async () => {
    const pool: RelayPoolPort = {
      ensureRelay: async () => { throw new Error("connection refused"); },
      querySync: async () => [],
      destroy: () => undefined
    };
    const client = new RelayClient({ relays: ["wss://one.example", "wss://two.example"], pool });

    await expect(client.queryProjections("d".repeat(64), 0)).rejects.toThrow("No order relay answered");
  });

  it("uses the relays that answered when only some are down", async () => {
    const pool: RelayPoolPort = {
      ensureRelay: async (url) => {
        if (url.includes("two")) throw new Error("connection refused");
        return { publish: async () => "stored" };
      },
      querySync: async () => [EVENT],
      destroy: () => undefined
    };
    const client = new RelayClient({ relays: ["wss://one.example", "wss://two.example"], pool });

    await expect(client.queryProjections("d".repeat(64), 0)).resolves.toEqual([EVENT]);
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

  it("queries the replaceable projection by exact order address", async () => {
    const pool = new FakePool();
    const client = new RelayClient({ relays: ["wss://one.example"], pool, maxWait: 3210 });

    await expect(client.queryOrder(ADDRESS)).resolves.toEqual([EVENT]);
    expect(pool.queries).toEqual([{
      relays: ["wss://one.example"],
      filter: {
        kinds: [30078],
        authors: ["b".repeat(64)],
        "#d": ["granola:order:v1:11111111-1111-4111-8111-111111111111"],
        limit: 10
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
