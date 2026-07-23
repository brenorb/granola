import type { Filter } from "nostr-tools/filter";
import { SimplePool } from "nostr-tools/pool";

import type { NostrEvent } from "../order/events.js";

export const PUBLIC_RELAYS = [
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://offchain.pub"
] as const;

export interface RelayReceipt {
  relay: string;
  ok: boolean;
  message: string;
}

export interface RelayReadback {
  relay: string;
  found: boolean;
}

export interface RelayPoolPort {
  ensureRelay(
    url: string,
    options?: { connectionTimeout?: number }
  ): Promise<{ publish(event: NostrEvent): Promise<string> }>;
  querySync(
    relays: string[],
    filter: Record<string, unknown>,
    options: { maxWait: number }
  ): Promise<NostrEvent[]>;
  destroy(): void;
}

interface RelayClientOptions {
  relays?: readonly string[];
  pool?: RelayPoolPort;
  maxWait?: number;
}

function relayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueEvents(events: NostrEvent[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const event of events) byId.set(event.id, event);
  return [...byId.values()];
}

function validateRelays(relays: readonly string[]): string[] {
  if (relays.length === 0) throw new Error("At least one Nostr relay is required");
  const normalized = relays.map((relay) => {
    const url = new URL(relay);
    if (url.protocol !== "wss:") throw new Error("Nostr relays must use wss://");
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString().replace(/\/$/, "");
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Nostr relay URLs must be unique");
  }
  return normalized;
}

export class RelayClient {
  readonly relays: string[];
  private readonly pool: RelayPoolPort;
  private readonly maxWait: number;

  constructor(options: RelayClientOptions = {}) {
    this.relays = validateRelays(options.relays ?? PUBLIC_RELAYS);
    this.pool = options.pool ?? new SimplePool({ enableReconnect: false });
    this.maxWait = options.maxWait ?? 5_000;
  }

  async publish(event: NostrEvent): Promise<RelayReceipt[]> {
    return Promise.all(this.relays.map(async (relay): Promise<RelayReceipt> => {
      try {
        const connection = await this.pool.ensureRelay(relay, {
          connectionTimeout: this.maxWait
        });
        const message = await connection.publish(event);
        return { relay, ok: true, message };
      } catch (error) {
        return { relay, ok: false, message: relayError(error) };
      }
    }));
  }

  async queryProjections(market: string, since: number): Promise<NostrEvent[]> {
    if (!/^[0-9a-f]{64}$/.test(market)) throw new Error("Market ID must be lowercase hex");
    if (!Number.isSafeInteger(since) || since < 0) throw new Error("Query start must be a Unix timestamp");
    const filter: Filter = {
      kinds: [30078],
      "#t": ["granola-order"],
      "#m": [market],
      since,
      limit: 500
    };
    const events = await this.pool.querySync(
      this.relays,
      filter as Record<string, unknown>,
      { maxWait: this.maxWait }
    );
    return uniqueEvents(events);
  }

  async readback(event: Pick<NostrEvent, "id" | "pubkey" | "kind">): Promise<RelayReadback[]> {
    const filter: Filter = {
      ids: [event.id],
      authors: [event.pubkey],
      kinds: [event.kind],
      limit: 1
    };
    return Promise.all(this.relays.map(async (relay): Promise<RelayReadback> => {
      try {
        const events = await this.pool.querySync(
          [relay],
          filter as Record<string, unknown>,
          { maxWait: this.maxWait }
        );
        return { relay, found: events.some((candidate) => candidate.id === event.id) };
      } catch {
        return { relay, found: false };
      }
    }));
  }

  dispose(): void {
    this.pool.destroy();
  }
}
