import { describe, expect, it } from "vitest";

import { addProofs, createEmptyWallet, getWalletView } from "./wallet.js";

describe("exact Cashu amounts", () => {
  it("keeps balances exact above JavaScript's safe integer range", () => {
    let state = addProofs(createEmptyWallet(), {
      mintUrl: "https://mint.test",
      unit: "sat",
      proofs: [
        {
          amount: "9007199254740993",
          id: "keyset",
          secret: "large-proof",
          C: "large-signature"
        }
      ]
    });
    state = addProofs(state, {
      mintUrl: "https://mint.test",
      unit: "sat",
      proofs: [
        {
          amount: "1",
          id: "keyset",
          secret: "small-proof",
          C: "small-signature"
        }
      ]
    });

    expect(getWalletView(state).balances[0]?.amount).toBe("9007199254740994");
    expect(getWalletView(state).pockets[0]?.denominations).toEqual([
      "1",
      "9007199254740993"
    ]);
  });
});
