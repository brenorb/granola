import { Wallet, type GetInfoResponse, type KeyChainCache } from "@cashu/cashu-ts";
import { normalizeMintUrl } from "../core/wallet.js";

const METADATA_TTL_MS = 60_000;
const metadata = new Map<string, {
  expiresAt: number;
  pending: Promise<{ info: GetInfoResponse; keychain: KeyChainCache }>;
}>();

/** Reuse public metadata only; every caller gets independent wallet operation state. */
export async function loadMintWallet(mintUrl: string, unitValue = "sat", refresh = false): Promise<Wallet> {
  const mint = normalizeMintUrl(mintUrl);
  const unit = unitValue.trim().toLowerCase();
  const key = `${mint}|${unit}`;
  const wallet = new Wallet(mint, { unit });
  let entry = metadata.get(key);
  if (refresh || !entry || entry.expiresAt <= Date.now()) {
    // ponytail: one-minute public metadata cache; refresh preflight and unknown keysets explicitly.
    const pending = wallet.loadMint().then(() => ({
      info: structuredClone(wallet.getMintInfo().cache),
      keychain: structuredClone(wallet.keyChain.cache)
    }));
    entry = { expiresAt: Date.now() + METADATA_TTL_MS, pending };
    metadata.delete(key);
    if (metadata.size >= 32) metadata.delete(metadata.keys().next().value!);
    metadata.set(key, entry);
  }
  try {
    const cached = await entry.pending;
    wallet.loadMintFromCache(structuredClone(cached.info), structuredClone(cached.keychain));
    return wallet;
  } catch (error) {
    if (metadata.get(key) === entry) metadata.delete(key);
    throw error;
  }
}
