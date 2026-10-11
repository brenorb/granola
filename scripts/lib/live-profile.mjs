import assert from "node:assert/strict";

export function settlementLegForSlot(side, slot) {
  assert.ok(["sell", "buy"].includes(side) && ["base", "quote"].includes(slot));
  return side === "sell" ? slot : slot === "base" ? "quote" : "base";
}

export function intervalUnion(intervals, start, end) {
  const clipped = intervals.map(([a, b]) => [Math.max(start, a), Math.min(end, b)])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0, right = start;
  for (const [a, b] of clipped) {
    total += Math.max(0, b - Math.max(a, right));
    right = Math.max(right, b);
  }
  return total;
}

function distribution(values) {
  const ordered = [...values].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
  return { count: ordered.length, min: ordered[0], max: ordered.at(-1),
    median: ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2 };
}

export function summarizeProfile(report) {
  assert.ok(!report.failure, "Failed profiles cannot be reported as successful benchmarks");
  assert.ok(report.completedAt && report.runs?.length, "Incomplete profiles cannot be reported as successful benchmarks");
  if (report.requestedRuns !== undefined) {
    assert.ok(Number.isSafeInteger(report.requestedRuns) && report.requestedRuns > 0);
    for (const { name } of report.variants) {
      const runs = report.runs.filter(run => run.variant === name);
      assert.equal(runs.length, report.requestedRuns, "Every requested variant must finish all runs");
      assert.deepEqual(runs.map(run => run.run).sort((a, b) => a - b),
        Array.from({ length: report.requestedRuns }, (_, index) => index + 1), "Runs cannot be duplicated or missing");
    }
  }
  const variants = Object.fromEntries([...new Set(report.runs.map(r => r.variant))].map(variant => {
    const runs = report.runs.filter(r => r.variant === variant);
    return [variant, {
      totalMs: distribution(runs.map(r => r.totalMs)),
      mintHttpUnionMs: distribution(runs.map(r => r.mintHttpUnionMs)),
      // A client CLOSE or socket close does not tell us when the relay answered.
      relayResponseUnionMs: distribution(runs.map(r => intervalUnion(r.relay
        .filter(s => ["ack", "rejected", "eose", "closed"].includes(s.outcome))
        .map(s => [s.start, s.end]), 0, r.totalMs))),
      localActionUnionMs: distribution(runs.map(r => intervalUnion(r.entries
        .filter(e => e.name === "granola:coordinator-action" && e.detail.execution === "local")
        .map(e => [e.startTime, e.startTime + e.duration]), 0, r.totalMs))),
      mintRequests: runs.map(r => Object.fromEntries([...new Set(r.entries
        .filter(e => e.name === "granola:network" && report.mints.includes(e.detail.origin))
        .map(e => e.detail.operation))].map(operation => [operation, r.entries.filter(e =>
          e.name === "granola:network" && report.mints.includes(e.detail.origin) &&
          e.detail.operation === operation && e.startTime >= 0).length]))),
      subscriptions: runs.map(r => (r.subscriptions ?? r.entries.filter(e => e.name === "granola:proof-wait")
        .map(e => ({ duration: e.duration, ...e.detail }))).map(s => ({ ...s })))
    }];
  }));
  const paired = report.runs.filter(r => r.variant === "baseline").map(before => {
    const after = report.runs.find(r => r.variant === "candidate" && r.run === before.run && r.side === before.side);
    assert.ok(after, "Each baseline needs a candidate with the same direction and run index");
    return { run: before.run, side: before.side, savedMs: before.totalMs - after.totalMs,
      savedPercent: (before.totalMs - after.totalMs) / before.totalMs * 100 };
  });
  return { variants, paired, ...(paired.length ? { pairedSavingMs: distribution(paired.map(p => p.savedMs)) } : {}) };
}
