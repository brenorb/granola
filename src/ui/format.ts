function groupInteger(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatFixed(amount: string, decimals: number): string {
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals);
  return `${groupInteger(whole)}.${fraction}`;
}

export function formatUnitAmount(amount: string, unit: string): string {
  if (!/^\d+$/.test(amount)) throw new Error("Amount must be an integer string");

  const normalized = unit.trim().toLowerCase();
  if (normalized === "sat") return `${groupInteger(amount)} sat`;
  if (normalized === "btc") return `${formatFixed(amount, 8)} BTC`;
  if (normalized === "usd" || normalized === "eur") {
    return `${formatFixed(amount, 2)} ${normalized.toUpperCase()}`;
  }
  return `${groupInteger(amount)} ${normalized.toUpperCase()}`;
}
