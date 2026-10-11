// Real Testnut swaps only. Never enable HAR, tracing, screenshots or raw-frame logging.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/profile-live-trades.mjs
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { verifyEvent } from "nostr-tools/pure";
import { intervalUnion as union, settlementLegForSlot } from "./lib/live-profile.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.env.GRANOLA_PROFILE_URL ?? "http://127.0.0.1:5183/";
const compareOrigin = process.env.GRANOLA_PROFILE_COMPARE_URL;
const runs = Number(process.env.GRANOLA_PROFILE_RUNS ?? 1);
const output = process.env.GRANOLA_PROFILE_OUTPUT ?? "/private/tmp/granola-live-profile.json";
assert.ok(Number.isSafeInteger(runs) && runs > 0 && runs <= 20);
const mints = [process.env.GRANOLA_PROFILE_BASE_MINT ?? "https://testnut.cashu.space", process.env.GRANOLA_PROFILE_QUOTE_MINT ?? "https://testnut.cashudevkit.org"];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const report = { version: 1, createdAt: new Date().toISOString(), origin, mints, requestedRuns: runs, runs: [] };
const variants = compareOrigin ? [{ name: "baseline", origin }, { name: "candidate", origin: compareOrigin }]
  : [{ name: "single", origin }];
report.variants = variants;
report.browserVersion = browser.version();
let stage = "startup";
let pages = [];
let crashedPages = 0;

function observe(page) {
  page.on("crash", () => { crashedPages += 1; });
  const spans = [], publicEvents = new Map();
  const signatures = { checked: 0, invalid: 0 };
  page.on("websocket", socket => {
    const relay = new URL(socket.url()).origin;
    const pending = new Map();
    socket.on("framesent", ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (!Array.isArray(frame)) return;
        if (frame[0] === "REQ") {
          pending.set(frame[1], { start: Date.now(), operation: `query_${frame[2]?.kinds?.[0] ?? "other"}` });
        } else if (frame[0] === "CLOSE") {
          const started = pending.get(frame[1]);
          if (started) {
            pending.delete(frame[1]);
            spans.push({ ...started, end: Date.now(), relay, outcome: "client-close" });
          }
        } else if (["EVENT", "AUTH"].includes(frame[0])) {
          const event = frame[1];
          signatures.checked += 1;
          if (!verifyEvent(event)) { signatures.invalid += 1; return; }
          pending.set(event.id, { start: Date.now(), operation: `${frame[0].toLowerCase()}_${event.kind}` });
          // Record only public order IDs after checking the actual outgoing signature.
          if (event.kind === 30078) {
            assert.ok(verifyEvent(event));
            publicEvents.set(`${relay}|${event.id}`, { eventId: event.id, signer: event.pubkey, relay,
              signatureVerified: true, startedAt: Date.now() });
          }
        }
      } catch { /* Do not copy untrusted payloads or exceptions into output. */ }
    });
    socket.on("framereceived", ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (!Array.isArray(frame)) return;
        if (["EOSE", "OK", "CLOSED"].includes(frame[0])) {
          const started = pending.get(frame[1]);
          if (!started) return;
          pending.delete(frame[1]);
          spans.push({ ...started, end: Date.now(), relay, outcome: frame[0] === "OK" ? (frame[2] ? "ack" : "rejected") : frame[0].toLowerCase() });
          const publicEvent = publicEvents.get(`${relay}|${frame[1]}`);
          if (frame[0] === "OK" && publicEvent) {
            publicEvent.acknowledged = frame[2] === true;
            publicEvent.acknowledgedAt = Date.now();
          }
        }
      } catch { /* Only sanitized operation/timing evidence is retained. */ }
    });
    socket.on("close", () => {
      for (const started of pending.values()) spans.push({ ...started, end: Date.now(), relay, outcome: "socket-close" });
      pending.clear();
    });
  });
  return { spans, publicEvents, signatures };
}

async function ready(page) {
  await page.waitForFunction(() => typeof window.granola?.getState === "function");
}
async function poll(check, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Profile condition timed out");
}
async function state(page) {
  return page.evaluate(async () => (await window.granola.getState()).wallet);
}
function amount(wallet, unit) {
  return BigInt(wallet.balances.find(balance => balance.unit === unit)?.amount ?? "0");
}
async function timeline(page) {
  return page.evaluate(() => JSON.parse(document.querySelector("#granola-performance").textContent));
}
try {
  const context = await browser.newContext();
  const suffix = Date.now().toString(36);
  const profiles = [];
  for (const variant of variants) {
    pages = await Promise.all([context.newPage(), context.newPage()]);
    const observations = pages.map(observe);
    for (let i = 0; i < pages.length; i++) {
      await pages[i].goto(`${variant.origin}?wallet=profile-${suffix}-${variant.name}-${i}&debug=performance`);
      await ready(pages[i]);
    }
    variant.csp = await pages[0].locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    variant.assets = await pages[0].evaluate(() => [...document.scripts].filter(s => s.src).map(s => new URL(s.src).pathname));
    stage = "mint-capabilities";
    report.capabilities = await pages[0].evaluate(async mints => {
      return Promise.all(mints.map(async mint => {
        const info = await (await fetch(`${mint}/v1/info`)).json();
        return { mint, version: info.version, nut07: info.nuts["7"]?.supported === true,
          nut14: info.nuts["14"]?.supported === true, nut17: Boolean(info.nuts["17"]) };
      }));
    }, mints);
    assert.ok(report.capabilities.every(mint => mint.nut07 && mint.nut14));
    stage = "funding";
    // Fund both units so the same isolated pair exercises maker buy and sell.
    for (const page of pages) for (const unit of ["sat", "usd"]) {
      await page.locator(`[data-mint-unit="${unit}"]`).click();
      await poll(() => page.evaluate(async unit => {
        const wallet = (await window.granola.getState()).wallet;
        return wallet.balances.some(b => b.unit === unit && BigInt(b.amount) >= 10000n);
      }, unit));
      console.log(JSON.stringify({ stage: "funded", variant: variant.name, wallet: pages.indexOf(page), unit }));
    }
    profiles.push({ ...variant, pages, observations });
  }
  for (let run = 0; run < runs; run++) {
    // AB, BA, AB, BA: matched directions and wallet histories, no overlapping swaps.
    for (const profile of run % 2 === 0 ? profiles : [...profiles].reverse()) {
      pages = profile.pages;
      const { observations } = profile;
      const side = run % 2 === 0 ? "sell" : "buy";
      stage = `run-${run + 1}-prepare`;
      await Promise.all(pages.map(async page => { await page.reload(); await ready(page); }));
      // The same fixed warmup is outside every measurement window.
      await pages[0].waitForTimeout(5_000);
      const before = await Promise.all(pages.map(state));
      const previousSessions = await Promise.all(pages.map(page => page.evaluate(async () =>
        (await window.granola.listTrades()).map(trade => trade.sessionId))));
      const [maker, taker] = pages;
      const existing = await maker.evaluate(() => window.granola.getMakerPublicKeys());
      stage = `run-${run + 1}-post-order`;
      await maker.locator('[name="side"]').selectOption(side);
      await maker.locator('[name="amount"]').fill("20");
      await maker.locator('[name="fiatPrice"]').fill("50000.00");
      await maker.locator('[name="days"]').fill("1");
      await maker.locator('#order-form button[type="submit"]').click();
      await poll(() => maker.evaluate(async old => {
        return (await window.granola.getMakerPublicKeys()).some(key => !old.includes(key)) &&
          (await window.granola.getPendingOrderPublications()).length === 0;
      }, existing), 90_000);
      const keys = await maker.evaluate(() => window.granola.getMakerPublicKeys());
      const orderKey = keys.find(key => !existing.includes(key));
      stage = `run-${run + 1}-maker-listener`;
      await maker.evaluate(() => window.granola.enableMaker());
      stage = `run-${run + 1}-find-order`;
      const order = await taker.evaluate(async key => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const { book } = await window.granola.getOrderBook();
          const order = [...book.asks, ...book.bids].find(order => order.makerPubkey === key);
          if (order) return order;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }, orderKey);
      if (!order) {
        report.discoveryFailure = { orderKey,
          publicEvents: observations.flatMap(o => [...o.publicEvents.values()]).filter(e => e.signer === orderKey),
          books: await Promise.all(pages.map(page => page.evaluate(async () => {
            const { book, rejected } = await window.granola.getOrderBook();
            return { market: book.market, asks: book.asks.length, bids: book.bids.length, rejectedCount: rejected.length };
          }))) };
      }
      assert.ok(order, "Published test order absent from validated book");
      stage = `run-${run + 1}-refresh-book`;
      await taker.locator('#refresh-orderbook').click();
      const row = taker.locator(`[data-order-id="${order.state.order_id}"]`);
      await row.locator('[data-take-order]').waitFor();
      stage = `run-${run + 1}-settle`;
      await row.locator('[data-take-order]').click();
      // Observe existing UI state; do not add repository reads or wake announcements during settlement.
      await Promise.all(pages.map((page, wallet) => page.waitForFunction(old => {
        if (document.querySelector('[data-granola-run-status="error"]')) return true;
        return [...document.querySelectorAll('.trade-card')].some(card =>
          !old.includes(card.dataset.tradeSession) && card.querySelector('h3')?.textContent === "Filled");
      }, previousSessions[wallet], { timeout: 120_000 })));
      const trades = await Promise.all(pages.map(page => page.evaluate(async address => {
        const trade = (await window.granola.listTrades()).find(trade => trade.orderAddress === address);
        // Full private IDs and transcript are deliberately excluded from persisted evidence.
        return { phase: trade.phase, role: trade.role, sessionId: trade.sessionId,
          messages: trade.protocol.messages.map(message => ({ type: message.type })), terms: trade.terms,
          legs: Object.fromEntries(Object.entries(trade.evidence.legs).map(([leg, evidence]) =>
            [leg, { keysetId: evidence.keysetId, mintState: evidence.mintState, proofCount: evidence.proofCount }])) };
      }, order.address)));
      assert.ok(trades.every(t => t.phase === "filled"));
      assert.equal(trades[0].sessionId, trades[1].sessionId);
      for (const trade of trades) assert.deepEqual(trade.messages.map(m => m.type), ["reserve_propose", "reserve_accept", "quote_lock"]);
      for (const trade of trades) {
        assert.equal(trade.terms.baseMint, mints[0]);
        assert.equal(trade.terms.quoteMint, mints[1]);
        assert.equal(trade.legs.base.mintState, "SPENT");
        assert.equal(trade.legs.quote.mintState, "SPENT");
        assert.notEqual(trade.terms.baseKeyset, trade.terms.quoteKeyset);
      }
      const timelines = await Promise.all(pages.map(timeline));
      const entries = timelines.flatMap((t, wallet) => t.entries.map(entry => ({ ...entry, wallet,
        absoluteStart: t.timeOrigin + entry.startTime })));
      const click = entries.find(entry => entry.name === "granola:take-order-click" && entry.wallet === 1);
      const filled = [0, 1].map(wallet => entries.find(entry => entry.name === "granola:trade-filled" &&
        entry.wallet === wallet && entry.detail.sessionId === trades[0].sessionId));
      assert.ok(click && filled.every(Boolean), "Both Filled marks and click required");
      const start = click.absoluteStart, end = Math.max(...filled.map(entry => entry.absoluteStart));
      const windowEntries = entries.filter(entry => entry.absoluteStart + entry.duration >= start && entry.absoluteStart <= end)
        .map(({ absoluteStart, detail, ...entry }) => ({ ...entry, startTime: absoluteStart - start,
          detail: Object.fromEntries(Object.entries(detail).filter(([key]) => key !== "sessionId")) }));
      const relay = observations.flatMap((o, wallet) => o.spans.filter(span => span.end >= start && span.start <= end)
        .map(span => ({ ...span, wallet, start: span.start - start, end: span.end - start })));
      const subscriptions = windowEntries.filter(e => e.name === "granola:proof-wait").map(wait => {
        const action = windowEntries.find(e => e.name === "granola:coordinator-action" && e.wallet === wait.wallet &&
          e.detail.action.startsWith("observe_") && wait.startTime >= e.startTime - 1 &&
          wait.startTime + wait.duration <= e.startTime + e.duration + 1);
        assert.ok(action, "Subscription must be attributable to its settlement leg");
        const slot = action.detail.action === "observe_base" ? "base" : "quote";
        const leg = settlementLegForSlot(side, slot);
        return { mint: trades[0].terms[`${leg}Mint`], unit: trades[0].terms[`${leg}Unit`],
          duration: wait.duration, ...wait.detail };
      });
      const mintIntervals = entries.filter(e => e.name === "granola:network" && mints.includes(e.detail.origin))
        .map(e => [e.absoluteStart, e.absoluteStart + e.duration]);
      const after = await Promise.all(pages.map(state));
      assert.ok(observations.every(o => o.signatures.invalid === 0), "Every outgoing event must have a valid signature");
      // Financial completion does not wait for background announcements. Check
      // their real relay acknowledgements outside the click-to-Filled window.
      await poll(() => {
        const events = observations.flatMap(o => [...o.publicEvents.values()]).filter(e => e.signer === orderKey);
        return events.length > 0 && [...new Set(events.map(e => e.eventId))].every(id =>
          events.some(e => e.eventId === id && e.acknowledged));
      }, 30_000);
      await poll(async () => (await maker.evaluate(() => window.granola.getPendingOrderPublications())).length === 0, 30_000);
      const publicEvents = observations.flatMap(o => [...o.publicEvents.values()]).filter(e => e.signer === orderKey);
      assert.ok(publicEvents.length > 0 && publicEvents.every(e => e.signatureVerified));
      for (const id of new Set(publicEvents.map(e => e.eventId))) {
        assert.ok(publicEvents.some(e => e.eventId === id && e.acknowledged), "Public event needs relay acknowledgement");
      }
      const satSeller = side === "sell" ? 0 : 1, satBuyer = 1 - satSeller;
      assert.equal(amount(after[satBuyer], "sat") - amount(before[satBuyer], "sat"), 20n);
      assert.equal(amount(after[satSeller], "usd") - amount(before[satSeller], "usd"), 1n);
      assert.ok(amount(before[satBuyer], "usd") - amount(after[satBuyer], "usd") >= 1n);
      assert.ok(amount(before[satSeller], "sat") - amount(after[satSeller], "sat") >= 20n);
      stage = `run-${run + 1}-reload`;
      await Promise.all(pages.map(async page => { await page.reload(); await ready(page); }));
      const reloaded = await Promise.all(pages.map(state));
      assert.deepEqual(reloaded.map(w => w.balances), after.map(w => w.balances));
      for (const page of pages) assert.equal(await page.evaluate(async address => {
        return (await window.granola.listTrades()).find(t => t.orderAddress === address)?.phase;
      }, order.address), "filled");
      await poll(() => taker.evaluate(async address => {
        const { book } = await window.granola.getOrderBook();
        return ![...book.asks, ...book.bids].some(order => order.address === address);
      }, order.address), 30_000);
      const evidence = { variant: profile.name, run: run + 1, side, totalMs: end - start,
        mintHttpUnionMs: union(mintIntervals, start, end),
        relayResponseUnionMs: union(relay.filter(s => ["ack", "rejected", "eose", "closed"].includes(s.outcome))
          .map(s => [s.start + start, s.end + start]), start, end),
        before, after, reloadValidated: true, terms: trades[0].terms, legs: trades.map(t => t.legs),
        messages: trades[0].messages.map(m => m.type), subscriptions, entries: windowEntries, relay,
        publicEvents, filledOrderAbsent: true, backgroundPublicationsDrained: true,
        outgoingSignatures: observations.map(o => ({ ...o.signatures })),
        privateAcknowledgements: relay.filter(s => s.operation === "event_1059").map(s => ({ relay: s.relay,
          wallet: s.wallet, outcome: s.outcome, durationMs: s.end - s.start })) };
      report.runs.push(evidence);
      await writeFile(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ variant: profile.name, run: run + 1, side, totalMs: evidence.totalMs,
        mintHttpUnionMs: evidence.mintHttpUnionMs, relayResponseUnionMs: evidence.relayResponseUnionMs,
        proofWaits: windowEntries.filter(e => e.name === "granola:proof-wait").map(e => ({ duration: e.duration, ...e.detail })),
        reloadValidated: true }));
    }
  }
  if (process.env.GRANOLA_PROFILE_REQUIRE_WEBSOCKETS === "1") {
    for (const variant of variants) for (const mint of new Set(mints)) {
      assert.ok(report.runs.filter(r => r.variant === variant.name).some(r =>
        r.subscriptions.some(s => s.mint === mint && s.outcome === "spent" && s.updates >= s.proofCount)),
      "Every mint must deliver a real spent subscription notification under CSP");
    }
  }
  report.completedAt = new Date().toISOString();
  report.validations = { distinctMints: new Set(mints).size === 2,
    websocketNotificationsRequired: process.env.GRANOLA_PROFILE_REQUIRE_WEBSOCKETS === "1",
    exactThreeMessages: true, bothLegsSpent: true, balanceDeltas: true,
    reloadPersistence: true, publicSignaturesAndAcknowledgements: true, filledOrderAbsent: true };
  await writeFile(output, JSON.stringify(report, null, 2));
} catch (error) {
  report.failure = { stage, errorClass: error.name,
    runnerLine: /profile-live-trades\.mjs:(\d+)/.exec(error.stack ?? "")?.[1],
    reason: [
      ["page_crashed", /page crashed|target crashed/i],
      ["target_closed", /target.*closed|page.*closed|browser.*closed/i],
      ["context_destroyed", /execution context.*destroyed/i],
      ["timeout", /timeout/i],
      ["assertion", /assertion/i]
    ].find(([, pattern]) => pattern.test(error.message ?? ""))?.[0] ?? "unclassified",
    browserConnected: browser.isConnected(), crashedPages, closedPages: pages.filter(page => page.isClosed()).length };
  report.failure.wallets = await Promise.all(pages.map(page => page.evaluate(async () => {
    const trades = await window.granola?.listTrades();
    const error = document.querySelector('[data-granola-run-error]')?.dataset.granolaRunError ??
      document.querySelector('#status')?.textContent ?? "";
    const codes = ["spent-witness", "proof-not-spent", "proof-state", "nut07", "nut14", "keyset", "token-commitment", "hash", "Failed to fetch"];
    return { trades: trades?.map(t => ({ phase: t.phase, role: t.role,
      legs: Object.fromEntries(Object.entries(t.evidence.legs).map(([leg, e]) => [leg, e.mintState])) })),
      errorCodes: codes.filter(code => error.includes(code)) };
  }).catch(() => ({ unavailable: true }))));
  // No browser error strings, invoice URLs or payloads.
  await writeFile(output, JSON.stringify(report, null, 2));
  console.error(JSON.stringify({ failed: true, stage, output }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
