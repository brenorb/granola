import { nip19 } from "nostr-tools";

import type { TradeMessageType } from "../trade/messages.js";
import type { PublicTradeView } from "../trade/session.js";

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

const MESSAGE_COPY: Record<TradeMessageType, {
  title: string;
  meaning: string;
}> = {
  reserve_propose: {
    title: "Order taken",
    meaning: "The taker commits to this exact order, amount, and settlement identity."
  },
  reserve_accept: {
    title: "Accepted · offer locked",
    meaning: "The maker accepts and sends the verifiable HTLC containing the offered ecash."
  },
  reserve_reject: {
    title: "Reservation rejected",
    meaning: "The maker declines the reservation request."
  },
  session_ack: {
    title: "Session acknowledged",
    meaning: "The taker confirms the private settlement session and its terms."
  },
  base_lock: {
    title: "Base locked",
    meaning: "The base-side ecash is locked and its verifiable commitment is shared."
  },
  base_lock_ack: {
    title: "Base lock verified",
    meaning: "The counterparty verifies the base-side lock."
  },
  quote_lock: {
    title: "Payment locked",
    meaning: "The taker sends the matching payment HTLC; mint state now drives settlement."
  },
  quote_lock_ack: {
    title: "Quote lock verified",
    meaning: "The counterparty verifies the quote-side lock."
  },
  claim_notice: {
    title: "Claim observed",
    meaning: "A mint observation proves that one side of the swap was claimed."
  },
  ack: {
    title: "Message acknowledged",
    meaning: "The counterparty confirms receipt of the preceding protocol message."
  },
  abort: {
    title: "Swap aborted",
    meaning: "The session requests the protocol-safe abort and recovery path."
  },
  fill_request: {
    title: "Fill requested",
    meaning: "The completed private settlement requests the public order fill."
  },
  settlement_ack: {
    title: "Settlement complete",
    meaning: "The counterparty confirms that the atomic swap settled."
  },
  refund: {
    title: "Refund observed",
    meaning: "A timed-out settlement leg was safely refunded."
  },
  error: {
    title: "Protocol error",
    meaning: "The counterparty reports a protocol validation or settlement error."
  }
};

function fullNpub(value: string | undefined): string {
  if (value === undefined || !/^[0-9a-f]{64}$/.test(value)) {
    return "Unavailable";
  }
  return nip19.npubEncode(value);
}

function technicalValue(label: string, value: string): HTMLElement {
  const row = element("div");
  row.append(element("dt", label));
  row.append(element("dd", value));
  return row;
}

function messageDirection(
  trade: PublicTradeView,
  authorPubkey: string | undefined,
  recipientPubkey: string | undefined
): string {
  if (
    trade.protocol.localNostrPubkey !== null &&
    authorPubkey === trade.protocol.localNostrPubkey
  ) return "Sent by you";
  if (
    trade.protocol.localNostrPubkey !== null &&
    recipientPubkey === trade.protocol.localNostrPubkey
  ) return "Received by you";
  return "Authenticated private message";
}

function messageTranscript(trade: PublicTradeView): HTMLOListElement {
  const transcript = element("ol");
  transcript.className = "trade-dm-list";
  for (const message of trade.protocol.messages) {
    const copy = message.type === undefined
      ? {
          title: "Private protocol message",
          meaning: "An authenticated legacy protocol message was accepted."
        }
      : MESSAGE_COPY[message.type];
    const item = element("li");
    item.className = "trade-dm";

    const heading = element("div");
    heading.className = "trade-dm__heading";
    heading.append(element("span", `DM ${message.sequence}`));
    heading.append(element(
      "small",
      messageDirection(trade, message.authorPubkey, message.recipientPubkey)
    ));
    item.append(heading);
    item.append(element("h4", copy.title));
    item.append(element("p", copy.meaning));

    const envelope = element("details");
    envelope.className = "trade-dm__envelope";
    envelope.append(element("summary", "Read technical envelope"));
    const values = element("dl");
    values.append(
      technicalValue("From", fullNpub(message.authorPubkey)),
      technicalValue("To", fullNpub(message.recipientPubkey)),
      technicalValue("Message ID", message.messageId),
      technicalValue("Rumor ID", message.rumorId),
      technicalValue("Transcript hash", message.transcriptHash)
    );
    envelope.append(values);
    item.append(envelope);
    transcript.append(item);
  }
  return transcript;
}

function showDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

function dmViewer(trade: PublicTradeView): {
  trigger: HTMLButtonElement;
  dialog: HTMLDialogElement;
} {
  const dialog = element("dialog");
  const dialogId = `trade-dms-${trade.sessionId}`;
  dialog.id = dialogId;
  dialog.className = "trade-dm-dialog";
  dialog.dataset.dmSession = trade.sessionId;
  dialog.setAttribute("aria-labelledby", `${dialogId}-title`);

  const header = element("header");
  const heading = element("div");
  heading.append(element("p", `${trade.protocol.messages.length} authenticated DMs`));
  const title = element("h3", "Private protocol transcript");
  title.id = `${dialogId}-title`;
  heading.append(title);
  const close = element("button", "Close");
  close.className = "quiet trade-dm-dialog__close";
  close.type = "button";
  close.addEventListener("click", () => closeDialog(dialog));
  header.append(heading, close);
  dialog.append(header);

  if (trade.protocol.messages.length === 0) {
    const empty = element("p", "No authenticated private messages have been accepted yet.");
    empty.className = "trade-dm-dialog__empty";
    dialog.append(empty);
  } else {
    dialog.append(messageTranscript(trade));
  }
  const privacy = element(
    "p",
    "Spendable tokens, preimages, and private keys are intentionally omitted."
  );
  privacy.className = "trade-dm-dialog__privacy";
  dialog.append(privacy);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });

  const trigger = element("button");
  trigger.type = "button";
  trigger.className = "trade-dms-trigger";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-controls", dialogId);
  trigger.append(element("span", "DMs"));
  trigger.append(element("strong", `${trade.protocol.messages.length} accepted`));
  trigger.append(element("small", "Read →"));
  trigger.addEventListener("click", () => showDialog(dialog));

  return { trigger, dialog };
}

export function renderTrades(
  root: HTMLElement,
  trades: PublicTradeView[]
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
    messages.className = "trade-protocol-summary__messages";
    const viewer = dmViewer(trade);
    messages.append(viewer.trigger);
    protocol.append(messages);
    card.append(protocol);
    card.append(viewer.dialog);

    root.append(card);
  }
}
