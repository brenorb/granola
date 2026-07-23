import { describe, expect, it } from "vitest";

import type { StoredProof, WalletState } from "../core/wallet.js";
import { reconcileProofReplacement } from "./wallet-reconcile.js";

function proof(secret: string, amount = "1"): StoredProof {
  return { amount, id: "00deadbeefcafeee", secret, C: `C-${secret}` };
}

function wallet(proofs: StoredProof[]): WalletState {
  return {
    version: 1,
    revision: 4,
    pockets: [{ mintUrl: "https://mint.example", unit: "sat", proofs }]
  };
}

describe("trade wallet reconciliation", () => {
  it("replaces the prepared inputs with returned change exactly once", () => {
    const first = reconcileProofReplacement(wallet([proof("spent-a", "8"), proof("keep", "2")]), {
      mintUrl: "https://mint.example",
      unit: "sat",
      spentSecrets: ["spent-a"],
      proofs: [proof("change", "3")]
    });
    const retried = reconcileProofReplacement(first, {
      mintUrl: "https://mint.example",
      unit: "sat",
      spentSecrets: ["spent-a"],
      proofs: [proof("change", "3")]
    });

    expect(first.pockets[0]?.proofs.map((item) => item.secret)).toEqual(["keep", "change"]);
    expect(retried).toBe(first);
  });

  it("fails closed on partial input or output reconciliation", () => {
    expect(() => reconcileProofReplacement(wallet([proof("spent-a"), proof("change")]), {
      mintUrl: "https://mint.example",
      unit: "sat",
      spentSecrets: ["spent-a", "spent-b"],
      proofs: [proof("change")]
    })).toThrow("ambiguous");

    expect(() => reconcileProofReplacement(wallet([proof("keep"), proof("change-a")]), {
      mintUrl: "https://mint.example",
      unit: "sat",
      spentSecrets: ["spent-a"],
      proofs: [proof("change-a"), proof("change-b")]
    })).toThrow("ambiguous");
  });

  it("rejects a replacement proof that collides with an unrelated wallet proof", () => {
    expect(() => reconcileProofReplacement(wallet([proof("spent"), proof("collision")]), {
      mintUrl: "https://mint.example",
      unit: "sat",
      spentSecrets: ["spent"],
      proofs: [proof("collision")]
    })).toThrow("collides");
  });
});
