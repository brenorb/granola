import { describe, expect, it } from "vitest";

import tutorial from "../docs/guides/manual-testnet-swap.md?raw";
import html from "../index.html?raw";

describe("manual testnet swap tutorial", () => {
  it("keeps the complete two-profile happy-path recipe", () => {
    expect(tutorial).toContain("?wallet=maker-tutorial");
    expect(tutorial).toContain("?wallet=taker-tutorial");
    expect(tutorial).toContain("100 SAT");
    expect(tutorial).toContain("USD 0.10");
    expect(tutorial).toContain("Enable maker inbox");
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
  });

  it("advertises the one-relay public order acknowledgement policy", () => {
    expect(html).toContain("1 of 3 acknowledgements");
    expect(html).not.toContain("2 of 3 acknowledgements");
  });

  it("keeps minimum fill out of the current order form", () => {
    expect(html).not.toContain("Minimum fill");
    expect(html).not.toContain('name="minimumFillAmount"');
  });
});
