import { getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { createTradeRumor, termsHash, wrapTradeRumor, type GranolaTradeMessage } from "../trade/messages.js";
import type { NostrEvent } from "../order/events.js";
import type { AuthHandler, InboxRelayPort } from "./inbox.js";
import { NostrTradeTransport } from "./trade-transport.js";

const key = (last: number): Uint8Array => {
  const value = new Uint8Array(32);
  value[31] = last;
  return value;
};

class MemoryInboxPort implements InboxRelayPort {
  readonly events = new Map<string, NostrEvent[]>();

  async info(): Promise<{ supportedNips: number[]; authRequired: boolean }> {
    return { supportedNips: [17, 40, 42], authRequired: true };
  }

  async publish(relay: string, event: NostrEvent, _auth: AuthHandler): Promise<string> {
    this.events.set(relay, [...(this.events.get(relay) ?? []), event]);
    return "saved";
  }

  async query(relay: string, filter: Record<string, unknown>, _auth: AuthHandler): Promise<NostrEvent[]> {
    const kinds = filter.kinds as number[] | undefined;
    const authors = filter.authors as string[] | undefined;
    const recipients = filter["#p"] as string[] | undefined;
    return (this.events.get(relay) ?? []).filter((event) =>
      (!kinds || kinds.includes(event.kind)) &&
      (!authors || authors.includes(event.pubkey)) &&
      (!recipients || event.tags.some((tag) => tag[0] === "p" && recipients.includes(tag[1] ?? "")))
    );
  }
}

const discovery = ["wss://one.example", "wss://two.example", "wss://three.example"];
const inboxes = ["wss://inbox.example"];
const now = 1_800_000_000;

describe("Nostr trade transport", () => {
  it("publishes and discovers the exact quorum-backed inbox list", async () => {
    const port = new MemoryInboxPort();
    const transport = new NostrTradeTransport(port, discovery, inboxes, () => now);
    const recipientKey = key(1);

    const registration = await transport.register(recipientKey);
    const selected = await transport.discover(getPublicKey(recipientKey), key(2));

    expect(registration.confirmed).toHaveLength(3);
    expect(selected).toEqual(inboxes);
  });

  it("requires at least one authenticated inbox acknowledgement and reads deduplicated wraps", async () => {
    const port = new MemoryInboxPort();
    const transport = new NostrTradeTransport(port, discovery, inboxes, () => now);
    const makerKey = key(3);
    const takerKey = key(4);
    const maker = getPublicKey(makerKey);
    const taker = getPublicKey(takerKey);
    const tradeTerms = {
      base_unit: "sat",
      base_mint: "https://testnut.cashu.space",
      base_keyset: "00ba2e3e5779e035",
      quote_unit: "usd",
      quote_mint: "https://nofee.testnut.cashu.space",
      quote_keyset: "00ca2e3e5779e035",
      base_amount: "20",
      quote_amount: "1",
      limit_price: { numerator: "1", denominator: "20" }
    };
    const message: GranolaTradeMessage = {
      schema: "granola/dm/v1",
      deployment: "cashu-testnet-v1",
      type: "reserve_propose",
      message_id: "11111111-1111-4111-8111-111111111111",
      session_id: "11".repeat(32),
      reservation_id: "22222222-2222-4222-8222-222222222222",
      order_address: `30078:${maker}:granola:order:v1:33333333-3333-4333-8333-333333333333`,
      order_head: "44".repeat(32),
      maker_order_pubkey: maker,
      author_pubkey: taker,
      recipient_pubkey: maker,
      sequence: "0",
      previous_message_id: null,
      previous_transcript_hash: null,
      sent_at: now - 1,
      expires_at: now + 300,
      terms_hash: await termsHash(tradeTerms),
      terms: tradeTerms,
      body: { taker_cashu_pubkey: `02${"55".repeat(32)}` }
    };
    const rumor = await createTradeRumor(message, takerKey);
    const wrapped = wrapTradeRumor(rumor, takerKey, {
      ephemeralSecretKey: key(5),
      sealCreatedAt: now - 2,
      wrapperCreatedAt: now - 3,
      outerExpiration: message.expires_at + 3_600,
      sealNonce: new Uint8Array(32).fill(6),
      wrapperNonce: new Uint8Array(32).fill(7)
    });

    const receipts = await transport.send(wrapped.wrapper, inboxes, takerKey);
    await transport.send(wrapped.wrapper, inboxes, takerKey);
    const received = await transport.read(maker, makerKey, now - 60);

    expect(receipts.filter((receipt) => receipt.ok)).toHaveLength(1);
    expect(received.map((event) => event.id)).toEqual([wrapped.wrapper.id]);
  });
});
