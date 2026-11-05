import { describe, expect, it } from "vitest";

import { describeNetworkFailure, isTransientNetworkError } from "./transient-error.js";

function named(name: string, message: string, status?: number): Error {
  const error = new Error(message);
  error.name = name;
  if (status !== undefined) Object.assign(error, { status });
  return error;
}

describe("transient network errors", () => {
  it("retries network failures, timeouts, 5xx and rate limits", () => {
    expect(isTransientNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientNetworkError(new Error("Failed to fetch"))).toBe(true);
    expect(isTransientNetworkError(named("NetworkError", "Failed to fetch"))).toBe(true);
    expect(isTransientNetworkError(new Error("Inbox relay query timed out"))).toBe(true);
    expect(isTransientNetworkError(named("HttpResponseError", "bad gateway", 502))).toBe(true);
    expect(isTransientNetworkError(named("HttpResponseError", "slow down", 429))).toBe(true);
  });

  it("never retries protocol, validation or client errors", () => {
    expect(isTransientNetworkError(new Error("Trade stopped in terminal phase frozen"))).toBe(false);
    expect(isTransientNetworkError(new Error("Encrypted message has expired"))).toBe(false);
    expect(isTransientNetworkError(named("HttpResponseError", "proofs already spent", 400))).toBe(false);
    expect(isTransientNetworkError("Failed to fetch")).toBe(false);
  });

  it("names the unreachable host instead of a bare fetch error", () => {
    expect(describeNetworkFailure(new TypeError("Failed to fetch"), "https://testnut.cashu.space"))
      .toBe("Could not reach testnut.cashu.space. Check your connection and try again.");
    expect(describeNetworkFailure(new Error("Quote expired"), "https://testnut.cashu.space"))
      .toBe("Quote expired");
  });
});
