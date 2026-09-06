import { EncryptedStorageDriver } from "../src/storage/encrypted-storage.js";
import type { StorageDriver } from "../src/storage/wallet-repository.js";
import { IndexedDbStorageDriver } from "../src/storage/wallet-repository.js";

const namespace = "browser-storage-binary";
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
  const raw = new IndexedDbStorageDriver(`granola-storage-binary-${mode}`);
  await raw.resetDatabase();
  return new EncryptedStorageDriver(
    mode === "legacy" ? new LegacyShapeStorage(raw) : raw,
    namespace
  );
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
const result = {
  benchmark: "encrypted-storage-binary-browser",
  payloadJsonBytes: JSON.stringify(payload).length,
  rounds: 8,
  storage: "IndexedDbStorageDriver",
  operationsMs: {
    native: { set: Number(set.nativeMs.toFixed(3)), get: Number(get.nativeMs.toFixed(3)) },
    legacy: { set: Number(set.legacyMs.toFixed(3)), get: Number(get.legacyMs.toFixed(3)) }
  }
};
document.body.textContent = JSON.stringify(result);
console.log(JSON.stringify(result));
