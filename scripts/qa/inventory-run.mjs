// Full inventory rerun against the production build on the local stack.
// Usage: node inventory-run.mjs <label>
import fs from "node:fs";
import {
  launch, openWallet, shot, act, clearStatus, waitStatus, control,
  recordStatuses, statuses, APP, EVIDENCE, QA_ROOT, REPO
} from "./harness.mjs";

const label = process.argv[2] ?? "run";
const only = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
const results = [];
const browser = await launch();
const funded = /added|Could not reach|error/i;
let n = 0;
const tag = () => `${label}-${Date.now() % 100000}-${n++}`;

async function check(id, name, fn) {
  if (only && !only.has(id)) return;
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ id, name, pass: true, ms: Date.now() - started, detail });
    console.log(`PASS ${id} ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    results.push({ id, name, pass: false, ms: Date.now() - started, detail: String(error?.message ?? error).split("\n")[0] });
    console.log(`FAIL ${id} ${name} — ${String(error?.message ?? error).split("\n")[0]}`);
  } finally {
    await control("/reset");
  }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
const clean = (log) => log.filter((l) => !l.includes("ws://localhost:4870") && !/ERR_CONNECTION_REFUSED/.test(l));

async function fundedWallet(profile, units = ["sat"]) {
  const wallet = await openWallet(browser, profile);
  await wallet.page.waitForTimeout(1200);
  for (const unit of units) {
    const name = unit === "sat" ? "Mint 10,000 satoshis" : "Mint 10,000 USD cents";
    const s = await act(wallet.page, () => wallet.page.getByRole("button", { name }).click(), funded);
    assert(/added/.test(s), `funding ${unit}: ${s}`);
  }
  return wallet;
}
async function postOrder(page, { side = "sell", amount = "100", price = "49990.00", days = "1" } = {}) {
  await page.selectOption("select[name=side]", side);
  await page.fill("input[name=amount]", amount);
  await page.fill("input[name=fiatPrice]", price);
  await page.fill("input[name=days]", days);
  const s = await act(page, () => page.getByRole("button", { name: /Sign & post order/ }).click(), /Order published|not public|error|Insufficient/i);
  await page.waitForTimeout(2000);
  return s;
}
// A real user expands "See more" when the row they want is collapsed.
async function reveal(page, row) {
  if (await row.isVisible()) return;
  const side = await row.evaluate((r) => r.closest(".orderbook-side").className.includes("asks") ? "asks" : "bids");
  const toggle = page.locator(`[data-orderbook-toggle=${side}]`);
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}
const phases = (page) => page.locator("[data-trade-session] .trade-card__heading h3").allInnerTexts();
async function waitPhases(page, pattern, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const p = await phases(page);
    if (p.length && p.every((x) => pattern.test(x))) return p;
    await page.waitForTimeout(1500);
  }
  throw new Error(`phases ${JSON.stringify(await phases(page))} did not match ${pattern}`);
}

// ---------- Routes ----------
await check("R1", "Default route loads under CSP without violations", async () => {
  const { page, context } = await openWallet(browser, "");
  await page.waitForTimeout(5000);
  const csp = page.consoleLog.filter((l) => /Content Security Policy/.test(l));
  assert(csp.length === 0, `CSP violations: ${csp[0]}`);
  const labelText = await page.locator("#profile-label").textContent();
  assert(labelText === "Local browser wallet", labelText);
  const errors = clean(page.consoleLog).filter((l) => /pageerror/.test(l));
  assert(errors.length === 0, errors[0]);
  await context.close();
});
await check("R2", "Invalid ?wallet= shows a visible error", async () => {
  for (const q of ["Maker", "a".repeat(40), "bad%20name"]) {
    const { page, context } = await openWallet(browser, q);
    await page.waitForTimeout(1500);
    const alert = await page.locator("[role=alert]").innerText().catch(() => "");
    assert(/cannot be opened/.test(alert) && /Invalid wallet profile/.test(alert), `no visible error for ${q}`);
    if (q === "Maker") await shot(page, `${label}-R2-invalid-profile`);
    await context.close();
  }
  return "3 invalid names explained";
});
await check("R2b", "Valid ?wallet= opens labeled workspace", async () => {
  const { page, context } = await openWallet(browser, "valid-ws-1");
  await page.waitForTimeout(1500);
  const text = await page.locator("#profile-label").textContent();
  assert(text === "Local wallet workspace: valid-ws-1", text);
  await context.close();
});
await check("R3", "HTTPS redirect script ships as an allowed external file", async () => {
  const html = fs.readFileSync(`${process.env.DIST ?? `${REPO}dist`}/index.html`, "utf8");
  assert(/<script src="\.\/https-redirect\.js"><\/script>/.test(html), "redirect script tag missing");
  assert(fs.existsSync(`${process.env.DIST ?? `${REPO}dist`}/https-redirect.js`), "redirect file missing");
  return "external script present; CSP clean per R1";
});
await check("R5", "runUntilSettled parameter reports errors", async () => {
  for (const [q, expected] of [["?runUntilSettled=nothex", /lowercase hex/], [`?runUntilSettled=${"a".repeat(64)}`, /does not exist/]]) {
    const { page, context } = await openWallet(browser, "", { query: q });
    await page.waitForFunction(() => document.documentElement.dataset.granolaRunStatus === "error", null, { timeout: 15000 });
    const err = await page.evaluate(() => document.documentElement.dataset.granolaRunError);
    assert(expected.test(err), err);
    await context.close();
  }
});
await check("R4", "debug=performance loads", async () => {
  const { page, context } = await openWallet(browser, "", { query: "?debug=performance" });
  await page.waitForTimeout(3000);
  assert(clean(page.consoleLog).filter((l) => /pageerror/.test(l)).length === 0, "page error");
  await context.close();
});
await check("R6", "Unknown path is a 404", async () => {
  const { page, context } = await openWallet(browser, "");
  const response = await page.goto("https://brenorb.com/granola/nope.html");
  assert(response.status() === 404, String(response.status()));
  await context.close();
});

// ---------- Order book ----------
await check("F2-scale", "1,200-order book shows every open order and true best prices", async () => {
  const { page, context } = await openWallet(browser, tag());
  await page.waitForSelector("[data-summary=best-ask]", { timeout: 60000 });
  const book = await page.evaluate(async () => {
    const r = await window.granola.getOrderBook();
    return { asks: r.book.asks.length, bids: r.book.bids.length };
  });
  const bestAsk = await page.locator("[data-summary=best-ask]").innerText();
  const bestBid = await page.locator("[data-summary=best-bid]").innerText();
  await shot(page, `${label}-F2-book`);
  assert(book.asks >= 601 && book.bids >= 601, `asks=${book.asks} bids=${book.bids}`);
  assert(bestAsk.startsWith("49,500.00"), `best ask ${bestAsk}`);
  assert(bestBid.startsWith("49,200.00"), `best bid ${bestBid}`);
  assert(await page.locator("#orderbook img").count() === 0, "hostile HTML rendered");
  await context.close();
  return `asks=${book.asks} bids=${book.bids} best ${bestAsk} / ${bestBid}`;
});
await check("F2-toggle", "See more / See less toggles and survives refresh", async () => {
  const { page, context } = await openWallet(browser, tag());
  await page.waitForSelector("[data-orderbook-toggle=asks]", { timeout: 60000 });
  const toggle = page.locator("[data-orderbook-toggle=asks]");
  await toggle.click();
  assert(await toggle.getAttribute("aria-expanded") === "true", "not expanded");
  const visible = await page.locator("tbody.orderbook-asks tr:not([hidden])").count();
  await page.getByRole("button", { name: "Refresh orders" }).click();
  await page.waitForTimeout(4000);
  assert(await page.locator("[data-orderbook-toggle=asks]").getAttribute("aria-expanded") === "true", "collapsed after refresh");
  await page.locator("[data-orderbook-toggle=asks]").click();
  const collapsed = await page.locator("tbody.orderbook-asks tr:not([hidden])").count();
  assert(collapsed === 3, `collapsed shows ${collapsed}`);
  await context.close();
  return `expanded rows=${visible}`;
});
await check("F2-take-validation", "Take amount validates AON and integers", async () => {
  const { page, context } = await openWallet(browser, tag());
  await page.waitForSelector("tbody.orderbook-asks tr", { timeout: 60000 });
  const row = page.locator("tbody.orderbook-asks tr").first();
  const input = row.locator("[data-take-amount]");
  for (const [value, expected] of [["1.5", /positive whole-number/], ["1", /all-or-none/]]) {
    await input.fill(value);
    await row.locator("[data-take-order]").click();
    const msg = await input.evaluate((e) => e.validationMessage);
    assert(expected.test(msg), `${value}: ${msg}`);
  }
  assert(await page.locator("[data-trade-session]").count() === 0, "a trade started");
  await context.close();
});
await check("F2-refresh-outage", "Refresh with all relays down reports failure, keeps book", async () => {
  const { page, context } = await openWallet(browser, tag());
  await page.waitForSelector("[data-summary=best-ask]", { timeout: 60000 });
  for (const h of ["nos.lol", "relay.primal.net", "offchain.pub"]) await control(`/fault?host=${h}&mode=down`);
  const s = await act(page, () => page.getByRole("button", { name: "Refresh orders" }).click(), /.+/, 60000);
  assert(/No order relay answered\. Showing the last loaded order book\./.test(s), s);
  assert(await page.locator("#status.error").count() === 1, "not error-styled");
  assert(await page.locator("[data-summary=best-ask]").count() === 1, "book cleared");
  await context.close();
  return s;
});

// ---------- Funding ----------
await check("F3-fund", "Fund SAT and USD", async () => {
  const { page, context } = await fundedWallet(tag(), ["sat", "usd"]);
  const summary = (await page.locator("#wallet-summary").innerText()).replace(/\n/g, " ");
  assert(/10,000 sat/.test(summary) && /100\.00 USD/.test(summary), summary);
  const log = await page.locator("#activity-log").innerText();
  assert(!/quote id|[0-9a-f]{32}/i.test(log), "secret-looking value in log");
  await context.close();
  return summary;
});
await check("F3-mint-down", "Funding with mint down names the mint", async () => {
  const { page, context } = await openWallet(browser, tag());
  await page.waitForTimeout(1200);
  await control("/fault?host=testnut.cashu.space&mode=down");
  const button = page.getByRole("button", { name: "Mint 10,000 satoshis" });
  const s = await act(page, () => button.click(), /.+/, 60000);
  assert(s === "Could not reach testnut.cashu.space. Check your connection and try again.", s);
  assert(!(await button.isDisabled()), "button stuck disabled");
  await context.close();
  return s;
});

// ---------- Order form ----------
await check("F4-validation", "Order form blocks bad input with specific messages", async () => {
  const { page, context } = await fundedWallet(tag());
  const cases = [
    ["amount", "abc", /whole number of SAT/], ["amount", "0", /whole number of SAT/], ["amount", "", /Enter the order size/],
    ["fiatPrice", "50,000.00", /thousands separators/], ["fiatPrice", "50000.123", /two decimals/], ["fiatPrice", "0", /greater than zero/],
    ["days", "31", /less than or equal to 30/]
  ];
  for (const [field, value, expected] of cases) {
    await page.fill("input[name=amount]", "100"); await page.fill("input[name=fiatPrice]", "50000.00"); await page.fill("input[name=days]", "1");
    await page.fill(`input[name=${field}]`, value);
    await page.getByRole("button", { name: /Sign & post order/ }).click();
    await page.waitForTimeout(300);
    const msg = await page.locator(`input[name=${field}]`).evaluate((e) => e.validationMessage);
    assert(expected.test(msg), `${field}=${value}: ${msg}`);
  }
  assert(await page.locator("tr[data-can-cancel=true]").count() === 0, "an order was published");
  await context.close();
  return `${cases.length} cases`;
});
await check("F4-funding", "Insufficient funds and sub-cent orders are refused", async () => {
  const { page, context } = await fundedWallet(tag());
  let s = await postOrder(page, { amount: "20000" });
  assert(/Insufficient SAT balance/.test(s), s);
  s = await postOrder(page, { side: "buy", amount: "100" });
  assert(/Insufficient USD balance/.test(s), s);
  s = await act(page, async () => {
    await page.selectOption("select[name=side]", "sell"); await page.fill("input[name=amount]", "1");
    await page.getByRole("button", { name: /Sign & post order/ }).click();
  }, /.+/);
  assert(/at least one quote unit/.test(s), s);
  await context.close();
});
await check("F4-hint", "Settlement hint explains truncation", async () => {
  const { page, context } = await openWallet(browser, tag());
  await page.fill("input[name=amount]", "333"); await page.fill("input[name=fiatPrice]", "50000.01");
  const hint = await page.locator("#order-settlement-hint").innerText();
  assert(/settles 16 cents \(0\.16 USD\)/.test(hint), hint);
  await context.close();
});
await check("F4-publish", "Publish shows own row, cancel removes it, double submit posts once", async () => {
  const { page, context } = await fundedWallet(tag());
  await page.fill("input[name=amount]", "100"); await page.fill("input[name=fiatPrice]", "51111.00"); await page.fill("input[name=days]", "1");
  await recordStatuses(page);
  await page.getByRole("button", { name: /Sign & post order/ }).dblclick();
  await page.waitForTimeout(5000);
  const s = await statuses(page);
  assert(s.some((x) => /Order published with 3 of 4 relay acknowledgements/.test(x)), JSON.stringify(s));
  const own = page.locator("tr[data-can-cancel=true]");
  assert(await own.count() === 1, `own rows ${await own.count()}`);
  assert(await own.locator("[data-take-order]").isDisabled(), "own order takeable");
  await own.locator("details.order-info summary").click();
  const info = await own.locator(".order-info__popup").innerText();
  assert(/AON/.test(info), info);
  const c = await act(page, () => own.locator("[data-cancel-order]").click(), /Canceled|error/i);
  assert(/Canceled/.test(c), c);
  await page.waitForTimeout(1500);
  assert(await page.locator("tr[data-can-cancel=true]").count() === 0, "row remains after cancel");
  await context.close();
});
await check("F4-relays-down", "Publishing with relays down is not reported as published; retry works", async () => {
  const { page, context } = await fundedWallet(tag());
  for (const h of ["nos.lol", "relay.primal.net", "offchain.pub"]) await control(`/fault?host=${h}&mode=down`);
  await recordStatuses(page);
  await page.fill("input[name=amount]", "100"); await page.fill("input[name=fiatPrice]", "52223.00"); await page.fill("input[name=days]", "1");
  await page.getByRole("button", { name: /Sign & post order/ }).click();
  await page.waitForTimeout(6000);
  const s = await statuses(page);
  assert(!s.some((x) => /^Order published/.test(x)), JSON.stringify(s));
  assert(s.some((x) => /^ERR Order signed, but no relay acknowledged it/.test(x)), JSON.stringify(s));
  const panel = await page.locator("#pending-publications").innerText();
  assert(/0\/4 relay acknowledgements/.test(panel), panel);
  await shot(page, `${label}-F4-relays-down`);
  for (const h of ["nos.lol", "relay.primal.net", "offchain.pub"]) await control(`/fault?host=${h}&mode=up`);
  const r = await act(page, () => page.getByRole("button", { name: "Retry same signed projection" }).click(), /acknowledgement|error/i, 60000);
  assert(/received a relay acknowledgement/.test(r), r);
  await page.waitForTimeout(2000);
  assert(!(await page.locator("#pending-publications").isVisible()), "pending panel remains");
  await context.close();
});

// ---------- Settlement ----------
async function swapPair(prefix, { amount = "100", price = "49980.00" } = {}) {
  const maker = await fundedWallet(`mk-${prefix}`);
  const taker = await fundedWallet(`tk-${prefix}`, ["usd"]);
  const s = await postOrder(maker.page, { amount, price });
  assert(/Order published/.test(s), s);
  const orderId = await maker.page.locator("tr[data-can-cancel=true]").first().getAttribute("data-order-id");
  await taker.page.getByRole("button", { name: "Refresh orders" }).click();
  await taker.page.waitForTimeout(3000);
  const row = taker.page.locator(`tr[data-order-id="${orderId}"]`);
  assert(await row.count() === 1, "taker cannot see order");
  await reveal(taker.page, row);
  return { maker: maker.page, taker: taker.page, row, orderId, contexts: [maker.context, taker.context] };
}
await check("W3", "Two users settle a swap; cards show units and plain-language state", async () => {
  const { maker, taker, row, contexts } = await swapPair(tag());
  const t0 = Date.now();
  const s = await act(taker, () => row.locator("[data-take-order]").click(), /Swap filled|error|could not/i, 180000);
  assert(/Swap filled/.test(s), s);
  await waitPhases(maker, /Filled/);
  for (const page of [maker, taker]) {
    const card = await page.locator("[data-trade-session]").first().innerText();
    assert(/0\.04 USD|0\.05 USD/.test(card), `card units: ${card.slice(0, 120)}`);
    assert(/100 sat/.test(card), "sat units");
    assert(/Settled\. Both legs were claimed/.test(card), "filled explanation");
    assert(!/Waiting for verified mint state/.test(card), "stale waiting text");
  }
  const tw = (await taker.locator("#wallet-summary").innerText()).replace(/\n/g, " ");
  assert(/100 sat/.test(tw), tw);
  await shot(taker, `${label}-W3-taker`);
  // DM dialog
  await taker.locator(".trade-dms-trigger").first().click();
  assert(await taker.locator("dialog[open]").count() === 1, "dialog not open");
  const dialog = await taker.locator("dialog[open]").innerText();
  assert(/3 AUTHENTICATED DMS/i.test(dialog) && !/cashu[AB]|nsec/.test(dialog), "dialog content");
  await taker.keyboard.press("Escape");
  assert(await taker.locator("dialog[open]").count() === 0, "Escape did not close");
  for (const c of contexts) await c.close();
  return `${Date.now() - t0} ms; taker ${tw}`;
});
await check("F2-self-take", "Own order cannot be taken (UI and API)", async () => {
  const { page, context } = await fundedWallet(tag(), ["sat", "usd"]);
  await postOrder(page, { price: "49970.00" });
  const own = page.locator("tr[data-can-cancel=true]").first();
  assert(await own.locator("[data-take-order]").isDisabled(), "button enabled");
  const order = await page.evaluate(async () => {
    const keys = await window.granola.getMakerPublicKeys();
    const book = await window.granola.getOrderBook();
    const mine = book.book.asks.find((o) => keys.includes(o.makerPubkey));
    try {
      await window.granola.takeOrder({ requestId: crypto.randomUUID(), address: mine.address, expectedProjectionId: mine.eventId, expectedRevision: mine.state.revision, fillBaseAmount: mine.state.remaining_amount });
      return "taken";
    } catch (error) { return error.message; }
  });
  assert(/your own order/.test(order), order);
  assert(await page.locator("[data-trade-session]").count() === 0, "session created");
  await context.close();
  return order;
});
await check("B13-race", "Race loser gets a plain explanation and a refreshed book", async () => {
  const p = tag();
  const { maker, taker, row, orderId, contexts } = await swapPair(p, { amount: "200", price: "49975.00" });
  const other = await fundedWallet(`tb-${p}`, ["usd"]);
  await other.page.getByRole("button", { name: "Refresh orders" }).click();
  await other.page.waitForTimeout(3000);
  const rowB = other.page.locator(`tr[data-order-id="${orderId}"]`);
  await reveal(other.page, rowB);
  await recordStatuses(taker); await recordStatuses(other.page);
  await Promise.all([row.locator("[data-take-order]").click(), rowB.locator("[data-take-order]").click()]);
  await taker.waitForTimeout(30000);
  const sa = await statuses(taker), sb = await statuses(other.page);
  const winner = [sa, sb].filter((s) => s.some((x) => /Swap filled/.test(x))).length;
  const loserStatuses = sa.some((x) => /Swap filled/.test(x)) ? sb : sa;
  const loserPage = sa.some((x) => /Swap filled/.test(x)) ? other.page : taker;
  assert(winner === 1, `winners=${winner} A=${JSON.stringify(sa)} B=${JSON.stringify(sb)}`);
  assert(loserStatuses.some((x) => /No funds moved from this wallet/.test(x)), JSON.stringify(loserStatuses));
  assert(!loserStatuses.some((x) => /terminal phase/.test(x)), "jargon shown");
  const card = await loserPage.locator("[data-trade-session]").first().innerText();
  assert(/No funds moved/.test(card), card.slice(0, 200));
  assert(await loserPage.locator(`tr[data-order-id="${orderId}"]`).count() === 0, "stale row still takeable");
  const lw = (await loserPage.locator("#wallet-summary").innerText()).replace(/\n/g, " ");
  assert(/100\.00 USD/.test(lw), lw);
  await shot(loserPage, `${label}-B13-loser`);
  for (const c of [...contexts, other.context]) await c.close();
  void maker;
  return "one winner; loser told no funds moved";
});
await check("B14-mint-outage", "Mint outage mid-swap resumes automatically", async () => {
  const { maker, taker, row, contexts } = await swapPair(tag(), { amount: "300", price: "49960.00" });
  await control("/fault?host=testnut.cashudevkit.org&mode=slow&delayMs=1500");
  await control("/fault?host=testnut.cashu.space&mode=slow&delayMs=1500");
  await row.locator("[data-take-order]").click();
  await taker.waitForFunction(() => /Base locked|Quote locked/.test(document.getElementById("trades").textContent), null, { timeout: 60000 });
  const at = await phases(taker);
  await control("/fault?host=testnut.cashudevkit.org&mode=down");
  await control("/fault?host=testnut.cashu.space&mode=down");
  await taker.waitForTimeout(20000);
  await control("/fault?host=testnut.cashudevkit.org&mode=up");
  await control("/fault?host=testnut.cashu.space&mode=up");
  const t0 = Date.now();
  await waitPhases(taker, /Filled/, 120000);
  await waitPhases(maker, /Filled/, 60000);
  for (const c of contexts) await c.close();
  return `interrupted at ${at}; both Filled ${Date.now() - t0} ms after restore, no manual action`;
});
await check("W5-reload", "Taker reload mid-swap resumes to Filled", async () => {
  const { maker, taker, row, contexts } = await swapPair(tag(), { amount: "300", price: "49961.00" });
  await control("/fault?host=testnut.cashudevkit.org&mode=slow&delayMs=1500");
  await control("/fault?host=testnut.cashu.space&mode=slow&delayMs=1500");
  await row.locator("[data-take-order]").click();
  await taker.waitForFunction(() => /Base locked|Quote locked|Reserved/.test(document.getElementById("trades").textContent), null, { timeout: 60000 });
  await taker.reload();
  await control("/fault?host=testnut.cashudevkit.org&mode=up");
  await control("/fault?host=testnut.cashu.space&mode=up");
  await waitPhases(taker, /Filled/, 120000);
  await waitPhases(maker, /Filled/, 60000);
  for (const c of contexts) await c.close();
});
await check("B08-offline-maker", "Offline maker: user is told nobody answered and no funds are locked", async () => {
  const { page, context } = await fundedWallet(tag(), ["usd"]);
  await recordStatuses(page);
  const ask = page.locator("tbody.orderbook-asks tr").first();
  await ask.locator("[data-take-order]").click();
  await page.waitForTimeout(26000);
  const s = await statuses(page);
  assert(s.some((x) => /Waiting for the maker to accept\. No funds are locked yet; the request expires at \d/.test(x)), JSON.stringify(s));
  const card = await page.locator("[data-trade-session]").first().innerText();
  assert(/Waiting for the maker to accept/.test(card), card.slice(0, 160));
  await shot(page, `${label}-B08-offline-maker`);
  await context.close();
});

// ---------- Listener / inbox relay ----------
await check("B12-inbox-recovery", "Maker listener recovers after the inbox relay returns", async () => {
  const { page, context } = await fundedWallet(tag());
  await postOrder(page, { price: "52224.00" });
  await control("/fault?host=auth.nostr1.com&mode=down");
  await page.reload();
  await page.waitForTimeout(6000);
  await control("/fault?host=auth.nostr1.com&mode=up");
  const t0 = Date.now();
  await page.waitForFunction(() => /Maker listener ready/.test(document.getElementById("activity-log").textContent), null, { timeout: 60000 });
  await context.close();
  return `ready ${Date.now() - t0} ms after restore`;
});

// ---------- Custody ----------
await check("F7-backup", "Backup downloads bearer tokens with warning", async () => {
  const { page, context } = await fundedWallet(tag());
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download bearer backup" }).click()]);
  const file = await download.path();
  const backup = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.rmSync(file, { force: true });
  assert(/granola-.*-bearer-backup\.json/.test(download.suggestedFilename()), download.suggestedFilename());
  assert(backup.tokens.length === 1 && typeof backup.warning === "string", "backup shape");
  const log = await page.locator("#activity-log").innerText();
  assert(!/cashu[AB]/.test(log), "token in log");
  await context.close();
});
await check("F7-erase", "Erase wallet and erase everything work in one click (product decision)", async () => {
  const { page, context } = await fundedWallet(tag());
  await page.locator("summary", { hasText: "Danger zone" }).click();
  const s = await act(page, () => page.getByRole("button", { name: "Erase local wallet" }).click(), /erased|error/i);
  assert(/Local wallet erased/.test(s), s);
  assert(/No balance/.test(await page.locator("#wallet-summary").innerText()), "balance remains");
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: /Erase everything/ }).click()]);
  await context.close();
});

// ---------- Multi-tab, layout ----------
await check("F12-tabs", "Two tabs of one workspace serialize funding", async () => {
  const context = await browser.newContext();
  const profile = tag();
  const one = (await openWallet(browser, profile, { context })).page;
  const two = (await openWallet(browser, profile, { context })).page;
  await one.waitForTimeout(1500);
  await Promise.all([
    one.getByRole("button", { name: "Mint 10,000 satoshis" }).click(),
    two.getByRole("button", { name: "Mint 10,000 satoshis" }).click()
  ]);
  await one.waitForTimeout(9000);
  await one.getByRole("button", { name: "Refresh balances" }).click();
  await one.waitForTimeout(1000);
  const text = await one.locator("#wallet-summary").innerText();
  assert(/20,000 sat/.test(text), text);
  await context.close();
});
await check("F10-mobile", "375 px layout has no horizontal scroll; notes readable", async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = (await openWallet(browser, tag(), { context })).page;
  await page.waitForTimeout(4000);
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  const columns = await page.locator(".protocol-notes__grid").evaluate((e) => getComputedStyle(e).gridTemplateColumns);
  await page.locator(".protocol-notes").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}/${label}-F10-mobile-notes.png` });
  assert(scroll <= client, `scrollWidth ${scroll} > ${client}`);
  assert(columns.split(" ").length === 1, `notes columns ${columns}`);
  await context.close();
  return `scrollWidth=${scroll}; notes columns=${columns}`;
});
await check("F9-closed-denial", "Listener works on a relay that denies with CLOSED restricted", async () => {
  const { execSync } = await import("node:child_process");
  execSync(`${REPO}scripts/qa/stack.sh relays closed`, { env: { ...process.env, QA_ROOT } });
  try {
    const { page, context } = await fundedWallet(tag());
    await postOrder(page, { price: "52225.00" });
    await page.waitForFunction(() => /Maker listener ready/.test(document.getElementById("activity-log").textContent), null, { timeout: 30000 });
    await context.close();
  } finally {
    execSync(`${REPO}scripts/qa/stack.sh relays filter`, { env: { ...process.env, QA_ROOT } });
  }
});

await browser.close();
const passed = results.filter((r) => r.pass).length;
fs.writeFileSync(`${EVIDENCE}/${label}-results.json`, JSON.stringify(results, null, 2));
console.log(`\n${passed}/${results.length} passed`);
