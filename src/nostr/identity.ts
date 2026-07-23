import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
  type EventTemplate
} from "nostr-tools/pure";

import type { StorageDriver } from "../storage/wallet-repository.js";

const IDENTITY_KEY = "granola.nostr.identity.v1";
const HEX_SECRET = /^[0-9a-f]{64}$/;

interface StoredIdentity {
  version: 1;
  secret_key: string;
}

export type ExclusiveRunner = <T>(action: () => Promise<T>) => Promise<T>;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function parseStored(value: unknown): StoredIdentity {
  if (!value || typeof value !== "object") {
    throw new Error("Maker identity storage is corrupt");
  }
  const stored = value as Partial<StoredIdentity>;
  if (stored.version !== 1 || typeof stored.secret_key !== "string" || !HEX_SECRET.test(stored.secret_key)) {
    throw new Error("Maker identity storage is corrupt");
  }
  try {
    getPublicKey(hexToBytes(stored.secret_key));
  } catch {
    throw new Error("Maker identity storage is corrupt");
  }
  return { version: 1, secret_key: stored.secret_key };
}

export class MakerIdentity {
  constructor(
    private readonly driver: StorageDriver,
    private readonly runExclusive: ExclusiveRunner = async (action) => action(),
    private readonly generate: () => Uint8Array = generateSecretKey
  ) {}

  private async secretKey(): Promise<Uint8Array> {
    return this.runExclusive(async () => {
      const existing = await this.driver.get(IDENTITY_KEY);
      if (existing !== undefined && existing !== null) {
        return hexToBytes(parseStored(existing).secret_key);
      }

      const secretKey = this.generate();
      const stored: StoredIdentity = {
        version: 1,
        secret_key: bytesToHex(secretKey)
      };
      parseStored(stored);
      await this.driver.set(IDENTITY_KEY, stored);
      return hexToBytes(stored.secret_key);
    });
  }

  async publicKey(): Promise<string> {
    return this.useSecretKey(async (secretKey) => getPublicKey(secretKey));
  }

  async sign(template: EventTemplate): Promise<Event> {
    const freshTemplate: EventTemplate = {
      kind: template.kind,
      created_at: template.created_at,
      tags: template.tags.map((tag) => [...tag]),
      content: template.content
    };
    return this.useSecretKey(async (secretKey) => finalizeEvent(freshTemplate, secretKey));
  }

  async useSecretKey<T>(action: (secretKey: Uint8Array) => Promise<T>): Promise<T> {
    const stored = await this.secretKey();
    const borrowed = stored.slice();
    stored.fill(0);
    try {
      return await action(borrowed);
    } finally {
      borrowed.fill(0);
    }
  }

  async destroy(): Promise<void> {
    await this.runExclusive(async () => {
      await this.driver.delete(IDENTITY_KEY);
    });
  }
}
