import { describe, expect, it } from "vitest";

import {
  addProofs,
  createEmptyWallet,
  getWalletView,
  replaceProofs,
  type StoredProof
} from "./wallet.js";

const proof = (amount: number, id: string, secret: string): StoredProof => ({
  amount: String(amount),
  id,
  secret,
  C: `signature-${secret}`
});

describe("wallet domain", () => {
  it("groups balances by unit and mint without converting currencies", () => {
    let state = createEmptyWallet();
    state = addProofs(state, {
      mintUrl: "https://mint-a.test/",
      unit: "sat",
      proofs: [proof(1, "sat-keyset", "sat-a-1"), proof(4, "sat-keyset", "sat-a-4")]
    });
    state = addProofs(state, {
      mintUrl: "https://mint-b.test",
      unit: "sat",
      proofs: [proof(2, "sat-keyset-b", "sat-b-2")]
    });
    state = addProofs(state, {
      mintUrl: "https://mint-fiat.test",
      unit: "usd",
      proofs: [proof(8, "usd-keyset", "usd-8")]
    });
    state = addProofs(state, {
      mintUrl: "https://mint-fiat.test",
      unit: "eur",
      proofs: [proof(3, "eur-keyset", "eur-3")]
    });

    expect(getWalletView(state)).toEqual({
      revision: 4,
      balances: [
        { unit: "eur", amount: "3", mintCount: 1, proofCount: 1 },
        { unit: "sat", amount: "7", mintCount: 2, proofCount: 3 },
        { unit: "usd", amount: "8", mintCount: 1, proofCount: 1 }
      ],
      pockets: [
        {
          mintUrl: "https://mint-a.test",
          unit: "sat",
          amount: "5",
          proofCount: 2,
          denominations: ["1", "4"],
          keysetIds: ["sat-keyset"]
        },
        {
          mintUrl: "https://mint-b.test",
          unit: "sat",
          amount: "2",
          proofCount: 1,
          denominations: ["2"],
          keysetIds: ["sat-keyset-b"]
        },
        {
          mintUrl: "https://mint-fiat.test",
          unit: "eur",
          amount: "3",
          proofCount: 1,
          denominations: ["3"],
          keysetIds: ["eur-keyset"]
        },
        {
          mintUrl: "https://mint-fiat.test",
          unit: "usd",
          amount: "8",
          proofCount: 1,
          denominations: ["8"],
          keysetIds: ["usd-keyset"]
        }
      ]
    });
  });

  it("deduplicates proofs so a repeated import cannot inflate balance", () => {
    const repeated = proof(8, "keyset", "same-secret");
    let state = addProofs(createEmptyWallet(), {
      mintUrl: "https://mint.test",
      unit: "sat",
      proofs: [repeated]
    });

    state = addProofs(state, {
      mintUrl: "https://mint.test/",
      unit: "sat",
      proofs: [repeated]
    });

    expect(getWalletView(state).balances).toEqual([
      { unit: "sat", amount: "8", mintCount: 1, proofCount: 1 }
    ]);
    expect(state.revision).toBe(1);
  });

  it("never exposes bearer secrets in the human or agent snapshot", () => {
    const state = addProofs(createEmptyWallet(), {
      mintUrl: "https://mint.test",
      unit: "sat",
      proofs: [proof(1, "keyset", "do-not-leak-this-secret")]
    });

    const serialized = JSON.stringify(getWalletView(state));

    expect(serialized).not.toContain("do-not-leak-this-secret");
    expect(serialized).not.toContain("signature-do-not-leak");
    expect(serialized).not.toContain('"secret"');
    expect(serialized).not.toContain('"C"');
  });

  it("atomically replaces spent inputs with swap change", () => {
    const funded = addProofs(createEmptyWallet(), {
      mintUrl: "https://mint.test",
      unit: "sat",
      proofs: [proof(8, "keyset", "spent-a"), proof(4, "keyset", "kept-b")]
    });

    const changed = replaceProofs(funded, {
      mintUrl: "https://mint.test",
      unit: "sat",
      spentSecrets: ["spent-a"],
      proofs: [proof(3, "keyset", "fresh-change")]
    });

    expect(changed.revision).toBe(funded.revision + 1);
    expect(changed.pockets[0]?.proofs.map((item) => item.secret).sort())
      .toEqual(["fresh-change", "kept-b"]);
    expect(getWalletView(changed).balances[0]?.amount).toBe("7");
  });

  it("does not mutate a wallet when a claimed spent input is absent", () => {
    const funded = addProofs(createEmptyWallet(), {
      mintUrl: "https://mint.test",
      unit: "sat",
      proofs: [proof(8, "keyset", "present")]
    });

    expect(() => replaceProofs(funded, {
      mintUrl: "https://mint.test",
      unit: "sat",
      spentSecrets: ["missing"],
      proofs: []
    })).toThrow("not in the wallet");
    expect(getWalletView(funded).balances[0]?.amount).toBe("8");
  });
});
