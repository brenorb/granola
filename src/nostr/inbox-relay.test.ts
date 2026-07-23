import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";

import type { NostrEvent } from "../order/events.js";
import { createNip42AuthEvent } from "./inbox.js";
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
  onauth: ((template: EventTemplate) => Promise<NostrEvent>) | undefined;
  published: NostrEvent[] = [];
  authPubkeys: string[] = [];

  private async authenticate(): Promise<void> {
    const auth = await this.onauth?.({
      kind: 22242,
      created_at: now,
      tags: [["relay", relayUrl], ["challenge", "relay-challenge"]],
      content: ""
    });
    if (!auth) throw new Error("missing auth");
    this.authPubkeys.push(auth.pubkey);
  }

  async publish(value: NostrEvent): Promise<string> {
    await this.authenticate();
    this.published.push(value);
    return "stored";
  }

  subscribe(
    _filters: Record<string, unknown>[],
    callbacks: { onevent: (value: NostrEvent) => void; oneose: () => void; onclose: (reason: string) => void }
  ) {
    void this.authenticate().then(() => {
      callbacks.onevent(event());
      callbacks.oneose();
    });
    return { close: vi.fn() };
  }

  close(): void {}
}

describe("nostr-tools inbox relay port", () => {
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
      override async publish(value: NostrEvent): Promise<string> {
        await this.onauth?.({ kind: 22242, created_at: now, tags: [], content: "" });
        return super.publish(value);
      }
    }
    const port = new NostrToolsInboxRelayPort(
      async () => new MissingChallengeConnection(),
      async () => new Response("{}", { status: 200 }),
      1_000
    );

    await expect(port.publish(relayUrl, event(), async (challenge) =>
      createNip42AuthEvent(relayUrl, challenge, protocolKey, now)))
      .rejects.toThrow(/challenge/i);
  });
});
