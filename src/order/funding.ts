import type { WalletView } from "../core/wallet.js";
import { formatUnitAmount } from "../ui/format.js";
import { quoteAmountForSettlement, type OrderSide } from "./model.js";

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
  priceCentsPerBtc: string
): void {
  if (!/^[1-9]\d*$/.test(amount)) return;
  const asset = OFFERED_ASSETS[side];
  const baseAmount = BigInt(amount);
  const requested = side === "sell"
    ? baseAmount
    : BigInt(quoteAmountForSettlement(amount, priceCentsPerBtc));
  const available = BigInt(availableOrderBalance(wallet, side));
  if (requested > available) {
    const otherMintBalance = wallet.pockets
      .filter((pocket) => pocket.unit === asset.unit && pocket.mintUrl !== asset.mintUrl)
      .reduce((sum, pocket) => sum + BigInt(pocket.amount), 0n);
    const otherMintHint = otherMintBalance > 0n
      ? ` The wallet also has ${formatUnitAmount(otherMintBalance.toString(), asset.unit)} ` +
        `at another mint, which cannot fund this issuer-specific market.`
      : "";
    throw new Error(
      `Insufficient ${asset.unit.toUpperCase()} balance at ${new URL(asset.mintUrl).host} ` +
      `to publish this ${side} order: requested ${formatUnitAmount(requested.toString(), asset.unit)}, ` +
      `available ${formatUnitAmount(available.toString(), asset.unit)}.${otherMintHint}`
    );
  }
}
