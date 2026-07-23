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
      record("ask-52000", "sell", "104"),
      record("bid-48000", "buy", "96"),
      record("ask-50500", "sell", "101"),
      record("bid-49500", "buy", "99")
    ], market, 1_700_000_100);
    const root = document.createElement("section");

    renderOrderBook(root, { status: "ready", book });

    expect(root.getAttribute("aria-live")).toBe("polite");
    expect(root.querySelector("caption")?.textContent).toContain("SAT / USD order book");
    expect(
      [...root.querySelectorAll<HTMLElement>("[data-order-id], [data-book-midpoint]")]
        .map((node) => node.dataset.orderId ?? "midpoint")
    ).toEqual(["ask-52000", "ask-50500", "midpoint", "bid-49500", "bid-48000"]);

    expect(root.querySelector('[data-order-id="ask-50500"]')?.getAttribute("data-best"))
      .toBe("ask");
    expect(root.querySelector('[data-order-id="bid-49500"]')?.getAttribute("data-best"))
      .toBe("bid");
    expect(root.querySelector('[data-summary="best-ask"]')?.textContent).toContain("50,500.00");
    expect(root.querySelector('[data-summary="best-bid"]')?.textContent).toContain("49,500.00");
    expect(root.querySelector('[data-summary="spread"]')?.textContent).toContain("1,000.00");
    expect(root.querySelector('[data-summary="spread"]')?.getAttribute("data-exact-spread"))
      .toBe("1/1000");
    expect(root.querySelector('[data-order-id="ask-50500"] [data-price]')
      ?.getAttribute("data-exact-price")).toBe("101/2000");

    expect(root.querySelectorAll('th[scope="row"]')).toHaveLength(4);
    expect(root.querySelector('[data-order-id="ask-50500"]')?.textContent).toContain("Best ask");
    expect(root.querySelector('[data-order-id="bid-49500"]')?.textContent).toContain("Best bid");
  });

  it("preserves a sub-safe-integer spread as an exact rational", async () => {
    const denominator = "9007199254740992";
    const book = await buildOrderBook([
      record("tiny-ask", "sell", "9007199254740993", denominator, denominator),
      record("unit-bid", "buy", "1", "1", denominator)
    ], market, 1_700_000_100);
    const root = document.createElement("section");

    renderOrderBook(root, { status: "ready", book });

    expect(root.querySelector('[data-summary="spread"]')?.getAttribute("data-exact-spread"))
      .toBe("1/9007199254740992");
    expect(root.querySelector('[data-order-id="tiny-ask"] [data-price]')
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
