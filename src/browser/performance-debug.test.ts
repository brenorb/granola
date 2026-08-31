import { describe, expect, it } from "vitest";

import { createPerformanceDebugTimeline } from "./performance-debug.js";

function clock() {
  return {
    timeOrigin: 1_788_000_000_000,
    measure: (name: string, options: PerformanceMeasureOptions) => ({
      name,
      startTime: Number(options.start),
      duration: Number(options.end) - Number(options.start)
    }) as PerformanceMeasure,
    mark: (name: string) => ({ name, startTime: 42 }) as PerformanceMark
  };
}

describe("performance debug timeline", () => {
  it("exposes secret-free browser evidence without rendering UI", () => {
    const timeline = createPerformanceDebugTimeline(document, clock(), false);
    timeline.mark("granola:take-order-click");
    timeline.action({
      action: "poll_inbox",
      execution: "external",
      sessionId: "session-id",
      role: "taker",
      revision: 3,
      startedAt: 50,
      endedAt: 75,
      succeeded: true
    });
    timeline.inboxWait({
      sessionId: "session-id",
      outcome: "event",
      startedAt: 40,
      endedAt: 50
    });
    timeline.recordResource({
      name: "https://testnut.cashu.space/v1/mint/quote/bolt11/private-quote-id?secret=value",
      entryType: "resource",
      initiatorType: "fetch",
      startTime: 80,
      duration: 20,
      requestStart: 82,
      responseStart: 95,
      responseEnd: 100
    } as PerformanceResourceTiming);

    const output = document.querySelector<HTMLScriptElement>("#granola-performance")!;
    expect(output.type).toBe("application/json");
    expect(document.body.textContent).toBe("");
    expect(output.textContent).not.toContain("private-quote-id");
    expect(output.textContent).not.toContain("secret=value");
    expect(JSON.parse(output.textContent!)).toMatchObject({
      version: 1,
      timeOrigin: 1_788_000_000_000,
      entries: [
        { name: "granola:take-order-click", startTime: 42, duration: 0 },
        {
          name: "granola:coordinator-action",
          startTime: 50,
          duration: 25,
          detail: { action: "poll_inbox", sessionId: "session-id" }
        },
        {
          name: "granola:inbox-wait",
          startTime: 40,
          duration: 10,
          detail: { outcome: "event", sessionId: "session-id" }
        },
        {
          name: "granola:network",
          startTime: 80,
          duration: 20,
          detail: {
            origin: "https://testnut.cashu.space",
            operation: "cashu_quote"
          }
        }
      ]
    });
  });
});
