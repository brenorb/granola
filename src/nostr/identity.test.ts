import { describe, expect, it } from "vitest";

import { MemoryStorageDriver } from "../storage/wallet-repository.js";
import { MakerIdentity } from "./identity.js";

const ORDER_A = "11111111-1111-4111-8111-111111111111";
const ORDER_B = "22222222-2222-4222-8222-222222222222";

describe("ephemeral maker order identity", () => {
  it("generates one stable key per active order and never shares keys", async () => {
    const driver = new MemoryStorageDriver();
    let next = 1;
    const identity = new MakerIdentity(driver, async (action) => action(), () =>
      new Uint8Array(32).fill(next++)
    );
    const first = await identity.publicKey(ORDER_A);
    expect(await identity.publicKey(ORDER_A)).toBe(first);
    expect(await identity.publicKey(ORDER_B)).not.toBe(first);
    expect(await identity.listOrderIds()).toEqual([ORDER_A, ORDER_B]);
    expect((await identity.listPublicKeys()).sort()).toEqual([first, await identity.publicKey(ORDER_B)].sort());
    expect(next).toBe(3);
  });

  it("signs with the exact order key and wipes borrowed bytes", async () => {
    const identity = new MakerIdentity(new MemoryStorageDriver(), async (action) => action(), () => new Uint8Array(32).fill(1));
    await identity.publicKey(ORDER_A);
    const signed = await identity.sign({ kind: 30078, created_at: 1_700_000_000, tags: [], content: "{}" }, ORDER_A);
    expect(signed.pubkey).toBe(await identity.publicKey(ORDER_A));
    const borrowed = await identity.useOrderSecretKey(ORDER_A, async (secret) => secret);
    expect([...borrowed]).toEqual(new Array(32).fill(0));
  });

  it("rejects corrupt order storage", async () => {
    const driver = new MemoryStorageDriver();
    await driver.set("granola.nostr.order-keys.v1", { version: 1, keys: { [ORDER_A]: "bad" } });
    await expect(new MakerIdentity(driver).listOrderIds()).rejects.toThrow("Order key storage is corrupt");
    await driver.set("granola.nostr.order-keys.v1", { version: 1, keys: {} });
    await new MakerIdentity(driver).listOrderIds();
  });

  it("erases a completed order key and generates a new key only on explicit reuse", async () => {
    let next = 1;
    const identity = new MakerIdentity(new MemoryStorageDriver(), async (action) => action(), () => new Uint8Array(32).fill(next++));
    const before = await identity.publicKey(ORDER_A);
    await identity.destroy(ORDER_A);
    expect(await identity.existingPublicKey(ORDER_A)).toBeUndefined();
    expect(await identity.publicKey(ORDER_A)).not.toBe(before);
  });
});
