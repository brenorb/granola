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

  constructor(
    private readonly connect: InboxRelayFactory = defaultFactory,
    private readonly fetchInfo: InboxInfoFetcher = fetch,
    private readonly queryTimeoutMs = 8_000
  ) {
    if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1) {
      throw new Error("Inbox relay query timeout is invalid");
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

  private async open(relay: string, auth: AuthHandler): Promise<InboxRelayConnection> {
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

  async publish(relay: string, event: NostrEvent, auth: AuthHandler): Promise<string> {
    const connection = await this.open(relay, auth);
    try {
      return await connection.publish(event);
    } finally {
      connection.close();
    }
  }

  async query(
    relay: string,
    filter: Record<string, unknown>,
    auth: AuthHandler
  ): Promise<NostrEvent[]> {
    const connection = await this.open(relay, auth);
    return await new Promise<NostrEvent[]>((resolve, reject) => {
      const events: NostrEvent[] = [];
      let settled = false;
      let subscription: { close(reason?: string): void } | undefined;
      const finish = (result: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        subscription?.close("granola query complete");
        connection.close();
        result();
      };
      const timeout = setTimeout(() => finish(() => reject(new Error("Inbox relay query timed out"))), this.queryTimeoutMs);
      subscription = connection.subscribe([filter], {
        onevent: (event) => events.push(event),
        oneose: () => finish(() => resolve(events)),
        onclose: (reason) => finish(() => reject(new Error(`Inbox relay closed query: ${reason}`)))
      });
    });
  }
}
