import { describe, expect, it } from "vitest";

import { EncryptedStorageDriver } from "./encrypted-storage.js";
import { MemoryStorageDriver } from "./wallet-repository.js";

describe("encrypted private storage", () => {
  it("round-trips structured data without storing plaintext recovery material", async () => {
    const raw = new MemoryStorageDriver();
    const encrypted = new EncryptedStorageDriver(raw, "trade-test");
    const secret = {
      preimage: "synthetic-preimage-that-must-not-be-plaintext",
      token: "cashuBsynthetic-bearer-token",
      revision: 1
    };

    await encrypted.set("session", secret);

    expect(await encrypted.get("session")).toEqual(secret);
    expect(JSON.stringify(await raw.get("trade-test.data.session")))
      .not.toContain(secret.preimage);
    expect(JSON.stringify(await raw.get("trade-test.data.session")))
      .not.toContain(secret.token);
    const key = await raw.get("trade-test.key");
    expect(key).toBeInstanceOf(CryptoKey);
    expect((key as CryptoKey).extractable).toBe(false);
  });

  it("fails closed when ciphertext or associated storage key is changed", async () => {
    const raw = new MemoryStorageDriver();
    const encrypted = new EncryptedStorageDriver(raw, "trade-test");
    await encrypted.set("session", { value: "private" });
    const envelope = await raw.get("trade-test.data.session") as {
      version: number;
      iv: number[];
      ciphertext: number[];
    };
    envelope.ciphertext[0] = (envelope.ciphertext[0] ?? 0) ^ 1;
    await raw.set("trade-test.data.session", envelope);

    await expect(encrypted.get("session")).rejects.toThrow(/decrypt/i);
  });

  it("supports deletion without deleting the profile encryption key", async () => {
    const raw = new MemoryStorageDriver();
    const encrypted = new EncryptedStorageDriver(raw, "trade-test");
    await encrypted.set("session", { value: "private" });

    await encrypted.delete("session");

    expect(await encrypted.get("session")).toBeUndefined();
    expect(await raw.get("trade-test.key")).toBeInstanceOf(CryptoKey);
  });
});
