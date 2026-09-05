import { verifyEvent } from "nostr-tools/pure";
import { coalesceRefresh } from "../browser/refresh.js";
import type { RelayClient } from "../nostr/relay.js";
import { parseProjectionEvent, type NostrEvent } from "./events.js";
import { buildOrderBook, marketId, type ExactMarket, type OrderBook, type OrderRecord } from "./model.js";

// Presentation only: trade actions still query and validate the current projection.
export async function watchOrderBook(
  relays: Pick<RelayClient, "subscribeProjections">,
  market: ExactMarket,
  onBook: (book: OrderBook) => void,
  onError: (error: unknown) => void,
  now = () => Math.floor(Date.now() / 1000),
  verify = (event: NostrEvent) => verifyEvent(event)
): Promise<{ close(): void }> {
  const selectedMarket = await marketId(market);
  const latest = new Map<string, { event: NostrEvent; record: OrderRecord }>();
  const pending = new Map<string, NostrEvent>();
  let closed = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let rendered = "";
  const render = coalesceRefresh(async () => {
    while (pending.size && !closed) {
      const [id, event] = pending.entries().next().value!;
      pending.delete(id);
      try {
        const record = await parseProjectionEvent(event, verify);
        const previous = latest.get(record.address);
        if (previous && (previous.event.created_at > event.created_at ||
          (previous.event.created_at === event.created_at && previous.event.id <= event.id))) continue;
        // ponytail: bounded book including tombstones; refresh/backfill replaces the feed.
        if (!previous && latest.size >= 2_000) {
          onError(new Error("Order book capacity reached; refresh to reload"));
          continue;
        }
        latest.set(record.address, { event, record });
      } catch {
        // Untrusted events cannot replace validated projections.
      }
    }
    const book = await buildOrderBook([...latest.values()].map(({ record }) => record), market, now());
    if (closed) return;
    const fingerprint = JSON.stringify(book);
    if (fingerprint !== rendered) {
      rendered = fingerprint;
      onBook(structuredClone(book));
    }
    clearTimeout(expiryTimer);
    const deadlines = [...latest.values()].flatMap(({ record }) => [
      record.state.expires_at, record.state.reservation?.expires_at ?? 0
    ]).filter((deadline) => deadline > now());
    if (deadlines.length) expiryTimer = setTimeout(update,
      Math.min(2_147_483_647, Math.max(1, (Math.min(...deadlines) - now()) * 1000)));
  });
  const update = () => { if (!closed) void render().catch(onError); };
  const subscription = relays.subscribeProjections(selectedMarket, {
    onevent: (event) => {
      if (closed || pending.size >= 2_000) return;
      pending.set(event.id, structuredClone(event));
      update();
    },
    oneose: update,
    onclose: (reasons) => { if (!closed) onError(new Error(`Order book disconnected: ${reasons.join("; ")}`)); }
  });
  return { close: () => {
    closed = true;
    clearTimeout(expiryTimer);
    subscription.close();
    pending.clear();
    latest.clear();
  } };
}
