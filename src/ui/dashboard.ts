import type { GranolaState } from "../api/granola-api.js";
import { formatUnitAmount } from "./format.js";

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  return node;
}

function mintHost(mintUrl: string): string {
  return new URL(mintUrl).host;
}

export function renderWalletSummary(root: HTMLElement, state: GranolaState): void {
  root.replaceChildren();
  root.setAttribute("aria-live", "polite");

  const summary = element("div");
  summary.className = "wallet-summary";
  for (const unit of ["sat", "usd"] as const) {
    const balance = state.wallet.balances.find((item) => item.unit === unit);
    const cell = element("article");
    cell.className = "wallet-summary__balance";
    cell.dataset.balanceUnit = unit;
    cell.append(element("span", `${unit.toUpperCase()} balance`));
    cell.append(element("strong", balance ? formatUnitAmount(balance.amount, unit) : "No balance"));
    summary.append(cell);
  }
  root.append(summary);
}

export function renderDashboard(root: HTMLElement, state: GranolaState): void {
  root.replaceChildren();
  root.setAttribute("aria-live", "polite");

  if (state.wallet.balances.length === 0) {
    const empty = element("div");
    empty.className = "empty-state";
    empty.append(element("h2", "No ecash yet"));
    empty.append(element("p", "Mint fake test tokens or receive a Cashu token to start."));
    root.append(empty);
    return;
  }

  const balances = element("div");
  balances.className = "balance-grid";
  for (const balance of state.wallet.balances) {
    const card = element("article");
    card.className = "balance-card";
    card.dataset.balanceUnit = balance.unit;
    card.append(element("span", balance.unit.toUpperCase()));
    card.append(element("strong", formatUnitAmount(balance.amount, balance.unit)));
    card.append(
      element(
        "small",
        `${balance.proofCount} proof${balance.proofCount === 1 ? "" : "s"} · ` +
          `${balance.mintCount} mint${balance.mintCount === 1 ? "" : "s"}`
      )
    );
    balances.append(card);
  }
  root.append(balances);

  const table = element("table");
  table.append(element("caption", "Bearer proof inventory by mint and unit"));
  const head = element("thead");
  const header = element("tr");
  for (const label of ["Mint", "Unit", "Balance", "Proofs", "Denominations"]) {
    header.append(element("th", label));
  }
  head.append(header);
  table.append(head);

  const body = element("tbody");
  for (const pocket of state.wallet.pockets) {
    const row = element("tr");
    row.append(element("td", mintHost(pocket.mintUrl)));
    row.append(element("td", pocket.unit.toUpperCase()));
    row.append(element("td", formatUnitAmount(pocket.amount, pocket.unit)));
    row.append(element("td", String(pocket.proofCount)));
    row.append(
      element(
        "td",
        pocket.denominations
          .map((amount) => groupDenomination(amount))
          .join(" · ")
      )
    );
    body.append(row);
  }
  table.append(body);

  const scroller = element("div");
  scroller.className = "table-scroll";
  scroller.append(table);
  root.append(scroller);
}

function groupDenomination(amount: string): string {
  return amount.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
