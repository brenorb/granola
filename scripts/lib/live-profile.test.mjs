import { describe, expect, it } from "vitest";
import { intervalUnion, summarizeProfile, settlementLegForSlot } from "./live-profile.mjs";

describe("live profiling attribution", () => {
  it("maps buy-order protocol slots to the actual settlement mint and unit", () => {
    expect(settlementLegForSlot("sell", "base")).toBe("base");
    expect(settlementLegForSlot("sell", "quote")).toBe("quote");
    expect(settlementLegForSlot("buy", "base")).toBe("quote");
    expect(settlementLegForSlot("buy", "quote")).toBe("base");
    expect(() => settlementLegForSlot("buy", "other")).toThrow();
  });
  it("clips network intervals and counts overlapping wallets only once", () => {
    expect(intervalUnion([[-5, 2], [1, 6], [3, 5], [8, 14], [15, 16]], 0, 10)).toBe(8);
    expect(intervalUnion([[0, 4], [4, 4], [4, 8]], 0, 8)).toBe(8);
  });
  it("excludes open subscription lifetimes from relay response time", () => {
    const run = { variant: "single", run: 1, side: "sell", totalMs: 100, mintHttpUnionMs: 20,
      entries: [], relay: [{ start: 0, end: 100, outcome: "client-close" },
        { start: 10, end: 25, outcome: "ack" }, { start: 15, end: 30, outcome: "eose" }] };
    expect(summarizeProfile({ completedAt: "synthetic-test", runs: [run], mints: [] }).variants.single.relayResponseUnionMs.median).toBe(20);
  });
  it("refuses failed reports and unmatched before/after directions", () => {
    expect(() => summarizeProfile({ failure: {} })).toThrow();
    const run = { variant: "baseline", run: 1, side: "sell", totalMs: 100, mintHttpUnionMs: 20,
      entries: [], relay: [] };
    expect(() => summarizeProfile({ completedAt: "synthetic-test", runs: [run, { ...run, variant: "candidate", side: "buy" }], mints: [] })).toThrow(/same direction/);
  });
  it("refuses incomplete comparisons and duplicate run indices", () => {
    const run = { variant: "single", run: 1, side: "sell", totalMs: 100, mintHttpUnionMs: 20,
      entries: [], relay: [] };
    expect(() => summarizeProfile({ runs: [run], mints: [] })).toThrow(/Incomplete/);
    const report = { completedAt: "synthetic-test", requestedRuns: 2, variants: [{ name: "single" }], mints: [] };
    expect(() => summarizeProfile({ ...report, runs: [run] })).toThrow(/finish all/);
    expect(() => summarizeProfile({ ...report, runs: [run, run] })).toThrow(/duplicated or missing/);
  });
});
