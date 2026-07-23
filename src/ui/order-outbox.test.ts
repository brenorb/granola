import { describe, expect, it, vi } from "vitest";

import type { PublicOrderPublication } from "../api/order-api.js";
import { renderPendingPublications } from "./order-outbox.js";

const pending: PublicOrderPublication = {
  orderId: "11111111-1111-4111-8111-111111111111",
  makerPubkey: "a".repeat(64),
  transitionId: "b".repeat(64),
  projectionId: "c".repeat(64),
  transitionReceipts: [
    { relay: "wss://one.example", ok: true, message: "stored" },
    { relay: "wss://two.example", ok: false, message: "blocked" }
  ],
  projectionReceipts: []
};

describe("pending order publications", () => {
  it("renders an actionable, secret-free retry without hiding partial success", () => {
    const root = document.createElement("section");
    const retry = vi.fn();

    renderPendingPublications(root, [pending], retry);

    expect(root.hidden).toBe(false);
    expect(root.textContent).toContain("1/3 transition relay acknowledgements");
    expect(root.textContent).toContain("11111111…11111111");
    expect(root.textContent).not.toContain(pending.makerPubkey);
    root.querySelector("button")?.click();
    expect(retry).toHaveBeenCalledWith(pending.orderId);
  });

  it("hides the outbox when no retry is pending", () => {
    const root = document.createElement("section");
    renderPendingPublications(root, [], () => undefined);
    expect(root.hidden).toBe(true);
    expect(root.textContent).toBe("");
  });
});
