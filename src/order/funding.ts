import type { WalletView } from "../core/wallet.js";
import type { OrderSide, RationalPrice } from "./model.js";

const OFFERED_ASSETS = {
  sell: { mintUrl: "https://testnut.cashu.space", unit: "sat" },
  buy: { mintUrl: "https://nofee.testnut.cashu.space", unit: "usd" }
} as const;

export function availableOrderBalance(wallet: WalletView, side: OrderSide): string {
  const asset = OFFERED_ASSETS[side];
  return wallet.pockets
    .filter((candidate) =>
      candidate.mintUrl === asset.mintUrl && candidate.unit === asset.unit
    )
    .reduce((sum, pocket) => sum + BigInt(pocket.amount), 0n)
    .toString();
}

/**
 * Orders are public intent, not escrow, but publishing an order larger than
 * the local offered-asset balance creates an immediately unfulfillable order.
 * Reject that mistake before signing or sending anything to Nostr.
 */
export function assertOrderFunding(
  wallet: WalletView,
  side: OrderSide,
  amount: string,
  price: RationalPrice
): void {
  if (!/^[1-9]\d*$/.test(amount)) return;
  const asset = OFFERED_ASSETS[side];
  const baseAmount = BigInt(amount);
  const numerator = BigInt(price.numerator);
  const denominator = BigInt(price.denominator);
  const offeredNumerator = side === "sell" ? baseAmount : baseAmount * numerator;
  if (offeredNumerator % denominator !== 0n) return;
  const requested = side === "sell" ? baseAmount : offeredNumerator / denominator;
  const available = BigInt(availableOrderBalance(wallet, side));
  if (requested > available) {
    throw new Error(
      `Insufficient ${asset.unit.toUpperCase()} balance to publish this ${side} order: ` +
      `requested ${requested.toLocaleString("en-US")} ${asset.unit.toUpperCase()}, ` +
      `available ${available.toLocaleString("en-US")} ${asset.unit.toUpperCase()}`
    );
  }
}
