import { describe, expect, it } from "vitest";

import { createOrderState, fillOrder, releaseOrder, reserveOrder } from "./model.js";
import {
  createProjectionTemplate,
  createStateTransitionTemplate,
  createTransitionTemplate,
  parseCreateTransitionEvent,
  parseProjectionEvent,
  parseTransitionEvent,
  type NostrEvent
} from "./events.js";

const maker = "a".repeat(64);
const transitionId = "b".repeat(64);
const signature = "c".repeat(128);
const orderId = "11111111-1111-4111-8111-111111111111";

function askState() {
  return createOrderState({
    orderId,
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
        ["d", `granola:order-transition:v1:${orderId}`],
        ["a", `30078:${maker}:granola:order:v1:${orderId}`],
        ["op", "create"]
      ])
    });
    expect(JSON.parse(transition.content)).toMatchObject({
      schema: "granola/order-transition/v1",
      operation_id: "operation-1",
      previous: null,
      state: { order_id: orderId }
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
      ["d", `granola:order:v1:${orderId}`],
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
      address: `30078:${maker}:granola:order:v1:${orderId}`,
      eventId: event.id,
      headEventId: transitionId,
      makerPubkey: maker,
      verified: false,
      state: { order_id: orderId, status: "open" }
    });
    expect(JSON.stringify(record)).not.toContain(signature);
  });

  it("verifies the authoritative create transition and its exact order state", () => {
    const state = askState();
    const event: NostrEvent = {
      ...createTransitionTemplate(state, maker, "operation-1"),
      id: transitionId,
      pubkey: maker,
      sig: signature
    };

    expect(parseCreateTransitionEvent(event, () => true)).toMatchObject({
      eventId: transitionId,
      makerPubkey: maker,
      address: `30078:${maker}:granola:order:v1:${orderId}`,
      operationId: "operation-1",
      state
    });

    const wrongAddress = {
      ...event,
      tags: event.tags.map((tag) => tag[0] === "a" ? ["a", "30078:wrong"] : tag)
    };
    expect(() => parseCreateTransitionEvent(wrongAddress, () => true))
      .toThrow("address tag mismatch");

    const nonCanonical = {
      ...event,
      content: event.content.replace('"101","denominator":"2000"', '"202","denominator":"4000"')
    };
    expect(() => parseCreateTransitionEvent(nonCanonical, () => true))
      .toThrow("canonical");
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

  it("builds and validates a reserve then fill chain with public commitments", async () => {
    const initial = askState();
    const create: NostrEvent = {
      ...createTransitionTemplate(initial, maker, "create-op"),
      id: transitionId,
      pubkey: maker,
      sig: signature
    };
    const reserved = reserveOrder(initial, {
      reservationId: "99999999-9999-4999-8999-999999999999",
      amount: "2000",
      acceptedAt: 1_700_000_100,
      expiresAt: 1_700_001_900,
      proposalEventId: "1".repeat(64),
      takerCommitment: "2".repeat(64)
    });
    const reserveTemplate = createStateTransitionTemplate(
      reserved,
      maker,
      "reserve-op",
      "reserve",
      create
    );
    expect(reserveTemplate).toMatchObject({
      kind: 78,
      created_at: 1_700_000_100,
      tags: expect.arrayContaining([
        ["op", "reserve"],
        ["e", transitionId]
      ])
    });
    const reserve: NostrEvent = {
      ...reserveTemplate,
      id: "e".repeat(64),
      pubkey: maker,
      sig: signature
    };
    expect(parseTransitionEvent(reserve, () => true)).toMatchObject({
      operation: "reserve",
      revision: "1",
      previous: transitionId,
      state: { status: "reserved", reserved_amount: "2000" }
    });
    const reservedProjection = await createProjectionTemplate(reserved, reserve);
    expect((await parseProjectionEvent({
      ...reservedProjection,
      id: "f".repeat(64),
      pubkey: maker,
      sig: signature
    }, () => true)).state.status).toBe("reserved");

    const filled = fillOrder(reserved, {
      reservationId: reserved.reservation!.id,
      amount: "2000"
    });
    const fillTemplate = createStateTransitionTemplate(
      filled,
      maker,
      "fill-op",
      "fill",
      reserve,
      {
        settlement_hash: "3".repeat(64),
        base_token_commitment: "4".repeat(64),
        quote_token_commitment: "5".repeat(64)
      }
    );
    const parsed = parseTransitionEvent({
      ...fillTemplate,
      id: "6".repeat(64),
      pubkey: maker,
      sig: signature
    }, () => true);
    expect(parsed).toMatchObject({
      operation: "fill",
      revision: "2",
      previous: reserve.id,
      state: { status: "filled", remaining_amount: "0" },
      evidence: {
        settlement_hash: "3".repeat(64),
        base_token_commitment: "4".repeat(64),
        quote_token_commitment: "5".repeat(64)
      }
    });
  });

  it("requires canonical expiry or signed-abort evidence on release transitions", () => {
    const initial = askState();
    const create: NostrEvent = {
      ...createTransitionTemplate(initial, maker, "create-op"),
      id: transitionId,
      pubkey: maker,
      sig: signature
    };
    const reserved = reserveOrder(initial, {
      reservationId: "99999999-9999-4999-8999-999999999999",
      amount: "2000",
      acceptedAt: 1_700_000_100,
      expiresAt: 1_700_001_900,
      proposalEventId: "1".repeat(64),
      takerCommitment: "2".repeat(64)
    });
    const reserve: NostrEvent = {
      ...createStateTransitionTemplate(reserved, maker, "reserve-op", "reserve", create),
      id: "e".repeat(64),
      pubkey: maker,
      sig: signature
    };
    const released = releaseOrder(reserved, {
      reservationId: reserved.reservation!.id,
      reason: "abort",
      releasedAt: 1_700_000_200,
      abortEventId: "7".repeat(64)
    });
    const template = createStateTransitionTemplate(
      released,
      maker,
      "release-op",
      "release",
      reserve,
      { release_reason: "abort", abort_event_id: "7".repeat(64) },
      1_700_000_200
    );
    const event = {
      ...template,
      id: "8".repeat(64),
      pubkey: maker,
      sig: signature
    };

    expect(parseTransitionEvent(event, () => true)).toMatchObject({
      operation: "release",
      state: { status: "open", reservation: null, reserved_amount: "0" },
      evidence: { release_reason: "abort", abort_event_id: "7".repeat(64) }
    });
    expect(() => createStateTransitionTemplate(
      released,
      maker,
      "release-op",
      "release",
      reserve,
      { release_reason: "expired" }
    )).toThrow("explicit release timestamp");
    const missingAbort = JSON.parse(event.content);
    delete missingAbort.evidence.abort_event_id;
    expect(() => parseTransitionEvent({
      ...event,
      content: JSON.stringify(missingAbort)
    }, () => true)).toThrow("signed abort");
    const extraEvidence = JSON.parse(event.content);
    extraEvidence.evidence.unrecognized = "f".repeat(64);
    expect(() => parseTransitionEvent({
      ...event,
      content: JSON.stringify(extraEvidence)
    }, () => true)).toThrow("canonical");
  });
});
