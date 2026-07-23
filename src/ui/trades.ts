import { nip19 } from "nostr-tools";

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

function identity(label: string, value: string | null): HTMLElement {
  const item = element("li");
  item.append(element("span", label));
  if (value === null) {
    item.append(element("strong", "Waiting for authenticated session"));
    return item;
  }
  const npub = nip19.npubEncode(value);
  const rendered = element("strong", `${npub.slice(0, 12)}…${npub.slice(-8)}`);
  rendered.title = npub;
  item.append(rendered);
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
    card.dataset.tradeRole = trade.role;
    const heading = element("div");
    heading.className = "trade-card__heading";
    const role = element(
      "p",
      `${trade.role === "maker" ? "Maker" : "Taker"} session · ${trade.reservationId.slice(0, 8)}…`
    );
    role.className = `trade-card__role trade-card__role--${trade.role}`;
    heading.append(role);
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

    const protocol = element("ul");
    protocol.className = "trade-protocol-summary";
    protocol.append(identity("Local npub", trade.protocol.localNostrPubkey));
    protocol.append(identity("Counterparty npub", trade.protocol.counterpartyNostrPubkey));
    const messages = element("li");
    messages.append(element("span", "DMs"));
    messages.append(element("strong", `${trade.protocol.messages.length} accepted`));
    protocol.append(messages);
    card.append(protocol);

    const advance = element("button", "Advance safely");
    advance.type = "button";
    advance.dataset.advanceTrade = "true";
    advance.disabled = options.onAdvance === undefined || ["filled", "released", "frozen"].includes(trade.phase);
    if (options.onAdvance) advance.addEventListener("click", () => options.onAdvance?.(trade.sessionId));
    card.append(advance);
    root.append(card);
  }
}
