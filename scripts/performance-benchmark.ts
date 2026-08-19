import {
  buildOrderBook,
  createOrderState,
  eligibleMarketIds,
  marketId,
  type ExactMarket,
  type OrderRecord
} from "../src/order/model.js";

const market: ExactMarket = {
  baseUnit: "sat",
  baseMint: "https://testnut.cashu.space",
  quoteUnit: "usd",
  quoteMint: "https://quote-1.test"
};
const acceptableMints = Array.from(
  { length: 8 },
  (_, index) => `https://quote-${index + 1}.test`
);
const now = 1_700_000_100;

function records(count: number): OrderRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const orderId = `${String(index + 1).padStart(8, "0")}-1111-4${index % 10}11-8111-111111111111`;
    return {
      address: `address-${index}`,
      eventId: `event-${index}`,
      makerPubkey: `maker-${index}`,
      verified: true,
      state: createOrderState({
        orderId,
        createdAt: 1_700_000_000,
        expiresAt: 1_800_000_000,
        side: index % 2 === 0 ? "sell" : "buy",
        baseUnit: "sat",
        quoteUnit: "usd",
        offered: index % 2 === 0
          ? { unit: "sat", mint: market.baseMint }
          : { unit: "usd", mint: market.quoteMint },
        requested: index % 2 === 0
          ? { unit: "usd", acceptableMints }
          : { unit: "sat", acceptableMints: [market.baseMint] },
        amount: "2000",
        priceCentsPerBtc: String(4_000_000 + index)
      })
    };
  });
}

async function referenceOrderBook(
  records: OrderRecord[],
  market: ExactMarket,
  now: number
): Promise<{ asks: OrderRecord[]; bids: OrderRecord[] }> {
  const selectedMarketId = await marketId(market);
  const eligible: OrderRecord[] = [];
  for (const record of records) {
    if (!record.verified) continue;
    if (["filled", "canceled", "expired"].includes(record.state.status)) continue;
    if (now >= record.state.expires_at) continue;
    const remaining = BigInt(record.state.remaining_amount);
    const available = record.state.reservation && now < record.state.reservation.expires_at
      ? remaining - BigInt(record.state.reserved_amount)
      : remaining;
    if (available <= 0n) continue;
    if (!(await eligibleMarketIds(record.state)).includes(selectedMarketId)) continue;
    eligible.push(record);
  }
  const comparePrice = (left: OrderRecord, right: OrderRecord): number =>
    BigInt(left.state.price_cents_per_btc) < BigInt(right.state.price_cents_per_btc)
      ? -1
      : BigInt(left.state.price_cents_per_btc) > BigInt(right.state.price_cents_per_btc)
        ? 1
        : 0;
  const tie = (left: OrderRecord, right: OrderRecord): number =>
    left.address.localeCompare(right.address);
  return {
    asks: eligible
      .filter(({ state }) => state.side === "sell")
      .sort((left, right) => comparePrice(left, right) || tie(left, right)),
    bids: eligible
      .filter(({ state }) => state.side === "buy")
      .sort((left, right) => -comparePrice(left, right) || tie(left, right))
  };
}

function sameOrders(left: OrderRecord[], right: OrderRecord[]): boolean {
  return left.map(({ address }) => address).join("\n") ===
    right.map(({ address }) => address).join("\n");
}

async function medianMs(
  action: () => Promise<{ asks: OrderRecord[]; bids: OrderRecord[] }>
): Promise<{ median: number; samples: number[] }> {
  await action();
  const samples: number[] = [];
  for (let index = 0; index < 9; index += 1) {
    const started = globalThis.performance.now();
    await action();
    if (index >= 2) samples.push(globalThis.performance.now() - started);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    samples
  };
}

const fixture = records(1_000);
const reference = await referenceOrderBook(fixture, market, now);
const optimized = await buildOrderBook(fixture, market, now);
if (
  optimized.asks.length + optimized.bids.length !== fixture.length ||
  !sameOrders(reference.asks, optimized.asks) ||
  !sameOrders(reference.bids, optimized.bids)
) throw new Error("Optimized order book differs from the reference implementation");
const before = await medianMs(() => referenceOrderBook(fixture, market, now));
const after = await medianMs(async () => {
  const book = await buildOrderBook(fixture, market, now);
  return { asks: book.asks, bids: book.bids };
});
console.log(JSON.stringify({
  benchmark: "buildOrderBook",
  records: fixture.length,
  acceptableMints: acceptableMints.length,
  before: {
    samplesMs: before.samples.map((sample) => Number(sample.toFixed(2))),
    medianMs: Number(before.median.toFixed(2))
  },
  after: {
    samplesMs: after.samples.map((sample) => Number(sample.toFixed(2))),
    medianMs: Number(after.median.toFixed(2))
  },
  speedup: Number((before.median / after.median).toFixed(1))
}));
