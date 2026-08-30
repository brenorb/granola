import { Relay, type EventTemplate } from "nostr-tools";

import type { NostrEvent } from "../order/events.js";
import type {
  AuthHandler,
  InboxRelayCapabilities,
  InboxRelayPort
} from "./inbox.js";

export interface InboxRelayConnection {
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

interface PooledConnection {
  key: string;
  connection: InboxRelayConnection;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

interface OpenedConnection {
  connection: InboxRelayConnection;
  release(): void;
  invalidate(): void;
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
  private readonly pooled = new Map<string, PooledConnection>();
  private readonly opening = new Map<string, Promise<PooledConnection>>();
  private closed = false;

  constructor(
    private readonly connect: InboxRelayFactory = defaultFactory,
    private readonly fetchInfo: InboxInfoFetcher = (input, init) =>
      globalThis.fetch(input, init),
    private readonly queryTimeoutMs = 8_000,
    private readonly idleTimeoutMs = 30_000
  ) {
    if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1) {
      throw new Error("Inbox relay query timeout is invalid");
    }
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1) {
      throw new Error("Inbox relay idle timeout is invalid");
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

  private async connectAndAuthenticate(relay: string, auth: AuthHandler): Promise<InboxRelayConnection> {
    const connection = await this.connect(relay);
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
      if ((await this.info(relay)).authRequired) {
        try {
          await connection.auth(signer);
        } catch {
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
      throw error;
    }
  }

  private async open(relay: string, auth: AuthHandler): Promise<OpenedConnection> {
    if (this.closed) throw new Error("Inbox relay port is closed");
    const identity = auth.identity;
    if (!identity) {
      const connection = await this.connectAndAuthenticate(relay, auth);
      let released = false;
      let invalidated = false;
      return {
        connection,
        release: () => {
          if (released) return;
          released = true;
          if (!invalidated) connection.close();
        },
        invalidate: () => {
          if (released || invalidated) return;
          invalidated = true;
          connection.close();
        }
      };
    }
    const key = `${relay}\u0000${identity}`;
    let entry = this.pooled.get(key);
    if (!entry) {
      let opening = this.opening.get(key);
      if (!opening) {
        opening = this.connectAndAuthenticate(relay, auth).then((connection) => {
          if (this.closed) {
            connection.close();
            throw new Error("Inbox relay port is closed");
          }
          const created = { key, connection, refs: 0, idleTimer: undefined };
          this.pooled.set(key, created);
          return created;
        });
        this.opening.set(key, opening);
        void opening.then(
          () => { if (this.opening.get(key) === opening) this.opening.delete(key); },
          () => { if (this.opening.get(key) === opening) this.opening.delete(key); }
        );
      }
      entry = await opening;
    }
    if (this.pooled.get(key) !== entry || this.closed) {
      entry.connection.close();
      throw new Error("Inbox relay port is closed");
    }
    entry.refs += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    let released = false;
    return {
      connection: entry.connection,
      release: () => {
        if (released) return;
        released = true;
        this.release(entry!);
      },
      invalidate: () => this.invalidate(entry!)
    };
  }

  private release(entry: PooledConnection): void {
    if (entry.refs === 0) return;
    entry.refs -= 1;
    if (entry.refs !== 0) return;
    entry.idleTimer = setTimeout(() => {
      if (entry.refs === 0 && this.pooled.get(entry.key) === entry) {
        this.pooled.delete(entry.key);
        entry.connection.close();
      }
    }, this.idleTimeoutMs);
    const timer = entry.idleTimer as ReturnType<typeof setTimeout> & { unref?: () => void };
    timer.unref?.();
  }

  private invalidate(entry: PooledConnection): void {
    if (this.pooled.get(entry.key) !== entry) return;
    this.pooled.delete(entry.key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.connection.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pooled.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.connection.close();
    }
    this.pooled.clear();
  }

  async publish(relay: string, event: NostrEvent, auth: AuthHandler): Promise<string> {
    const opened = await this.open(relay, auth);
    try {
      return await opened.connection.publish(event);
    } catch (error) {
      opened.invalidate();
      throw error;
    } finally {
      opened.release();
    }
  }

  async query(
    relay: string,
    filter: Record<string, unknown>,
    auth: AuthHandler
  ): Promise<NostrEvent[]> {
    const opened = await this.open(relay, auth);
    return await new Promise<NostrEvent[]>((resolve, reject) => {
      const events: NostrEvent[] = [];
      let settled = false;
      let subscription: { close(reason?: string): void } | undefined;
      const finish = (result: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        subscription?.close("granola query complete");
        opened.release();
        result();
      };
      const timeout = setTimeout(() => {
        opened.invalidate();
        finish(() => reject(new Error("Inbox relay query timed out")));
      }, this.queryTimeoutMs);
      try {
        subscription = opened.connection.subscribe([filter], {
        onevent: (event) => events.push(event),
        oneose: () => finish(() => resolve(events)),
        onclose: (reason) => {
          if (!settled) opened.invalidate();
          finish(() => reject(new Error(`Inbox relay closed query: ${reason}`)));
        }
        });
      } catch (error) {
        opened.invalidate();
        opened.release();
        reject(error);
      }
    });
  }

  async subscribe(
    relay: string,
    filter: Record<string, unknown>,
    auth: AuthHandler,
    callbacks: PersistentInboxCallbacks
  ): Promise<PersistentInboxSubscription> {
    const opened = await this.open(relay, auth);
    let closed = false;
    let subscription: { close(reason?: string): void } | undefined;
    const closeConnection = (reason: string, report: boolean): void => {
      if (closed) return;
      closed = true;
      subscription?.close(reason);
      opened.release();
      if (report) callbacks.onclose(reason);
    };
    try {
      subscription = opened.connection.subscribe([structuredClone(filter)], {
        onevent: (event) => {
          if (!closed) callbacks.onevent(structuredClone(event));
        },
        // EOSE ends the stored backlog, not the live subscription.
        oneose: () => undefined,
        onclose: (reason) => {
          if (!closed) opened.invalidate();
          closeConnection(reason, true);
        }
      });
    } catch (error) {
      opened.invalidate();
      opened.release();
      throw error;
    }
    return {
      close: (reason = "granola subscription closed") =>
        closeConnection(reason, false)
    };
  }
}
