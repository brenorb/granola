import type { InboxWaitProfile } from "./trade-controller.js";
import type { CoordinatorActionProfile } from "../trade/coordinator.js";

const MAX_ENTRIES = 1_000;

interface DebugEntry {
  name: string;
  startTime: number;
  duration: number;
  detail: Record<string, unknown>;
}

interface DebugPayload {
  version: 1;
  timeOrigin: number;
  entries: DebugEntry[];
}

type DebugPerformance = Pick<Performance, "timeOrigin" | "mark" | "measure">;

function resourceOperation(pathname: string): string {
  if (pathname === "/v1/info") return "cashu_info";
  if (pathname === "/v1/keysets") return "cashu_keysets";
  if (/^\/v1\/keys(?:\/|$)/.test(pathname)) return "cashu_keys";
  if (/\/v1\/(mint|melt)\/quote\//.test(pathname)) return "cashu_quote";
  if (/\/v1\/mint\//.test(pathname)) return "cashu_mint";
  if (/\/v1\/melt\//.test(pathname)) return "cashu_melt";
  if (/\/v1\/swap(?:\/|$)/.test(pathname)) return "cashu_swap";
  if (/\/v1\/checkstate(?:\/|$)/.test(pathname)) return "cashu_checkstate";
  if (/\/v1\/restore(?:\/|$)/.test(pathname)) return "cashu_restore";
  return pathname === "/" ? "relay_info" : "external_http";
}

export function createPerformanceDebugTimeline(
  document: Document,
  clock: DebugPerformance,
  observeResources = true
) {
  const payload: DebugPayload = {
    version: 1,
    timeOrigin: clock.timeOrigin,
    entries: []
  };
  const output = document.createElement("script");
  output.id = "granola-performance";
  output.type = "application/json";
  output.dataset.granolaPerformance = "v1";
  document.head.append(output);

  const append = (entry: DebugEntry): void => {
    payload.entries.push(entry);
    if (payload.entries.length > MAX_ENTRIES) payload.entries.shift();
    output.textContent = JSON.stringify(payload);
  };
  output.textContent = JSON.stringify(payload);

  const recordResource = (entry: PerformanceResourceTiming): void => {
    const url = new URL(entry.name, document.location.href);
    if (!/^https?:$/.test(url.protocol) || url.origin === document.location.origin) return;
    append({
      name: "granola:network",
      startTime: entry.startTime,
      duration: entry.duration,
      detail: {
        origin: url.origin,
        operation: resourceOperation(url.pathname),
        initiatorType: entry.initiatorType,
        requestStart: entry.requestStart,
        responseStart: entry.responseStart,
        responseEnd: entry.responseEnd
      }
    });
  };

  const recordProofWait = (entry: PerformanceMeasure): void => {
    if (entry.name !== "granola:proof-wait") return;
    const { outcome, updates, proofCount } = entry.detail ?? {};
    if (!["spent", "timeout", "unavailable"].includes(outcome) ||
      !Number.isSafeInteger(updates) || !Number.isSafeInteger(proofCount)) return;
    append({ name: entry.name, startTime: entry.startTime, duration: entry.duration,
      detail: { outcome, updates, proofCount } });
  };

  const recordRelayConnect = (entry: PerformanceMeasure): void => {
    if (entry.name !== "granola:relay-connect") return;
    const outcome = entry.detail?.outcome;
    if (!["warm", "warming", "cold", "failed"].includes(outcome)) return;
    append({ name: entry.name, startTime: entry.startTime, duration: entry.duration, detail: { outcome } });
  };

  if (observeResources) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === "resource") {
          recordResource(entry as PerformanceResourceTiming);
        } else if (entry.entryType === "measure") {
          recordProofWait(entry as PerformanceMeasure);
          recordRelayConnect(entry as PerformanceMeasure);
        }
      }
    });
    observer.observe({ type: "resource", buffered: true });
    observer.observe({ type: "measure", buffered: true });
  }

  return {
    action(profile: CoordinatorActionProfile): void {
      const entry = clock.measure("granola:coordinator-action", {
        start: profile.startedAt,
        end: profile.endedAt,
        detail: profile
      });
      append({
        name: entry.name,
        startTime: entry.startTime,
        duration: entry.duration,
        detail: profile as unknown as Record<string, unknown>
      });
    },
    inboxWait(wait: InboxWaitProfile): void {
      const entry = clock.measure("granola:inbox-wait", {
        start: wait.startedAt,
        end: wait.endedAt,
        detail: wait
      });
      append({
        name: entry.name,
        startTime: entry.startTime,
        duration: entry.duration,
        detail: wait as unknown as Record<string, unknown>
      });
    },
    mark(name: "granola:take-order-click" | "granola:trade-filled", detail: {
      sessionId?: string;
      role?: "maker" | "taker";
    } = {}): void {
      const entry = clock.mark(name, { detail });
      append({ name, startTime: entry.startTime, duration: 0, detail });
    },
    recordResource,
    recordProofWait,
    recordRelayConnect
  };
}
