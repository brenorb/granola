import {
  hasNativeWebLocks,
  withSharedLock,
  type LockPort
} from "../core/lock.js";

export { hasNativeWebLocks } from "../core/lock.js";
export type { LockPort } from "../core/lock.js";

export async function withWalletLock<T>(
  profile: string,
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  return withSharedLock(
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
  return withSharedLock(
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
  return withSharedLock(
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
  return withSharedLock(
    `granola-trade-${profile}-storage-write`,
    action,
    locks
  );
}
