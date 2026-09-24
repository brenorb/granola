// Run against a production preview: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npx tsx scripts/check-orderbook-reconnect.mjs
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { TEST_MARKET } from "../src/api/order-api.js";
import { createProjectionTemplate } from "../src/order/events.js";
import { cancelOrder, createOrderState } from "../src/order/model.js";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.GRANOLA_CHECK_URL ?? "http://127.0.0.1:5182/";
const key = generateSecretKey();
const now = Math.floor(Date.now() / 1000);
const state = createOrderState({
  orderId: crypto.randomUUID(), createdAt: now, expiresAt: now + 3600,
  side: "sell", baseUnit: "sat", quoteUnit: "usd",
  offered: { unit: "sat", mint: TEST_MARKET.baseMint },
  requested: { unit: "usd", acceptableMints: [TEST_MARKET.quoteMint] },
  amount: "100", priceCentsPerBtc: "200000000"
});
const open = finalizeEvent(await createProjectionTemplate(state, getPublicKey(key)), key);
const canceled = finalizeEvent(await createProjectionTemplate(cancelOrder(state), getPublicKey(key), now + 1), key);
key.fill(0);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext();
  await context.route("**/*", (route) => new URL(route.request().url()).origin === new URL(origin).origin
    ? route.continue() : route.abort());
  let mode = "open", requests = 0;
  const sockets = new Set();
  await context.routeWebSocket(/.*/, (socket) => {
    sockets.add(socket);
    socket.onMessage((message) => {
      const [type, id, filter] = JSON.parse(String(message));
      if (type !== "REQ") return;
      if (filter.kinds?.includes(30078)) {
        requests++;
        if (mode === "offline") { socket.close(); return; }
        socket.send(JSON.stringify(["EVENT", id, mode === "canceled" ? canceled : open]));
      }
      socket.send(JSON.stringify(["EOSE", id]));
    });
  });
  const page = await context.newPage();
  await page.goto(origin + "?wallet=orderbook-reconnect-check");
  const rows = page.locator('#orderbook tr[data-projection-id]');
  await rows.first().waitFor();
  const count = requests;
  // A dropped connection must not replace the snapshot with an error.
  mode = "offline";
  for (const socket of sockets) socket.close();
  async function refresh() {
    await page.getByRole("button", {name:"Refresh orders", exact:true}).click();
    await page.waitForFunction(() => !document.querySelector('#refresh-orderbook').disabled);
  }
  await refresh();
  assert.equal(await rows.count(), 1);
  assert.equal(await page.locator('#orderbook').getAttribute('role'), null);
  // Advance past the removed 60-second feed reset without a real minute wait.
  await page.clock.install();
  const before = requests;
  await page.clock.runFor(61_000);
  assert.equal(requests, before);
  assert.equal(await rows.count(), 1);
  mode = "canceled";
  await refresh();
  assert.equal(await rows.count(), 0);
  mode = "open"; // A delayed pre-cancellation event cannot reopen the order.
  await refresh();
  assert.equal(await rows.count(), 0);
  assert.ok(requests > count);
  console.log(JSON.stringify({ retainedOnDisconnect:true, noMinuteReset:true, cancellationAfterReconnect:true, noStaleReopen:true }));
} finally { await browser.close(); }
