import { describe, expect, it } from "vitest";

import tutorial from "../docs/guides/manual-testnet-swap.md?raw";
import html from "../index.html?raw";

describe("manual testnet swap tutorial", () => {
  it("keeps the complete shared-page happy-path recipe", () => {
    expect(tutorial).toContain("?wallet=maker-tutorial");
    expect(tutorial).toContain("?wallet=taker-tutorial");
    expect(tutorial).toContain("Fund SAT");
    expect(tutorial).toContain("Fund USD");
    expect(tutorial).toContain("automatically registers and listens");
    expect(tutorial).not.toContain("Sync maker listener");
    expect(tutorial).toContain("20 SAT");
    expect(tutorial).toContain("50,000.00");
    expect(tutorial).toContain("Retry same signed projection");
    expect(tutorial).toContain("Take ask");
    expect(tutorial).toContain("runUntilSettled");
    expect(tutorial).toContain("Advance safely");
    expect(tutorial).toContain("filled");
    expect(tutorial).toContain("4-day");
    expect(tutorial).toContain("7-day");
  });

  it("links the human tutorial from the deployed static shell", () => {
    expect(html).toContain(
      "https://github.com/brenorb/granola/blob/main/docs/guides/manual-testnet-swap.md"
    );
    expect(html).toContain("Manual test tutorial");
    expect(html).toContain('id="order-settlement-hint"');
    expect(html).not.toContain('id="mint-form"');
  });

  it("keeps the public market header focused on the wallet and order book", () => {
    expect(html).not.toContain('class="market-tape"');
    expect(html).not.toContain("Base issuer");
    expect(html).not.toContain("Active order keys");
  });

  it("places pending relay publications below the order form", () => {
    expect(html.indexOf('id="pending-publications"')).toBeGreaterThan(
      html.indexOf('class="order-entry"')
    );
  });

  it("keeps minimum fill out of the current order form", () => {
    expect(html).not.toContain("Minimum fill");
    expect(html).not.toContain('name="minimumFillAmount"');
  });

  it("keeps demo wallet deletion to one click", () => {
    expect(html).toContain('id="clear-wallet"');
    expect(html).toContain('id="reset-profile"');
    expect(html).not.toContain('name="confirmation"');
    expect(html).not.toContain("DELETE TEST WALLET");
    expect(html).not.toContain("RESET GRANOLA PROFILE");
  });
});
