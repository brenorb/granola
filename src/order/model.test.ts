import { describe, expect, it } from "vitest";

import {
  buildOrderBook,
  cancelOrder,
  createOrderState,
  eligibleMarketIds,
  expireOrder,
  fillOrder,
  marketId,
  quoteAmountForSettlement,
  releaseOrder,
  reserveOrder,
  type OrderRecord
} from "./model.js";

const testnut = "https://testnut.cashu.space";
const nofee = "https://nofee.testnut.cashu.space";
const askOne = "11111111-1111-4111-8111-111111111111";
const bidOne = "22222222-2222-4222-8222-222222222222";

describe("Granola order model", () => {
  it("creates a canonical ask with explicit 30-day expiry and indexed markets", async () => {
    const state = createOrderState({
      orderId: askOne,
      createdAt: 1_700_000_000,
      side: "sell",
      baseUnit: "sat",
      quoteUnit: "usd",
      offered: { unit: "sat", mint: testnut },
      requested: { unit: "usd", acceptableMints: [testnut, nofee, nofee] },
      amount: "2000",
      priceCentsPerBtc: "5050000"
    });

    expect(state.expires_at).toBe(1_702_592_000);
    expect(state.execution).toBe("all_or_none");
    expect(state.minimum_fill_amount).toBe("2000");
    expect(state.requested.acceptable_mints).toEqual([nofee, testnut]);
    await expect(eligibleMarketIds(state)).resolves.toEqual([
      "79da04f634a843c37c7a5ffb4aa29742a2551d238d9a443b39338c52b8fd1d5b",
      "8b232677c9edc17ccae45cf226fda181d314a83426212ee0ffada7f92d10dbad"
    ]);
  });

  it("models a bid without reversing offered/requested mint cardinality", async () => {
    const state = createOrderState({
      orderId: bidOne,
      createdAt: 1_700_000_000,
      side: "buy",
      baseUnit: "sat",
      quoteUnit: "usd",
      offered: { unit: "usd", mint: nofee },
      requested: { unit: "sat", acceptableMints: [testnut, nofee] },
      amount: "2000",
      priceCentsPerBtc: "4950000",
      execution: "partial",
      minimumFillAmount: "1000"
    });

    expect(state.offered).toEqual({ unit: "usd", mint: nofee });
    expect(state.requested.acceptable_mints).toEqual([nofee, testnut]);
    await expect(eligibleMarketIds(state)).resolves.toEqual([
      "79da04f634a843c37c7a5ffb4aa29742a2551d238d9a443b39338c52b8fd1d5b",
      "af826c2cddbdba30d2fa196180ce8a0111618e002eec2a1e644cbddd9935797e"
    ]);
  });

  it("preserves exact SAT amounts, truncates cents, and rejects zero quotes", () => {
    const exactBase = createOrderState({
      orderId: "99999999-9999-4999-8999-999999999999",
      createdAt: 1,
      side: "sell",
      baseUnit: "sat",
      quoteUnit: "usd",
      offered: { unit: "sat", mint: testnut },
      requested: { unit: "usd", acceptableMints: [nofee] },
      amount: "200",
      priceCentsPerBtc: "4950000"
    });
    expect(exactBase.original_amount).toBe("200");
    expect(exactBase.remaining_amount).toBe("200");
    expect(quoteAmountForSettlement("200", exactBase.price_cents_per_btc)).toBe("9");

    expect(() => createOrderState({
      orderId: "33333333-3333-4333-8333-333333333333",
      createdAt: 1,
      side: "buy",
      baseUnit: "sat",
      quoteUnit: "usd",
      offered: { unit: "usd", mint: nofee },
      requested: { unit: "sat", acceptableMints: [testnut] },
      amount: "1",
      priceCentsPerBtc: "50000000"
    })).toThrow("at least one quote unit");

    const truncated = createOrderState({
      orderId: "77777777-7777-4777-8777-777777777777",
      createdAt: 1,
      side: "sell",
      baseUnit: "sat",
      quoteUnit: "usd",
      offered: { unit: "sat", mint: testnut },
      requested: { unit: "usd", acceptableMints: [nofee] },
      amount: "2000",
      priceCentsPerBtc: "4960000"
    });
    expect(truncated.original_amount).toBe("2000");
    expect(quoteAmountForSettlement("2000", truncated.price_cents_per_btc)).toBe("99");

    expect(() => createOrderState({
      orderId: "44444444-4444-4444-8444-444444444444",
      createdAt: 1,
      side: "sell",
      baseUnit: "sat",
      quoteUnit: "usd",
      offered: { unit: "usd", mint: nofee },
      requested: { unit: "sat", acceptableMints: [testnut] },
      amount: "2",
      priceCentsPerBtc: "50000000"
    })).toThrow("Sell orders must offer the base unit");
  });

  it("rejects non-UUID IDs and runtime enum bypasses", () => {
    const valid = {
      orderId: "11111111-1111-4111-8111-111111111111",
      createdAt: 1,
      side: "sell" as const,
      baseUnit: "sat",
      quoteUnit: "usd",
      offered: { unit: "sat", mint: testnut },
      requested: { unit: "usd", acceptableMints: [nofee] },
      amount: "2",
      priceCentsPerBtc: "50000000"
    };

    expect(() => createOrderState({ ...valid, orderId: "decorated-id" }))
      .toThrow("Order ID must be a UUID");
    expect(() => createOrderState({ ...valid, side: "market" as "sell" }))
      .toThrow("Order side");
    expect(() => createOrderState({
      ...valid,
      execution: "immediate" as "partial",
      minimumFillAmount: "1"
    })).toThrow("Execution condition");
  });

  it("sorts an issuer-specific book and makes the top bid and ask explicit", async () => {
    const askHigh = "55555555-5555-4555-8555-555555555555";
    const bidLow = "66666666-6666-4666-8666-666666666666";
    const askLow = "77777777-7777-4777-8777-777777777777";
    const bidHigh = "88888888-8888-4888-8888-888888888888";
    const record = (orderId: string, side: "buy" | "sell", numerator: string): OrderRecord => ({
      address: `30078:maker:${orderId}`,
      eventId: `${orderId}-head`,
      makerPubkey: `maker-${orderId}`,
      verified: true,
      state: createOrderState({
        orderId,
        createdAt: 1_700_000_000,
        expiresAt: 1_800_000_000,
        side,
        baseUnit: "sat",
        quoteUnit: "usd",
        offered: side === "sell"
          ? { unit: "sat", mint: testnut }
          : { unit: "usd", mint: nofee },
          requested: side === "sell"
          ? { unit: "usd", acceptableMints: [nofee] }
          : { unit: "sat", acceptableMints: [testnut] },
          amount: "2000",
        priceCentsPerBtc: (BigInt(numerator) * 50_000n).toString()
      })
    });
    const market = { baseUnit: "sat", baseMint: testnut, quoteUnit: "usd", quoteMint: nofee };
    const records = [
      record(askHigh, "sell", "102"),
      record(bidLow, "buy", "98"),
      record(askLow, "sell", "101"),
      record(bidHigh, "buy", "99")
    ];

    const book = await buildOrderBook(records, market, 1_700_000_100);

    expect(book.asks.map((order) => order.state.order_id)).toEqual([askLow, askHigh]);
    expect(book.bids.map((order) => order.state.order_id)).toEqual([bidHigh, bidLow]);
    expect(book.topAsk?.state.order_id).toBe(askLow);
    expect(book.topBid?.state.order_id).toBe(bidHigh);
    await expect(marketId(market)).resolves.toBe(
      "79da04f634a843c37c7a5ffb4aa29742a2551d238d9a443b39338c52b8fd1d5b"
    );
  });

  it("reserves an exact all-or-none amount without reducing the remaining amount", () => {
    const initial = createOrderState({
      orderId: askOne,
      createdAt: 1_700_000_000,
      expiresAt: 1_700_010_000,
      side: "sell",
      baseUnit: "sat",
      quoteUnit: "usd",
      offered: { unit: "sat", mint: testnut },
      requested: { unit: "usd", acceptableMints: [nofee] },
      amount: "20",
      priceCentsPerBtc: "5000000"
    });

    const reserved = reserveOrder(initial, {
      reservationId: "99999999-9999-4999-8999-999999999999",
      amount: "20",
      acceptedAt: 1_700_000_100,
      expiresAt: 1_700_001_900,
      proposalEventId: "a".repeat(64),
      takerCommitment: "b".repeat(64)
    });

    expect(reserved).toMatchObject({
      revision: "1",
      remaining_amount: "20",
      reserved_amount: "20",
      status: "reserved",
      reservation: {
        id: "99999999-9999-4999-8999-999999999999",
        amount: "20",
        accepted_at: 1_700_000_100,
        expires_at: 1_700_001_900
      }
    });
    expect(() => reserveOrder(reserved, {
      reservationId: "88888888-8888-4888-8888-888888888888",
      amount: "20",
      acceptedAt: 1_700_000_101,
      expiresAt: 1_700_001_901,
      proposalEventId: "c".repeat(64),
      takerCommitment: "d".repeat(64)
    })).toThrow("live reservation");
  });

  it("fills only the matching reservation and reaches a terminal zero balance", () => {
    const initial = createOrderState({
      orderId: askOne,
      createdAt: 1_700_000_000,
      expiresAt: 1_700_010_000,
      side: "sell",
      baseUnit: "sat",
      quoteUnit: "usd",
      offered: { unit: "sat", mint: testnut },
      requested: { unit: "usd", acceptableMints: [nofee] },
      amount: "20",
      priceCentsPerBtc: "5000000"
    });
    const reserved = reserveOrder(initial, {
      reservationId: "99999999-9999-4999-8999-999999999999",
      amount: "20",
      acceptedAt: 1_700_000_100,
      expiresAt: 1_700_001_900,
      proposalEventId: "a".repeat(64),
      takerCommitment: "b".repeat(64)
    });

    expect(() => fillOrder(reserved, {
      reservationId: "88888888-8888-4888-8888-888888888888",
      amount: "20"
    })).toThrow("reservation ID");

    expect(fillOrder(reserved, {
      reservationId: "99999999-9999-4999-8999-999999999999",
      amount: "20"
    })).toMatchObject({
      revision: "2",
      remaining_amount: "0",
      reserved_amount: "0",
      reservation: null,
      status: "filled"
    });
  });

  it("releases only the matching reservation after expiry or a signed abort", () => {
    const initial = createOrderState({
      orderId: askOne,
      createdAt: 1_700_000_000,
      expiresAt: 1_700_010_000,
      side: "sell",
      baseUnit: "sat",
      quoteUnit: "usd",
      offered: { unit: "sat", mint: testnut },
      requested: { unit: "usd", acceptableMints: [nofee] },
      amount: "20",
      priceCentsPerBtc: "5000000"
    });
    const reserved = reserveOrder(initial, {
      reservationId: "99999999-9999-4999-8999-999999999999",
      amount: "20",
      acceptedAt: 1_700_000_100,
      expiresAt: 1_700_001_900,
      proposalEventId: "a".repeat(64),
      takerCommitment: "b".repeat(64)
    });

    expect(() => releaseOrder(reserved, {
      reservationId: reserved.reservation!.id,
      reason: "expired",
      releasedAt: 1_700_001_899
    })).toThrow(/not expired/i);

    expect(releaseOrder(reserved, {
      reservationId: reserved.reservation!.id,
      reason: "expired",
      releasedAt: 1_700_001_900
    })).toMatchObject({
      revision: "2",
      remaining_amount: "20",
      reserved_amount: "0",
      reservation: null,
      status: "open"
    });

    expect(releaseOrder(reserved, {
      reservationId: reserved.reservation!.id,
      reason: "abort",
      releasedAt: 1_700_000_200,
      abortEventId: "c".repeat(64)
    })).toMatchObject({ revision: "2", status: "open", reservation: null });
    expect(() => releaseOrder(reserved, {
      reservationId: reserved.reservation!.id,
      reason: "abort",
      releasedAt: 1_700_000_200
    })).toThrow(/abort event/i);
  });

  it("cancels or expires only an unreserved projection", () => {
    const initial = createOrderState({
      orderId: askOne,
      createdAt: 1_700_000_000,
      expiresAt: 1_700_001_000,
      side: "sell",
      baseUnit: "sat",
      quoteUnit: "usd",
      offered: { unit: "sat", mint: testnut },
      requested: { unit: "usd", acceptableMints: [nofee] },
      amount: "20",
      priceCentsPerBtc: "5000000"
    });
    const reserved = reserveOrder(initial, {
      reservationId: "99999999-9999-4999-8999-999999999999",
      amount: "20",
      acceptedAt: 1_700_000_100,
      expiresAt: 1_700_000_900,
      proposalEventId: "a".repeat(64),
      takerCommitment: "b".repeat(64)
    });

    expect(cancelOrder(initial)).toMatchObject({ revision: "1", status: "canceled" });
    expect(expireOrder(initial, 1_700_001_000))
      .toMatchObject({ revision: "1", status: "expired" });
    expect(() => cancelOrder(reserved)).toThrow(/released/i);
    expect(() => expireOrder(reserved, 1_700_001_000)).toThrow(/released/i);
  });
});
