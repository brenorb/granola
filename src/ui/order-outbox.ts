import type { PublicOrderPublication } from "../api/order-api.js";

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  return node;
}

function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

export function renderPendingPublications(
  root: HTMLElement,
  publications: PublicOrderPublication[],
  retry: (orderId: string) => void,
  relayCount = 3
): void {
  root.replaceChildren();
  root.hidden = publications.length === 0;
  if (publications.length === 0) return;

  root.append(element("h3", "Pending relay publication"));
  const list = element("ul");
  for (const publication of publications) {
    const acknowledgements = publication.receipts.filter((receipt) => receipt.ok).length;
    const item = element("li");
    const description = element(
      "span",
      `${shortId(publication.orderId)} · ${acknowledgements}/${relayCount} relay acknowledgements` +
      (acknowledgements > 0 ? " · sufficient" : "")
    );
    const button = element("button", "Retry same signed projection");
    button.type = "button";
    button.addEventListener("click", () => retry(publication.orderId));
    item.append(description, button);
    list.append(item);
  }
  root.append(list);
}
