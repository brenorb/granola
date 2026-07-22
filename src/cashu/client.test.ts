import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeAmount {
    private constructor(private readonly value: bigint) {}

    static from(value: string | number | bigint | FakeAmount): FakeAmount {
      return value instanceof FakeAmount ? value : new FakeAmount(BigInt(value));
    }

    toString(): string {
      return this.value.toString();
    }

    isZero(): boolean {
      return this.value === 0n;
    }

    lessThan(other: string | number | bigint | FakeAmount): boolean {
      return this.value < FakeAmount.from(other).value;
    }

    greaterThan(other: string | number | bigint | FakeAmount): boolean {
      return this.value > FakeAmount.from(other).value;
    }
  }
  const amount = (value: string) => FakeAmount.from(value);
  const wallet = {
    loadMint: vi.fn(),
    getMintInfo: vi.fn(),
    createMintQuoteBolt11: vi.fn(),
    checkMintQuoteBolt11: vi.fn(),
    mintProofsBolt11: vi.fn(),
    receive: vi.fn()
  };
  return {
    amount,
    wallet,
    Wallet: vi.fn(function WalletMock() {
      return wallet;
    }),
    Amount: FakeAmount,
    getTokenMetadata: vi.fn(),
    getEncodedToken: vi.fn(() => "cashuBexported"),
    deserializeProofs: vi.fn((proofs: Array<Record<string, unknown>>) =>
      proofs.map((proof) => ({ ...proof, amount: amount(String(proof.amount)) }))
    )
  };
});

vi.mock("@cashu/cashu-ts", () => ({
  Wallet: mocks.Wallet,
  Amount: mocks.Amount,
  getTokenMetadata: mocks.getTokenMetadata,
  getEncodedToken: mocks.getEncodedToken,
  deserializeProofs: mocks.deserializeProofs,
  MintQuoteState: {
    UNPAID: "UNPAID",
    PAID: "PAID",
    ISSUED: "ISSUED"
  }
}));

import { CashuClient } from "./client.js";

describe("Cashu client adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.wallet.loadMint.mockResolvedValue(undefined);
    mocks.wallet.getMintInfo.mockReturnValue({
      cache: {
        name: "Testnut",
        version: "test/1",
        nuts: {
          "4": {
            disabled: false,
            methods: [
              { method: "bolt11", unit: "sat", min_amount: 1, max_amount: 500_000 },
              { method: "bolt11", unit: "usd", min_amount: 1, max_amount: 500_000 }
            ]
          },
          "5": { disabled: false, methods: [] },
          "7": { supported: true },
          "12": { supported: true },
          "14": { supported: true }
        }
      },
      isSupported: vi.fn((nut: number) => ({
        supported: [7, 12, 14].includes(nut)
      }))
    });
  });

  it("reports mintable units from NUT-04 instead of inferring them from keysets", async () => {
    const capabilities = await new CashuClient().inspectMint(
      "https://testnut.cashu.space"
    );

    expect(capabilities).toEqual({
      mintUrl: "https://testnut.cashu.space",
      name: "Testnut",
      version: "test/1",
      bolt11: [
        { unit: "sat", minAmount: "1", maxAmount: "500000" },
        { unit: "usd", minAmount: "1", maxAmount: "500000" }
      ],
      supports: { nut07: true, nut12: true, nut14: true }
    });
    expect(capabilities.bolt11.map((method) => method.unit)).not.toContain("eur");
  });

  it("checks a quote and only mints exact proofs after it is PAID", async () => {
    mocks.wallet.createMintQuoteBolt11.mockResolvedValue({
      quote: "secret-quote-id",
      request: "lnbc-fake-invoice",
      amount: mocks.amount("250"),
      unit: "usd",
      state: "UNPAID",
      expiry: 1234
    });
    mocks.wallet.checkMintQuoteBolt11.mockResolvedValue({
      quote: "secret-quote-id",
      request: "lnbc-fake-invoice",
      amount: mocks.amount("250"),
      unit: "usd",
      state: "PAID",
      expiry: 1234
    });
    mocks.wallet.mintProofsBolt11.mockResolvedValue([
      {
        amount: mocks.amount("250"),
        id: "usd-keyset",
        secret: "minted-secret",
        C: "minted-signature"
      }
    ]);
    const client = new CashuClient();

    const quote = await client.createMintQuote({
      mintUrl: "https://testnut.cashu.space",
      unit: "usd",
      amount: "250"
    });
    const result = await client.checkAndMint(quote);

    expect(quote.amount).toBe("250");
    expect(result.quote.state).toBe("ISSUED");
    expect(result.batch).toEqual({
      mintUrl: "https://testnut.cashu.space",
      unit: "usd",
      proofs: [
        {
          amount: "250",
          id: "usd-keyset",
          secret: "minted-secret",
          C: "minted-signature"
        }
      ]
    });
    expect(mocks.wallet.mintProofsBolt11).toHaveBeenCalledOnce();
  });

  it("inspects and receives a token with its explicit mint and unit", async () => {
    mocks.getTokenMetadata.mockReturnValue({
      mint: "https://mint.test",
      unit: "eur",
      memo: "test euros",
      amount: mocks.amount("250")
    });
    mocks.wallet.receive.mockResolvedValue([
      {
        amount: mocks.amount("250"),
        id: "eur-keyset",
        secret: "fresh-secret",
        C: "fresh-signature"
      }
    ]);
    const client = new CashuClient();

    expect(client.inspectToken("cashuBeuros")).toEqual({
      mintUrl: "https://mint.test",
      unit: "eur",
      amount: "250",
      memo: "test euros"
    });
    const batch = await client.receiveToken("cashuBeuros");

    expect(batch.unit).toBe("eur");
    expect(mocks.wallet.receive).toHaveBeenCalledWith("cashuBeuros", {
      requireDleq: true
    });
  });
});
