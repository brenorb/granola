export interface LockPort {
  request(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<unknown>
  ): Promise<unknown>;
}

export async function withWalletLock<T>(
  profile: string,
  action: () => Promise<T>,
  locks: LockPort = navigator.locks
): Promise<T> {
  return await locks.request(
    `granola-wallet-${profile}-write`,
    { mode: "exclusive" },
    action
  ) as T;
}

export async function withOrderOutboxLock<T>(
  profile: string,
  action: () => Promise<T>,
  locks: LockPort = navigator.locks
): Promise<T> {
  return await locks.request(
    `granola-order-outbox-${profile}-write`,
    { mode: "exclusive" },
    action
  ) as T;
}

export async function withTradeSessionLock<T>(
  profile: string,
  sessionId: string,
  action: () => Promise<T>,
  locks: LockPort = navigator.locks
): Promise<T> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) {
    throw new Error("Trade lock profile is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(sessionId)) {
    throw new Error("Trade lock session ID is invalid");
  }
  return await locks.request(
    `granola-trade-${profile}-${sessionId}-write`,
    { mode: "exclusive" },
    action
  ) as T;
}

export async function withTradeSessionStorageLock<T>(
  profile: string,
  action: () => Promise<T>,
  locks: LockPort = navigator.locks
): Promise<T> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) {
    throw new Error("Trade storage lock profile is invalid");
  }
  return await locks.request(
    `granola-trade-${profile}-storage-write`,
    { mode: "exclusive" },
    action
  ) as T;
}
