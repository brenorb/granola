import { Amount, OutputData, type MintPreview } from "@cashu/cashu-ts";
import { describe, expect, it, vi } from "vitest";

import { CashuClient, type CashuQuote, type TokenSummary } from "../cashu/client.js";
import { createEmptyWallet, replaceProofs, type WalletPocket } from "../core/wallet.js";
import {
  MemoryStorageDriver,
  WalletRepository
} from "../storage/wallet-repository.js";
import { GranolaApi, QuoteRepository, type CashuPort } from "./granola-api.js";

function fakeCashu() {
  return {
    inspectMint: vi.fn<CashuPort["inspectMint"]>(),
    createMintQuote: vi.fn<CashuPort["createMintQuote"]>(),
    checkAndMint: vi.fn<CashuPort["checkAndMint"]>(),
    inspectToken: vi.fn<CashuPort["inspectToken"]>(),
    receiveToken: vi.fn<CashuPort["receiveToken"]>(),
    encodeToken: vi.fn<CashuPort["encodeToken"]>()
  } satisfies CashuPort;
}

const quote: CashuQuote = {
  quoteId: "mint-secret-quote-id",
  request: "lnbc-fake-invoice",
  mintUrl: "https://testnut.cashu.space",
  unit: "usd",
  amount: "500",
  state: "UNPAID",
  expiry: 1234
};

const batch: WalletPocket = {
  mintUrl: "https://testnut.cashu.space",
  unit: "usd",
  proofs: [
    {
      amount: "500",
      id: "usd-keyset",
      secret: "bearer-secret",
      C: "mint-signature"
    }
  ]
};

describe("Granola agent API", () => {
  it("persists mint quotes behind a local reference without exposing quote IDs", async () => {
    const driver = new MemoryStorageDriver();
    const cashu = fakeCashu();
    cashu.createMintQuote.mockResolvedValue(quote);
    const api = new GranolaApi(
      new WalletRepository(driver),
      new QuoteRepository(driver),
      cashu,
      () => "local-ref"
    );

    const publicQuote = await api.requestMint({
      mintUrl: quote.mintUrl,
      unit: quote.unit,
      amount: quote.amount
    });
    const reloaded = new GranolaApi(
      new WalletRepository(driver),
      new QuoteRepository(driver),
      cashu,
      () => "unused"
    );

    expect(publicQuote).toEqual({
      ref: "local-ref",
      request: "lnbc-fake-invoice",
      mintUrl: quote.mintUrl,
      unit: "usd",
      amount: "500",
      state: "UNPAID",
      walletCredit: "pending",
      expiry: 1234
    });
    expect(JSON.stringify(await reloaded.getState())).not.toContain(
      "mint-secret-quote-id"
    );
  });

  it("adds proofs only after the mint reports a paid quote", async () => {
    const driver = new MemoryStorageDriver();
    const cashu = fakeCashu();
    cashu.createMintQuote.mockResolvedValue(quote);
    cashu.checkAndMint.mockImplementation(async (_quote, checkpoint) => {
      const keysetId = "00deadbeefcafeee";
      const output = OutputData.createSingleRandomData(quote.amount, keysetId);
      await checkpoint.savePrepared({ ...quote, state: "PAID" }, {
        keysetId,
        outputs: [OutputData.serialize(output)]
      });
      return { quote: { ...quote, state: "ISSUED" }, batch };
    });
    const api = new GranolaApi(
      new WalletRepository(driver),
      new QuoteRepository(driver),
      cashu,
      () => "local-ref"
    );
    await api.requestMint({
      mintUrl: quote.mintUrl,
      unit: quote.unit,
      amount: quote.amount
    });

    await api.claimMint("local-ref");

    const state = await api.getState();
    expect(state.wallet.balances).toEqual([
      { unit: "usd", amount: "500", mintCount: 1, proofCount: 1 }
    ]);
    expect(state.quotes[0]).toMatchObject({ state: "ISSUED", walletCredit: "credited" });
    expect(JSON.stringify(state)).not.toContain("bearer-secret");
  });

  it.each(["before issuance", "after issuance", "during local commit"] as const)(
    "credits a saved funding quote once after an interruption %s",
    async (interruption) => {
      const driver = new MemoryStorageDriver();
      const quotes = new QuoteRepository(driver);
      const wallets = new WalletRepository(driver);
      const crash = new Error("Simulated funding interruption");
      const setMany = driver.setMany.bind(driver);
      let interrupted = false;
      vi.spyOn(driver, "setMany").mockImplementation(async (entries) => {
        if (interruption === "during local commit" && entries.length === 2 && !interrupted) {
          interrupted = true;
          throw crash;
        }
        await setMany(entries);
      });

      const keysetId = "00deadbeefcafeee";
      // Synthetic signing key for a fake mint. The compressed generator lets
      // the test exercise the SDK's real output serialization and unblinding.
      const keyset = {
        id: keysetId,
        keys: { [quote.amount]: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }
      };
      const amount = Amount.from(quote.amount);
      const mintQuote = { quote: quote.quoteId, request: quote.request, unit: quote.unit, amount, expiry: quote.expiry };
      let issued: MintPreview["payload"]["outputs"] | undefined;
      const signature = (output: MintPreview["payload"]["outputs"][number]) => ({
        amount: output.amount, id: output.id, C_: output.B_
      });
      const wallet = {
        getMintInfo: () => ({ cache: { nuts: { "4": { methods: [{ method: "bolt11", unit: quote.unit }] } } } }),
        createMintQuoteBolt11: async () => ({ ...mintQuote, state: "UNPAID" }),
        checkMintQuoteBolt11: vi.fn(async () => ({ ...mintQuote, state: issued ? "ISSUED" : "PAID" })),
        prepareMint: vi.fn(async () => {
          const output = OutputData.createSingleRandomData(amount, keysetId);
          return {
            method: "bolt11",
            quote: mintQuote,
            keysetId,
            outputData: [output],
            payload: { quote: quote.quoteId, outputs: [output.blindedMessage] }
          };
        }),
        completeMint: vi.fn(async (preview: MintPreview) => {
          const saved = (await quotes.load())[0]?.prepared;
          expect(saved?.outputs.map((output) => output.blindedMessage.B_))
            .toEqual(preview.payload.outputs.map((output) => output.B_));
          if (!interrupted && interruption !== "during local commit") {
            interrupted = true;
            if (interruption === "after issuance") issued = preview.payload.outputs;
            throw crash;
          }
          issued = preview.payload.outputs;
          return preview.outputData.map((output) => output.toProof(signature(output.blindedMessage), keyset));
        }),
        getKeyset: () => keyset,
        mint: {
          restore: vi.fn(async ({ outputs }: { outputs: MintPreview["payload"]["outputs"] }) => {
            expect(outputs.map(({ B_ }) => B_)).toEqual(issued?.map(({ B_ }) => B_));
            return { outputs, signatures: outputs.map(signature) };
          })
        }
      };
      const api = () => new GranolaApi(
        new WalletRepository(driver),
        new QuoteRepository(driver),
        Object.assign(new CashuClient(), { wallet: async () => wallet }),
        () => "local-ref"
      );
      const first = api();
      const { ref } = await first.requestMint({ mintUrl: quote.mintUrl, unit: quote.unit, amount: quote.amount });
      await expect(first.claimMint(ref)).rejects.toBe(crash);

      const reopened = api();
      const pending = await reopened.getState();
      expect(pending.quotes[0]).toMatchObject({ state: "PAID", walletCredit: "recoverable" });
      expect(pending.wallet.balances).toEqual([]);

      const credited = await reopened.claimMint(ref);
      expect(credited.quotes[0]).toMatchObject({ state: "ISSUED", walletCredit: "credited" });
      expect(credited.wallet.balances).toEqual([
        { unit: quote.unit, amount: quote.amount, mintCount: 1, proofCount: 1 }
      ]);
      expect((await quotes.load())[0]?.prepared).toBeUndefined();
      expect(wallet.prepareMint).toHaveBeenCalledOnce();
      expect(wallet.completeMint).toHaveBeenCalledTimes(interruption === "before issuance" ? 2 : 1);
      expect(wallet.mint.restore).toHaveBeenCalledTimes(interruption === "before issuance" ? 0 : 1);
      expect(await reopened.claimMint(ref)).toEqual(credited);

      const funded = await wallets.load();
      const pocket = funded.pockets[0]!;
      await wallets.save(replaceProofs(funded, {
        ...pocket, spentSecrets: pocket.proofs.map(({ secret }) => secret), proofs: []
      }));
      const afterSpend = await api().claimMint(ref);
      expect(afterSpend.wallet.balances).toEqual([]);
      expect(afterSpend.quotes[0]?.walletCredit).toBe("credited");
      expect(wallet.checkMintQuoteBolt11).toHaveBeenCalledTimes(2);
    }
  );

  it("keeps legacy issued quotes readable without assuming they were credited", async () => {
    const driver = new MemoryStorageDriver();
    const quotes = new QuoteRepository(driver);
    const issued = { ...quote, state: "ISSUED" } as const;
    await quotes.save([{ ref: "legacy-ref", quote: issued }]);
    const cashu = fakeCashu();
    cashu.checkAndMint.mockResolvedValue({ quote: issued });
    const api = new GranolaApi(new WalletRepository(driver), quotes, cashu);

    const state = await api.claimMint("legacy-ref");
    expect(state.quotes[0]).toMatchObject({ state: "ISSUED", walletCredit: "unknown" });
    expect(state.wallet.balances).toEqual([]);
  });

  it("rejects mints outside the browser CSP allowlist before network access", async () => {
    const driver = new MemoryStorageDriver();
    const cashu = fakeCashu();
    const summary: TokenSummary = {
      mintUrl: "https://unknown-mint.test",
      unit: "eur",
      amount: "250"
    };
    cashu.inspectToken.mockReturnValue(summary);
    cashu.receiveToken.mockResolvedValue({ ...batch, mintUrl: summary.mintUrl, unit: "eur" });
    const api = new GranolaApi(
      new WalletRepository(driver),
      new QuoteRepository(driver),
      cashu
    );

    await expect(api.receiveToken("cashuBunknown")).rejects.toThrow(
      "Mint is not allowed in this test wallet"
    );
    expect(cashu.receiveToken).not.toHaveBeenCalled();
    expect((await api.getState()).wallet.balances).toEqual([]);
  });

  it("rejects unknown mint network calls through the agent API", async () => {
    const driver = new MemoryStorageDriver();
    const cashu = fakeCashu();
    const api = new GranolaApi(
      new WalletRepository(driver),
      new QuoteRepository(driver),
      cashu
    );

    await expect(api.inspectMint("https://unknown-mint.test")).rejects.toThrow(
      "Mint is not allowed in this test wallet"
    );
    await expect(api.requestMint({
      mintUrl: "https://unknown-mint.test",
      unit: "sat",
      amount: "1"
    })).rejects.toThrow("Mint is not allowed in this test wallet");
    expect(cashu.inspectMint).not.toHaveBeenCalled();
    expect(cashu.createMintQuote).not.toHaveBeenCalled();
  });

  it("exports bearer backups and refuses accidental deletion", async () => {
    const driver = new MemoryStorageDriver();
    const wallet = new WalletRepository(driver);
    await wallet.save({ ...createEmptyWallet(), pockets: [batch], revision: 1 });
    const cashu = fakeCashu();
    cashu.encodeToken.mockReturnValue("cashuBbackup");
    const api = new GranolaApi(wallet, new QuoteRepository(driver), cashu);

    expect(await api.createBackup()).toEqual({
      createdAt: expect.any(String),
      warning: "Anyone with these tokens can spend them.",
      tokens: [
        { mintUrl: batch.mintUrl, unit: "usd", amount: "500", token: "cashuBbackup" }
      ]
    });
    await expect(api.clearWallet("delete")).rejects.toThrow(
      "Type DELETE TEST WALLET"
    );
    await api.clearWallet("DELETE TEST WALLET");
    expect((await api.getState()).wallet).toEqual({
      revision: 0,
      balances: [],
      pockets: []
    });
  });
});
