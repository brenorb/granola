import { createEmptyWallet, type WalletState } from "../core/wallet.js";

const WALLET_KEY = "granola.wallet.v1";

export interface StorageDriver {
  readonly invalidationSignal?: AbortSignal;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

type StorageEntry = readonly [key: string, value: unknown];

export interface AtomicStorageDriver extends StorageDriver {
  setMany(entries: readonly StorageEntry[]): Promise<void>;
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
    return structuredClone(stored);
  }

  async save(state: WalletState): Promise<void> {
    assertWalletState(state);
    await this.driver.set(WALLET_KEY, structuredClone(state));
  }

  async saveAlongside(
    state: WalletState,
    driver: AtomicStorageDriver,
    entry: StorageEntry
  ): Promise<void> {
    if (driver !== this.driver) throw new Error("Wallet and funding quotes must share storage");
    assertWalletState(state);
    await driver.setMany([[WALLET_KEY, state], entry]);
  }

  async clear(): Promise<void> {
    await this.driver.delete(WALLET_KEY);
  }
}

export class MemoryStorageDriver implements AtomicStorageDriver {
  private readonly values = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async setMany(entries: readonly StorageEntry[]): Promise<void> {
    for (const [key, value] of structuredClone(entries)) this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export class IndexedDbStorageDriver implements AtomicStorageDriver {
  private database: Promise<IDBDatabase> | undefined;
  private readonly invalidation = new AbortController();
  readonly invalidationSignal = this.invalidation.signal;

  private invalidate(): void {
    this.invalidation.abort(new Error("Wallet database was invalidated; reload this profile"));
    void this.database?.then(database => database.close(), () => undefined);
    this.database = undefined;
  }

  constructor(
    private readonly databaseName = "granola-wallet",
    private readonly storeName = "private-wallet"
  ) {}

  private open(): Promise<IDBDatabase> {
    this.invalidationSignal.throwIfAborted();
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false;
      const request = indexedDB.open(this.databaseName, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) {
          request.result.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        if (blocked || this.invalidationSignal.aborted) {
          database.close();
          if (blocked) return;
          reject(this.invalidationSignal.reason);
          return;
        }
        database.onversionchange = () => this.invalidate();
        database.onclose = () => this.invalidate();
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => {
        blocked = true;
        reject(new Error("IndexedDB upgrade is blocked; close or reload other profile tabs"));
      };
    }).catch(error => {
      this.database = undefined;
      throw error;
    });
  }

  private async transact<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => () => T,
    options?: IDBTransactionOptions
  ): Promise<T> {
    const database = await this.open();
    this.invalidationSignal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(this.storeName, mode, options);
      let result: () => T;
      // Resolve only after commit: an IDB request can succeed before its transaction aborts.
      transaction.oncomplete = () => resolve(result());
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB aborted"));
      try {
        result = operation(transaction.objectStore(this.storeName));
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  }

  private request<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    return this.transact(mode, (store) => {
      const request = operation(store);
      return () => request.result;
    });
  }

  async get(key: string): Promise<unknown> {
    return this.request("readonly", (store) => store.get(key));
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.request("readwrite", (store) => store.put(value, key));
  }

  async setMany(entries: readonly StorageEntry[]): Promise<void> {
    await this.transact("readwrite", (store) => {
      for (const [key, value] of entries) store.put(value, key);
      return () => undefined;
    }, { durability: "strict" });
  }

  async delete(key: string): Promise<void> {
    await this.request("readwrite", (store) => store.delete(key));
  }

  async resetDatabase(): Promise<void> {
    this.invalidate();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB delete failed"));
      request.onblocked = () => reject(new Error("IndexedDB reset is blocked by another open profile tab"));
    });
  }
}
