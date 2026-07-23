import { GranolaApi, QuoteRepository, type BrowserGranolaApi, type GranolaState } from "./api/granola-api.js";
import { OrderApi, TEST_MARKET, type PublishOrderInput } from "./api/order-api.js";
import { TradeApi, type TakeOrderInput } from "./api/trade-api.js";
import { nip19 } from "nostr-tools";
import {
  hasNativeWebLocks,
  withOrderOutboxLock,
  withWalletLock
} from "./browser/lock.js";
import { profileFromLocation, storageNameForProfile } from "./browser/profile.js";
import { BrowserTradeController } from "./browser/trade-controller.js";
import { startInboxListeners } from "./browser/startup.js";
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
import { renderDashboard, renderWalletSummary } from "./ui/dashboard.js";
import { formatUnitAmount } from "./ui/format.js";
import { renderMintActions, type QuickMintRequest } from "./ui/mint-actions.js";
import { renderOrderBook } from "./ui/orderbook.js";
import { renderPendingPublications } from "./ui/order-outbox.js";
import { renderTrades } from "./ui/trades.js";
import {
  renderActivityLog,
  type ActivityDetail,
  type ActivityEntry
} from "./ui/activity-log.js";
import type { PublicTradeView } from "./trade/session.js";

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
    input.priceCentsPerBtc,
    TEST_MARKET
  );
  const publication = await orderApi.publishOrder(input);
  // Publishing creates the order's fresh maker key. Keep the shared page's
  // maker side live without requiring a reload or a role-specific page.
  try {
    await syncMakerInboxes();
  } catch (error) {
    // A relay/listener refresh must not turn an already-published order into
    // a failed API result. The visible listener status remains actionable.
    report(messageOf(error), true);
  }
  return publication;
}
const dashboard = byId("dashboard");
const walletSummary = byId("wallet-summary");
const orderbook = byId("orderbook");
const pendingPublications = byId("pending-publications");
const trades = byId("trades");
const status = byId("status");
const orderSettlementHint = byId("order-settlement-hint");
const activity = byId<HTMLOListElement>("activity-log");
let tradeControllerPromise: Promise<BrowserTradeController> | undefined;
const activityEntries: ActivityEntry[] = [];
const tracedTradeMessages = new Set<string>();
const tracedTradeCheckpoints = new Set<string>();

function log(message: string): void {
  trace("Activity", message);
}

function trace(label: string, title: string, details: ActivityDetail[] = []): void {
  activityEntries.unshift({ at: Date.now(), label, title, details });
  activityEntries.splice(100);
  renderActivityLog(activity, activityEntries);
}

function shortIdentifier(value: string): ActivityDetail {
  return { label: "id", value: `${value.slice(0, 8)}…`, title: value };
}

function publicNpub(label: string, pubkey: string): ActivityDetail {
  const npub = nip19.npubEncode(pubkey);
  return { label, value: `${npub.slice(0, 12)}…${npub.slice(-8)}`, title: npub };
}

function tradeTrace(trade: PublicTradeView): void {
  const checkpointKey = `${trade.sessionId}:${trade.revision}:${trade.phase}`;
  if (!tracedTradeCheckpoints.has(checkpointKey)) {
    tracedTradeCheckpoints.add(checkpointKey);
    trace("Protocol", "Trade checkpoint accepted", [
      { label: "role", value: trade.role },
      { label: "phase", value: trade.phase },
      shortIdentifier(trade.sessionId),
      shortIdentifier(trade.reservationId),
      { label: "order address", value: `${trade.orderAddress.slice(0, 22)}…`, title: trade.orderAddress },
      shortIdentifier(trade.offeredProjectionId),
      ...(trade.protocol.localNostrPubkey === null
        ? []
        : [publicNpub("local npub", trade.protocol.localNostrPubkey)]),
      publicNpub("order npub", trade.protocol.orderAuthorityPubkey),
      ...(trade.protocol.counterpartyNostrPubkey === null
        ? []
        : [publicNpub("counterparty", trade.protocol.counterpartyNostrPubkey)])
    ]);
  }

  const inboxKey = `${trade.sessionId}:${trade.protocol.inbox.registrationEventId}:${trade.protocol.inbox.status}`;
  if (!tracedTradeCheckpoints.has(inboxKey) && trade.protocol.inbox.status !== "unregistered") {
    tracedTradeCheckpoints.add(inboxKey);
    trace("Inbox", "Private inbox checkpoint", [
      { label: "status", value: trade.protocol.inbox.status },
      ...(trade.protocol.inbox.registrationEventId === null
        ? []
        : [shortIdentifier(trade.protocol.inbox.registrationEventId)]),
      { label: "relays", value: String(trade.protocol.inbox.relayCount) },
      { label: "acks", value: String(trade.protocol.inbox.acknowledgements) },
      ...(trade.protocol.localNostrPubkey === null
        ? []
        : [publicNpub("recipient", trade.protocol.localNostrPubkey)])
    ]);
  }

  for (const message of trade.protocol.messages) {
    const messageKey = `${trade.sessionId}:${message.messageId}`;
    if (tracedTradeMessages.has(messageKey)) continue;
    tracedTradeMessages.add(messageKey);
    trace("DM", `${message.type ?? "Private message"} accepted`, [
      { label: "sequence", value: message.sequence },
      shortIdentifier(message.messageId),
      shortIdentifier(message.rumorId),
      shortIdentifier(message.transcriptHash),
      ...(message.authorPubkey === undefined ? [] : [publicNpub("from", message.authorPubkey)]),
      ...(message.recipientPubkey === undefined ? [] : [publicNpub("to", message.recipientPubkey)])
    ]);
  }
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
  renderWalletSummary(walletSummary, next);
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
    onError: (message) => report(message, true),
    onMakerError: (message) => report(message, true)
  }));
  return tradeControllerPromise;
}

function advanceTrade(sessionId: string): void {
  void granola.advanceTrade(sessionId)
    .then(async (trade) => {
      await Promise.all([refreshTrades(), refreshOrderBook(), refresh()]);
      tradeTrace(trade);
      report(`Completed one checkpointed ${trade.role} action`);
    })
    .catch((error: unknown) => report(messageOf(error), true));
}

async function refreshTrades(): Promise<void> {
  const controller = await tradeController();
  const current = await controller.resume();
  current.forEach(tradeTrace);
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
    tradeTrace(trade);
    report("Swap session persisted; advance one verified action at a time");
  }).catch((error: unknown) => report(messageOf(error), true));
}

function retryPendingPublication(orderId: string): void {
  void granola.retryOrderPublication(orderId)
    .then(async (publication) => {
      await Promise.all([
        refreshOrderBook(),
        refreshPendingPublications(),
        syncMakerInboxes()
      ]);
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
    await Promise.all([
      refreshOrderBook(),
      refreshPendingPublications(),
      syncMakerInboxes()
    ]);
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

if (!hasNativeWebLocks()) {
  log("Web Locks API unavailable. Using single-tab mode; keep this wallet profile in one tab. Use HTTPS and a browser with Web Locks for multi-tab workflows.");
  report("Web Locks unavailable: single-tab mode enabled. Do not open this wallet profile in another tab.");
}

let makerInboxStartPromise: Promise<void> | undefined;
let makerInboxResyncQueued = false;

async function syncMakerInboxes(): Promise<void> {
  const publicKeys = await granola.getMakerPublicKeys();
  if (publicKeys.length === 0) {
    return;
  }
  await startMakerInbox();
}

function startMakerInbox(): Promise<void> {
  if (makerInboxStartPromise !== undefined) {
    makerInboxResyncQueued = true;
    const current = makerInboxStartPromise;
    return current.then(() => {
      if (!makerInboxResyncQueued) return;
      makerInboxResyncQueued = false;
      return startMakerInbox();
    });
  }
  makerInboxStartPromise = granola.enableMaker()
    .then(({ makerPubkey, inboxRelay }) => {
      if (!makerPubkey) {
        return;
      }
      trace("Nostr", "Maker listener ready", [
        { label: "meaning", value: "public order authority for maker inbox discovery" },
        publicNpub("order npub", makerPubkey),
        { label: "relay", value: new URL(inboxRelay).host }
      ]);
      report("Maker listener is authenticated and listening");
    })
    .catch((error: unknown) => {
      report(messageOf(error), true);
    })
    .finally(() => {
      makerInboxStartPromise = undefined;
    });
  return makerInboxStartPromise;
}

function defaultMintForUnit(unit: QuickMintRequest["unit"]): string {
  return unit === "usd"
    ? "https://nofee.testnut.cashu.space"
    : "https://testnut.cashu.space";
}

async function requestAndClaimMint(input: {
  mintUrl: string;
  unit: string;
  amount: string;
}): Promise<void> {
  const quote = await granola.requestMint(input);
  log(`Mint quote requested for ${formatUnitAmount(quote.amount, quote.unit)} from ${new URL(quote.mintUrl).host}`);
  report("Quote created; waiting for the fake mint to mark it paid");

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    const state = await granola.claimMint(quote.ref);
    await refresh(state);
    const current = state.quotes.find((item) => item.ref === quote.ref);
    if (current?.state === "ISSUED") {
      log(`Received ${formatUnitAmount(current.amount, current.unit)} of fake test ecash`);
      report("Fake test tokens added to this browser wallet");
      return;
    }
  }
  throw new Error("The quote did not become paid within 60 seconds");
}

renderMintActions(byId("mint-actions"), (request) => {
  void requestAndClaimMint({
    ...request,
    mintUrl: defaultMintForUnit(request.unit)
  }).catch((error: unknown) => report(messageOf(error), true));
});

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

byId("profile-label").textContent = profile === "default"
  ? "Local browser wallet"
  : `Local wallet workspace: ${profile}`;
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
const orderForm = byId<HTMLFormElement>("order-form");
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
    trace("Order", "Public order published", [
      { label: "side", value: side },
      shortIdentifier(publication.orderId),
      shortIdentifier(publication.projectionId),
      { label: "revision", value: publication.revision },
      publicNpub("order npub", publication.makerPubkey),
      { label: "relay acks", value: String(acknowledgements) }
    ]);
    await Promise.all([refreshOrderBook(), refreshPendingPublications()]);
    report(`Order published with ${acknowledgements} relay acknowledgements`);
  })().catch(async (error: unknown) => {
    await refreshPendingPublications();
    report(messageOf(error), true);
  });
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

byId("clear-wallet").addEventListener("click", () => {
  void granola.clearWallet("DELETE TEST WALLET")
    .then(async () => { await refresh(); log("Erased this profile’s local wallet"); report("Local wallet erased"); })
    .catch((error: unknown) => report(messageOf(error), true));
});

byId("reset-profile").addEventListener("click", () => {
  void granola.resetProfile("RESET GRANOLA PROFILE")
    .then(() => window.location.reload())
    .catch((error: unknown) => report(messageOf(error), true));
});

void Promise.all([
  refresh(),
  refreshOrderBook(),
  refreshPendingPublications(),
  startInboxListeners({
    startSessions: refreshTrades,
    startMaker: syncMakerInboxes
  }),
])
  .then(() => log("Opened the shared maker/taker workspace"))
  .catch((error: unknown) => report(messageOf(error), true));

window.addEventListener("pagehide", () => {
  void tradeControllerPromise?.then((controller) => controller.stop()).catch(() => undefined);
  relayClient.dispose();
}, { once: true });
