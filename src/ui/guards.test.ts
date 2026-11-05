import { describe, expect, it } from "vitest";

import {
  priceValidationMessage,
  renderBootError,
  sizeValidationMessage
} from "./guards.js";

describe("order form messages", () => {
  it("explains size mistakes specifically", () => {
    expect(sizeValidationMessage("100")).toBe("");
    for (const value of ["0", "-5", "1.5", "abc", "1,000"]) {
      expect(sizeValidationMessage(value)).toMatch(/whole number of SAT/);
    }
    expect(sizeValidationMessage("")).toMatch(/Enter the order size/);
  });

  it("explains price mistakes specifically", () => {
    expect(priceValidationMessage("50000.00")).toBe("");
    expect(priceValidationMessage("50,000.00")).toMatch(/thousands separators/);
    expect(priceValidationMessage("50000.123")).toMatch(/two decimals/);
    expect(priceValidationMessage("1e5")).toMatch(/two decimals/);
    expect(priceValidationMessage("0.00")).toMatch(/greater than zero/);
  });
});

describe("boot error", () => {
  it("shows a visible alert with a way back instead of a blank page", () => {
    document.body.innerHTML = `<p id="profile-label">Wallet profile: …</p><main><section>app</section></main>`;
    renderBootError(document, "Invalid wallet profile: use 1–32 lowercase letters, numbers, or hyphens");

    const alert = document.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("Invalid wallet profile");
    expect(alert?.querySelector("a")?.getAttribute("href")).toBe("./");
    expect(document.getElementById("profile-label")?.textContent).toBe("Invalid wallet workspace");
    expect(document.querySelector("main section.boot-error")).not.toBeNull();
  });
});
