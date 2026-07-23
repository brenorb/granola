import { describe, expect, it, vi } from "vitest";

import { withOrderOutboxLock, withWalletLock, type LockPort } from "./lock.js";

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
