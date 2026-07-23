import { OrderApi } from "../src/api/order-api.js";
import { MakerIdentity } from "../src/nostr/identity.js";
import { PUBLIC_RELAYS, RelayClient, type RelayReadback } from "../src/nostr/relay.js";
import { NostrOrderService } from "../src/order/service.js";
import { OrderOutboxRepository } from "../src/storage/order-outbox.js";
import { MemoryStorageDriver } from "../src/storage/wallet-repository.js";

interface SeedOrder {
  label: string;
  side: "buy" | "sell";
  amount: string;
  priceCentsPerBtc: string;
  usdPerBtc: string;
}

const seeds: SeedOrder[] = [
  { label: "ask-50500", side: "sell", amount: "2000", priceCentsPerBtc: "5050000", usdPerBtc: "50500.00" },
  { label: "ask-51000", side: "sell", amount: "1000", priceCentsPerBtc: "5100000", usdPerBtc: "51000.00" },
  { label: "ask-52000", side: "sell", amount: "1000", priceCentsPerBtc: "5200000", usdPerBtc: "52000.00" },
  { label: "bid-49500", side: "buy", amount: "2000", priceCentsPerBtc: "4950000", usdPerBtc: "49500.00" },
  { label: "bid-49000", side: "buy", amount: "1000", priceCentsPerBtc: "4900000", usdPerBtc: "49000.00" },
  { label: "bid-48000", side: "buy", amount: "1000", priceCentsPerBtc: "4800000", usdPerBtc: "48000.00" }
];

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function confirmedReadback(
  client: RelayClient,
  event: Parameters<RelayClient["readback"]>[0]
): Promise<RelayReadback[]> {
  let result: RelayReadback[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(750 * (attempt + 1));
    result = await client.readback(event);
    if (result.some((receipt) => receipt.found)) return result;
  }
  throw new Error(`Event ${event.id} did not read back from a configured relay`);
}

const relayClient = new RelayClient({ maxWait: 8_000 });
const startedAt = new Date().toISOString();
const publications = [];

try {
  for (const seed of seeds) {
    const driver = new MemoryStorageDriver();
    const identity = new MakerIdentity(driver);
    const service = new NostrOrderService(identity, relayClient);
    const api = new OrderApi(
      identity,
      service,
      undefined,
      () => crypto.randomUUID(),
      new OrderOutboxRepository(driver)
    );
    const result = await api.publishOrder({
      side: seed.side,
      amount: seed.amount,
      priceCentsPerBtc: seed.priceCentsPerBtc,
      execution: "all_or_none"
    });
    const projectionReadback = await confirmedReadback(relayClient, servicePublicationEvent(
      result.projectionId,
      result.makerPubkey,
      30078
    ));
    publications.push({
      ...seed,
      orderId: result.orderId,
      makerPubkey: result.makerPubkey,
      projectionId: result.projectionId,
      revision: result.revision,
      receipts: result.receipts,
      projectionReadback
    });
  }
} finally {
  relayClient.dispose();
}

console.log(JSON.stringify({
  schema: "granola/order-publication-trace/v1",
  startedAt,
  completedAt: new Date().toISOString(),
  relays: PUBLIC_RELAYS,
  acknowledgementsRequired: 1,
  publications
}, null, 2));

function servicePublicationEvent(id: string, pubkey: string, kind: number) {
  return { id, pubkey, kind };
}
