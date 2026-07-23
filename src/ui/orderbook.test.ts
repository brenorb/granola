import { describe, expect, it } from "vitest";
import { vi } from "vitest";

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
  priceCentsPerBtc: string,
  amount = "2000"
): OrderRecord {
  return {
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
        ? { unit: "sat", mint: baseMint }
        : { unit: "usd", mint: quoteMint },
        requested: side === "sell"
        ? { unit: "usd", acceptableMints: [quoteMint] }
        : { unit: "sat", acceptableMints: [baseMint] },
        amount,
      priceCentsPerBtc
    })
  };
}

describe("order-book presentation", () => {
  it("renders asks above the midpoint, bids below, and identifies the inside market", async () => {
    const book = await buildOrderBook([
      record(askHigh, "sell", "5200000"),
      record(bidLow, "buy", "4800000"),
      record(askLow, "sell", "5050000"),
      record(bidHigh, "buy", "4950000")
    ], market, 1_700_000_100);
    const root = document.createElement("section");

    renderOrderBook(root, { status: "ready", book });

    expect(root.getAttribute("aria-live")).toBe("polite");
    expect([...root.querySelectorAll("caption")].map((caption) => caption.textContent))
      .toEqual(["Asks", "Bids"]);
    expect(
      [...root.querySelectorAll<HTMLElement>("[data-order-id], [data-book-midpoint]")]
        .map((node) => node.dataset.orderId ?? "midpoint")
    ).toEqual([askLow, askHigh, "midpoint", bidHigh, bidLow]);

    expect(root.querySelector(`[data-order-id="${askLow}"]`)?.getAttribute("data-best"))
      .toBe("ask");
    expect(root.querySelector(`[data-order-id="${bidHigh}"]`)?.getAttribute("data-best"))
      .toBe("bid");
    expect(root.querySelector('[data-summary="best-ask"]')?.textContent).toContain("50,500.00");
    expect(root.querySelector('[data-summary="best-bid"]')?.textContent).toContain("49,500.00");
    expect(root.querySelector('[data-summary="spread"]')?.textContent).toContain("1,000.00");
    expect(root.querySelector('[data-summary="spread"]')?.getAttribute("data-spread-cents-per-btc"))
      .toBe("100000");
    expect(root.querySelector(`[data-order-id="${askLow}"] [data-price]`)
      ?.getAttribute("data-price-cents-per-btc")).toBe("5050000");

    expect(root.querySelectorAll(".orderbook-side")).toHaveLength(2);
    expect(root.querySelector(`[data-order-id="${askLow}"]`)?.getAttribute("aria-label"))
      .toBe("Best ask");
    expect(root.querySelector(`[data-order-id="${bidHigh}"]`)?.getAttribute("aria-label"))
      .toBe("Best bid");
  });

  it("offers an explicit take action with the exact verified order record", async () => {
    const best = record(askLow, "sell", "5000000", "20");
    const book = await buildOrderBook([best], market, 1_700_000_100);
    const root = document.createElement("section");
    const take = vi.fn();

    renderOrderBook(root, { status: "ready", book }, { onTake: take });
    const button = root.querySelector<HTMLButtonElement>(`[data-order-id="${askLow}"] [data-take-order]`);
    const amount = root.querySelector<HTMLInputElement>(
      `[data-order-id="${askLow}"] [data-take-amount]`
    );
    button?.click();

    expect(button?.textContent).toBe("Take ask");
    expect(amount?.value).toBe("20");
    expect(take).toHaveBeenCalledWith(best, "20");
  });

  it("offers bid taking and exposes cancellation only for owned orders", async () => {
    const ask = record(askLow, "sell", "5000000", "20");
    const bid = record(bidHigh, "buy", "5000000", "20");
    const book = await buildOrderBook([ask, bid], market, 1_700_000_100);
    const root = document.createElement("section");
    const cancel = vi.fn();

    renderOrderBook(root, { status: "ready", book }, {
      onTake: vi.fn(),
      onCancel: cancel,
      canCancel: (order) => order.eventId === ask.eventId
    });

    const bidTake = root.querySelector<HTMLButtonElement>(
      `[data-order-id="${bidHigh}"] [data-take-order]`
    );
    expect(bidTake?.textContent).toBe("Sell into bid");
    bidTake?.click();
    expect(root.querySelector(`[data-order-id="${bidHigh}"] [data-take-amount]`)
      ?.getAttribute("aria-label")).toMatch(/sell/i);
    const cancelButton = root.querySelector<HTMLButtonElement>(
      `[data-order-id="${askLow}"] [data-cancel-order]`
    );
    cancelButton?.click();
    expect(cancel).toHaveBeenCalledWith(ask);
    expect(root.querySelector(`[data-order-id="${bidHigh}"] [data-cancel-order]`))
      .toBeNull();
  });

  it("validates exact all-or-none and partial-fill amounts before taking an order", async () => {
    const allOrNone = record(askLow, "sell", "5000000", "20");
    const partial = record(
      "77777777-7777-4777-8777-777777777777",
      "sell",
      "5000000",
      "100"
    );
    partial.state.execution = "partial";
    partial.state.minimum_fill_amount = "10";
    const book = await buildOrderBook([allOrNone, partial], market, 1_700_000_100);
    const root = document.createElement("section");
    const take = vi.fn();
    renderOrderBook(root, { status: "ready", book }, { onTake: take });

    const aonRow = root.querySelector<HTMLElement>(`[data-order-id="${askLow}"]`)!;
    const aonAmount = aonRow.querySelector<HTMLInputElement>("[data-take-amount]")!;
    aonAmount.value = "19";
    aonRow.querySelector<HTMLButtonElement>("[data-take-order]")!.click();
    expect(take).not.toHaveBeenCalled();
    expect(aonAmount.validationMessage).toMatch(/all-or-none/i);

    const partialRow = root.querySelector<HTMLElement>(
      '[data-order-id="77777777-7777-4777-8777-777777777777"]'
    )!;
    const partialAmount = partialRow.querySelector<HTMLInputElement>("[data-take-amount]")!;
    partialAmount.value = "9";
    partialRow.querySelector<HTMLButtonElement>("[data-take-order]")!.click();
    expect(take).not.toHaveBeenCalled();
    expect(partialAmount.validationMessage).toMatch(/minimum/i);

    partialAmount.value = "25";
    partialRow.querySelector<HTMLButtonElement>("[data-take-order]")!.click();
    expect(take).toHaveBeenCalledWith(partial, "25");
  });

  it("preserves integer prices above Number.MAX_SAFE_INTEGER", async () => {
    const book = await buildOrderBook([
      record("55555555-5555-4555-8555-555555555555", "sell", "9007199254740993"),
      record("66666666-6666-4666-8666-666666666666", "buy", "9007199254740992")
    ], market, 1_700_000_100);
    const root = document.createElement("section");

    renderOrderBook(root, { status: "ready", book });

    expect(root.querySelector('[data-summary="spread"]')?.getAttribute("data-spread-cents-per-btc"))
      .toBe("1");
    expect(root.querySelector('[data-order-id="55555555-5555-4555-8555-555555555555"] [data-price]')
      ?.getAttribute("data-price-cents-per-btc")).toBe("9007199254740993");
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
