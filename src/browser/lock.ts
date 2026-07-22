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
