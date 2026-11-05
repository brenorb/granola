/** Field-specific message for the order size input, or "" when valid. */
export function sizeValidationMessage(value: string): string {
  if (value.trim() === "") return "Enter the order size in SAT.";
  if (!/^[1-9]\d*$/.test(value)) return "Enter a whole number of SAT, 1 or more (no decimals, signs or separators).";
  return "";
}

/** Field-specific message for the USD/BTC price input, or "" when valid. */
export function priceValidationMessage(value: string): string {
  if (value.trim() === "") return "Enter a limit price in USD per BTC.";
  if (/,/.test(value)) return "Remove the thousands separators, e.g. 50000.00.";
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    return "Use digits with at most two decimals, e.g. 50000.00.";
  }
  if (/^0(?:\.0{0,2})?$/.test(value)) return "The price must be greater than zero.";
  return "";
}

/** Replaces the page with a visible explanation when it cannot start. */
export function renderBootError(document: Document, message: string): void {
  const main = document.querySelector("main");
  const panel = document.createElement("section");
  panel.className = "boot-error";
  panel.setAttribute("role", "alert");
  const heading = document.createElement("h2");
  heading.textContent = "This wallet link cannot be opened";
  const detail = document.createElement("p");
  detail.textContent = message;
  const link = document.createElement("a");
  link.href = "./";
  link.textContent = "Open the default wallet";
  panel.append(heading, detail, link);
  if (main) main.replaceChildren(panel);
  else document.body.append(panel);
  const label = document.getElementById("profile-label");
  if (label) label.textContent = "Invalid wallet workspace";
}
