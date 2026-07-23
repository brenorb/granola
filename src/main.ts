import { GranolaApi, QuoteRepository, type BrowserGranolaApi, type GranolaState } from "./api/granola-api.js";
import { OrderApi, type PublishOrderInput } from "./api/order-api.js";
import { TradeApi, type TakeOrderInput } from "./api/trade-api.js";
import { withOrderOutboxLock, withWalletLock } from "./browser/lock.js";
import { profileFromLocation, storageNameForProfile } from "./browser/profile.js";
import { BrowserTradeController } from "./browser/trade-controller.js";
import { createBrowserTradeRuntime } from "./browser/trade-runtime.js";
import { CashuClient } from "./cashu/client.js";
import {
  fiatPerBtcPrice,
  settlementQuoteGuidance
} from "./order/human-price.js";
import { assertOrderFunding } from "./order/funding.js";
import type { OrderRecord } from "./order/model.js";
import { NostrOrderService } from "./order/service.js";
import { MakerIdentity } from "./nostr/identity.js";
import { RelayClient } from "./nostr/relay.js";
import { OrderOutboxRepository } from "./storage/order-outbox.js";
import { IndexedDbStorageDriver, WalletRepository } from "./storage/wallet-repository.js";
import { renderDashboard } from "./ui/dashboard.js";
import { formatUnitAmount } from "./ui/format.js";
import { renderOrderBook } from "./ui/orderbook.js";
import { renderPendingPublications } from "./ui/order-outbox.js";
import { renderTrades } from "./ui/trades.js";

interface GranolaBrowserFacade {
  getState: BrowserGranolaApi["getState"];
  inspectMint: BrowserGranolaApi["inspectMint"];
  inspectToken: BrowserGranolaApi["inspectToken"];
  requestMint: BrowserGranolaApi["requestMint"];
  claimMint: BrowserGranolaApi["claimMint"];
  receiveToken: BrowserGranolaApi["receiveToken"];
  createBackup: BrowserGranolaApi["createBackup"];
  clearWallet: BrowserGranolaApi["clearWallet"];
  resetProfile: (confirmation: string) => Promise<void>;
  getMakerPublicKeys: OrderApi["getMakerPublicKeys"];
  getOrderBook: OrderApi["getOrderBook"];
  publishOrder: OrderApi["publishOrder"];
  getPendingOrderPublications: OrderApi["getPendingOrderPublications"];
  retryOrderPublication: OrderApi["retryOrderPublication"];
  cancelOrder: OrderApi["cancelOrder"];
  listTrades: TradeApi["listTrades"];
  getTrade: TradeApi["getTrade"];
  takeOrder: TradeApi["takeOrder"];
  advanceTrade: TradeApi["advanceTrade"];
  runUntilSettled: BrowserTradeController["runUntilSettled"];
  enableMaker: BrowserTradeController["enableMaker"];
}

declare global {
  interface Window { granola: GranolaBrowserFacade; }
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

const profile = profileFromLocation(window.location.href);
const driver = new IndexedDbStorageDriver(storageNameForProfile(profile));
const locked = <T>(action: () => Promise<T>): Promise<T> => withWalletLock(profile, action);
const outboxLocked = <T>(action: () => Promise<T>): Promise<T> =>
  withOrderOutboxLock(profile, action);
const walletRepository = new WalletRepository(driver);
const cashu = new CashuClient();
const api = new GranolaApi(walletRepository, new QuoteRepository(driver), cashu);
const makerIdentity = new MakerIdentity(driver, locked);
const relayClient = new RelayClient();
const orderService = new NostrOrderService(makerIdentity, relayClient);
const orderOutbox = new OrderOutboxRepository(driver, outboxLocked);
const orderApi = new OrderApi(
  makerIdentity,
  orderService,
  () => Math.floor(Date.now() / 1000),
  () => crypto.randomUUID(),
  orderOutbox
);

async function publishOrderWithFunding(input: PublishOrderInput) {
  assertOrderFunding(
    (await api.getState()).wallet,
    input.side,
    input.amount,
    input.priceCentsPerBtc
  );
  return orderApi.publishOrder(input);
}
const dashboard = byId("dashboard");
const orderbook = byId("orderbook");
const pendingPublications = byId("pending-publications");
const trades = byId("trades");
const status = byId("status");
const orderSettlementHint = byId("order-settlement-hint");
const activity = byId<HTMLOListElement>("activity-log");
let tradeControllerPromise: Promise<BrowserTradeController> | undefined;

function log(message: string): void {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  item.append(time, document.createTextNode(message));
  activity.prepend(item);
}

function report(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle("error", error);
  status.classList.add("visible");
  window.setTimeout(() => status.classList.remove("visible"), 5000);
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function refresh(state?: GranolaState): Promise<GranolaState> {
  const next = state ?? await api.getState();
  renderDashboard(dashboard, next);
  return next;
}

async function refreshOrderBook(): Promise<void> {
  renderOrderBook(orderbook, { status: "loading" });
  try {
    const [result, identities] = await Promise.all([
      orderApi.getOrderBook(),
      orderApi.getMakerPublicKeys()
    ]);
    renderOrderBook(
      orderbook,
      { status: "ready", book: result.book },
      {
        onTake: takeOrderFromBook,
        onCancel: cancelOrderFromBook,
        canCancel: (order) => identities.includes(order.makerPubkey)
      }
    );
    if (result.rejected > 0) {
      log(`Ignored ${result.rejected} invalid or conflicting public order event(s)`);
    }
  } catch (error) {
    renderOrderBook(orderbook, { status: "error", message: messageOf(error) });
    throw error;
  }
}

function tradeController(): Promise<BrowserTradeController> {
  tradeControllerPromise ??= createBrowserTradeRuntime({
    profile,
    driver,
    wallet: walletRepository,
    makerIdentity,
    orderApi,
    orderService,
    orderOutbox,
    cashu
  }).then((runtime) => new BrowserTradeController({
    api: runtime.api,
    sessions: runtime.sessions,
    transport: runtime.transport,
    inboxPort: runtime.inboxPort,
    inboxRelay: runtime.inboxRelay,
    makerIdentity,
    onChange: () => { void refreshTrades(); },
    onError: (message) => report(message, true)
  }));
  return tradeControllerPromise;
}

function advanceTrade(sessionId: string): void {
  void granola.advanceTrade(sessionId)
    .then(async (trade) => {
      await Promise.all([refreshTrades(), refreshOrderBook(), refresh()]);
      log(`Advanced ${trade.role} swap ${trade.reservationId.slice(0, 8)}… to ${trade.phase}`);
      report(`Completed one checkpointed ${trade.role} action`);
    })
    .catch((error: unknown) => report(messageOf(error), true));
}

async function refreshTrades(): Promise<void> {
  const controller = await tradeController();
  const current = await controller.resume();
  renderTrades(trades, current, { onAdvance: advanceTrade });
}

const takeRequestIds = new Map<string, string>();

function takeOrderFromBook(
  order: OrderRecord,
  fillBaseAmount: string
): void {
  const retryKey = `${order.address}:${order.eventId}:${fillBaseAmount}`;
  const requestId = takeRequestIds.get(retryKey) ?? crypto.randomUUID();
  takeRequestIds.set(retryKey, requestId);
  void granola.takeOrder({
    requestId,
    address: order.address,
    expectedProjectionId: order.eventId,
    expectedRevision: order.state.revision,
    fillBaseAmount
  }).then(async (trade) => {
    takeRequestIds.delete(retryKey);
    await refreshTrades();
    log(`Opened taker swap ${trade.reservationId.slice(0, 8)}… for ${fillBaseAmount} ${trade.terms.baseUnit.toUpperCase()}`);
    report("Swap session persisted; advance one verified action at a time");
  }).catch((error: unknown) => report(messageOf(error), true));
}

function retryPendingPublication(orderId: string): void {
  void granola.retryOrderPublication(orderId)
    .then(async (publication) => {
      await Promise.all([refreshOrderBook(), refreshPendingPublications()]);
      log(`Republished exact order projection ${publication.orderId.slice(0, 8)}…`);
      report("Pending signed projection received a relay acknowledgement");
    })
    .catch(async (error: unknown) => {
      await refreshPendingPublications();
      report(messageOf(error), true);
    });
}

function cancelOrderFromBook(order: OrderRecord): void {
  void granola.cancelOrder({
    address: order.address,
    expectedProjectionId: order.eventId,
    expectedRevision: order.state.revision
  }).then(async () => {
    await Promise.all([refreshOrderBook(), refreshPendingPublications()]);
    log(`Canceled order ${order.state.order_id.slice(0, 8)}…`);
    report("Canceled order projection received a relay acknowledgement");
  }).catch((error: unknown) => report(messageOf(error), true));
}

async function refreshPendingPublications(): Promise<void> {
  renderPendingPublications(
    pendingPublications,
    await orderApi.getPendingOrderPublications(),
    retryPendingPublication
  );
}

const granola: GranolaBrowserFacade = {
  getState: api.getState.bind(api),
  inspectMint: api.inspectMint.bind(api),
  inspectToken: api.inspectToken.bind(api),
  requestMint: (input) => locked(() => api.requestMint(input)),
  claimMint: (ref) => locked(() => api.claimMint(ref)),
  receiveToken: (token) => locked(() => api.receiveToken(token)),
  createBackup: () => locked(() => api.createBackup()),
  clearWallet: (confirmation) => locked(() => api.clearWallet(confirmation)),
  resetProfile: async (confirmation) => {
    if (confirmation !== "RESET GRANOLA PROFILE") {
      throw new Error("Type RESET GRANOLA PROFILE to erase this profile");
    }
    await driver.resetDatabase();
  },
  getMakerPublicKeys: orderApi.getMakerPublicKeys.bind(orderApi),
  getOrderBook: orderApi.getOrderBook.bind(orderApi),
  publishOrder: publishOrderWithFunding,
  getPendingOrderPublications: orderApi.getPendingOrderPublications.bind(orderApi),
  retryOrderPublication: orderApi.retryOrderPublication.bind(orderApi),
  cancelOrder: orderApi.cancelOrder.bind(orderApi),
  listTrades: async () => (await tradeController()).listTrades(),
  getTrade: async (sessionId) => (await tradeController()).getTrade(sessionId),
  takeOrder: async (input: TakeOrderInput) => (await tradeController()).takeOrder(input),
  advanceTrade: async (sessionId) => (await tradeController()).advanceTrade(sessionId),
  runUntilSettled: async (sessionId) =>
    (await tradeController()).runUntilSettled(sessionId),
  enableMaker: async () => (await tradeController()).enableMaker()
};
window.granola = granola;

function runAgentSettlement(sessionId: string): void {
  const root = document.documentElement;
  if (!/^[0-9a-f]{64}$/.test(sessionId)) {
    root.dataset.granolaRunStatus = "error";
    root.dataset.granolaRunError = "Agent run requires a lowercase hex session ID";
    return;
  }
  if (root.dataset.granolaRunStatus === "running") return;
  root.dataset.granolaRunStatus = "running";
  delete root.dataset.granolaRunResult;
  delete root.dataset.granolaRunError;
  void granola.runUntilSettled(sessionId)
    .then(async (result) => {
      root.dataset.granolaRunResult = JSON.stringify(result);
      root.dataset.granolaRunStatus = "filled";
      await refreshTrades();
    })
    .catch((error: unknown) => {
      root.dataset.granolaRunError = messageOf(error);
      root.dataset.granolaRunStatus = "error";
    });
}

document.addEventListener("granola:run-until-settled", () => {
  runAgentSettlement(document.documentElement.dataset.granolaRunSession ?? "");
});

const requestedAgentRun = new URL(window.location.href).searchParams
  .get("runUntilSettled");
if (requestedAgentRun !== null) runAgentSettlement(requestedAgentRun);

byId("profile-label").textContent = `Wallet profile: ${profile}`;
byId("refresh").addEventListener("click", () => {
  void refresh().then(() => report("Wallet state refreshed")).catch((error: unknown) => report(messageOf(error), true));
});
byId("refresh-orderbook").addEventListener("click", () => {
  void refreshOrderBook()
    .then(() => report("Order book refreshed from public relays"))
    .catch((error: unknown) => report(messageOf(error), true));
});
byId("refresh-trades").addEventListener("click", () => {
  void refreshTrades()
    .then(() => report("Swap sessions refreshed from durable checkpoints"))
    .catch((error: unknown) => report(messageOf(error), true));
});
byId("enable-maker").addEventListener("click", () => {
  void granola.enableMaker()
    .then(({ makerPubkey, inboxRelay }) => {
      byId("maker-inbox-state").textContent = "listening";
      log(`Maker inbox ready for ${makerPubkey.slice(0, 8)}… on ${new URL(inboxRelay).host}`);
      report("Maker order inbox is authenticated and listening");
    })
    .catch((error: unknown) => {
      byId("maker-inbox-state").textContent = "offline";
      report(messageOf(error), true);
    });
});

const orderForm = byId<HTMLFormElement>("order-form");
const mintInput = byId<HTMLSelectElement>("mint-url");
const mintUnitInput = byId<HTMLSelectElement>("mint-unit");
function requiredOrderInput(name: string): HTMLInputElement {
  const input = orderForm.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (input === null) throw new Error(`Missing order input ${name}`);
  return input;
}
const orderAmountInput = requiredOrderInput("amount");
const orderPriceInput = requiredOrderInput("fiatPrice");

const defaultOrderSettlementHint = orderSettlementHint.textContent ?? "";
function groupedInteger(value: string): string {
  return BigInt(value).toLocaleString("en-US");
}

function decimalMinorUnits(numerator: string, denominator: string): string {
  const whole = BigInt(numerator);
  const divisor = BigInt(denominator);
  const integerPart = whole / divisor;
  let remainder = whole % divisor;
  if (remainder === 0n) return integerPart.toString();
  let fraction = "";
  for (let index = 0; index < 4 && remainder !== 0n; index += 1) {
    remainder *= 10n;
    fraction += (remainder / divisor).toString();
    remainder %= divisor;
  }
  return `${integerPart}.${fraction.replace(/0+$/, "")}${remainder !== 0n ? "…" : ""}`;
}

function updateOrderSettlementHint(): void {
  orderAmountInput.setCustomValidity("");
  orderSettlementHint.textContent = defaultOrderSettlementHint;
  try {
    const price = fiatPerBtcPrice(orderPriceInput.value);
    const guidance = settlementQuoteGuidance(orderAmountInput.value, price);
    if (guidance === null) return;
    const exactQuote = decimalMinorUnits(
      guidance.exactQuoteNumerator,
      guidance.exactQuoteDenominator
    );
    const message = `At ${orderPriceInput.value} USD/BTC, ${groupedInteger(orderAmountInput.value)} SAT ` +
      `is ${exactQuote} cents at the entered price. The USD mint settles ` +
      `${groupedInteger(guidance.settlementQuoteAmount)} cents ` +
      `(${formatUnitAmount(guidance.settlementQuoteAmount, "usd")}) after truncating the fractional cent. ` +
      `Your order remains exactly ${groupedInteger(orderAmountInput.value)} SAT.`;
    orderSettlementHint.textContent = message;
  } catch {
    // Native input patterns and the submit handler provide the authoritative error.
  }
}

orderAmountInput.addEventListener("input", () => updateOrderSettlementHint());
orderPriceInput.addEventListener("input", () => updateOrderSettlementHint());
orderAmountInput.addEventListener("change", () => updateOrderSettlementHint());
orderPriceInput.addEventListener("change", () => updateOrderSettlementHint());
orderAmountInput.addEventListener("invalid", () => {
  if (orderAmountInput.validationMessage.length > 0) {
    report(orderAmountInput.validationMessage, true);
  }
});
updateOrderSettlementHint();

mintUnitInput.addEventListener("change", () => {
  mintInput.value = mintUnitInput.value === "usd"
    ? "https://nofee.testnut.cashu.space"
    : "https://testnut.cashu.space";
});

orderForm.addEventListener("submit", (event) => {
  event.preventDefault();
  updateOrderSettlementHint();
  const form = new FormData(event.currentTarget as HTMLFormElement);
  void (async () => {
    const side = String(form.get("side"));
    const days = Number(String(form.get("days")));
    if (side !== "buy" && side !== "sell") throw new Error("Unknown order side");
    if (!Number.isSafeInteger(days) || days < 1 || days > 30) {
      throw new Error("Order lifetime must be 1–30 days");
    }
    const input: PublishOrderInput = {
      side,
      amount: String(form.get("amount")),
      priceCentsPerBtc: fiatPerBtcPrice(String(form.get("fiatPrice"))),
      expiresAt: Math.floor(Date.now() / 1000) + days * 86_400,
      execution: "all_or_none"
    };
    const publication = await granola.publishOrder(input);
    const acknowledgements = publication.receipts.filter((receipt) => receipt.ok).length;
    log(`Published ${side} order ${publication.orderId.slice(0, 8)}… to ${acknowledgements} relay(s)`);
    await Promise.all([refreshOrderBook(), refreshPendingPublications()]);
    report(`Order published with ${acknowledgements} relay acknowledgements`);
  })().catch(async (error: unknown) => {
    await refreshPendingPublications();
    report(messageOf(error), true);
  });
});

byId<HTMLFormElement>("mint-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget as HTMLFormElement);
  const mintUrl = String(form.get("mintUrl"));
  const unit = String(form.get("unit"));
  const amount = String(form.get("amount"));
  void (async () => {
    const quote = await granola.requestMint({ mintUrl, unit, amount });
    const quoteBox = byId("quote");
    quoteBox.hidden = false;
    quoteBox.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = `${formatUnitAmount(quote.amount, quote.unit)} · ${quote.state}`;
    const invoice = document.createElement("code");
    invoice.textContent = quote.request;
    quoteBox.append(heading, invoice);
    log(`Mint quote requested for ${formatUnitAmount(quote.amount, quote.unit)} from ${new URL(quote.mintUrl).host}`);
    report("Quote created; waiting for the fake mint to mark it paid");

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      const state = await granola.claimMint(quote.ref);
      await refresh(state);
      const current = state.quotes.find((item) => item.ref === quote.ref);
      if (current) heading.textContent = `${formatUnitAmount(current.amount, current.unit)} · ${current.state}`;
      if (current?.state === "ISSUED") {
        log(`Received ${formatUnitAmount(current.amount, current.unit)} of fake test ecash`);
        report("Fake test tokens added to this browser wallet");
        return;
      }
    }
    throw new Error("The quote did not become paid within 60 seconds");
  })().catch((error: unknown) => report(messageOf(error), true));
});

const tokenInput = byId<HTMLTextAreaElement>("token");
tokenInput.addEventListener("input", () => {
  const preview = byId("token-preview");
  try {
    const summary = api.inspectToken(tokenInput.value);
    preview.textContent = `${formatUnitAmount(summary.amount, summary.unit)} from ${new URL(summary.mintUrl).host}`;
  } catch {
    preview.textContent = tokenInput.value ? "This is not a readable Cashu token yet." : "Paste a token to inspect its mint, unit, and amount before receiving.";
  }
});

byId<HTMLFormElement>("receive-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const token = tokenInput.value;
    const summary = api.inspectToken(token);
    const state = await granola.receiveToken(token);
    tokenInput.value = "";
    byId("token-preview").textContent = "Token received and rotated into fresh proofs.";
    await refresh(state);
    log(`Received ${formatUnitAmount(summary.amount, summary.unit)} from ${new URL(summary.mintUrl).host}`);
    report("Token verified and received");
  })().catch((error: unknown) => report(messageOf(error), true));
});

byId("backup").addEventListener("click", () => {
  void (async () => {
    const backup = await granola.createBackup();
    const data = JSON.stringify(backup, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `granola-${profile}-bearer-backup.json`;
    link.click();
    URL.revokeObjectURL(url);
    log(`Downloaded a bearer backup containing ${backup.tokens.length} token pocket(s)`);
    report("Bearer backup downloaded — keep it private");
  })().catch((error: unknown) => report(messageOf(error), true));
});

byId<HTMLFormElement>("clear-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  void granola.clearWallet(String(new FormData(form).get("confirmation")))
    .then(async () => { form.reset(); await refresh(); log("Erased this profile’s local wallet"); report("Local wallet erased"); })
    .catch((error: unknown) => report(messageOf(error), true));
});

byId<HTMLFormElement>("reset-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  void granola.resetProfile(String(new FormData(form).get("confirmation")))
    .then(() => window.location.reload())
    .catch((error: unknown) => report(messageOf(error), true));
});

void Promise.all([
  refresh(),
  refreshOrderBook(),
  refreshPendingPublications(),
  refreshTrades(),
  granola.getMakerPublicKeys().then((publicKeys) => {
    const publicKey = publicKeys[0] ?? "";
    byId("maker-pubkey").textContent = publicKey
      ? `${publicKey.slice(0, 12)}…${publicKey.slice(-8)}`
      : "none (create an order)";
    byId("maker-pubkey").title = publicKeys.join("\n");
  })
])
  .then(() => log(`Opened isolated wallet profile “${profile}”`))
  .catch((error: unknown) => report(messageOf(error), true));

window.addEventListener("pagehide", () => {
  void tradeControllerPromise?.then((controller) => controller.stop()).catch(() => undefined);
  relayClient.dispose();
}, { once: true });
