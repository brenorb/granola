import type {
  ExactMarket,
  OrderBook,
  OrderRecord
} from "../order/model.js";
import { beginButtonFeedback } from "./button-feedback.js";

export type OrderBookRenderState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; book: OrderBook };

export interface OrderBookRenderOptions {
  onTake?: (order: OrderRecord, fillBaseAmount: string, button: HTMLButtonElement) => void;
  onCancel?: (order: OrderRecord, button: HTMLButtonElement) => void;
  canCancel?: (order: OrderRecord) => boolean;
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

function infoLine(label: string, value: string, title?: string): HTMLElement {
  const line = element("p");
  line.append(element("span", label), element("strong", value));
  if (title !== undefined) line.lastElementChild?.setAttribute("title", title);
  return line;
}

function orderInfo(
  order: OrderRecord,
  onCancel?: (button: HTMLButtonElement) => void
): HTMLDetailsElement {
  const details = element("details");
  details.className = "order-info";
  details.dataset.orderInfo = "true";
  const summary = element("summary", "i");
  summary.setAttribute("aria-label", "Show order details");
  summary.title = "Show order details";
  const popup = element("div");
  popup.className = "order-info__popup";
  const expiry = new Date(order.state.expires_at * 1000).toISOString();
  const execution = order.state.execution === "all_or_none"
    ? "AON"
    : "Partial";
  popup.append(
    infoLine(
      "Execution",
      execution,
      order.state.execution === "all_or_none" ? "All or none (AON)" : "Partial fill"
    ),
    infoLine("Expires", expiry),
    infoLine("Order", `${order.state.order_id.slice(0, 8)}…`, order.state.order_id)
  );
  if (onCancel) {
    const cancel = element("button", "Cancel order");
    cancel.type = "button";
    cancel.className = "quiet order-info__cancel";
    cancel.dataset.cancelOrder = "true";
    cancel.addEventListener("click", () => onCancel(cancel));
    popup.append(cancel);
  }
  details.append(summary, popup);
  return details;
}

function validateTakeAmount(amount: HTMLInputElement, order: OrderRecord): void {
  amount.setCustomValidity("");
  if (!/^[1-9]\d*$/.test(amount.value)) {
    amount.setCustomValidity("Enter a positive whole-number amount.");
    return;
  }
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

function orderRow(
  order: OrderRecord,
  market: ExactMarket,
  best: "ask" | "bid" | undefined,
  options: OrderBookRenderOptions
): HTMLTableRowElement {
  const row = element("tr");
  row.className = `order-row order-row--${order.state.side === "sell" ? "ask" : "bid"}`;
  row.dataset.orderId = order.state.order_id;
  const side = order.state.side === "sell" ? "Ask" : "Bid";
  row.setAttribute("aria-label", best ? `Best ${side.toLowerCase()}` : side);
  if (best !== undefined) row.dataset.best = best;
  row.append(priceCell(order, market));
  row.append(
    element(
      "td",
      `${groupedInteger(order.state.remaining_amount)} ${market.baseUnit.toUpperCase()}`
    )
  );
  const action = element("td");
  action.className = "order-action";
  const amount = element("input");
  amount.type = "text";
  amount.inputMode = "numeric";
  amount.pattern = "[0-9]+";
  amount.value = order.state.remaining_amount;
  amount.dataset.takeAmount = "true";
  amount.setAttribute(
    "aria-label",
    `Base amount to ${order.state.side === "sell" ? "buy" : "sell"} in ${market.baseUnit.toUpperCase()}`
  );
  const take = element(
    "button",
    order.state.side === "sell" ? "Take ask" : "Sell into bid"
  );
  take.type = "button";
  take.className = "quiet";
  take.dataset.takeOrder = "true";
  take.disabled = !order.verified || options.onTake === undefined;
  if (options.onTake) take.addEventListener("click", () => {
    validateTakeAmount(amount, order);
    if (!amount.reportValidity()) return;
    beginButtonFeedback(take, "Settling…");
    options.onTake?.(order, amount.value, take);
  });
  action.append(amount, take);
  action.append(orderInfo(
    order,
    options.canCancel?.(order) && options.onCancel
      ? (cancel) => options.onCancel?.(order, cancel)
      : undefined
  ));
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

function renderSideTable(
  label: "Asks" | "Bids",
  orders: OrderRecord[],
  best: OrderRecord | undefined,
  market: ExactMarket,
  options: OrderBookRenderOptions
): HTMLElement {
  const section = element("section");
  section.className = `orderbook-side orderbook-side--${label.toLowerCase()}`;
  const table = element("table");
  table.className = "orderbook-table";
  table.append(element("caption", label));
  const head = element("thead");
  const headers = element("tr");
  for (const headerLabel of ["Limit price", "Remaining", "Action"]) {
    const header = element("th", headerLabel);
    header.scope = "col";
    headers.append(header);
  }
  head.append(headers);
  table.append(head);

  const body = element("tbody");
  body.className = `orderbook-${label.toLowerCase()}`;
  body.setAttribute("aria-label", label);
  for (const order of orders) {
    body.append(orderRow(
      order,
      market,
      order.address === best?.address ? label === "Asks" ? "ask" : "bid" : undefined,
      options
    ));
  }
  table.append(body);

  const scroller = element("div");
  scroller.className = "table-scroll";
  scroller.append(table);
  section.append(scroller);
  return section;
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

  const columns = element("div");
  columns.className = "orderbook-columns";
  columns.append(
    renderSideTable("Asks", book.asks, book.topAsk, book.market, options)
  );

  const midpoint = element("aside");
  midpoint.className = "orderbook-midpoint";
  midpoint.dataset.bookMidpoint = "true";
  midpoint.append(renderSummary(book));
  midpoint.append(element("p", midpointText(book)));
  columns.append(midpoint);

  columns.append(renderSideTable("Bids", book.bids, book.topBid, book.market, options));
  root.append(columns);
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
