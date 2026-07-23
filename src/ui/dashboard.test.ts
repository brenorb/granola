import { describe, expect, it } from "vitest";

import type { GranolaState } from "../api/granola-api.js";
import { renderDashboard, renderWalletSummary } from "./dashboard.js";

describe("wallet dashboard", () => {
  it("renders compact SAT and USD balances for the market surface", () => {
    const root = document.createElement("section");

    renderWalletSummary(root, {
      wallet: {
        revision: 2,
        balances: [
          { unit: "sat", amount: "1200", mintCount: 1, proofCount: 3 },
          { unit: "usd", amount: "500", mintCount: 1, proofCount: 2 }
        ],
        pockets: []
      },
      quotes: []
    });

    expect(root.querySelectorAll("[data-balance-unit]")).toHaveLength(2);
    expect(root.querySelector('[data-balance-unit="sat"]')?.textContent)
      .toContain("1,200 sat");
    expect(root.querySelector('[data-balance-unit="usd"]')?.textContent)
      .toContain("5.00 USD");
  });

  it("renders unit totals, mint liabilities, and proof inventory accessibly", () => {
    const state: GranolaState = {
      wallet: {
        revision: 2,
        balances: [
          { unit: "sat", amount: "1200", mintCount: 1, proofCount: 3 },
          { unit: "usd", amount: "500", mintCount: 1, proofCount: 2 }
        ],
        pockets: [
          {
            mintUrl: "https://testnut.cashu.space",
            unit: "sat",
            amount: "1200",
            proofCount: 3,
            denominations: ["8", "168", "1024"],
            keysetIds: ["sat-keyset"]
          },
          {
            mintUrl: "https://testnut.cashu.space",
            unit: "usd",
            amount: "500",
            proofCount: 2,
            denominations: ["100", "400"],
            keysetIds: ["usd-keyset"]
          }
        ]
      },
      quotes: []
    };
    const root = document.createElement("section");

    renderDashboard(root, state);

    expect(root.getAttribute("aria-live")).toBe("polite");
    expect(root.querySelectorAll("[data-balance-unit]")).toHaveLength(2);
    expect(root.textContent).toContain("1,200 sat");
    expect(root.textContent).toContain("5.00 USD");
    expect(root.textContent).toContain("testnut.cashu.space");
    expect(root.textContent).toContain("8 · 168 · 1,024");
    expect(root.querySelector("table")?.querySelector("caption")?.textContent).toContain(
      "mint and unit"
    );
  });

  it("renders an honest empty state without inventing a zero-denomination balance", () => {
    const root = document.createElement("section");
    renderDashboard(root, {
      wallet: { revision: 0, balances: [], pockets: [] },
      quotes: []
    });

    expect(root.textContent).toContain("No ecash yet");
    expect(root.querySelectorAll("[data-balance-unit]")).toHaveLength(0);
  });
});
