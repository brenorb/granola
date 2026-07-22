import { createEmptyWallet, type WalletState } from "../core/wallet.js";

const WALLET_KEY = "granola.wallet.v1";

export interface StorageDriver {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertWalletState(value: unknown): asserts value is WalletState {
  if (!value || typeof value !== "object") {
    throw new Error("Wallet storage is corrupt");
  }
  const candidate = value as Partial<WalletState>;
  if (candidate.version !== 1) {
    throw new Error(`Unsupported wallet schema version: ${String(candidate.version)}`);
  }
  if (!Number.isSafeInteger(candidate.revision) || (candidate.revision ?? -1) < 0) {
    throw new Error("Wallet storage has an invalid revision");
  }
  if (!Array.isArray(candidate.pockets)) {
    throw new Error("Wallet storage has invalid pockets");
  }
  for (const pocket of candidate.pockets) {
    if (
      !pocket ||
      typeof pocket.mintUrl !== "string" ||
      typeof pocket.unit !== "string" ||
      !Array.isArray(pocket.proofs)
    ) {
      throw new Error("Wallet storage has an invalid pocket");
    }
    for (const proof of pocket.proofs) {
      if (
        !proof ||
        typeof proof.amount !== "string" ||
        !/^[1-9]\d*$/.test(proof.amount) ||
        typeof proof.id !== "string" ||
        typeof proof.secret !== "string" ||
        typeof proof.C !== "string"
      ) {
        throw new Error("Wallet storage has an invalid proof");
      }
    }
  }
}

export class WalletRepository {
  constructor(private readonly driver: StorageDriver) {}

  async load(): Promise<WalletState> {
    const stored = await this.driver.get(WALLET_KEY);
    if (stored === undefined || stored === null) return createEmptyWallet();
    assertWalletState(stored);
    return clone(stored);
  }

  async save(state: WalletState): Promise<void> {
    assertWalletState(state);
    await this.driver.set(WALLET_KEY, clone(state));
  }

  async clear(): Promise<void> {
    await this.driver.delete(WALLET_KEY);
  }
}

export class MemoryStorageDriver implements StorageDriver {
  private readonly values = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    const value = this.values.get(key);
    return value === undefined ? undefined : clone(value);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, clone(value));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export class IndexedDbStorageDriver implements StorageDriver {
  constructor(
    private readonly databaseName = "granola-wallet",
    private readonly storeName = "private-wallet"
  ) {}

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) {
          request.result.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
  }

  private async request<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const database = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(this.storeName, mode);
        const request = operation(transaction.objectStore(this.storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB aborted"));
      });
    } finally {
      database.close();
    }
  }

  async get(key: string): Promise<unknown> {
    return this.request("readonly", (store) => store.get(key));
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.request("readwrite", (store) => store.put(value, key));
  }

  async delete(key: string): Promise<void> {
    await this.request("readwrite", (store) => store.delete(key));
  }
}
