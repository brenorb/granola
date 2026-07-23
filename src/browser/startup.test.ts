import { describe, expect, it, vi } from "vitest";

import { startInboxListeners } from "./startup.js";

describe("browser inbox startup", () => {
  it("starts the maker and persisted session inboxes together", async () => {
    const startSessions = vi.fn(async () => undefined);
    const startMaker = vi.fn(async () => undefined);

    await startInboxListeners({ startSessions, startMaker });

    expect(startSessions).toHaveBeenCalledOnce();
    expect(startMaker).toHaveBeenCalledOnce();
  });

  it("waits for both inbox startup tasks to finish", async () => {
    let releaseSessions!: () => void;
    let releaseMaker!: () => void;
    const sessions = new Promise<void>((resolve) => { releaseSessions = resolve; });
    const maker = new Promise<void>((resolve) => { releaseMaker = resolve; });
    const startup = startInboxListeners({
      startSessions: vi.fn(() => sessions),
      startMaker: vi.fn(() => maker)
    });
    let settled = false;
    void startup.then(() => { settled = true; });

    await vi.waitFor(() => expect(settled).toBe(false));
    releaseSessions();
    await vi.waitFor(() => expect(settled).toBe(false));
    releaseMaker();
    await startup;
    expect(settled).toBe(true);
  });
});
