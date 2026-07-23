import { describe, expect, it } from "vitest";

import type { WalletView } from "../core/wallet.js";
import { assertOrderFunding, availableOrderBalance } from "./funding.js";

const wallet: WalletView = {
  revision: 1,
  balances: [
    { unit: "sat", amount: "100", mintCount: 1, proofCount: 3 },
    { unit: "usd", amount: "20", mintCount: 1, proofCount: 1 }
  ],
  pockets: [
    {
      mintUrl: "https://testnut.cashu.space",
      unit: "sat",
      amount: "100",
      proofCount: 3,
      denominations: ["4", "32", "64"],
      keysetIds: ["sat-keyset"]
    },
    {
      mintUrl: "https://nofee.testnut.cashu.space",
      unit: "usd",
      amount: "20",
      proofCount: 1,
      denominations: ["20"],
      keysetIds: ["usd-keyset"]
    }
  ]
};

const market = {
  baseUnit: "sat",
  baseMint: "https://testnut.cashu.space",
  quoteUnit: "usd",
  quoteMint: "https://nofee.testnut.cashu.space"
};

describe("order funding guard", () => {
  it("uses the exact offered mint and unit balance", () => {
    expect(availableOrderBalance(wallet, "sell", market)).toBe("100");
    expect(availableOrderBalance(wallet, "buy", market)).toBe("20");
  });

  it("rejects a sell order larger than the SAT balance", () => {
    expect(() => assertOrderFunding(wallet, "sell", "1875", "100000000", market))
      .toThrow("requested 1,875 sat, available 100 sat");
  });

  it("allows an order within balance and rejects an oversized buy", () => {
    expect(() => assertOrderFunding(wallet, "sell", "100", "100000000", market)).not.toThrow();
    expect(() => assertOrderFunding(wallet, "buy", "42", "50000000", market))
      .toThrow("requested 0.21 USD, available 0.20 USD");
  });

  it("checks a buy against the truncated integer quote amount", () => {
    expect(() => assertOrderFunding(wallet, "buy", "200", "4950000", market)).not.toThrow();
    expect(() => assertOrderFunding(wallet, "buy", "500", "4950000", market))
      .toThrow("requested 0.24 USD, available 0.20 USD");
  });

  it("explains when USD is available at the wrong mint", () => {
    const walletWithWrongUsdMint: WalletView = {
      ...wallet,
      balances: [
        { unit: "sat", amount: "100", mintCount: 1, proofCount: 3 },
        { unit: "usd", amount: "10000", mintCount: 1, proofCount: 1 }
      ],
      pockets: [
        wallet.pockets[0]!,
        {
          ...wallet.pockets[1]!,
          mintUrl: "https://testnut.cashu.space",
          amount: "10000"
        }
      ]
    };

    expect(() => assertOrderFunding(walletWithWrongUsdMint, "buy", "200", "5100000", market))
      .toThrow(
        "requested 0.10 USD, available 0.00 USD. The wallet also has 100.00 USD at another mint"
      );
  });

  it("derives the offered balance from a configured one-mint market", () => {
    const oneMint = {
      baseUnit: "sat",
      baseMint: "https://mint.example",
      quoteUnit: "usd",
      quoteMint: "https://mint.example"
    };
    const oneMintWallet: WalletView = {
      ...wallet,
      pockets: [
        {
          ...wallet.pockets[0]!,
          mintUrl: oneMint.baseMint
        },
        {
          ...wallet.pockets[1]!,
          mintUrl: oneMint.quoteMint
        }
      ]
    };

    expect(availableOrderBalance(oneMintWallet, "buy", oneMint)).toBe("20");
    expect(() => assertOrderFunding(
      oneMintWallet,
      "buy",
      "200",
      "5100000",
      oneMint
    )).not.toThrow();
  });
});
