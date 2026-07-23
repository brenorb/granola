import type { StorageDriver } from "./wallet-repository.js";

interface EncryptedEnvelope {
  version: 1;
  iv: number[];
  ciphertext: number[];
}

export type StorageExclusiveRunner = <T>(action: () => Promise<T>) => Promise<T>;

const direct: StorageExclusiveRunner = async <T>(action: () => Promise<T>): Promise<T> => action();
const utf8 = new TextEncoder();

function bytes(
  value: unknown,
  expectedLength: number | null,
  label: string
): Uint8Array<ArrayBuffer> {
  if (
    !Array.isArray(value) ||
    (expectedLength !== null && value.length !== expectedLength) ||
    value.some((item) => !Number.isInteger(item) || item < 0 || item > 255)
  ) throw new Error(`Encrypted storage ${label} is corrupt`);
  const result = new Uint8Array((value as number[]).length);
  result.set(value as number[]);
  return result;
}

/**
 * AES-GCM wrapper for private browser state. The non-extractable profile key is
 * structured-cloned by IndexedDB; this protects raw storage dumps, not code
 * already executing with this origin's privileges.
 */
export class EncryptedStorageDriver implements StorageDriver {
  constructor(
    private readonly storage: StorageDriver,
    private readonly namespace: string,
    private readonly runExclusive: StorageExclusiveRunner = direct
  ) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(namespace)) {
      throw new Error("Encrypted storage namespace is invalid");
    }
  }

  private get keyStorageKey(): string {
    return `${this.namespace}.key`;
  }

  private dataStorageKey(key: string): string {
    if (!key || key.length > 256) throw new Error("Encrypted storage key is invalid");
    return `${this.namespace}.data.${key}`;
  }

  private async encryptionKey(): Promise<CryptoKey> {
    return this.runExclusive(async () => {
      const existing = await this.storage.get(this.keyStorageKey);
      if (existing !== undefined && existing !== null) {
        if (
          !(existing instanceof CryptoKey) ||
          existing.type !== "secret" ||
          existing.extractable ||
          existing.algorithm.name !== "AES-GCM" ||
          !existing.usages.includes("encrypt") ||
          !existing.usages.includes("decrypt")
        ) throw new Error("Encrypted storage profile key is corrupt");
        return existing;
      }
      const generated = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
      await this.storage.set(this.keyStorageKey, generated);
      return generated;
    });
  }

  async get(key: string): Promise<unknown> {
    const stored = await this.storage.get(this.dataStorageKey(key));
    if (stored === undefined || stored === null) return undefined;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      throw new Error("Encrypted storage envelope is corrupt");
    }
    const envelope = stored as Partial<EncryptedEnvelope>;
    if (envelope.version !== 1) throw new Error("Encrypted storage envelope is corrupt");
    const iv = bytes(envelope.iv, 12, "IV");
    const ciphertext = bytes(envelope.ciphertext, null, "ciphertext");
    if (ciphertext.length < 17) throw new Error("Encrypted storage ciphertext is corrupt");
    try {
      const plaintext = await crypto.subtle.decrypt({
        name: "AES-GCM",
        iv,
        additionalData: utf8.encode(`${this.namespace}\0${key}`)
      }, await this.encryptionKey(), ciphertext);
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (error) {
      throw new Error("Encrypted storage could not decrypt or parse private state", { cause: error });
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    let plaintext: Uint8Array<ArrayBuffer>;
    try {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) throw new Error("undefined");
      plaintext = utf8.encode(encoded);
    } catch (error) {
      throw new Error("Encrypted storage value is not JSON-serializable", { cause: error });
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv,
      additionalData: utf8.encode(`${this.namespace}\0${key}`)
    }, await this.encryptionKey(), plaintext);
    const envelope: EncryptedEnvelope = {
      version: 1,
      iv: [...iv],
      ciphertext: [...new Uint8Array(ciphertext)]
    };
    await this.storage.set(this.dataStorageKey(key), envelope);
  }

  async delete(key: string): Promise<void> {
    await this.storage.delete(this.dataStorageKey(key));
  }
}
