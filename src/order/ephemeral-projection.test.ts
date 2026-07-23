import { describe, expect, it } from "vitest";

import type { NostrEvent, UnsignedNostrEvent } from "./events.js";
import { createOrderState } from "./model.js";
import { NostrOrderService } from "./service.js";

const MAKER = "a".repeat(64);
const SIGNATURE = "b".repeat(128);

function state() {
  return createOrderState({
    orderId: "11111111-1111-4111-8111-111111111111",
    createdAt: 1_700_000_000,
    expiresAt: 1_700_003_600,
    side: "sell",
    baseUnit: "sat",
    quoteUnit: "usd",
    offered: { unit: "sat", mint: "https://mint.example" },
    requested: {
      unit: "usd",
      acceptableMints: ["https://quote.example"]
    },
    amount: "100",
    priceCentsPerBtc: "200000000"
  });
}

describe("ephemeral order projections", () => {
  it("stages one complete kind 30078 event without a public chain", async () => {
    const signed: UnsignedNostrEvent[] = [];
    const signer = {
      async publicKey() {
        return MAKER;
      },
      async sign(template: UnsignedNostrEvent): Promise<NostrEvent> {
        signed.push(structuredClone(template));
        return {
          ...structuredClone(template),
          id: "c".repeat(64),
          pubkey: MAKER,
          sig: SIGNATURE
        };
      }
    };
    const relays = {
      async publish() {
        return [{ relay: "wss://one.example", ok: true, message: "stored" }];
      },
      async queryProjections() {
        return [];
      },
      async queryOrder() {
        return [];
      }
    };
    const service = new NostrOrderService(signer, relays, () => true);

    const publication = await service.stage(state());

    expect(signed).toHaveLength(1);
    expect(signed[0]?.kind).toBe(30078);
    expect(signed[0]?.tags.some((tag) => tag[0] === "e")).toBe(false);
    expect(JSON.parse(signed[0]!.content)).not.toHaveProperty("head");
    expect(publication).not.toHaveProperty("transition");
  });
});
