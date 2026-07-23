import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import type { PublicTradeView } from "../trade/session.js";
import { renderTrades } from "./trades.js";

const trade: PublicTradeView = {
  revision: 0,
  sessionId: "11".repeat(32),
  reservationId: "11111111-1111-4111-8111-111111111111",
  role: "taker",
  phase: "quote_locked",
  orderAddress: `30078:${"22".repeat(32)}:granola:order:v1:22222222-2222-4222-8222-222222222222`,
  offeredProjectionId: "33".repeat(32),
  offeredProjectionRevision: "0",
  reserveProjectionId: "44".repeat(32),
  reserveProjectionRevision: "1",
  fillProjectionId: null,
  fillProjectionRevision: null,
  pendingOrderPublication: null,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_010,
  protocol: {
    localNostrPubkey: null,
    orderAuthorityPubkey: "22".repeat(32),
    counterpartyNostrPubkey: "aa".repeat(32),
    inbox: {
      status: "registered",
      registrationEventId: "bb".repeat(32),
      relayCount: 3,
      acknowledgements: 3
    },
    messages: []
  },
  terms: {
    baseMint: "https://testnut.cashu.space",
    baseUnit: "sat",
    baseKeyset: "base-keyset",
    baseAmount: "20",
    quoteMint: "https://nofee.testnut.cashu.space",
    quoteUnit: "usd",
    quoteKeyset: "quote-keyset",
    quoteAmount: "1",
    priceCentsPerBtc: "5000000"
  },
  plan: {
    anchor: 1_700_000_000,
    shortLocktime: 1_700_000_600,
    makerClaimCutoff: 1_700_000_480,
    longLocktime: 1_700_001_200,
    takerClaimCutoff: 1_700_001_080,
    reservationExpiresAt: 1_700_001_800,
    refundGuardSeconds: 60
  },
  evidence: {
    makerPubkey: "22".repeat(32),
    commitments: ["44".repeat(32)],
    mintStates: ["base:UNSPENT", "quote:UNSPENT"],
    reserveProjectionId: "44".repeat(32),
    reserveProjectionRevision: "1",
    fillProjectionId: null,
    fillProjectionRevision: null,
    reservation: {
      proposalSealId: "99".repeat(32),
      takerCommitment: "aa".repeat(32),
      abortSealId: null
    },
    legs: {
      base: {
        tokenCommitment: "55".repeat(32),
        validationCommitment: "66".repeat(32),
        keysetId: "00deadbeefcafeee",
        proofCount: 2,
        fee: "1",
        mintState: "UNSPENT",
        observedAt: 1_700_000_009,
        spendCommitment: null,
        claimOperationCommitment: null,
        refundOperationCommitment: null
      },
      quote: {
        tokenCommitment: "77".repeat(32),
        validationCommitment: "88".repeat(32),
        keysetId: "00deadbeefcafeff",
        proofCount: 1,
        fee: "0",
        mintState: "UNSPENT",
        observedAt: 1_700_000_009,
        spendCommitment: null,
        claimOperationCommitment: null,
        refundOperationCommitment: null
      }
    }
  }
};

describe("trade session presentation", () => {
  it("renders an honest empty state", () => {
    const root = document.createElement("section");
    renderTrades(root, []);

    expect(root.textContent).toContain("No active swap sessions");
  });

  it("shows progress and exact liabilities without secrets", () => {
    const root = document.createElement("section");
    renderTrades(root, [trade]);

    expect(root.textContent).toContain("Quote locked");
    expect(root.textContent).toContain("20 SAT");
    expect(root.textContent).toContain("1 USD");
    expect(root.textContent).toContain("nofee.testnut.cashu.space");
    expect(root.querySelector("[data-advance-trade]")).toBeNull();
    expect(root.innerHTML).not.toContain("privateState");
    expect(root.innerHTML).not.toContain("cashu-private-token");
  });

  it("keeps maker and taker sessions visibly distinct on the shared page", () => {
    const root = document.createElement("section");
    renderTrades(root, [
      trade,
      { ...trade, sessionId: "aa".repeat(32), role: "maker" }
    ]);

    expect(root.querySelectorAll("[data-trade-role='taker']")).toHaveLength(1);
    expect(root.querySelectorAll("[data-trade-role='maker']")).toHaveLength(1);
    expect(root.textContent).toContain("Taker session");
    expect(root.textContent).toContain("Maker session");
  });

  it("opens the accepted DM count as a readable redacted transcript", () => {
    const root = document.createElement("section");
    const local = "cc".repeat(32);
    renderTrades(root, [{
      ...trade,
      protocol: {
        ...trade.protocol,
        localNostrPubkey: local,
        messages: [{
          sequence: "0",
          messageId: "01".repeat(32),
          rumorId: "02".repeat(32),
          transcriptHash: "03".repeat(32),
          type: "reserve_propose",
          authorPubkey: "aa".repeat(32),
          recipientPubkey: local
        }, {
          sequence: "1",
          messageId: "04".repeat(32),
          rumorId: "05".repeat(32),
          transcriptHash: "06".repeat(32),
          type: "reserve_accept",
          authorPubkey: local,
          recipientPubkey: "aa".repeat(32)
        }]
      }
    }]);

    const trigger = root.querySelector<HTMLButtonElement>(".trade-dms-trigger");
    const dialog = root.querySelector<HTMLDialogElement>(".trade-dm-dialog");
    expect(trigger?.textContent).toContain("2 accepted");
    expect(trigger?.getAttribute("aria-haspopup")).toBe("dialog");

    trigger?.click();

    expect(dialog?.hasAttribute("open")).toBe(true);
    expect(dialog?.textContent).toContain("Reserve proposal");
    expect(dialog?.textContent).toContain("Received by you");
    expect(dialog?.textContent).toContain("Reservation accepted");
    expect(dialog?.textContent).toContain("Sent by you");
    expect(dialog?.textContent).toContain(nip19.npubEncode(local));
    expect(dialog?.textContent).toContain("Spendable tokens");
    expect(dialog?.textContent).not.toContain("cashu-private-token");

    dialog?.querySelector<HTMLButtonElement>(".trade-dm-dialog__close")?.click();
    expect(dialog?.hasAttribute("open")).toBe(false);
  });
});
