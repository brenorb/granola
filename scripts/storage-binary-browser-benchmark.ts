import { EncryptedStorageDriver } from "../src/storage/encrypted-storage.js";
import type { StorageDriver } from "../src/storage/wallet-repository.js";
import { IndexedDbStorageDriver } from "../src/storage/wallet-repository.js";

const namespace = "browser-storage-binary";
const cutoverNamespace = "browser-storage-cutover";
const payload = {
  revision: 42,
  entries: Array.from({ length: 500 }, (_, index) => ({
    id: index,
    status: index % 3 === 0 ? "pending" : "complete",
    label: `entry-${index}`,
    metadata: "x".repeat(120)
  }))
};

function legacyEnvelope(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const envelope = value as { version?: unknown; iv?: unknown; ciphertext?: unknown };
  const toNumbers = (bytes: unknown): unknown =>
    ArrayBuffer.isView(bytes) && Object.prototype.toString.call(bytes) === "[object Uint8Array]"
      ? [...(bytes as Uint8Array)]
      : bytes;
  return {
    version: envelope.version,
    iv: toNumbers(envelope.iv),
    ciphertext: toNumbers(envelope.ciphertext)
  };
}

class LegacyShapeStorage implements StorageDriver {
  readonly invalidationSignal: AbortSignal;

  constructor(private readonly delegate: StorageDriver & { invalidationSignal: AbortSignal }) {
    this.invalidationSignal = delegate.invalidationSignal;
  }

  async get(key: string): Promise<unknown> {
    return this.delegate.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.delegate.set(
      key,
      key === `${namespace}.data.payload` ? legacyEnvelope(value) : value
    );
  }

  async delete(key: string): Promise<void> {
    await this.delegate.delete(key);
  }
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function pairMedian(
  nativeAction: () => Promise<void>,
  legacyAction: () => Promise<void>
): Promise<{ nativeMs: number; legacyMs: number }> {
  await nativeAction();
  await legacyAction();
  const nativeSamples: number[] = [];
  const legacySamples: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    const actions = index % 2 === 0
      ? [[nativeAction, nativeSamples], [legacyAction, legacySamples]] as const
      : [[legacyAction, legacySamples], [nativeAction, nativeSamples]] as const;
    for (const [action, samples] of actions) {
      const started = performance.now();
      await action();
      if (index >= 2) samples.push(performance.now() - started);
    }
  }
  return { nativeMs: median(nativeSamples), legacyMs: median(legacySamples) };
}

async function createDriver(mode: "native" | "legacy"): Promise<EncryptedStorageDriver> {
  const databaseName = `granola-storage-binary-${mode}`;
  await new IndexedDbStorageDriver(databaseName).resetDatabase();
  const raw = new IndexedDbStorageDriver(databaseName);
  return new EncryptedStorageDriver(
    mode === "legacy" ? new LegacyShapeStorage(raw) : raw,
    namespace
  );
}

function openDatabase(name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("private-wallet")) {
        request.result.createObjectStore("private-wallet");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

async function verifyVersionCutover(): Promise<{
  oldTabInvalidated: boolean;
  legacyReadable: boolean;
  binaryWritten: boolean;
  binaryReadable: boolean;
  rollbackV1Rejected: boolean;
}> {
  const databaseName = `granola-storage-binary-cutover-${Date.now()}`;
  const oldDatabase = await openDatabase(databaseName, 1);
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify({ marker: "legacy" }));
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: new TextEncoder().encode(`${cutoverNamespace}\0payload`)
  }, key, plaintext);
  await new Promise<void>((resolve, reject) => {
    const transaction = oldDatabase.transaction("private-wallet", "readwrite");
    const store = transaction.objectStore("private-wallet");
    store.put(key, `${cutoverNamespace}.key`);
    store.put({
      version: 1,
      iv: [...iv],
      ciphertext: [...new Uint8Array(ciphertext)]
    }, `${cutoverNamespace}.data.payload`);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write aborted"));
  });
  let oldTabInvalidated = false;
  oldDatabase.onversionchange = () => {
    oldTabInvalidated = true;
    oldDatabase.close();
  };

  const raw = new IndexedDbStorageDriver(databaseName);
  const encrypted = new EncryptedStorageDriver(raw, cutoverNamespace);
  const legacyReadable = JSON.stringify(await encrypted.get("payload")) ===
    JSON.stringify({ marker: "legacy" });
  await encrypted.set("payload", { marker: "binary" });
  const stored = await raw.get(`${cutoverNamespace}.data.payload`) as {
    iv?: unknown;
    ciphertext?: unknown;
  };
  const binaryWritten =
    ArrayBuffer.isView(stored.iv) &&
    Object.prototype.toString.call(stored.iv) === "[object Uint8Array]" &&
    ArrayBuffer.isView(stored.ciphertext) &&
    Object.prototype.toString.call(stored.ciphertext) === "[object Uint8Array]";
  const binaryReadable = JSON.stringify(await encrypted.get("payload")) ===
    JSON.stringify({ marker: "binary" });

  const rollback = indexedDB.open(databaseName, 1);
  const rollbackV1Rejected = await new Promise<boolean>((resolve) => {
    rollback.onerror = () => resolve(rollback.error?.name === "VersionError");
    rollback.onsuccess = () => {
      rollback.result.close();
      resolve(false);
    };
  });
  return { oldTabInvalidated, legacyReadable, binaryWritten, binaryReadable, rollbackV1Rejected };
}

const native = await createDriver("native");
const legacy = await createDriver("legacy");
await native.set("payload", payload);
await legacy.set("payload", payload);
const set = await pairMedian(
  () => native.set("payload", payload),
  () => legacy.set("payload", payload)
);
const get = await pairMedian(
  async () => { await native.get("payload"); },
  async () => { await legacy.get("payload"); }
);
const cutover = await verifyVersionCutover();
const result = {
  benchmark: "encrypted-storage-binary-browser",
  payloadJsonBytes: JSON.stringify(payload).length,
  rounds: 8,
  storage: "IndexedDbStorageDriver",
  operationsMs: {
    native: { set: Number(set.nativeMs.toFixed(3)), get: Number(get.nativeMs.toFixed(3)) },
    legacy: { set: Number(set.legacyMs.toFixed(3)), get: Number(get.legacyMs.toFixed(3)) }
  },
  versionCutover: cutover
};
document.body.textContent = JSON.stringify(result);
console.log(JSON.stringify(result));
