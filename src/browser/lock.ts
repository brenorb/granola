export interface LockPort {
  request(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<unknown>
  ): Promise<unknown>;
}

const fallbackQueues = new Map<string, Promise<void>>();

export function hasNativeWebLocks(): boolean {
  return typeof navigator !== "undefined" &&
    navigator.locks !== undefined &&
    typeof navigator.locks.request === "function";
}

/** Serialize mutations within this page when Web Locks is unavailable. */
async function withFallbackLock<T>(
  name: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = fallbackQueues.get(name) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  fallbackQueues.set(name, queued);

  await previous;
  try {
    return await action();
  } finally {
    release();
    if (fallbackQueues.get(name) === queued) fallbackQueues.delete(name);
  }
}

async function requestLock<T>(
  name: string,
  action: () => Promise<T>,
  locks: LockPort | undefined
): Promise<T> {
  if (locks !== undefined) {
    return await locks.request(name, { mode: "exclusive" }, action) as T;
  }
  return withFallbackLock(name, action);
}

export async function withWalletLock<T>(
  profile: string,
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  return requestLock(
    `granola-wallet-${profile}-write`,
    action,
    locks
  );
}

export async function withOrderOutboxLock<T>(
  profile: string,
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  return requestLock(
    `granola-order-outbox-${profile}-write`,
    action,
    locks
  );
}

export async function withTradeSessionLock<T>(
  profile: string,
  sessionId: string,
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) {
    throw new Error("Trade lock profile is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(sessionId)) {
    throw new Error("Trade lock session ID is invalid");
  }
  return requestLock(
    `granola-trade-${profile}-${sessionId}-write`,
    action,
    locks
  );
}

export async function withTradeSessionStorageLock<T>(
  profile: string,
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) {
    throw new Error("Trade storage lock profile is invalid");
  }
  return requestLock(
    `granola-trade-${profile}-storage-write`,
    action,
    locks
  );
}
