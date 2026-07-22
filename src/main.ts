import { GranolaApi, QuoteRepository, type BrowserGranolaApi, type GranolaState } from "./api/granola-api.js";
import { withWalletLock } from "./browser/lock.js";
import { profileFromLocation, storageNameForProfile } from "./browser/profile.js";
import { CashuClient } from "./cashu/client.js";
import { IndexedDbStorageDriver, WalletRepository } from "./storage/wallet-repository.js";
import { renderDashboard } from "./ui/dashboard.js";
import { formatUnitAmount } from "./ui/format.js";

interface GranolaBrowserFacade {
  getState: BrowserGranolaApi["getState"];
  inspectMint: BrowserGranolaApi["inspectMint"];
  inspectToken: BrowserGranolaApi["inspectToken"];
  requestMint: BrowserGranolaApi["requestMint"];
  claimMint: BrowserGranolaApi["claimMint"];
  receiveToken: BrowserGranolaApi["receiveToken"];
  createBackup: BrowserGranolaApi["createBackup"];
  clearWallet: BrowserGranolaApi["clearWallet"];
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
const api = new GranolaApi(new WalletRepository(driver), new QuoteRepository(driver), new CashuClient());
const dashboard = byId("dashboard");
const status = byId("status");
const activity = byId<HTMLOListElement>("activity-log");

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

const locked = <T>(action: () => Promise<T>): Promise<T> => withWalletLock(profile, action);
const granola: GranolaBrowserFacade = {
  getState: api.getState.bind(api),
  inspectMint: api.inspectMint.bind(api),
  inspectToken: api.inspectToken.bind(api),
  requestMint: (input) => locked(() => api.requestMint(input)),
  claimMint: (ref) => locked(() => api.claimMint(ref)),
  receiveToken: (token, options) => locked(() => api.receiveToken(token, options)),
  createBackup: () => locked(() => api.createBackup()),
  clearWallet: (confirmation) => locked(() => api.clearWallet(confirmation))
};
window.granola = granola;

byId("profile-label").textContent = `Wallet profile: ${profile}`;
byId("refresh").addEventListener("click", () => {
  void refresh().then(() => report("Wallet state refreshed")).catch((error: unknown) => report(messageOf(error), true));
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
    const state = await granola.receiveToken(token, { acceptMint: byId<HTMLInputElement>("accept-mint").checked });
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

void refresh().then(() => log(`Opened isolated wallet profile “${profile}”`)).catch((error: unknown) => report(messageOf(error), true));
