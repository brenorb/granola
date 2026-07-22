import { describe, expect, it } from "vitest";

import { profileFromLocation, storageNameForProfile } from "./profile.js";

describe("browser wallet profiles", () => {
  it("uses a named profile so two test traders can remain isolated", () => {
    expect(profileFromLocation("https://example.test/?wallet=maker")).toBe("maker");
    expect(profileFromLocation("https://example.test/?wallet=taker-2")).toBe("taker-2");
    expect(storageNameForProfile("maker")).toBe("granola-wallet-maker");
  });

  it("defaults predictably and rejects names that could create ambiguous storage", () => {
    expect(profileFromLocation("https://example.test/")).toBe("default");
    for (const value of ["../maker", "Maker", "a b", "", "a".repeat(33)]) {
      expect(() => profileFromLocation(`https://example.test/?wallet=${encodeURIComponent(value)}`))
        .toThrow("Invalid wallet profile");
    }
  });
});
