// Classifies failures that are safe to retry because nothing was decided:
// the mint or relay simply did not answer. Validation, protocol and
// state-contradiction errors are never transient and must surface at once.

const TRANSIENT_MESSAGES = [
  /^Failed to fetch$/,
  /^Load failed$/,
  /^NetworkError when attempting to fetch resource\.?$/,
  /^Network request failed$/,
  /timed out/i,
  /^All inbox relays were unavailable$/,
  /^No order relay answered$/
];

export function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // cashu-ts wraps fetch failures and timeouts in NetworkError.
  if (error.name === "NetworkError") return true;
  const status = (error as { status?: unknown }).status;
  if (error.name === "HttpResponseError" && typeof status === "number") {
    return status === 429 || status >= 500;
  }
  return TRANSIENT_MESSAGES.some((pattern) => pattern.test(error.message));
}

/** Names the unreachable host for people; keeps other messages as they are. */
export function describeNetworkFailure(error: unknown, url: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!isTransientNetworkError(error)) return message;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Keep the raw value.
  }
  return `Could not reach ${host}. Check your connection and try again.`;
}
