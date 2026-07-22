import { describe, expect, it } from "vitest";

import { addProofs, createEmptyWallet } from "../core/wallet.js";
import {
  MemoryStorageDriver,
  WalletRepository
} from "./wallet-repository.js";

describe("wallet repository", () => {
  it("starts empty and round-trips bearer proofs without losing amount precision", async () => {
    const driver = new MemoryStorageDriver();
    const repository = new WalletRepository(driver);

    expect(await repository.load()).toEqual(createEmptyWallet());

    const state = addProofs(createEmptyWallet(), {
      mintUrl: "https://mint.test",
      unit: "usd",
      proofs: [
        {
          amount: "9007199254740993",
          id: "usd-keyset",
          secret: "persisted-secret",
          C: "persisted-signature"
        }
      ]
    });
    await repository.save(state);

    const restored = await repository.load();
    expect(restored).toEqual(state);
    expect(restored).not.toBe(state);
  });

  it("refuses unknown schema versions instead of discarding wallet data", async () => {
    const driver = new MemoryStorageDriver();
    await driver.set("granola.wallet.v1", { version: 2, revision: 0, pockets: [] });

    await expect(new WalletRepository(driver).load()).rejects.toThrow(
      "Unsupported wallet schema version"
    );
  });

  it("clears persisted proofs only when explicitly called", async () => {
    const driver = new MemoryStorageDriver();
    const repository = new WalletRepository(driver);
    const state = addProofs(createEmptyWallet(), {
      mintUrl: "https://mint.test",
      unit: "sat",
      proofs: [
        { amount: "1", id: "keyset", secret: "secret", C: "signature" }
      ]
    });
    await repository.save(state);

    await repository.clear();

    expect(await repository.load()).toEqual(createEmptyWallet());
  });
});
