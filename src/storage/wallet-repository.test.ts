import { describe, expect, it, vi } from "vitest";

import { addProofs, createEmptyWallet } from "../core/wallet.js";
import {
  MemoryStorageDriver,
  IndexedDbStorageDriver,
  WalletRepository
} from "./wallet-repository.js";

describe("wallet repository", () => {
  it("shares an open connection, waits for commit and closes on cross-tab invalidation", async () => {
    const transactions: Array<{ oncomplete?: (() => void) | undefined; onabort?: () => void; error?: Error }> = [];
    const database = {
      onversionchange: () => {},
      onclose: () => {},
      close: vi.fn(),
      transaction: vi.fn(() => {
        const transaction = {
          oncomplete: undefined as (() => void) | undefined,
          objectStore: () => ({ get: () => ({ result: "stored" }) })
        };
        transactions.push(transaction);
        return transaction;
      })
    };
    const request = { result: database, onsuccess: () => {} };
    const open = vi.fn(() => { queueMicrotask(() => request.onsuccess()); return request; });
    vi.stubGlobal("indexedDB", { open });
    try {
      const driver = new IndexedDbStorageDriver("test-profile");
      const first = driver.get("one"), second = driver.get("two");
      await vi.waitFor(() => expect(transactions).toHaveLength(2));
      let settled = false;
      void first.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      transactions[0]!.oncomplete?.();
      transactions[1]!.error = new Error("commit aborted");
      transactions[1]!.onabort?.();
      await expect(first).resolves.toBe("stored");
      await expect(second).rejects.toThrow(/commit aborted/);
      expect(open).toHaveBeenCalledTimes(1);
      expect(database.close).not.toHaveBeenCalled();
      database.onversionchange();
      await Promise.resolve();
      expect(database.close).toHaveBeenCalledTimes(1);
      expect(driver.invalidationSignal.aborted).toBe(true);
      await expect(driver.get("one")).rejects.toThrow(/reload/);
    } finally { vi.unstubAllGlobals(); }
  });

  it("invalidates the old driver before reset and allows a fresh driver to reopen", async () => {
    const deleted = { onsuccess: () => {} };
    const deleteDatabase = vi.fn(() => { queueMicrotask(() => deleted.onsuccess()); return deleted; });
    vi.stubGlobal("indexedDB", { deleteDatabase });
    try {
      const driver = new IndexedDbStorageDriver("test-profile");
      const invalidated = vi.fn();
      driver.invalidationSignal.addEventListener("abort", invalidated);
      await driver.resetDatabase();
      expect(deleteDatabase).toHaveBeenCalledWith("test-profile");
      expect(invalidated).toHaveBeenCalledTimes(1);
      await expect(driver.set("key", "value")).rejects.toThrow(/reload/);
      expect(new IndexedDbStorageDriver("test-profile").invalidationSignal.aborted).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it("starts empty and round-trips bearer proofs without losing amount precision", async () => {
    const driver = new MemoryStorageDriver();
    const repository = new WalletRepository(driver);

    expect(await repository.load()).toEqual(createEmptyWallet());

    const state = addProofs(createEmptyWallet(), {
      mintUrl: "https://mint.test",
      unit: "usd",
      proofs: [
        {
          amount: "9007199254740993",
          id: "usd-keyset",
          secret: "persisted-secret",
          C: "persisted-signature"
        }
      ]
    });
    await repository.save(state);

    const restored = await repository.load();
    expect(restored).toEqual(state);
    expect(restored).not.toBe(state);
  });

  it("refuses unknown schema versions instead of discarding wallet data", async () => {
    const driver = new MemoryStorageDriver();
    await driver.set("granola.wallet.v1", { version: 2, revision: 0, pockets: [] });

    await expect(new WalletRepository(driver).load()).rejects.toThrow(
      "Unsupported wallet schema version"
    );
  });

  it("clears persisted proofs only when explicitly called", async () => {
    const driver = new MemoryStorageDriver();
    const repository = new WalletRepository(driver);
    const state = addProofs(createEmptyWallet(), {
      mintUrl: "https://mint.test",
      unit: "sat",
      proofs: [
        { amount: "1", id: "keyset", secret: "secret", C: "signature" }
      ]
    });
    await repository.save(state);

    await repository.clear();

    expect(await repository.load()).toEqual(createEmptyWallet());
  });
});
