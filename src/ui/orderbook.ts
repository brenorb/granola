import type {
  ExactMarket,
  OrderBook,
  OrderRecord
} from "../order/model.js";
import { beginButtonFeedback } from "./button-feedback.js";

const COLLAPSED_ORDER_COUNT = 3;

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
  const displayed = element("data", fiatPerBtc(price));
  displayed.dataset.price = "true";
  displayed.dataset.priceCentsPerBtc = price;
  displayed.setAttribute("value", price);
  displayed.title = `${fiatPerBtc(price)} ${priceLabel(market)}`;
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
      groupedInteger(order.state.remaining_amount)
    )
  );
  row.cells[1]?.setAttribute(
    "title",
    `${groupedInteger(order.state.remaining_amount)} ${market.baseUnit.toUpperCase()} remaining`
  );
  const action = element("td");
  action.className = "order-action";
  const controls = element("div");
  controls.className = "order-action__controls";
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
    order.state.side === "sell" ? "Buy" : "Sell"
  );
  take.type = "button";
  take.className = "quiet";
  take.dataset.takeOrder = "true";
  take.setAttribute(
    "aria-label",
    `${order.state.side === "sell" ? "Buy from ask" : "Sell into bid"}`
  );
  take.disabled = !order.verified || options.onTake === undefined;
  if (options.onTake) take.addEventListener("click", () => {
    validateTakeAmount(amount, order);
    if (!amount.reportValidity()) return;
    beginButtonFeedback(take, "Settling…");
    options.onTake?.(order, amount.value, take);
  });
  controls.append(amount, take);
  controls.append(orderInfo(
    order,
    options.canCancel?.(order) && options.onCancel
      ? (cancel) => options.onCancel?.(order, cancel)
      : undefined
  ));
  action.append(controls);
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

  const spreadValue = element("dd", "—");
  spreadValue.dataset.summary = "spread";
  if (book.topAsk && book.topBid) {
    const spread =
      BigInt(book.topAsk.state.price_cents_per_btc) -
      BigInt(book.topBid.state.price_cents_per_btc);
    spreadValue.textContent = `${fiatPerBtc(spread.toString())} ${priceLabel(book.market)}`;
    spreadValue.dataset.spreadCentsPerBtc = spread.toString();
  }
  const entries: Array<[string, HTMLElement]> = [
    ["Best ask", summaryValue("best-ask", book.topAsk, book.market)],
    ["Spread", spreadValue],
    ["Best bid", summaryValue("best-bid", book.topBid, book.market)]
  ];
  for (const [label, value] of entries) {
    const item = element("div");
    item.append(element("dt", label), value);
    summary.append(item);
  }
  return summary;
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
  for (const headerLabel of [
    `Limit (${priceLabel(market)})`,
    "Left",
    "Trade"
  ]) {
    const header = element("th", headerLabel);
    header.scope = "col";
    headers.append(header);
  }
  head.append(headers);
  table.append(head);

  const body = element("tbody");
  body.className = `orderbook-${label.toLowerCase()}`;
  body.setAttribute("aria-label", label);
  const overflowRows: HTMLTableRowElement[] = [];
  orders.forEach((order, index) => {
    const row = orderRow(
      order,
      market,
      order.address === best?.address ? label === "Asks" ? "ask" : "bid" : undefined,
      options
    );
    if (index >= COLLAPSED_ORDER_COUNT) {
      row.hidden = true;
      overflowRows.push(row);
    }
    body.append(row);
  });
  table.append(body);

  const scroller = element("div");
  scroller.className = "table-scroll";
  scroller.append(table);
  section.append(scroller);
  if (overflowRows.length > 0) {
    const footer = element("footer");
    footer.className = "orderbook-side__footer";
    const count = element(
      "small",
      `${COLLAPSED_ORDER_COUNT} / ${orders.length} shown`
    );
    const toggle = element(
      "button",
      "See more"
    );
    toggle.type = "button";
    toggle.className = "quiet orderbook-toggle";
    toggle.dataset.orderbookToggle = label.toLowerCase();
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      for (const row of overflowRows) row.hidden = expanded;
      toggle.setAttribute("aria-expanded", String(!expanded));
      toggle.textContent = expanded
        ? "See more"
        : "See less";
      count.textContent = expanded
        ? `${COLLAPSED_ORDER_COUNT} / ${orders.length} shown`
        : `${orders.length} / ${orders.length} shown`;
    });
    footer.append(count, toggle);
    section.append(footer);
  }
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

  const frame = element("div");
  frame.className = "orderbook-frame";
  const marketStrip = element("aside");
  marketStrip.className = "orderbook-market-strip";
  marketStrip.dataset.bookMidpoint = "true";
  marketStrip.setAttribute("aria-label", "Inside market");
  marketStrip.append(renderSummary(book));
  const columns = element("div");
  columns.className = "orderbook-columns";
  columns.append(
    renderSideTable("Asks", book.asks, book.topAsk, book.market, options),
    renderSideTable("Bids", book.bids, book.topBid, book.market, options)
  );
  frame.append(marketStrip, columns);
  root.append(frame);
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
