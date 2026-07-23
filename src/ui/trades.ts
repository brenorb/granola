import type { PublicTradeView } from "../trade/session.js";

export interface TradeRenderOptions {
  onAdvance?: (sessionId: string) => void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  return node;
}

function phaseLabel(phase: PublicTradeView["phase"]): string {
  return phase.split("_").map((part, index) =>
    index === 0 ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : part
  ).join(" ");
}

function liability(label: string, amount: string, unit: string, mint: string): HTMLElement {
  const item = element("li");
  item.append(element("span", label));
  item.append(element("strong", `${amount} ${unit.toUpperCase()}`));
  item.append(element("small", new URL(mint).host));
  return item;
}

export function renderTrades(
  root: HTMLElement,
  trades: PublicTradeView[],
  options: TradeRenderOptions = {}
): void {
  root.replaceChildren();
  root.setAttribute("aria-live", "polite");
  if (trades.length === 0) {
    const empty = element("div");
    empty.className = "empty-state";
    empty.append(element("h3", "No active swap sessions"));
    empty.append(element("p", "Take a verified order to negotiate an atomic testnet exchange."));
    root.append(empty);
    return;
  }

  for (const trade of trades) {
    const card = element("article");
    card.className = "trade-card";
    card.dataset.tradeSession = trade.sessionId;
    const heading = element("div");
    heading.className = "trade-card__heading";
    heading.append(element("p", `${trade.role === "maker" ? "Maker" : "Taker"} · ${trade.reservationId.slice(0, 8)}…`));
    heading.append(element("h3", phaseLabel(trade.phase)));
    card.append(heading);

    const liabilities = element("ul");
    liabilities.className = "trade-liabilities";
    liabilities.append(liability("Base", trade.terms.baseAmount, trade.terms.baseUnit, trade.terms.baseMint));
    liabilities.append(liability("Quote", trade.terms.quoteAmount, trade.terms.quoteUnit, trade.terms.quoteMint));
    card.append(liabilities);

    const progress = element("p", trade.evidence.mintStates.length > 0
      ? trade.evidence.mintStates.join(" · ")
      : "Waiting for verified mint state");
    progress.className = "trade-card__state";
    card.append(progress);

    const advance = element("button", "Advance safely");
    advance.type = "button";
    advance.dataset.advanceTrade = "true";
    advance.disabled = options.onAdvance === undefined || ["filled", "released", "frozen"].includes(trade.phase);
    if (options.onAdvance) advance.addEventListener("click", () => options.onAdvance?.(trade.sessionId));
    card.append(advance);
    root.append(card);
  }
}
