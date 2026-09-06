import { Relay, type EventTemplate } from "nostr-tools";

import { normalizePublicRelay } from "./relay.js";
import type { NostrEvent } from "../order/events.js";
import type {
  AuthHandler,
  InboxRelayCapabilities,
  InboxRelayPort,
  InboxRelaySession
} from "./inbox.js";

export interface InboxRelayConnection {
  readonly connected?: boolean;
  onauth: ((template: EventTemplate) => Promise<NostrEvent>) | undefined;
  auth(signer: (template: EventTemplate) => Promise<NostrEvent>): Promise<string>;
  publish(event: NostrEvent): Promise<string>;
  subscribe(
    filters: Record<string, unknown>[],
    callbacks: {
      onevent: (event: NostrEvent) => void;
      oneose: () => void;
      onclose: (reason: string) => void;
    }
  ): { close(reason?: string): void };
  close(): void;
}

export type InboxRelayFactory = (relay: string) => Promise<InboxRelayConnection>;
export type InboxInfoFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface PersistentInboxSubscription {
  close(reason?: string): void;
}

export interface PersistentInboxCallbacks {
  onevent(event: NostrEvent): void;
  onclose(reason: string): void;
}

function nip11Url(relay: string): string {
  const url = new URL(relay);
  if (url.protocol !== "wss:") throw new Error("Inbox relay must use wss://");
  url.protocol = "https:";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function challengeFrom(template: EventTemplate): string {
  const values = template.tags
    .filter((tag) => tag[0] === "challenge" && typeof tag[1] === "string")
    .map((tag) => tag[1] as string);
  if (template.kind !== 22242 || values.length !== 1 || !values[0]) {
    throw new Error("Relay AUTH template requires one exact challenge");
  }
  return values[0];
}

const defaultFactory: InboxRelayFactory = async (relay) =>
  await Relay.connect(relay, { enableReconnect: false }) as InboxRelayConnection;

export class NostrToolsInboxRelayPort implements InboxRelayPort {
  private readonly infoCache = new Map<string, InboxRelayCapabilities>();
  private readonly warmConnectionsByRelay = new Map<string, Array<{
    result: Promise<InboxRelayConnection | null>;
    connection?: InboxRelayConnection | null;
  }>>();
  private warmTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(
    private readonly connect: InboxRelayFactory = defaultFactory,
    private readonly fetchInfo: InboxInfoFetcher = (input, init) =>
      globalThis.fetch(input, init),
    private readonly queryTimeoutMs = 8_000
  ) {
    if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1) {
      throw new Error("Inbox relay query timeout is invalid");
    }
  }

  warmConnections(relays: readonly string[]): void {
    if (this.disposed) return;
    const urls = [...new Set(relays.map(normalizePublicRelay))].filter(url => url.startsWith("wss://"));
    if (new Set([...this.warmConnectionsByRelay.keys(), ...urls]).size > 5) {
      throw new Error("Relay warmup supports at most five configured relays");
    }
    for (const relay of urls) {
      if (!this.warmConnectionsByRelay.has(relay)) this.warmConnectionsByRelay.set(relay, []);
      this.replenish(relay);
      void this.info(relay).catch(() => undefined);
    }
    this.warmTimer ??= setInterval(() => {
      for (const relay of this.warmConnectionsByRelay.keys()) this.replenish(relay);
    }, 30_000);
  }

  private replenish(relay: string): void {
    const slots = this.warmConnectionsByRelay.get(relay);
    if (!slots || this.disposed) return;
    for (let i = slots.length - 1; i >= 0; i--) {
      if (slots[i]!.connection === null || slots[i]!.connection?.connected === false) slots.splice(i, 1);
    }
    // ponytail: two unauthenticated spares per configured relay; never return an authenticated socket.
    while (slots.length < 2) {
      const slot: (typeof slots)[number] = { result: Promise.resolve(null) };
      slot.result = Promise.resolve().then(() => this.connect(relay)).then(connection => {
        if (this.disposed) { connection.close(); return null; }
        slot.connection = connection;
        return connection;
      }, () => { slot.connection = null; return null; });
      slots.push(slot);
    }
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.warmTimer);
    for (const slots of this.warmConnectionsByRelay.values()) {
      for (const slot of slots) slot.connection?.close();
    }
    this.warmConnectionsByRelay.clear();
  }

  private async takeConnection(relay: string, fresh = false): Promise<{
    connection: InboxRelayConnection;
    warmed: boolean;
  }> {
    const start = performance.now();
    let outcome = "cold";
    try {
      if (this.disposed) throw new Error("Inbox relay port is disposed");
      const slot = fresh ? undefined : this.warmConnectionsByRelay.get(relay)?.shift();
      if (slot) outcome = slot.connection && slot.connection.connected !== false ? "warm" : "warming";
      this.replenish(relay);
      let connection = slot ? await slot.result : null;
      if (this.disposed) { connection?.close(); throw new Error("Inbox relay port is disposed"); }
      if (connection?.connected === false) { connection.close(); connection = null; }
      if (!connection) { outcome = "cold"; connection = await this.connect(relay); }
      if (this.disposed) { connection.close(); throw new Error("Inbox relay port is disposed"); }
      return { connection, warmed: outcome !== "cold" };
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      try {
        performance.measure("granola:relay-connect", { start, end: performance.now(), detail: { outcome } });
      } catch { /* Diagnostics must never change settlement. */ }
    }
  }

  async info(relay: string): Promise<InboxRelayCapabilities> {
    const cached = this.infoCache.get(relay);
    if (cached) return structuredClone(cached);
    const response = await this.fetchInfo(nip11Url(relay), {
      headers: { Accept: "application/nostr+json" }
    });
    if (!response.ok) throw new Error(`Inbox relay NIP-11 request failed with ${response.status}`);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object") throw new Error("Inbox relay NIP-11 document is invalid");
    const document = value as {
      supported_nips?: unknown;
      limitation?: { auth_required?: unknown };
    };
    if (
      !Array.isArray(document.supported_nips) ||
      document.supported_nips.some((nip) => !Number.isSafeInteger(nip))
    ) {
      throw new Error("Inbox relay NIP-11 supported_nips is invalid");
    }
    const capabilities = {
      supportedNips: document.supported_nips as number[],
      authRequired: document.limitation?.auth_required === true
    };
    this.infoCache.set(relay, capabilities);
    return structuredClone(capabilities);
  }

  private async open(relay: string, auth: AuthHandler, fresh = false): Promise<InboxRelayConnection> {
    const { connection, warmed } = await this.takeConnection(relay, fresh);
    let challengeSeen: (() => void) | undefined;
    const challengeReady = new Promise<void>((resolve) => {
      challengeSeen = resolve;
    });
    const signer = async (template: EventTemplate): Promise<NostrEvent> => {
      const challenge = challengeFrom(template);
      challengeSeen?.();
      return await auth(challenge);
    };
    connection.onauth = signer;
    try {
      const authRequired = (await this.info(relay)).authRequired;
      if (authRequired || warmed) {
        try {
          await connection.auth(signer);
        } catch (error) {
          if (!authRequired) {
            // nostr-tools retains challenges received before the AUTH handler is installed.
            if (error instanceof Error && error.message === "can't perform auth, no challenge was received") return connection;
            throw error;
          }
          await Promise.race([
            challengeReady,
            new Promise<never>((_resolve, reject) => setTimeout(
              () => reject(new Error("Relay AUTH challenge was not received")),
              this.queryTimeoutMs
            ))
          ]);
          await connection.auth(signer);
        }
      }
      return connection;
    } catch (error) {
      connection.close();
      // A warm socket may carry an expired AUTH challenge. Retry once before any publication.
      if (warmed && !fresh) return this.open(relay, auth, true);
      throw error;
    }
  }

  async withConnection<T>(
    relay: string,
    auth: AuthHandler,
    action: (session: InboxRelaySession) => Promise<T>
  ): Promise<T> {
    const connection = await this.open(relay, auth);
    try {
      return await action({
        publish: event => connection.publish(event),
        query: (filter, completeOn) => this.queryConnection(connection, filter, completeOn)
      });
    } finally {
      connection.close();
    }
  }

  async publish(relay: string, event: NostrEvent, auth: AuthHandler): Promise<string> {
    return this.withConnection(relay, auth, connection => connection.publish(event));
  }

  async query(
    relay: string,
    filter: Record<string, unknown>,
    auth: AuthHandler,
    completeOn?: (event: NostrEvent) => boolean
  ): Promise<NostrEvent[]> {
    return this.withConnection(relay, auth, connection => connection.query(filter, completeOn));
  }

  private async queryConnection(
    connection: InboxRelayConnection,
    filter: Record<string, unknown>,
    completeOn?: (event: NostrEvent) => boolean
  ): Promise<NostrEvent[]> {
    return await new Promise<NostrEvent[]>((resolve, reject) => {
      const events: NostrEvent[] = [];
      let settled = false;
      let subscription: { close(reason?: string): void } | undefined;
      const finish = (result: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        subscription?.close("granola query complete");
        result();
      };
      const timeout = setTimeout(() => finish(() => reject(new Error("Inbox relay query timed out"))), this.queryTimeoutMs);
      try {
        subscription = connection.subscribe([filter], {
          onevent: (event) => {
            if (settled) return;
            const candidate = structuredClone(event);
            events.push(candidate);
            try {
              if (completeOn?.(candidate)) finish(() => resolve([candidate]));
            } catch {
              // Invalid candidates cannot end the query ahead of valid readback.
            }
          },
          oneose: () => finish(() => resolve(events)),
          onclose: (reason) => finish(() => reject(new Error(`Inbox relay closed query: ${reason}`)))
        });
        if (settled) subscription.close("granola query complete");
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  async subscribe(
    relay: string,
    filter: Record<string, unknown>,
    auth: AuthHandler,
    callbacks: PersistentInboxCallbacks
  ): Promise<PersistentInboxSubscription> {
    const connection = await this.open(relay, auth);
    let closed = false;
    let subscription: { close(reason?: string): void } | undefined;
    const closeConnection = (reason: string, report: boolean): void => {
      if (closed) return;
      closed = true;
      subscription?.close(reason);
      connection.close();
      if (report) callbacks.onclose(reason);
    };
    try {
      subscription = connection.subscribe([structuredClone(filter)], {
        onevent: (event) => {
          if (!closed) callbacks.onevent(structuredClone(event));
        },
        // EOSE ends the stored backlog, not the live subscription.
        oneose: () => undefined,
        onclose: (reason) => closeConnection(reason, true)
      });
    } catch (error) {
      connection.close();
      throw error;
    }
    return {
      close: (reason = "granola subscription closed") =>
        closeConnection(reason, false)
    };
  }
}
