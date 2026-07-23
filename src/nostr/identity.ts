import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
  type EventTemplate
} from "nostr-tools/pure";

import type { StorageDriver } from "../storage/wallet-repository.js";

const ORDER_KEYS_KEY = "granola.nostr.order-keys.v1";
const HEX_SECRET = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface StoredOrderKeys {
  version: 1;
  keys: Record<string, string>;
}

export type ExclusiveRunner = <T>(action: () => Promise<T>) => Promise<T>;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function parseStored(value: unknown): StoredOrderKeys {
  if (!value || typeof value !== "object") {
    throw new Error("Order key storage is corrupt");
  }
  const stored = value as Partial<StoredOrderKeys>;
  if (stored.version !== 1 || !stored.keys || typeof stored.keys !== "object" || Array.isArray(stored.keys)) {
    throw new Error("Order key storage is corrupt");
  }
  for (const [orderId, secretKey] of Object.entries(stored.keys)) {
    if (!UUID_V4.test(orderId) || typeof secretKey !== "string" || !HEX_SECRET.test(secretKey)) {
      throw new Error("Order key storage is corrupt");
    }
    try {
      getPublicKey(hexToBytes(secretKey));
    } catch {
      throw new Error("Order key storage is corrupt");
    }
  }
  return { version: 1, keys: { ...stored.keys } };
}

export class MakerIdentity {
  constructor(
    private readonly driver: StorageDriver,
    private readonly runExclusive: ExclusiveRunner = async (action) => action(),
    private readonly generate: () => Uint8Array = generateSecretKey
  ) {}

  private async readStoredKeys(): Promise<StoredOrderKeys> {
    const existing = await this.driver.get(ORDER_KEYS_KEY);
    if (existing === undefined || existing === null) return { version: 1, keys: {} };
    return parseStored(existing);
  }

  private async withStoredKeys<T>(action: (stored: StoredOrderKeys) => Promise<T>): Promise<T> {
    return this.runExclusive(async () => action(await this.readStoredKeys()));
  }

  private async secretKey(orderId: string): Promise<Uint8Array> {
    if (!UUID_V4.test(orderId)) throw new Error("Order ID must be a UUID v4");
    return this.withStoredKeys(async (stored) => {
      const existing = stored.keys[orderId];
      if (existing !== undefined) return hexToBytes(existing);

      const secretKey = this.generate();
      const next: StoredOrderKeys = {
        version: 1,
        keys: { ...stored.keys, [orderId]: bytesToHex(secretKey) }
      };
      parseStored(next);
      await this.driver.set(ORDER_KEYS_KEY, next);
      const result = secretKey.slice();
      secretKey.fill(0);
      return result;
    });
  }

  private async existingSecretKey(orderId: string): Promise<Uint8Array> {
    if (!UUID_V4.test(orderId)) throw new Error("Order ID must be a UUID v4");
    return this.withStoredKeys(async (stored) => {
      const secretKey = stored.keys[orderId];
      if (!secretKey) throw new Error("Nostr order key is no longer available");
      return hexToBytes(secretKey);
    });
  }

  async listOrderIds(): Promise<string[]> {
    return this.withStoredKeys(async (stored) => Object.keys(stored.keys).sort());
  }

  async listPublicKeys(): Promise<string[]> {
    return this.withStoredKeys(async (stored) =>
      Object.values(stored.keys).map((secretKey) => {
        const bytes = hexToBytes(secretKey);
        try {
          return getPublicKey(bytes);
        } finally {
          bytes.fill(0);
        }
      }).sort()
    );
  }

  async publicKey(orderId?: string): Promise<string> {
    if (!orderId) throw new Error("Order ID is required for a Nostr order key");
    const secretKey = await this.secretKey(orderId);
    try {
      return getPublicKey(secretKey);
    } finally {
      secretKey.fill(0);
    }
  }

  async existingPublicKey(orderId: string): Promise<string | undefined> {
    if (!UUID_V4.test(orderId)) throw new Error("Order ID must be a UUID v4");
    return this.withStoredKeys(async (stored) => {
      const secretKey = stored.keys[orderId];
      if (!secretKey) return undefined;
      const bytes = hexToBytes(secretKey);
      try {
        return getPublicKey(bytes);
      } finally {
        bytes.fill(0);
      }
    });
  }

  async sign(template: EventTemplate, orderId: string): Promise<Event> {
    const freshTemplate: EventTemplate = {
      kind: template.kind,
      created_at: template.created_at,
      tags: template.tags.map((tag) => [...tag]),
      content: template.content
    };
    return this.useOrderSecretKey(orderId, async (secretKey) => finalizeEvent(freshTemplate, secretKey));
  }

  async useOrderSecretKey<T>(orderId: string, action: (secretKey: Uint8Array) => Promise<T>): Promise<T> {
    const stored = await this.existingSecretKey(orderId);
    const borrowed = stored.slice();
    stored.fill(0);
    try {
      return await action(borrowed);
    } finally {
      borrowed.fill(0);
    }
  }

  async destroy(orderId: string): Promise<void> {
    if (!UUID_V4.test(orderId)) throw new Error("Order ID must be a UUID v4");
    await this.withStoredKeys(async (stored) => {
      if (!Object.hasOwn(stored.keys, orderId)) return;
      const secretKey = stored.keys[orderId];
      delete stored.keys[orderId];
      await this.driver.set(ORDER_KEYS_KEY, stored);
      if (secretKey) {
        const bytes = hexToBytes(secretKey);
        bytes.fill(0);
      }
    });
  }
}
