import { describe, expect, it, vi } from "vitest";

import type { PublicTradeView } from "../trade/session.js";
import { renderTrades } from "./trades.js";

const trade: PublicTradeView = {
  revision: 0,
  sessionId: "11".repeat(32),
  reservationId: "11111111-1111-4111-8111-111111111111",
  role: "taker",
  phase: "quote_locked",
  orderAddress: `30078:${"22".repeat(32)}:granola:order:v1:22222222-2222-4222-8222-222222222222`,
  offeredOrderHead: "33".repeat(32),
  reserveTransitionId: "44".repeat(32),
  fillTransitionId: null,
  pendingOrderPublication: null,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_010,
  terms: {
    baseMint: "https://testnut.cashu.space",
    baseUnit: "sat",
    baseKeyset: "base-keyset",
    baseAmount: "20",
    quoteMint: "https://nofee.testnut.cashu.space",
    quoteUnit: "usd",
    quoteKeyset: "quote-keyset",
    quoteAmount: "1",
    price: { numerator: "1", denominator: "20" }
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
    reserveTransitionId: "44".repeat(32),
    fillTransitionId: null,
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
    renderTrades(root, [], { onAdvance: vi.fn() });

    expect(root.textContent).toContain("No active swap sessions");
  });

  it("shows progress, exact liabilities, and an advance action without secrets", () => {
    const root = document.createElement("section");
    const advance = vi.fn();
    renderTrades(root, [trade], { onAdvance: advance });

    expect(root.textContent).toContain("Quote locked");
    expect(root.textContent).toContain("20 SAT");
    expect(root.textContent).toContain("1 USD");
    expect(root.textContent).toContain("nofee.testnut.cashu.space");
    root.querySelector<HTMLButtonElement>("[data-advance-trade]")?.click();
    expect(advance).toHaveBeenCalledWith(trade.sessionId);
    expect(root.innerHTML).not.toMatch(/private|preimage|token|proof/i);
  });
});
