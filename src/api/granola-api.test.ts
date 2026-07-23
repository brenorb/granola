import { describe, expect, it, vi } from "vitest";

import type { CashuQuote, TokenSummary } from "../cashu/client.js";
import { createEmptyWallet, type WalletPocket } from "../core/wallet.js";
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
    cashu.checkAndMint.mockResolvedValue({
      quote: { ...quote, state: "ISSUED" },
      batch
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
    expect(state.quotes[0]?.state).toBe("ISSUED");
    expect(JSON.stringify(state)).not.toContain("bearer-secret");
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
