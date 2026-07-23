import type {
  CashuClient,
  CashuQuote,
  MintCapabilities,
  TokenSummary
} from "../cashu/client.js";
import {
  addProofs,
  getWalletView,
  normalizeMintUrl,
  type WalletPocket,
  type WalletView
} from "../core/wallet.js";
import type {
  StorageDriver,
  WalletRepository
} from "../storage/wallet-repository.js";

const QUOTE_KEY = "granola.quotes.v1";
const ALLOWED_TEST_MINTS = new Set([
  "https://testnut.cashu.space",
  "https://nofee.testnut.cashu.space"
]);

function allowedTestMint(mintUrl: string): string {
  const normalized = normalizeMintUrl(mintUrl);
  if (!ALLOWED_TEST_MINTS.has(normalized)) {
    throw new Error(`Mint is not allowed in this test wallet: ${normalized}`);
  }
  return normalized;
}

interface StoredQuote {
  ref: string;
  quote: CashuQuote;
}

export interface PublicQuote {
  ref: string;
  request: string;
  mintUrl: string;
  unit: string;
  amount: string;
  state: CashuQuote["state"];
  expiry: number | null;
}

export interface GranolaState {
  wallet: WalletView;
  quotes: PublicQuote[];
}

export interface CashuPort {
  inspectMint(mintUrl: string): Promise<MintCapabilities>;
  createMintQuote(input: {
    mintUrl: string;
    unit: string;
    amount: string;
  }): Promise<CashuQuote>;
  checkAndMint(quote: CashuQuote): Promise<{
    quote: CashuQuote;
    batch?: WalletPocket;
  }>;
  inspectToken(token: string): TokenSummary;
  receiveToken(token: string): Promise<WalletPocket>;
  encodeToken(pocket: WalletPocket, memo?: string): string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function toPublicQuote(stored: StoredQuote): PublicQuote {
  const { quote } = stored;
  return {
    ref: stored.ref,
    request: quote.request,
    mintUrl: quote.mintUrl,
    unit: quote.unit,
    amount: quote.amount,
    state: quote.state,
    expiry: quote.expiry
  };
}

function assertStoredQuotes(value: unknown): asserts value is StoredQuote[] {
  if (!Array.isArray(value)) throw new Error("Quote storage is corrupt");
  for (const item of value) {
    if (
      !item ||
      typeof item.ref !== "string" ||
      !item.quote ||
      typeof item.quote.quoteId !== "string" ||
      typeof item.quote.request !== "string" ||
      typeof item.quote.mintUrl !== "string" ||
      typeof item.quote.unit !== "string" ||
      typeof item.quote.amount !== "string" ||
      !["UNPAID", "PAID", "ISSUED"].includes(item.quote.state)
    ) {
      throw new Error("Quote storage is corrupt");
    }
  }
}

export class QuoteRepository {
  constructor(private readonly driver: StorageDriver) {}

  async load(): Promise<StoredQuote[]> {
    const value = await this.driver.get(QUOTE_KEY);
    if (value === undefined || value === null) return [];
    assertStoredQuotes(value);
    return clone(value);
  }

  async save(quotes: StoredQuote[]): Promise<void> {
    assertStoredQuotes(quotes);
    await this.driver.set(QUOTE_KEY, clone(quotes));
  }

  async clear(): Promise<void> {
    await this.driver.delete(QUOTE_KEY);
  }
}

export class GranolaApi {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly quotes: QuoteRepository,
    private readonly cashu: CashuPort,
    private readonly createRef: () => string = () => crypto.randomUUID()
  ) {}

  async getState(): Promise<GranolaState> {
    const [wallet, quotes] = await Promise.all([
      this.wallets.load(),
      this.quotes.load()
    ]);
    return {
      wallet: getWalletView(wallet),
      quotes: quotes.map(toPublicQuote)
    };
  }

  async inspectMint(mintUrl: string): Promise<MintCapabilities> {
    return await this.cashu.inspectMint(allowedTestMint(mintUrl));
  }

  inspectToken(token: string): TokenSummary {
    return this.cashu.inspectToken(token);
  }

  async requestMint(input: {
    mintUrl: string;
    unit: string;
    amount: string;
  }): Promise<PublicQuote> {
    const quote = await this.cashu.createMintQuote({
      ...input,
      mintUrl: allowedTestMint(input.mintUrl)
    });
    const stored: StoredQuote = { ref: this.createRef(), quote };
    const quotes = await this.quotes.load();
    if (quotes.some((item) => item.ref === stored.ref)) {
      throw new Error("Local quote reference collision");
    }
    await this.quotes.save([...quotes, stored]);
    return toPublicQuote(stored);
  }

  async claimMint(ref: string): Promise<GranolaState> {
    const quotes = await this.quotes.load();
    const index = quotes.findIndex((item) => item.ref === ref);
    const stored = quotes[index];
    if (!stored) throw new Error("Unknown local quote reference");

    const result = await this.cashu.checkAndMint(stored.quote);
    if (result.batch) {
      const wallet = addProofs(await this.wallets.load(), result.batch);
      await this.wallets.save(wallet);
    }
    quotes[index] = { ref: stored.ref, quote: result.quote };
    await this.quotes.save(quotes);
    return this.getState();
  }

  async receiveToken(token: string): Promise<GranolaState> {
    const summary = this.cashu.inspectToken(token);
    allowedTestMint(summary.mintUrl);
    const batch = await this.cashu.receiveToken(token);
    const wallet = addProofs(await this.wallets.load(), batch);
    await this.wallets.save(wallet);
    return this.getState();
  }

  async createBackup(): Promise<{
    createdAt: string;
    warning: string;
    tokens: Array<{
      mintUrl: string;
      unit: string;
      amount: string;
      token: string;
    }>;
  }> {
    const wallet = await this.wallets.load();
    return {
      createdAt: new Date().toISOString(),
      warning: "Anyone with these tokens can spend them.",
      tokens: wallet.pockets.map((pocket) => ({
        mintUrl: pocket.mintUrl,
        unit: pocket.unit,
        amount: pocket.proofs
          .reduce((sum, proof) => sum + BigInt(proof.amount), 0n)
          .toString(),
        token: this.cashu.encodeToken(pocket, "Granola test wallet backup")
      }))
    };
  }

  async clearWallet(confirmation: string): Promise<void> {
    if (confirmation !== "DELETE TEST WALLET") {
      throw new Error("Type DELETE TEST WALLET to clear bearer tokens");
    }
    await Promise.all([this.wallets.clear(), this.quotes.clear()]);
  }
}

export type BrowserGranolaApi = GranolaApi;
export const satisfiesCashuPort = (client: CashuClient): CashuPort => client;
