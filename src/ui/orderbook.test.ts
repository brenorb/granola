import { describe, expect, it } from "vitest";

import { buildOrderBook, createOrderState, type OrderRecord } from "../order/model.js";
import { renderOrderBook } from "./orderbook.js";

const baseMint = "https://testnut.cashu.space";
const quoteMint = "https://nofee.testnut.cashu.space";
const market = {
  baseUnit: "sat",
  baseMint,
  quoteUnit: "usd",
  quoteMint
};
const askHigh = "11111111-1111-4111-8111-111111111111";
const bidLow = "22222222-2222-4222-8222-222222222222";
const askLow = "33333333-3333-4333-8333-333333333333";
const bidHigh = "44444444-4444-4444-8444-444444444444";

function record(
  orderId: string,
  side: "buy" | "sell",
  numerator: string,
  denominator = "2000",
  amount = "2000"
): OrderRecord {
  return {
    address: `30078:maker:${orderId}`,
    eventId: `${orderId}-event`,
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
        ? { unit: "sat", mint: baseMint }
        : { unit: "usd", mint: quoteMint },
      requested: side === "sell"
        ? { unit: "usd", acceptableMints: [quoteMint] }
        : { unit: "sat", acceptableMints: [baseMint] },
      amount,
      price: { numerator, denominator }
    })
  };
}

describe("order-book presentation", () => {
  it("renders asks above the midpoint, bids below, and identifies the inside market", async () => {
    const book = await buildOrderBook([
      record(askHigh, "sell", "104"),
      record(bidLow, "buy", "96"),
      record(askLow, "sell", "101"),
      record(bidHigh, "buy", "99")
    ], market, 1_700_000_100);
    const root = document.createElement("section");

    renderOrderBook(root, { status: "ready", book });

    expect(root.getAttribute("aria-live")).toBe("polite");
    expect(root.querySelector("caption")?.textContent).toContain("SAT / USD order book");
    expect(
      [...root.querySelectorAll<HTMLElement>("[data-order-id], [data-book-midpoint]")]
        .map((node) => node.dataset.orderId ?? "midpoint")
    ).toEqual([askHigh, askLow, "midpoint", bidHigh, bidLow]);

    expect(root.querySelector(`[data-order-id="${askLow}"]`)?.getAttribute("data-best"))
      .toBe("ask");
    expect(root.querySelector(`[data-order-id="${bidHigh}"]`)?.getAttribute("data-best"))
      .toBe("bid");
    expect(root.querySelector('[data-summary="best-ask"]')?.textContent).toContain("50,500.00");
    expect(root.querySelector('[data-summary="best-bid"]')?.textContent).toContain("49,500.00");
    expect(root.querySelector('[data-summary="spread"]')?.textContent).toContain("1,000.00");
    expect(root.querySelector('[data-summary="spread"]')?.getAttribute("data-exact-spread"))
      .toBe("1/1000");
    expect(root.querySelector(`[data-order-id="${askLow}"] [data-price]`)
      ?.getAttribute("data-exact-price")).toBe("101/2000");

    expect(root.querySelectorAll('th[scope="row"]')).toHaveLength(4);
    expect(root.querySelector(`[data-order-id="${askLow}"]`)?.textContent).toContain("Best ask");
    expect(root.querySelector(`[data-order-id="${bidHigh}"]`)?.textContent).toContain("Best bid");
  });

  it("preserves a sub-safe-integer spread as an exact rational", async () => {
    const denominator = "9007199254740992";
    const book = await buildOrderBook([
      record("55555555-5555-4555-8555-555555555555", "sell", "9007199254740993", denominator, denominator),
      record("66666666-6666-4666-8666-666666666666", "buy", "1", "1", denominator)
    ], market, 1_700_000_100);
    const root = document.createElement("section");

    renderOrderBook(root, { status: "ready", book });

    expect(root.querySelector('[data-summary="spread"]')?.getAttribute("data-exact-spread"))
      .toBe("1/9007199254740992");
    expect(root.querySelector('[data-order-id="55555555-5555-4555-8555-555555555555"] [data-price]')
      ?.getAttribute("data-exact-price")).toBe("9007199254740993/9007199254740992");
  });

  it("renders honest loading, error, and empty states", async () => {
    const root = document.createElement("section");

    renderOrderBook(root, { status: "loading" });
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(root.textContent).toContain("Loading order book");

    renderOrderBook(root, { status: "error", message: "Relay timed out" });
    expect(root.getAttribute("role")).toBe("alert");
    expect(root.textContent).toContain("Relay timed out");

    const book = await buildOrderBook([], market, 1_700_000_100);
    renderOrderBook(root, { status: "ready", book });
    expect(root.getAttribute("aria-busy")).toBe("false");
    expect(root.getAttribute("role")).toBeNull();
    expect(root.textContent).toContain("No open orders for this issuer pair");
    expect(root.querySelector("table")).toBeNull();
  });
});
