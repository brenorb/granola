import { describe, expect, it } from "vitest";

import {
  QUICK_MINT_AMOUNT,
  renderMintActions,
  type QuickMintRequest
} from "./mint-actions.js";

describe("quick mint actions", () => {
  it("renders compact SAT and USD buttons with the 10,000 minor-unit default", () => {
    const root = document.createElement("div");

    renderMintActions(root, () => undefined);

    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons).toHaveLength(2);
    expect(buttons.map((button) => button.dataset.mintUnit)).toEqual(["sat", "usd"]);
    expect(buttons.map((button) => button.dataset.mintAmount)).toEqual([
      QUICK_MINT_AMOUNT,
      QUICK_MINT_AMOUNT
    ]);
    expect(buttons[0]?.querySelector(".quick-mint__symbol")?.textContent).toBe("₿");
    expect(buttons[1]?.querySelector(".quick-mint__symbol")?.textContent).toBe("$");
    expect(buttons[0]?.textContent).toContain("Fund SAT");
    expect(buttons[1]?.textContent).toContain("Fund USD");
    expect(root.querySelector("form")).toBeNull();
  });

  it("issues the selected unit when a quick action is clicked", () => {
    const root = document.createElement("div");
    const requests: QuickMintRequest[] = [];

    renderMintActions(root, (request) => requests.push(request));

    root.querySelector<HTMLButtonElement>('[data-mint-unit="usd"]')?.click();

    expect(requests).toEqual([{ unit: "usd", amount: QUICK_MINT_AMOUNT }]);
  });
});
