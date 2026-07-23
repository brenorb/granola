export const QUICK_MINT_AMOUNT = "10000";

export type QuickMintUnit = "sat" | "usd";

export interface QuickMintRequest {
  unit: QuickMintUnit;
  amount: string;
}

const QUICK_MINT_ACTIONS: ReadonlyArray<{
  unit: QuickMintUnit;
  symbol: string;
  label: string;
  accessibleLabel: string;
}> = [
  {
    unit: "sat",
    symbol: "₿",
    label: "Fund SAT",
    accessibleLabel: "Mint 10,000 satoshis"
  },
  {
    unit: "usd",
    symbol: "$",
    label: "Fund USD",
    accessibleLabel: "Mint 10,000 USD cents"
  }
];

export function renderMintActions(
  root: HTMLElement,
  onIssue: (request: QuickMintRequest, button: HTMLButtonElement) => void
): void {
  root.replaceChildren();

  for (const action of QUICK_MINT_ACTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quick-mint";
    button.dataset.mintUnit = action.unit;
    button.dataset.mintAmount = QUICK_MINT_AMOUNT;
    button.setAttribute("aria-label", action.accessibleLabel);

    const symbol = document.createElement("span");
    symbol.className = "quick-mint__symbol";
    symbol.setAttribute("aria-hidden", "true");
    symbol.textContent = action.symbol;

    const label = document.createElement("span");
    label.dataset.buttonLabel = "true";
    label.textContent = action.label;
    button.append(symbol, label);
    button.addEventListener("click", () => {
      onIssue({ unit: action.unit, amount: QUICK_MINT_AMOUNT }, button);
    });
    root.append(button);
  }
}
