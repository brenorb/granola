import { EncryptedStorageDriver } from "../src/storage/encrypted-storage.js";
import type { StorageDriver } from "../src/storage/wallet-repository.js";
import { MemoryStorageDriver } from "../src/storage/wallet-repository.js";

const dataKey = "binary-benchmark.data.payload";
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
  constructor(private readonly delegate: StorageDriver) {}

  async get(key: string): Promise<unknown> {
    return this.delegate.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.delegate.set(key, key === dataKey ? legacyEnvelope(value) : value);
  }

  async delete(key: string): Promise<void> {
    await this.delegate.delete(key);
  }
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function asyncMedian(action: () => Promise<void>): Promise<number> {
  await action();
  const samples: number[] = [];
  for (let index = 0; index < 9; index += 1) {
    const started = performance.now();
    await action();
    if (index >= 2) samples.push(performance.now() - started);
  }
  return median(samples);
}

function cloneMedian(value: unknown): number {
  structuredClone(value);
  const samples: number[] = [];
  for (let index = 0; index < 9; index += 1) {
    const started = performance.now();
    structuredClone(value);
    if (index >= 2) samples.push(performance.now() - started);
  }
  return median(samples);
}

const nativeRaw = new MemoryStorageDriver();
const legacyRaw = new LegacyShapeStorage(new MemoryStorageDriver());
const native = new EncryptedStorageDriver(nativeRaw, "binary-benchmark");
const legacy = new EncryptedStorageDriver(legacyRaw, "binary-benchmark");

await native.set("payload", payload);
await legacy.set("payload", payload);
const nativeSetMs = await asyncMedian(() => native.set("payload", payload));
const legacySetMs = await asyncMedian(() => legacy.set("payload", payload));
const nativeGetMs = await asyncMedian(async () => { await native.get("payload"); });
const legacyGetMs = await asyncMedian(async () => { await legacy.get("payload"); });

const ciphertext = new Uint8Array(100_000);
const nativeEnvelope = { version: 1, iv: new Uint8Array(12), ciphertext };
const oldEnvelope = {
  version: 1,
  iv: [...nativeEnvelope.iv],
  ciphertext: [...nativeEnvelope.ciphertext]
};
console.log(JSON.stringify({
  benchmark: "encrypted-storage-binary",
  payloadJsonBytes: JSON.stringify(payload).length,
  driver: {
    native: { setMs: Number(nativeSetMs.toFixed(3)), getMs: Number(nativeGetMs.toFixed(3)) },
    legacy: { setMs: Number(legacySetMs.toFixed(3)), getMs: Number(legacyGetMs.toFixed(3)) }
  },
  structuredClone: {
    nativeMs: Number(cloneMedian(nativeEnvelope).toFixed(3)),
    legacyMs: Number(cloneMedian(oldEnvelope).toFixed(3))
  }
}));
