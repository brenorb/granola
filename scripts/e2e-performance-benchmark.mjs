import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const outputDir = mkdtempSync(join(tmpdir(), "granola-e2e-"));
const vitest = join(process.cwd(), "node_modules/vitest/vitest.mjs");
const files = [
  "src/trade/happy-path.integration.test.ts",
  "src/api/order-api.test.ts"
];

const runs = [];
for (let run = 0; run < 3; run += 1) {
  const outputFile = join(outputDir, `vitest-${run}.json`);
  const result = spawnSync(
    process.execPath,
    [vitest, "run", ...files, "--reporter=json", `--outputFile=${outputFile}`],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  const report = JSON.parse(readFileSync(outputFile, "utf8"));
  runs.push(report.testResults.flatMap(({ assertionResults }) =>
    assertionResults.map(({ ancestorTitles, title, status, duration }) => ({
      name: [...ancestorTitles, title].join(" "),
      scenario: classify([...ancestorTitles, title].join(" ")),
      status,
      durationMs: Number(duration.toFixed(2))
    }))
  ));
}

const tests = runs[0].map((test) => {
  const samples = runs.map((run) => run.find((candidate) => candidate.name === test.name));
  if (samples.some((sample) => sample === undefined)) {
    throw new Error(`Benchmark test set changed between runs: ${test.name}`);
  }
  const samplesMs = samples.map((sample) => sample.durationMs);
  return {
    scenario: test.scenario,
    status: test.status,
    samplesMs,
    medianMs: median(samplesMs)
  };
});

console.log(JSON.stringify({
  benchmark: "granola-e2e",
  transport: "deterministic in-process relay and counterparty fixtures",
  includes: [
    "signed order publication and relay readback",
    "buy and sell coordinator settlement with wrapped private messages",
    "reservation and release",
    "cancellation and expiry",
    "relay retry and stale-operation failures"
  ],
  tests
}, null, 2));

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function classify(name) {
  if (/buy-side/.test(name)) return "buy_settlement";
  if (/configured two-mint/.test(name)) return "sell_settlement";
  if (/one-mint/.test(name)) return "one_mint_settlement";
  if (/reserves by replacing/.test(name)) return "reserve";
  if (/releases a reserved/.test(name)) return "release";
  if (/canceled and expired/.test(name)) return "cancel_and_expire";
  if (/retry|legacy acknowledged/.test(name)) return "retry_failure_recovery";
  if (/stale/.test(name)) return "stale_failure";
  return "order_lifecycle";
}
