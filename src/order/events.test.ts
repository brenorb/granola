import { describe, expect, it } from "vitest";

import { createOrderState } from "./model.js";
import {
  createProjectionTemplate,
  createTransitionTemplate,
  parseProjectionEvent,
  type NostrEvent
} from "./events.js";

const maker = "a".repeat(64);
const transitionId = "b".repeat(64);
const signature = "c".repeat(128);

function askState() {
  return createOrderState({
    orderId: "order-1",
    createdAt: 1_700_000_000,
    side: "sell",
    baseUnit: "sat",
    quoteUnit: "usd",
    offered: { unit: "sat", mint: "https://testnut.cashu.space" },
    requested: {
      unit: "usd",
      acceptableMints: ["https://nofee.testnut.cashu.space"]
    },
    amount: "2000",
    price: { numerator: "101", denominator: "2000" }
  });
}

describe("Granola Nostr order events", () => {
  it("builds an immutable create transition followed by its addressable projection", async () => {
    const state = askState();
    const transition = createTransitionTemplate(state, maker, "operation-1");
    expect(transition).toMatchObject({
      kind: 78,
      created_at: state.created_at,
      tags: expect.arrayContaining([
        ["d", "granola:order-transition:v1:order-1"],
        ["a", `30078:${maker}:granola:order:v1:order-1`],
        ["op", "create"]
      ])
    });
    expect(JSON.parse(transition.content)).toMatchObject({
      schema: "granola/order-transition/v1",
      operation_id: "operation-1",
      previous: null,
      state: { order_id: "order-1" }
    });

    const signedTransition: NostrEvent = {
      ...transition,
      id: transitionId,
      pubkey: maker,
      sig: signature
    };
    const projection = await createProjectionTemplate(state, signedTransition);
    expect(projection.kind).toBe(30078);
    expect(projection.tags).toEqual(expect.arrayContaining([
      ["d", "granola:order:v1:order-1"],
      ["e", transitionId],
      ["expiration", String(state.expires_at + 604_800)],
      ["m", "79da04f634a843c37c7a5ffb4aa29742a2551d238d9a443b39338c52b8fd1d5b"]
    ]));
    expect(JSON.parse(projection.content).head).toBe(transitionId);
  });

  it("verifies and parses a projection into a secret-free order record", async () => {
    const state = askState();
    const transition = { ...createTransitionTemplate(state, maker, "op"), id: transitionId, pubkey: maker, sig: signature };
    const projection = await createProjectionTemplate(state, transition);
    const event: NostrEvent = {
      ...projection,
      id: "d".repeat(64),
      pubkey: maker,
      sig: signature
    };

    const record = await parseProjectionEvent(event, () => true);

    expect(record).toMatchObject({
      address: `30078:${maker}:granola:order:v1:order-1`,
      eventId: event.id,
      makerPubkey: maker,
      verified: true,
      state: { order_id: "order-1", status: "open" }
    });
    expect(JSON.stringify(record)).not.toContain(signature);
  });

  it("rejects a signature failure or forged market index", async () => {
    const state = askState();
    const transition = { ...createTransitionTemplate(state, maker, "op"), id: transitionId, pubkey: maker, sig: signature };
    const projection = await createProjectionTemplate(state, transition);
    const event: NostrEvent = { ...projection, id: "d".repeat(64), pubkey: maker, sig: signature };

    await expect(parseProjectionEvent(event, () => false)).rejects.toThrow("signature");
    const forged = {
      ...event,
      tags: event.tags.map((tag) => tag[0] === "m" ? ["m", "0".repeat(64)] : tag)
    };
    await expect(parseProjectionEvent(forged, () => true)).rejects.toThrow("market index");
  });
});
