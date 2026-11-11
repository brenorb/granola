import assert from "node:assert/strict";
import { GranolaApi, QuoteRepository } from "../../src/api/granola-api.ts";
import { CashuClient } from "../../src/cashu/client.ts";
import { MemoryStorageDriver, WalletRepository } from "../../src/storage/wallet-repository.ts";

const mintUrl = "https://testnut.cashu.space";
const quote = { quote: "local-fake-quote", request: "fake-invoice", unit: "sat", amount: 100, expiry: null };
let issued = false;
let issuanceCalls = 0;
const fakeMintWallet = {
  getMintInfo: () => ({ cache: { nuts: { "4": { methods: [{ method: "bolt11", unit: "sat" }] } } } }),
  createMintQuoteBolt11: async () => ({ ...quote, state: "UNPAID" }),
  checkMintQuoteBolt11: async () => ({ ...quote, state: issued ? "ISSUED" : "PAID" }),
  mintProofsBolt11: async () => {
    issuanceCalls += 1;
    issued = true;
    return [{ amount: quote.amount, id: "synthetic-keyset", secret: "synthetic-proof", C: "synthetic-signature" }];
  }
};
const cashu = Object.assign(new CashuClient(), { wallet: async () => fakeMintWallet });
const driver = new MemoryStorageDriver();
const interruptedWallet = new WalletRepository(driver);
const stop = new Error("Simulated interruption before local wallet commit");
interruptedWallet.save = async () => { throw stop; };

const quotes = new QuoteRepository(driver);
const first = new GranolaApi(interruptedWallet, quotes, cashu, () => "local-ref");
await first.requestMint({ mintUrl, unit: "sat", amount: String(quote.amount) });
await assert.rejects(first.claimMint("local-ref"), (error) => error === stop);
assert.equal((await first.getState()).quotes[0]?.state, "UNPAID");
assert.equal(issued, true);

const reopened = new GranolaApi(new WalletRepository(driver), quotes, cashu);
const result = await reopened.claimMint("local-ref");
assert.equal(result.quotes[0]?.state, "ISSUED");
assert.deepEqual(result.wallet.balances, []);
assert.equal(issuanceCalls, 1);
console.log("Reproduced: quote ISSUED after reopening and retrying, with no local wallet credit.");
