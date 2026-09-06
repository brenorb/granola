import { describe, expect, it, vi } from "vitest";

import { EncryptedStorageDriver } from "./encrypted-storage.js";
import { MemoryStorageDriver } from "./wallet-repository.js";

describe("encrypted private storage", () => {
  it("coalesces key loading, keeps it non-extractable and isolates namespaces", async () => {
    const raw = new MemoryStorageDriver();
    const read = vi.spyOn(raw, "get");
    const encrypted = new EncryptedStorageDriver(raw, "profile-a");
    await Promise.all([encrypted.set("one", { n: 1 }), encrypted.set("two", { n: 2 })]);
    expect(await encrypted.get("one")).toEqual({ n: 1 });
    expect(await encrypted.get("two")).toEqual({ n: 2 });
    expect(read.mock.calls.filter(([key]) => key === "profile-a.key")).toHaveLength(1);
    const key = await raw.get("profile-a.key") as CryptoKey;
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    const other = new EncryptedStorageDriver(raw, "profile-b");
    await other.set("one", { n: 3 });
    expect(await encrypted.get("one")).toEqual({ n: 1 });
    await raw.set("profile-b.data.one", await raw.get("profile-a.data.one"));
    await expect(other.get("one")).rejects.toThrow(/decrypt/);
  });

  it("retries a failed key load and refuses the cached key after profile invalidation", async () => {
    const invalidation = new AbortController();
    const raw = Object.assign(new MemoryStorageDriver(), { invalidationSignal: invalidation.signal });
    const encrypted = new EncryptedStorageDriver(raw, "profile-a");
    vi.spyOn(raw, "get").mockRejectedValueOnce(new Error("temporary storage failure"));
    await expect(encrypted.set("one", { n: 1 })).rejects.toThrow(/temporary/);
    await encrypted.set("one", { n: 2 });
    invalidation.abort(new Error("profile reset"));
    await expect(encrypted.get("one")).rejects.toThrow(/decrypt/);
    await expect(encrypted.set("two", { n: 3 })).rejects.toThrow(/profile reset/);
    expect(await raw.get("profile-a.data.two")).toBeUndefined();
  });

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
