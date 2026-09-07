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
      expect(open).toHaveBeenCalledWith("test-profile", 2);
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

  it("upgrades old tabs without deleting records and rejects a v1 rollback", async () => {
    type Request = {
      result?: FakeDatabase;
      error?: DOMException;
      onblocked?: () => void;
      onerror?: () => void;
      onsuccess?: () => void;
      onupgradeneeded?: () => void;
    };
    type FakeDatabase = {
      version: number;
      data: Map<string, unknown>;
      close: () => void;
      createObjectStore: () => void;
      objectStoreNames: { contains: () => boolean };
      onversionchange?: () => void;
      transaction: (name: string, mode: IDBTransactionMode) => FakeTransaction;
    };
    type FakeTransaction = {
      error?: Error;
      onabort?: () => void;
      oncomplete?: () => void;
      objectStore: () => {
        delete: (key: string) => { result?: unknown };
        get: (key: string) => { result?: unknown };
        put: (value: unknown, key: string) => { result?: unknown };
      };
    };

    const record: { version: number; connections: Set<FakeDatabase>; data: Map<string, unknown> } = {
      version: 1,
      connections: new Set(),
      data: new Map([["kept", "legacy-record"]])
    };
    const open = vi.fn((name: string, requestedVersion = 1): Request => {
      expect(name).toBe("cutover-profile");
      const request: Request = {};
      queueMicrotask(() => {
        const database: FakeDatabase = {
          version: record.version,
          data: record.data,
          close: vi.fn(),
          createObjectStore: vi.fn(),
          objectStoreNames: { contains: () => true },
          transaction: (_storeName, _mode) => {
            const transaction: FakeTransaction = {
              objectStore: () => ({
                get: (key) => {
                  const result = { result: record.data.get(key) };
                  queueMicrotask(() => transaction.oncomplete?.());
                  return result;
                },
                put: (value, key) => {
                  record.data.set(key, value);
                  const result = {};
                  queueMicrotask(() => transaction.oncomplete?.());
                  return result;
                },
                delete: (key) => {
                  record.data.delete(key);
                  const result = {};
                  queueMicrotask(() => transaction.oncomplete?.());
                  return result;
                }
              })
            };
            return transaction;
          }
        };
        request.result = database;
        if (requestedVersion < record.version) {
          request.error = new DOMException("Database version is newer", "VersionError");
          request.onerror?.();
          return;
        }
        if (requestedVersion > record.version) {
          for (const connection of record.connections) connection.onversionchange?.();
          if (record.connections.size > 0) {
            request.onblocked?.();
            return;
          }
          record.version = requestedVersion;
          database.version = record.version;
          request.onupgradeneeded?.();
        }
        record.connections.add(database);
        request.result = database;
        request.onsuccess?.();
      });
      return request;
    });
    vi.stubGlobal("indexedDB", { open });
    try {
      const oldRequest = open("cutover-profile", 1);
      let oldDatabase: FakeDatabase | undefined;
      const oldInvalidated = vi.fn(() => {
        oldDatabase?.close();
        if (oldDatabase) record.connections.delete(oldDatabase);
      });
      oldRequest.onsuccess = () => {
        oldDatabase = oldRequest.result;
        oldDatabase!.onversionchange = oldInvalidated;
      };
      await vi.waitFor(() => expect(oldDatabase).toBeDefined());

      const upgraded = new IndexedDbStorageDriver("cutover-profile");
      expect(await upgraded.get("kept")).toBe("legacy-record");
      expect(oldInvalidated).toHaveBeenCalledTimes(1);
      expect(record.version).toBe(2);

      const rollback = open("cutover-profile", 1);
      const rollbackError = new Promise<DOMException>((resolve) => {
        rollback.onerror = () => resolve(rollback.error!);
      });
      await expect(rollbackError).resolves.toMatchObject({ name: "VersionError" });
      expect(record.data.get("kept")).toBe("legacy-record");
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects a blocked upgrade and closes a late connection", async () => {
    const database = {
      close: vi.fn(),
      objectStoreNames: { contains: () => true },
      createObjectStore: vi.fn()
    };
    const request: {
      result: typeof database;
      onblocked?: () => void;
      onerror?: () => void;
      onsuccess?: () => void;
      onupgradeneeded?: () => void;
      error?: Error;
    } = { result: database };
    const open = vi.fn(() => {
      queueMicrotask(() => request.onblocked?.());
      queueMicrotask(() => request.onsuccess?.());
      return request;
    });
    vi.stubGlobal("indexedDB", { open });
    try {
      await expect(new IndexedDbStorageDriver("blocked-profile").get("key"))
        .rejects.toThrow(/close or reload other profile tabs/);
      await vi.waitFor(() => expect(database.close).toHaveBeenCalledTimes(1));
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
