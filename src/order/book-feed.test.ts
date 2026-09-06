import { expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { SubscribeManyParams } from "nostr-tools/abstract-pool";
import { createProjectionTemplate } from "./events.js";
import { createOrderState, cancelOrder, type OrderBook } from "./model.js";
import { watchOrderBook } from "./book-feed.js";

it("updates a live book, retains cancellation against older events and closes", async () => {
  const key = generateSecretKey();
  const market = { baseUnit: "sat", quoteUnit: "usd", baseMint: "https://mint.example", quoteMint: "https://quote.example" };
  const state = createOrderState({
    orderId: crypto.randomUUID(), createdAt: 1_700_000_000, expiresAt: 1_700_003_600,
    side: "sell", baseUnit: "sat", quoteUnit: "usd",
    offered: { unit: "sat", mint: market.baseMint },
    requested: { unit: "usd", acceptableMints: [market.quoteMint] },
    amount: "100", priceCentsPerBtc: "200000000"
  });
  const open = finalizeEvent(await createProjectionTemplate(state, getPublicKey(key)), key);
  const another = finalizeEvent(await createProjectionTemplate({ ...state, order_id: crypto.randomUUID() }, getPublicKey(key)), key);
  const canceled = finalizeEvent(await createProjectionTemplate(cancelOrder({ ...state, revision: "1" }), getPublicKey(key), state.created_at + 1), key);
  const delayedOpen = finalizeEvent(await createProjectionTemplate({ ...state, revision: "1" }, getPublicKey(key), state.created_at + 2), key);
  key.fill(0);
  let callbacks!: SubscribeManyParams;
  const close = vi.fn();
  const books: OrderBook[] = [];
  const error = vi.fn();
  let now = state.created_at + 2;
  const feed = await watchOrderBook({ subscribeProjections: (_market, handlers) => {
    callbacks = handlers;
    return { close };
  } }, market, (book) => books.push(book), error, () => now);
  try {
    callbacks.onevent!(open);
    await vi.waitFor(() => expect(books.at(-1)?.asks).toHaveLength(1));
    callbacks.oneose!();
    callbacks.onevent!({ ...canceled, content: "tampered" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(books.at(-1)?.asks).toHaveLength(1);
    callbacks.onevent!(canceled);
    await vi.waitFor(() => expect(books.at(-1)?.asks).toHaveLength(0));
    callbacks.onevent!(open);
    callbacks.onevent!(delayedOpen);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(books.at(-1)?.asks).toHaveLength(0);
    callbacks.onevent!(another);
    await vi.waitFor(() => expect(books.at(-1)?.asks).toHaveLength(1));
    now = state.expires_at;
    callbacks.oneose!();
    await vi.waitFor(() => expect(books.at(-1)?.asks).toHaveLength(0));
  } finally { feed.close(); }
  expect(close).toHaveBeenCalledOnce();
  const count = books.length;
  callbacks.onevent!(open);
  await Promise.resolve();
  expect(books).toHaveLength(count);
  expect(error).not.toHaveBeenCalled();
});
