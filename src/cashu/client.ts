import {
  Amount,
  deserializeProofs,
  getEncodedToken,
  getTokenMetadata,
  MintQuoteState,
  Wallet,
  type GetInfoResponse,
  type MintQuoteBolt11Response,
  type Proof
} from "@cashu/cashu-ts";

import {
  normalizeMintUrl,
  type StoredProof,
  type WalletPocket
} from "../core/wallet.js";

export interface Bolt11Capability {
  unit: string;
  minAmount: string | null;
  maxAmount: string | null;
}

export interface MintCapabilities {
  mintUrl: string;
  name: string;
  version: string;
  bolt11: Bolt11Capability[];
  supports: {
    nut07: boolean;
    nut10: boolean;
    nut11: boolean;
    nut12: boolean;
    nut14: boolean;
  };
}

export interface TradeMintPreflight {
  mintUrl: string;
  unit: string;
  keysetId: string;
  inputFeePpk: number;
  supportsDleq: boolean;
}

export interface TradeSpendability {
  mintUrl: string;
  unit: string;
  faceAmount: string;
  spendableAmount: string;
  inputFee: string;
  proofCount: number;
}

export interface CashuQuote {
  quoteId: string;
  request: string;
  mintUrl: string;
  unit: string;
  amount: string;
  state: "UNPAID" | "PAID" | "ISSUED";
  expiry: number | null;
}

export interface TokenSummary {
  mintUrl: string;
  unit: string;
  amount: string;
  memo?: string;
}

function amountString(value: unknown): string {
  if (value instanceof Amount) return value.toString();
  if (value && typeof value === "object" && "toString" in value) {
    return String(value);
  }
  return Amount.from(value as string | number | bigint).toString();
}

function optionalAmount(value: unknown): string | null {
  return value === null || value === undefined ? null : amountString(value);
}

function toStoredProof(proof: Proof): StoredProof {
  return {
    amount: proof.amount.toString(),
    id: proof.id,
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq ? { dleq: proof.dleq } : {})
  };
}

function quoteFromResponse(
  mintUrl: string,
  response: MintQuoteBolt11Response
): CashuQuote {
  return {
    quoteId: response.quote,
    request: response.request,
    mintUrl,
    unit: response.unit,
    amount: response.amount.toString(),
    state: response.state,
    expiry: response.expiry
  };
}

function capabilitiesFromInfo(
  mintUrl: string,
  info: GetInfoResponse
): MintCapabilities {
  const methods = info.nuts["4"].disabled ? [] : info.nuts["4"].methods;
  return {
    mintUrl,
    name: info.name,
    version: info.version,
    bolt11: methods
      .filter((method) => method.method === "bolt11")
      .map((method) => ({
        unit: method.unit.toLowerCase(),
        minAmount: optionalAmount(method.min_amount),
        maxAmount: optionalAmount(method.max_amount)
      }))
      .sort((a, b) => a.unit.localeCompare(b.unit)),
    supports: {
      nut07: info.nuts["7"]?.supported === true,
      nut10: info.nuts["10"]?.supported === true,
      nut11: info.nuts["11"]?.supported === true,
      nut12: info.nuts["12"]?.supported === true,
      nut14: info.nuts["14"]?.supported === true
    }
  };
}

export class CashuClient {
  private async wallet(mintUrl: string, unit = "sat"): Promise<Wallet> {
    const wallet = new Wallet(normalizeMintUrl(mintUrl), { unit });
    await wallet.loadMint();
    return wallet;
  }

  async inspectMint(mintUrl: string): Promise<MintCapabilities> {
    const normalized = normalizeMintUrl(mintUrl);
    const wallet = await this.wallet(normalized);
    return capabilitiesFromInfo(normalized, wallet.getMintInfo().cache);
  }

  async inspectTradeMint(
    mintUrl: string,
    unitValue: string
  ): Promise<TradeMintPreflight> {
    const normalized = normalizeMintUrl(mintUrl);
    const unit = unitValue.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,15}$/.test(unit)) {
      throw new Error("Trade mint unit is invalid");
    }
    const wallet = await this.wallet(normalized, unit);
    const info = wallet.getMintInfo();
    for (const nut of [7, 10, 11, 14] as const) {
      if (!info.isSupported(nut).supported) {
        throw new Error(`Trade mint does not support required NUT-${nut}`);
      }
    }
    const keyset = wallet.keyChain.getCheapestKeyset();
    if (
      !keyset.isActive ||
      keyset.unit !== unit ||
      !/^[0-9a-f]{16,66}$/.test(keyset.id) ||
      !Number.isSafeInteger(keyset.fee) ||
      keyset.fee < 0
    ) {
      throw new Error("Trade mint has no usable active keyset for the selected unit");
    }
    return {
      mintUrl: normalized,
      unit,
      keysetId: keyset.id,
      inputFeePpk: keyset.fee,
      supportsDleq: info.isSupported(12).supported
    };
  }

  async inspectTradeSpendability(
    pocket: WalletPocket
  ): Promise<TradeSpendability> {
    const mintUrl = normalizeMintUrl(pocket.mintUrl);
    const unit = pocket.unit.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,15}$/.test(unit) || pocket.proofs.length === 0) {
      throw new Error("Trade funding pocket is invalid");
    }
    let proofs: Proof[];
    try {
      proofs = deserializeProofs(
        pocket.proofs.map((proof) => JSON.stringify(proof))
      );
    } catch {
      throw new Error("Trade funding proofs are invalid");
    }
    const face = pocket.proofs.reduce((sum, proof) => {
      if (!/^[1-9]\d*$/.test(proof.amount)) {
        throw new Error("Trade funding proof amount is invalid");
      }
      return sum + BigInt(proof.amount);
    }, 0n);
    const wallet = await this.wallet(mintUrl, unit);
    const spendable = BigInt(wallet.maxSpendableAfterFees(proofs).toString());
    if (spendable < 0n || spendable > face) {
      throw new Error("Trade funding spendability result is invalid");
    }
    return {
      mintUrl,
      unit,
      faceAmount: face.toString(),
      spendableAmount: spendable.toString(),
      inputFee: (face - spendable).toString(),
      proofCount: proofs.length
    };
  }

  async createMintQuote(input: {
    mintUrl: string;
    unit: string;
    amount: string;
  }): Promise<CashuQuote> {
    const mintUrl = normalizeMintUrl(input.mintUrl);
    const unit = input.unit.trim().toLowerCase();
    const amount = Amount.from(input.amount);
    if (amount.isZero()) throw new Error("Mint amount must be positive");

    const wallet = await this.wallet(mintUrl, unit);
    const capabilities = capabilitiesFromInfo(mintUrl, wallet.getMintInfo().cache);
    const method = capabilities.bolt11.find((item) => item.unit === unit);
    if (!method) throw new Error(`Mint does not advertise BOLT11 minting for ${unit}`);
    if (method.minAmount !== null && amount.lessThan(method.minAmount)) {
      throw new Error(`Amount is below mint minimum ${method.minAmount} ${unit}`);
    }
    if (method.maxAmount !== null && amount.greaterThan(method.maxAmount)) {
      throw new Error(`Amount is above mint maximum ${method.maxAmount} ${unit}`);
    }

    const response = await wallet.createMintQuoteBolt11(
      amount,
      "Granola fake testnet tokens"
    );
    return quoteFromResponse(mintUrl, response);
  }

  async checkAndMint(quote: CashuQuote): Promise<{
    quote: CashuQuote;
    batch?: WalletPocket;
  }> {
    const wallet = await this.wallet(quote.mintUrl, quote.unit);
    const checked = await wallet.checkMintQuoteBolt11(quote.quoteId);
    const current = quoteFromResponse(quote.mintUrl, checked);
    if (checked.state !== MintQuoteState.PAID) return { quote: current };

    const proofs = await wallet.mintProofsBolt11(checked.amount, checked);
    return {
      quote: { ...current, state: MintQuoteState.ISSUED },
      batch: {
        mintUrl: quote.mintUrl,
        unit: quote.unit,
        proofs: proofs.map(toStoredProof)
      }
    };
  }

  inspectToken(token: string): TokenSummary {
    const metadata = getTokenMetadata(token.trim());
    return {
      mintUrl: normalizeMintUrl(metadata.mint),
      unit: metadata.unit.toLowerCase(),
      amount: metadata.amount.toString(),
      ...(metadata.memo ? { memo: metadata.memo } : {})
    };
  }

  async receiveToken(token: string): Promise<WalletPocket> {
    const summary = this.inspectToken(token);
    const wallet = await this.wallet(summary.mintUrl, summary.unit);
    const requireDleq = wallet.getMintInfo().isSupported(12).supported;
    const proofs = await wallet.receive(token.trim(), { requireDleq });
    return {
      mintUrl: summary.mintUrl,
      unit: summary.unit,
      proofs: proofs.map(toStoredProof)
    };
  }

  encodeToken(pocket: WalletPocket, memo?: string): string {
    const proofs = deserializeProofs(
      pocket.proofs.map((proof) => JSON.stringify(proof))
    );
    return getEncodedToken({
      mint: normalizeMintUrl(pocket.mintUrl),
      unit: pocket.unit,
      proofs,
      ...(memo ? { memo } : {})
    });
  }
}
