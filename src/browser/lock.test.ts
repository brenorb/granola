import { describe, expect, it, vi } from "vitest";

import {
  withOrderOutboxLock,
  withTradeSessionLock,
  withTradeSessionStorageLock,
  withWalletLock,
  type LockPort
} from "./lock.js";

describe("wallet mutation lock", () => {
  it("serializes work under an exclusive profile-scoped Web Lock", async () => {
    const request = vi.fn(async (
      _name: string,
      _options: { mode: "exclusive" },
      callback: () => Promise<unknown>
    ) => callback());
    const locks: LockPort = { request };

    await expect(withWalletLock("maker", async () => "done", locks)).resolves.toBe("done");
    expect(request).toHaveBeenCalledWith(
      "granola-wallet-maker-write",
      { mode: "exclusive" },
      expect.any(Function)
    );
  });
});

describe("order outbox mutation lock", () => {
  it("uses a separate exclusive profile-scoped Web Lock", async () => {
    const request = vi.fn(async (
      _name: string,
      _options: { mode: "exclusive" },
      callback: () => Promise<unknown>
    ) => callback());
    const locks: LockPort = { request };

    await expect(withOrderOutboxLock("maker", async () => "done", locks)).resolves.toBe("done");
    expect(request).toHaveBeenCalledWith(
      "granola-order-outbox-maker-write",
      { mode: "exclusive" },
      expect.any(Function)
    );
  });
});

describe("trade session mutation lock", () => {
  it("uses an exclusive profile- and session-scoped Web Lock", async () => {
    const request = vi.fn(async (
      _name: string,
      _options: { mode: "exclusive" },
      callback: () => Promise<unknown>
    ) => callback());
    const locks: LockPort = { request };
    const sessionId = "ab".repeat(32);

    await expect(withTradeSessionLock(
      "maker",
      sessionId,
      async () => "done",
      locks
    )).resolves.toBe("done");
    expect(request).toHaveBeenCalledWith(
      `granola-trade-maker-${sessionId}-write`,
      { mode: "exclusive" },
      expect.any(Function)
    );
  });

  it("rejects malformed profile or session lock names", async () => {
    const locks: LockPort = { request: vi.fn() };

    await expect(withTradeSessionLock("../maker", "ab".repeat(32), async () => {}, locks))
      .rejects.toThrow("profile");
    await expect(withTradeSessionLock("maker", "not-a-session", async () => {}, locks))
      .rejects.toThrow("session");
    expect(locks.request).not.toHaveBeenCalled();
  });
});

describe("trade session storage lock", () => {
  it("uses one global profile-scoped lock for the shared session array", async () => {
    const request = vi.fn(async (
      _name: string,
      _options: { mode: "exclusive" },
      callback: () => Promise<unknown>
    ) => callback());
    const locks: LockPort = { request };

    await expect(withTradeSessionStorageLock(
      "maker",
      async () => "done",
      locks
    )).resolves.toBe("done");
    expect(request).toHaveBeenCalledWith(
      "granola-trade-maker-storage-write",
      { mode: "exclusive" },
      expect.any(Function)
    );
  });
});
