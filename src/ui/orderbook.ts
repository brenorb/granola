import type {
  ExactMarket,
  OrderBook,
  OrderRecord
} from "../order/model.js";

export type OrderBookRenderState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; book: OrderBook };

export interface OrderBookRenderOptions {
  onTake?: (order: OrderRecord, fillBaseAmount: string) => void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  return node;
}

function groupedInteger(value: string): string {
  const sign = value.startsWith("-") ? "−" : "";
  const unsigned = value.startsWith("-") ? value.slice(1) : value;
  return `${sign}${unsigned.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function fiatPerBtc(priceCentsPerBtc: string): string {
  const cents = BigInt(priceCentsPerBtc);
  const unsigned = cents < 0n ? -cents : cents;
  const whole = unsigned / 100n;
  const fraction = (unsigned % 100n).toString().padStart(2, "0");
  return `${cents < 0n ? "−" : ""}${groupedInteger(whole.toString())}.${fraction}`;
}

function priceLabel(market: ExactMarket): string {
  return `${market.quoteUnit.toUpperCase()}/BTC`;
}

function priceCell(order: OrderRecord, market: ExactMarket): HTMLTableCellElement {
  const cell = element("td");
  const price = order.state.price_cents_per_btc;
  const displayed = element("data", `${fiatPerBtc(price)} ${priceLabel(market)}`);
  displayed.dataset.price = "true";
  displayed.dataset.priceCentsPerBtc = price;
  displayed.setAttribute("value", price);
  cell.append(displayed);
  return cell;
}

function orderRow(
  order: OrderRecord,
  market: ExactMarket,
  best: "ask" | "bid" | undefined,
  options: OrderBookRenderOptions
): HTMLTableRowElement {
  const row = element("tr");
  row.className = `order-row order-row--${order.state.side === "sell" ? "ask" : "bid"}`;
  row.dataset.orderId = order.state.order_id;
  if (best !== undefined) row.dataset.best = best;

  const side = order.state.side === "sell" ? "Ask" : "Bid";
  const sideHeader = element("th", best ? `Best ${side.toLowerCase()}` : side);
  sideHeader.scope = "row";
  row.append(sideHeader);
  row.append(priceCell(order, market));
  row.append(
    element(
      "td",
      `${groupedInteger(order.state.remaining_amount)} ${market.baseUnit.toUpperCase()}`
    )
  );
  row.append(
    element(
      "td",
      order.state.execution === "all_or_none" ? "All or none" : "Partial fill"
    )
  );
  const expiry = element("td");
  const time = element("time", new Date(order.state.expires_at * 1000).toISOString());
  time.dateTime = new Date(order.state.expires_at * 1000).toISOString();
  expiry.append(time);
  row.append(expiry);
  const action = element("td");
  const amount = element("input");
  amount.type = "text";
  amount.inputMode = "numeric";
  amount.pattern = "[0-9]+";
  amount.value = order.state.remaining_amount;
  amount.dataset.takeAmount = "true";
  amount.setAttribute(
    "aria-label",
    `Base amount to take in ${market.baseUnit.toUpperCase()}`
  );
  const take = element("button", `Take ${order.state.side === "sell" ? "ask" : "bid"}`);
  take.type = "button";
  take.className = "quiet";
  take.dataset.takeOrder = "true";
  take.disabled = !order.verified || options.onTake === undefined;
  if (options.onTake) take.addEventListener("click", () => {
    amount.setCustomValidity("");
    if (!/^[1-9]\d*$/.test(amount.value)) {
      amount.setCustomValidity("Enter a positive whole-number amount.");
    } else {
      const fill = BigInt(amount.value);
      const remaining = BigInt(order.state.remaining_amount);
      const minimum = BigInt(order.state.minimum_fill_amount);
      if (fill > remaining) {
        amount.setCustomValidity("The fill cannot exceed the remaining amount.");
      } else if (
        order.state.execution === "all_or_none" &&
        fill !== remaining
      ) {
        amount.setCustomValidity("This all-or-none order requires the full remaining amount.");
      } else if (
        order.state.execution === "partial" &&
        fill < minimum
      ) {
        amount.setCustomValidity(`The minimum partial fill is ${minimum.toString()}.`);
      } else if (
        order.state.execution === "partial" &&
        remaining - fill > 0n &&
        remaining - fill < minimum
      ) {
        amount.setCustomValidity("This fill would leave less than the order minimum.");
      }
    }
    if (!amount.reportValidity()) return;
    options.onTake?.(order, amount.value);
  });
  action.append(amount, take);
  row.append(action);
  return row;
}

function summaryValue(
  name: string,
  order: OrderRecord | undefined,
  market: ExactMarket
): HTMLElement {
  const value = element("dd");
  value.dataset.summary = name;
  if (order === undefined) {
    value.textContent = "—";
    return value;
  }
  const price = order.state.price_cents_per_btc;
  value.textContent = `${fiatPerBtc(price)} ${priceLabel(market)}`;
  value.dataset.priceCentsPerBtc = price;
  return value;
}

function renderSummary(book: OrderBook): HTMLElement {
  const summary = element("dl");
  summary.className = "orderbook-summary";

  summary.append(element("dt", "Best bid"));
  summary.append(summaryValue("best-bid", book.topBid, book.market));
  summary.append(element("dt", "Best ask"));
  summary.append(summaryValue("best-ask", book.topAsk, book.market));
  summary.append(element("dt", "Spread"));

  const spreadValue = element("dd", "—");
  spreadValue.dataset.summary = "spread";
  if (book.topAsk && book.topBid) {
    const spread =
      BigInt(book.topAsk.state.price_cents_per_btc) -
      BigInt(book.topBid.state.price_cents_per_btc);
    spreadValue.textContent = `${fiatPerBtc(spread.toString())} ${priceLabel(book.market)}`;
    spreadValue.dataset.spreadCentsPerBtc = spread.toString();
  }
  summary.append(spreadValue);
  return summary;
}

function midpointText(book: OrderBook): string {
  if (!book.topAsk || !book.topBid) return "Inside market unavailable";
  const spread =
    BigInt(book.topAsk.state.price_cents_per_btc) -
    BigInt(book.topBid.state.price_cents_per_btc);
  return `Spread ${fiatPerBtc(spread.toString())} ${priceLabel(book.market)}`;
}

function renderReady(root: HTMLElement, book: OrderBook, options: OrderBookRenderOptions): void {
  if (book.asks.length === 0 && book.bids.length === 0) {
    const empty = element("div");
    empty.className = "empty-state";
    empty.append(element("h2", "No open orders for this issuer pair"));
    empty.append(element("p", "The book will update when verified makers publish orders."));
    root.append(empty);
    return;
  }

  root.append(renderSummary(book));
  const table = element("table");
  table.className = "orderbook-table";
  table.append(
    element(
      "caption",
      `${book.market.baseUnit.toUpperCase()} / ${book.market.quoteUnit.toUpperCase()} order book`
    )
  );
  const head = element("thead");
  const headers = element("tr");
  for (const label of ["Side", "Limit price", "Remaining", "Execution", "Expires (UTC)", "Action"]) {
    const header = element("th", label);
    header.scope = "col";
    headers.append(header);
  }
  head.append(headers);
  table.append(head);

  const asks = element("tbody");
  asks.className = "orderbook-asks";
  asks.setAttribute("aria-label", "Asks");
  for (const order of [...book.asks].reverse()) {
    asks.append(
      orderRow(order, book.market, order.address === book.topAsk?.address ? "ask" : undefined, options)
    );
  }
  table.append(asks);

  const midpoint = element("tbody");
  midpoint.className = "orderbook-midpoint";
  const midpointRow = element("tr");
  midpointRow.dataset.bookMidpoint = "true";
  const midpointCell = element("td", midpointText(book));
  midpointCell.colSpan = 6;
  midpointRow.append(midpointCell);
  midpoint.append(midpointRow);
  table.append(midpoint);

  const bids = element("tbody");
  bids.className = "orderbook-bids";
  bids.setAttribute("aria-label", "Bids");
  for (const order of book.bids) {
    bids.append(
      orderRow(order, book.market, order.address === book.topBid?.address ? "bid" : undefined, options)
    );
  }
  table.append(bids);

  const scroller = element("div");
  scroller.className = "table-scroll";
  scroller.append(table);
  root.append(scroller);
}

export function renderOrderBook(
  root: HTMLElement,
  state: OrderBookRenderState,
  options: OrderBookRenderOptions = {}
): void {
  root.replaceChildren();
  root.setAttribute("aria-live", "polite");
  root.removeAttribute("role");
  root.setAttribute("aria-busy", state.status === "loading" ? "true" : "false");

  if (state.status === "loading") {
    root.append(element("p", "Loading order book…"));
    return;
  }
  if (state.status === "error") {
    root.setAttribute("role", "alert");
    root.setAttribute("aria-live", "assertive");
    root.append(element("p", state.message));
    return;
  }
  renderReady(root, state.book, options);
}
