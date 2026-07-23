import { describe, expect, it } from "vitest";

import { MemoryStorageDriver } from "../storage/wallet-repository.js";
import { MakerIdentity } from "./identity.js";

const FIXED_SECRET = new Uint8Array(32).fill(1);

describe("maker identity", () => {
  it("persists one protocol key and exposes only its public key", async () => {
    const driver = new MemoryStorageDriver();
    let generations = 0;
    const first = new MakerIdentity(driver, async (action) => action(), () => {
      generations += 1;
      return FIXED_SECRET;
    });

    const publicKey = await first.publicKey();
    const restored = new MakerIdentity(driver);

    expect(await restored.publicKey()).toBe(publicKey);
    expect(publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(generations).toBe(1);
    expect(JSON.stringify(first)).not.toContain("01010101");
  });

  it("signs a fresh Nostr event without returning key material", async () => {
    const identity = new MakerIdentity(
      new MemoryStorageDriver(),
      async (action) => action(),
      () => FIXED_SECRET
    );

    const signed = await identity.sign({
      kind: 30078,
      created_at: 1_700_000_000,
      tags: [["t", "granola-test"]],
      content: "{}"
    });

    expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(signed.pubkey).toBe(await identity.publicKey());
    expect(Object.keys(signed)).not.toContain("secretKey");
    expect(JSON.stringify(signed)).not.toContain("01010101");
  });

  it("rejects corrupt stored key material instead of rotating authority", async () => {
    const driver = new MemoryStorageDriver();
    await driver.set("granola.nostr.identity.v1", {
      version: 1,
      secret_key: "not-a-secret-key"
    });

    await expect(new MakerIdentity(driver).publicKey()).rejects.toThrow(
      "Maker identity storage is corrupt"
    );
  });

  it("destroys identity only through the explicit operation", async () => {
    const driver = new MemoryStorageDriver();
    let next = 1;
    const identity = new MakerIdentity(driver, async (action) => action(), () =>
      new Uint8Array(32).fill(next++)
    );
    const before = await identity.publicKey();

    await identity.destroy();

    expect(await identity.publicKey()).not.toBe(before);
  });

  it("scopes private-key use to an internal callback and wipes the borrowed bytes", async () => {
    const identity = new MakerIdentity(
      new MemoryStorageDriver(),
      async (action) => action(),
      () => FIXED_SECRET
    );

    const borrowed = await identity.useSecretKey(async (secret) => {
      expect(secret).not.toBe(FIXED_SECRET);
      expect(secret.some((byte) => byte !== 0)).toBe(true);
      return secret;
    });

    expect([...borrowed]).toEqual(new Array(32).fill(0));
    expect(await identity.publicKey()).toMatch(/^[0-9a-f]{64}$/);
  });
});
