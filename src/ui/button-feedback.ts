export function beginButtonFeedback(
  button: HTMLButtonElement,
  busyLabel: string
): void {
  if (button.dataset.busy === "true") return;
  button.dataset.idleHtml = button.innerHTML;
  button.dataset.busy = "true";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const label = button.querySelector<HTMLElement>("[data-button-label]");
  if (label) {
    label.textContent = busyLabel;
  } else {
    button.textContent = busyLabel;
  }
}

export function endButtonFeedback(button: HTMLButtonElement): void {
  const idleHtml = button.dataset.idleHtml;
  if (idleHtml !== undefined) button.innerHTML = idleHtml;
  delete button.dataset.idleHtml;
  delete button.dataset.busy;
  button.removeAttribute("aria-busy");
  button.disabled = false;
}

export async function withButtonFeedback<T>(
  button: HTMLButtonElement,
  busyLabel: string,
  task: () => Promise<T>
): Promise<T> {
  beginButtonFeedback(button, busyLabel);
  try {
    return await task();
  } finally {
    endButtonFeedback(button);
  }
}
