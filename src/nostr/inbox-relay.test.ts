import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent, type EventTemplate } from "nostr-tools";

import type { NostrEvent } from "../order/events.js";
import { createInboxList, createNip42AuthEvent, publishInboxList } from "./inbox.js";
import { NostrToolsInboxRelayPort, type InboxRelayConnection } from "./inbox-relay.js";

const key = (last: number): Uint8Array => {
  const bytes = new Uint8Array(32);
  bytes[31] = last;
  return bytes;
};

const protocolKey = key(1);
const protocolPubkey = getPublicKey(protocolKey);
const now = 1_800_000_000;
const relayUrl = "wss://auth.example/path";

function event(): NostrEvent {
  return finalizeEvent({ kind: 1059, created_at: now, tags: [["p", protocolPubkey]], content: "ciphertext" }, key(2));
}

class FakeConnection implements InboxRelayConnection {
  connected = true;
  onauth: ((template: EventTemplate) => Promise<NostrEvent>) | undefined;
  published: NostrEvent[] = [];
  authPubkeys: string[] = [];

  async auth(signer: (template: EventTemplate) => Promise<NostrEvent>): Promise<string> {
    const auth = await signer({
      kind: 22242,
      created_at: now,
      tags: [["relay", relayUrl], ["challenge", "relay-challenge"]],
      content: ""
    });
    this.authPubkeys.push(auth.pubkey);
    return "authenticated";
  }

  async publish(value: NostrEvent): Promise<string> {
    this.published.push(value);
    return "stored";
  }

  subscribe(
    _filters: Record<string, unknown>[],
    callbacks: { onevent: (value: NostrEvent) => void; oneose: () => void; onclose: (reason: string) => void }
  ): { close(reason?: string): void } {
    queueMicrotask(() => {
      callbacks.onevent(event());
      callbacks.oneose();
    });
    return { close: vi.fn() };
  }

  close(): void {}
}

describe("nostr-tools inbox relay port", () => {
  it.each([false, true])("handles a cached optional AUTH challenge (present=%s) without waiting for a new challenge", async present => {
    const connections: FakeConnection[] = [];
    const port = new NostrToolsInboxRelayPort(async () => {
      const connection = new FakeConnection();
      if (!present) connection.auth = async () => { throw new Error("can't perform auth, no challenge was received"); };
      connections.push(connection);
      return connection;
    }, async () => new Response(JSON.stringify({ supported_nips: [42], limitation: {} })));
    try {
      port.warmConnections([relayUrl]);
      await vi.waitFor(() => expect(connections).toHaveLength(2));
      await expect(port.publish(relayUrl, event(), async challenge =>
        createNip42AuthEvent(relayUrl, challenge, protocolKey, now))).resolves.toBe("stored");
      expect(connections[0]!.authPubkeys).toEqual(present ? [protocolPubkey] : []);
      expect(connections[0]!.published).toHaveLength(1);
    } finally { port.dispose(); }
  });

  it("authenticates a challenge received during warmup and retries an expired challenge before publishing", async () => {
    const stale = Object.assign(new FakeConnection(), { challenge: "old-challenge" });
    stale.auth = async signer => {
      await signer({ kind: 22242, created_at: now, tags: [["challenge", "old-challenge"]], content: "" });
      throw new Error("expired challenge");
    };
    vi.spyOn(stale, "close");
    const connections: FakeConnection[] = [];
    const connect = vi.fn().mockResolvedValueOnce(stale).mockImplementation(async () => {
      const connection = Object.assign(new FakeConnection(), { challenge: "current-challenge" });
      connections.push(connection);
      return connection;
    });
    const port = new NostrToolsInboxRelayPort(connect,
      async () => new Response(JSON.stringify({ supported_nips: [42], limitation: { auth_required: true } })));
    try {
      port.warmConnections([relayUrl]);
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
      await expect(port.publish(relayUrl, event(), async challenge =>
        createNip42AuthEvent(relayUrl, challenge, protocolKey, now))).resolves.toBe("stored");
      expect(stale.close).toHaveBeenCalledTimes(1);
      expect(stale.published).toHaveLength(0);
      const published = connections.filter(c => c.published.length > 0);
      expect(published).toHaveLength(1);
      expect(published[0]!.authPubkeys).toEqual([protocolPubkey]);
    } finally { port.dispose(); }
  });

  it("warms without AUTH and leases each ready socket to only one identity without waiting for refill", async () => {
    const connections = [new FakeConnection(), new FakeConnection()];
    for (const connection of connections) vi.spyOn(connection, "close");
    const pending: Array<(connection: InboxRelayConnection) => void> = [];
    let next = 0;
    const connect = vi.fn(async () => connections[next++] ?? await new Promise<InboxRelayConnection>(resolve => pending.push(resolve)));
    const port = new NostrToolsInboxRelayPort(connect,
      async () => new Response(JSON.stringify({ supported_nips: [42], limitation: { auth_required: true } })));
    try {
      port.warmConnections([relayUrl, relayUrl]);
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
      expect(connections.every(c => c.authPubkeys.length === 0 && c.published.length === 0)).toBe(true);
      for (const signer of [protocolKey, key(3)]) {
        await expect(port.publish(relayUrl, event(), async challenge =>
          createNip42AuthEvent(relayUrl, challenge, signer, now))).resolves.toBe("stored");
      }
      expect(connections.map(c => c.authPubkeys)).toEqual([[protocolPubkey], [getPublicKey(key(3))]]);
      for (const connection of connections) expect(connection.close).toHaveBeenCalledTimes(1);
      expect(pending).toHaveLength(2);
    } finally { port.dispose(); }
    const late = pending.map(resolve => {
      const connection = new FakeConnection();
      vi.spyOn(connection, "close");
      resolve(connection);
      return connection;
    });
    await vi.waitFor(() => late.forEach(c => expect(c.close).toHaveBeenCalledTimes(1)));
  });

  it.each(["failed", "closed"])("falls back when the warm connection %s before use", async failure => {
    const stale = new FakeConnection();
    const fallback = new FakeConnection();
    const connect = vi.fn().mockImplementationOnce(async () => {
      if (failure === "failed") throw new Error("offline");
      return stale;
    }).mockImplementation(async () => fallback);
    const port = new NostrToolsInboxRelayPort(connect,
      async () => new Response(JSON.stringify({ supported_nips: [], limitation: {} })));
    try {
      port.warmConnections([relayUrl]);
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
      stale.connected = false;
      await expect(port.publish(relayUrl, event(), async challenge =>
        createNip42AuthEvent(relayUrl, challenge, protocolKey, now))).resolves.toBe("stored");
      expect(stale.published).toHaveLength(0);
      expect(fallback.published).toHaveLength(1);
    } finally { port.dispose(); }
  });

  it("retries idle warmup at a bounded interval and stops on disposal", async () => {
    vi.useFakeTimers();
    const connect = vi.fn(async (): Promise<InboxRelayConnection> => { throw new Error("offline"); });
    const port = new NostrToolsInboxRelayPort(connect,
      async () => new Response(JSON.stringify({ supported_nips: [], limitation: {} })));
    try {
      port.warmConnections([relayUrl]);
      await vi.advanceTimersByTimeAsync(0);
      expect(connect).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(connect).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(connect).toHaveBeenCalledTimes(4);
      port.dispose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(connect).toHaveBeenCalledTimes(4);
      await expect(port.publish(relayUrl, event(), vi.fn())).rejects.toThrow(/disposed/);
    } finally { port.dispose(); vi.useRealTimers(); }
  });

  it("publishes and validates exact readback on one authenticated connection, isolated per operation", async () => {
    const connections: FakeConnection[] = [];
    const connect = vi.fn(async () => {
      const connection = new FakeConnection();
      vi.spyOn(connection, "close");
      connection.subscribe = (_filters, callbacks) => {
        queueMicrotask(() => {
          const published = connection.published[0]!;
          callbacks.onevent({ ...published, content: "tampered" });
          callbacks.onevent(published);
        });
        return { close: vi.fn() };
      };
      connections.push(connection);
      return connection;
    });
    const port = new NostrToolsInboxRelayPort(connect,
      async () => new Response(JSON.stringify({ supported_nips: [17, 40, 42], limitation: { auth_required: true } })));
    for (const signer of [protocolKey, key(3)]) {
      const list = createInboxList([relayUrl], signer, now);
      const relays = ["wss://one.example", "wss://two.example", "wss://three.example"];
      const result = await publishInboxList(list, relays, signer, port, now, 3);
      expect(result.confirmed).toEqual(expect.arrayContaining(relays));
      expect(result.readback[0]?.event?.id).toBe(list.id);
    }
    expect(connect).toHaveBeenCalledTimes(6);
    expect(connections.map(c => c.authPubkeys)).toEqual([
      ...Array.from({ length: 3 }, () => [protocolPubkey]),
      ...Array.from({ length: 3 }, () => [getPublicKey(key(3))])
    ]);
    for (const connection of connections) expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "disconnect", "subscribe throws", "publish fails"])("closes scoped connections on %s", async failure => {
    const connection = new FakeConnection();
    const close = vi.spyOn(connection, "close");
    connection.subscribe = (_filters, callbacks) => {
      if (failure === "subscribe throws") throw new Error("subscribe failed");
      if (failure === "disconnect") queueMicrotask(() => callbacks.onclose("disconnected"));
      return { close: vi.fn() };
    };
    if (failure === "publish fails") connection.publish = async () => { throw new Error("publish failed"); };
    const port = new NostrToolsInboxRelayPort(async () => connection,
      async () => new Response(JSON.stringify({ supported_nips: [], limitation: {} })), 10);
    const list = createInboxList([relayUrl], protocolKey, now);
    await expect(port.withConnection(relayUrl,
      async challenge => createNip42AuthEvent(relayUrl, challenge, protocolKey, now),
      async session => {
        await session.publish(list);
        return session.query({ ids: [list.id] });
      })).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("finishes verified exact readback before EOSE and closes a synchronous subscription", async () => {
    const candidate = event();
    const subscriptionClose = vi.fn();
    const connection = new FakeConnection();
    const close = vi.spyOn(connection, "close");
    connection.subscribe = (_filters, callbacks) => {
      callbacks.onevent({ ...candidate, content: "tampered" });
      callbacks.onevent(candidate);
      return { close: subscriptionClose };
    };
    const port = new NostrToolsInboxRelayPort(async () => connection,
      async () => new Response(JSON.stringify({ supported_nips: [], limitation: {} })));
    const result = await port.query(relayUrl, { ids: [candidate.id] },
      async (challenge) => createNip42AuthEvent(relayUrl, challenge, protocolKey, now),
      (value) => verifyEvent(structuredClone(value)) && value.id === candidate.id);
    expect(result).toEqual([structuredClone(candidate)]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(subscriptionClose).toHaveBeenCalledTimes(1);
  });

  it("calls the browser fetch implementation with the Window receiver", async () => {
    const receiver = vi.fn();
    vi.stubGlobal("fetch", function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit
    ): Promise<Response> {
      receiver(this);
      return Promise.resolve(new Response(JSON.stringify({
        supported_nips: [17, 40, 42],
        limitation: { auth_required: true }
      }), { status: 200 }));
    });
    try {
      const port = new NostrToolsInboxRelayPort(
        async () => new FakeConnection()
      );
      await port.info(relayUrl);
      expect(receiver).toHaveBeenCalledWith(globalThis);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads NIP-11 capabilities and authenticates publish/query with the supplied key", async () => {
    const connection = new FakeConnection();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      supported_nips: [17, 40, 42],
      limitation: { auth_required: true }
    }), { status: 200 }));
    const port = new NostrToolsInboxRelayPort(
      async () => connection,
      fetcher,
      1_000
    );
    const auth = async (challenge: string) =>
      createNip42AuthEvent(relayUrl, challenge, protocolKey, now);

    await expect(port.info(relayUrl)).resolves.toEqual({
      supportedNips: [17, 40, 42],
      authRequired: true
    });
    await expect(port.publish(relayUrl, event(), auth)).resolves.toBe("stored");
    await expect(port.query(relayUrl, { kinds: [1059] }, auth)).resolves.toHaveLength(1);

    expect(fetcher).toHaveBeenCalledWith("https://auth.example/path", expect.objectContaining({
      headers: { Accept: "application/nostr+json" }
    }));
    expect(connection.authPubkeys).toEqual([protocolPubkey, protocolPubkey]);
  });

  it("rejects an AUTH template without an exact challenge", async () => {
    class MissingChallengeConnection extends FakeConnection {
      override async auth(signer: (template: EventTemplate) => Promise<NostrEvent>): Promise<string> {
        await signer({ kind: 22242, created_at: now, tags: [], content: "" });
        return "unreachable";
      }
    }
    const port = new NostrToolsInboxRelayPort(
      async () => new MissingChallengeConnection(),
      async () => new Response(JSON.stringify({
        supported_nips: [17, 40, 42],
        limitation: { auth_required: true }
      }), { status: 200 }),
      1_000
    );

    await expect(port.publish(relayUrl, event(), async (challenge) =>
      createNip42AuthEvent(relayUrl, challenge, protocolKey, now)))
      .rejects.toThrow(/challenge/i);
  });

  it("waits for a challenge that arrives just after connect before publishing", async () => {
    class DelayedChallengeConnection extends FakeConnection {
      challenged = false;

      override async auth(signer: (template: EventTemplate) => Promise<NostrEvent>): Promise<string> {
        const template: EventTemplate = {
          kind: 22242,
          created_at: now,
          tags: [["relay", relayUrl], ["challenge", "delayed-challenge"]],
          content: ""
        };
        if (!this.challenged) {
          queueMicrotask(() => {
            this.challenged = true;
            void this.onauth?.(template);
          });
          throw new Error("can't perform auth, no challenge was received");
        }
        return super.auth(signer);
      }
    }
    const connection = new DelayedChallengeConnection();
    const port = new NostrToolsInboxRelayPort(
      async () => connection,
      async () => new Response(JSON.stringify({
        supported_nips: [17, 40, 42],
        limitation: { auth_required: true }
      }), { status: 200 }),
      1_000
    );

    await expect(port.publish(relayUrl, event(), async (challenge) =>
      createNip42AuthEvent(relayUrl, challenge, protocolKey, now)))
      .resolves.toBe("stored");
    expect(connection.challenged).toBe(true);
  });

  it("keeps an authenticated inbox subscription open after EOSE until explicitly closed", async () => {
    class PersistentConnection extends FakeConnection {
      closed = false;
      subscriptionClosed = false;
      callbacks:
        | {
            onevent: (value: NostrEvent) => void;
            oneose: () => void;
            onclose: (reason: string) => void;
          }
        | undefined;

      override subscribe(
        _filters: Record<string, unknown>[],
        callbacks: {
          onevent: (value: NostrEvent) => void;
          oneose: () => void;
          onclose: (reason: string) => void;
        }
      ) {
        this.callbacks = callbacks;
        return {
          close: () => {
            this.subscriptionClosed = true;
          }
        };
      }

      override close(): void {
        this.closed = true;
      }
    }

    const connection = new PersistentConnection();
    const port = new NostrToolsInboxRelayPort(
      async () => connection,
      async () => new Response(JSON.stringify({
        supported_nips: [17, 40, 42],
        limitation: { auth_required: true }
      }), { status: 200 }),
      1_000
    );
    const received: string[] = [];
    const closed: string[] = [];
    const subscription = await port.subscribe(
      relayUrl,
      { kinds: [1059], "#p": [protocolPubkey], since: now },
      async (challenge) => createNip42AuthEvent(relayUrl, challenge, protocolKey, now),
      {
        onevent: (value) => received.push(value.id),
        onclose: (reason) => closed.push(reason)
      }
    );

    connection.callbacks?.oneose();
    connection.callbacks?.onevent(event());
    expect(received).toEqual([event().id]);
    expect(connection.closed).toBe(false);
    expect(connection.subscriptionClosed).toBe(false);

    subscription.close("test complete");
    expect(connection.subscriptionClosed).toBe(true);
    expect(connection.closed).toBe(true);
    expect(closed).toEqual([]);
  });

  it("closes the connection and reports an unexpected persistent subscription failure once", async () => {
    class ClosingConnection extends FakeConnection {
      closed = false;
      callbacks:
        | {
            onevent: (value: NostrEvent) => void;
            oneose: () => void;
            onclose: (reason: string) => void;
          }
        | undefined;

      override subscribe(
        _filters: Record<string, unknown>[],
        callbacks: {
          onevent: (value: NostrEvent) => void;
          oneose: () => void;
          onclose: (reason: string) => void;
        }
      ) {
        this.callbacks = callbacks;
        return { close: vi.fn() };
      }

      override close(): void {
        this.closed = true;
      }
    }

    const connection = new ClosingConnection();
    const port = new NostrToolsInboxRelayPort(
      async () => connection,
      async () => new Response(JSON.stringify({
        supported_nips: [17, 40, 42],
        limitation: { auth_required: true }
      }), { status: 200 }),
      1_000
    );
    const closed: string[] = [];
    await port.subscribe(
      relayUrl,
      { kinds: [1059], "#p": [protocolPubkey], since: now },
      async (challenge) => createNip42AuthEvent(relayUrl, challenge, protocolKey, now),
      { onevent: vi.fn(), onclose: (reason) => closed.push(reason) }
    );

    connection.callbacks?.onclose("relay unavailable");
    connection.callbacks?.onclose("duplicate close");
    expect(connection.closed).toBe(true);
    expect(closed).toEqual(["relay unavailable"]);
  });
});
