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

  it("stores native bytes and reads envelopes persisted as legacy number arrays", async () => {
    const raw = new MemoryStorageDriver();
    const encrypted = new EncryptedStorageDriver(raw, "binary-test");
    const value = { revision: 7, state: "private" };

    await encrypted.set("session", value);
    const stored = await raw.get("binary-test.data.session") as {
      version: number;
      iv: Uint8Array;
      ciphertext: Uint8Array;
    };
    expect(ArrayBuffer.isView(stored.iv)).toBe(true);
    expect(Object.prototype.toString.call(stored.iv)).toBe("[object Uint8Array]");
    expect(ArrayBuffer.isView(stored.ciphertext)).toBe(true);
    expect(Object.prototype.toString.call(stored.ciphertext)).toBe("[object Uint8Array]");

    await raw.set("binary-test.data.session", {
      version: stored.version,
      iv: [...stored.iv],
      ciphertext: [...stored.ciphertext]
    });
    await expect(encrypted.get("session")).resolves.toEqual(value);
  });

  it("rejects malformed binary envelopes before decryption", async () => {
    const raw = new MemoryStorageDriver();
    const encrypted = new EncryptedStorageDriver(raw, "binary-test");
    const key = "binary-test.data.session";

    await raw.set(key, {
      version: 1,
      iv: new Uint16Array(6),
      ciphertext: new Uint8Array(17)
    });
    await expect(encrypted.get("session")).rejects.toThrow(/IV is corrupt/);

    await raw.set(key, {
      version: 1,
      iv: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      ciphertext: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 256]
    });
    await expect(encrypted.get("session")).rejects.toThrow(/ciphertext is corrupt/);
  });

  it("fails closed when ciphertext or associated storage key is changed", async () => {
    const raw = new MemoryStorageDriver();
    const encrypted = new EncryptedStorageDriver(raw, "trade-test");
    await encrypted.set("session", { value: "private" });
    const envelope = await raw.get("trade-test.data.session") as {
      version: number;
      iv: Uint8Array;
      ciphertext: Uint8Array;
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
