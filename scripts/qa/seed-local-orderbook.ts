// Seeds a local QA relay set with sanitized, production-scale order-book data.
//
// Every key is generated here and discarded; no real identity, proof, or
// preimage is involved. Relays are addressed by their production URLs and
// rewritten to local ports, so the events are byte-identical to what the app
// would publish in production.
//
//   QA_RELAY_MAP='wss://nos.lol=ws://127.0.0.1:7001,...' tsx scripts/qa/seed-local-orderbook.ts
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";

import { OrderApi, TEST_MARKET } from "../../src/api/order-api.js";
import { MakerIdentity } from "../../src/nostr/identity.js";
import { RelayClient, type RelayPoolPort } from "../../src/nostr/relay.js";
import { NostrOrderService } from "../../src/order/service.js";
import { marketId } from "../../src/order/model.js";
import { OrderOutboxRepository } from "../../src/storage/order-outbox.js";
import { MemoryStorageDriver } from "../../src/storage/wallet-repository.js";
import type { NostrEvent } from "../../src/order/events.js";

const nodeProcess = (globalThis as unknown as {
  process: {
    env: Record<string, string | undefined>;
    exit(code: number): never;
    stderr: { write(text: string): void };
  };
}).process;

const RELAYS = ["wss://nos.lol", "wss://relay.primal.net", "wss://offchain.pub"];
const INBOX_RELAY = "wss://auth.nostr1.com";
const map = new Map(
  (nodeProcess.env.QA_RELAY_MAP ?? "").split(",").filter(Boolean).map((pair: string): [string, string] => {
    const [from, to] = pair.split("=");
    return [from!, to!];
  })
);
if (map.size === 0) throw new Error("QA_RELAY_MAP is required so seeding never reaches public relays");
for (const relay of RELAYS) {
  const target = map.get(relay);
  if (!target || !/^ws:\/\/127\.0\.0\.1:\d+$/.test(target)) {
    throw new Error(`Refusing to seed ${relay}: it must map to a ws://127.0.0.1 port`);
  }
}

const OPEN = Number(nodeProcess.env.QA_OPEN_ORDERS ?? 1200);
const CANCELED = Number(nodeProcess.env.QA_CANCELED_ORDERS ?? 400);
const MAKERS = Number(nodeProcess.env.QA_MAKERS ?? 300);
const DAY = 86_400;
const nowSeconds = Math.floor(Date.now() / 1000);

class LocalPool implements RelayPoolPort {
  private readonly pool = new SimplePool({ enableReconnect: false });
  private target(url: string): string {
    const mapped = map.get(url.replace(/\/$/, ""));
    if (!mapped) throw new Error(`Unmapped relay ${url}`);
    return mapped;
  }
  ensureRelay(url: string, options?: { connectionTimeout?: number }) {
    return this.pool.ensureRelay(this.target(url), options);
  }
  querySync(relays: string[], filter: Record<string, unknown>, options: { maxWait: number }) {
    return this.pool.querySync(
      relays.map((r) => this.target(r)),
      filter as Parameters<SimplePool["querySync"]>[1],
      options
    ) as Promise<NostrEvent[]>;
  }
  destroy() {
    this.pool.destroy();
  }
}

let seed = 0x5eed;
function random(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

const relayClient = new RelayClient({ relays: RELAYS, pool: new LocalPool(), maxWait: 4_000 });
const makers = Array.from({ length: MAKERS }, () => {
  const driver = new MemoryStorageDriver();
  return { driver, identity: new MakerIdentity(driver) };
});

const sizes = ["100", "250", "500", "1000", "2000", "5000", "10000", "25000", "50000"];
const summary = { open: 0, canceled: 0, oldBestAsk: "", oldBestBid: "", invalid: 0, failures: 0 };

async function publish(index: number, options: {
  side: "buy" | "sell";
  priceCentsPerBtc: string;
  amount: string;
  ageSeconds: number;
  lifetimeDays: number;
  cancel?: boolean;
}) {
  const maker = makers[index % makers.length]!;
  const createdAt = nowSeconds - options.ageSeconds;
  const api = new OrderApi(
    maker.identity,
    new NostrOrderService(maker.identity, relayClient, undefined, [INBOX_RELAY]),
    () => createdAt,
    () => crypto.randomUUID(),
    new OrderOutboxRepository(maker.driver)
  );
  const result = await api.publishOrder({
    side: options.side,
    amount: options.amount,
    priceCentsPerBtc: options.priceCentsPerBtc,
    expiresAt: createdAt + options.lifetimeDays * DAY,
    execution: "all_or_none"
  });
  if (!result.receipts.some((receipt) => receipt.ok)) throw new Error("no relay acknowledged");
  if (options.cancel) {
    await api.cancelOrder({
      address: `30078:${result.makerPubkey}:granola:order:v1:${result.orderId}`,
      expectedProjectionId: result.projectionId,
      expectedRevision: result.revision
    });
  }
  return result;
}

async function inBatches<T>(count: number, size: number, task: (index: number) => Promise<T>) {
  for (let start = 0; start < count; start += size) {
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(size, count - start) }, (_, offset) => task(start + offset))
    );
    for (const result of results) {
      if (result.status === "rejected") {
        summary.failures += 1;
        if (summary.failures <= 5) console.error(String(result.reason));
      }
    }
    nodeProcess.stderr.write(`\r${Math.min(start + size, count)}/${count}`);
  }
  nodeProcess.stderr.write("\n");
}

// The best ask and best bid are the OLDEST open orders. A book that only reads
// the newest N projections hides them.
const oldBestAsk = await publish(0, {
  side: "sell", priceCentsPerBtc: "4950000", amount: "100", ageSeconds: 25 * DAY, lifetimeDays: 30
});
const oldBestBid = await publish(1, {
  side: "buy", priceCentsPerBtc: "4920000", amount: "100", ageSeconds: 25 * DAY - 60, lifetimeDays: 30
});
summary.oldBestAsk = oldBestAsk.orderId;
summary.oldBestBid = oldBestBid.orderId;

await inBatches(OPEN, 25, async (index) => {
  const side = index % 2 === 0 ? "sell" : "buy";
  // Asks 50,000–55,000 USD/BTC, bids 45,500–48,999 USD/BTC, whole cents.
  const cents = side === "sell"
    ? 5_000_000 + Math.floor(random() * 500_000)
    : 4_550_000 + Math.floor(random() * 350_000);
  await publish(index + 2, {
    side,
    priceCentsPerBtc: String(cents),
    amount: pick(sizes),
    ageSeconds: Math.floor(random() * 24 * DAY),
    lifetimeDays: 30
  });
  summary.open += 1;
});

await inBatches(CANCELED, 25, async (index) => {
  await publish(index + 7, {
    side: index % 2 === 0 ? "sell" : "buy",
    priceCentsPerBtc: String(4_900_000 + Math.floor(random() * 200_000)),
    amount: pick(sizes),
    ageSeconds: Math.floor(random() * 3 * DAY),
    lifetimeDays: 30,
    cancel: true
  });
  summary.canceled += 1;
});

// Hostile or malformed public data that the book must reject without breaking.
const market = await marketId(TEST_MARKET);
const pool = new SimplePool({ enableReconnect: false });
const targets = RELAYS.map((relay) => map.get(relay)!);
const hostile: Array<{ content: string; tags: string[][] }> = [
  { content: "not json", tags: [] },
  { content: "{}", tags: [] },
  { content: JSON.stringify({ protocol: "granola/order/v1", amount: "-5" }), tags: [] },
  { content: "x".repeat(60_000), tags: [] },
  { content: JSON.stringify({ html: "<img src=x onerror=alert(1)>" }), tags: [] }
];
for (const [index, item] of hostile.entries()) {
  const secret = generateSecretKey();
  const event = finalizeEvent({
    kind: 30078,
    created_at: nowSeconds - index,
    tags: [
      ["d", `granola:order:v1:${crypto.randomUUID()}`],
      ["t", "granola-order"],
      ["m", market],
      ...item.tags
    ],
    content: item.content
  }, secret);
  await Promise.allSettled(pool.publish(targets, event));
  summary.invalid += 1;
}
pool.destroy();
relayClient.dispose();

console.log(JSON.stringify({ market, ...summary }, null, 2));
nodeProcess.exit(0);
