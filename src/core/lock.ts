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

/** Serialize mutations within one page when Web Locks are unavailable. */
export async function withSharedLock<T>(
  name: string,
  action: () => Promise<T>,
  locks: LockPort | undefined = hasNativeWebLocks() ? navigator.locks : undefined
): Promise<T> {
  if (locks !== undefined) {
    return await locks.request(name, { mode: "exclusive" }, action) as T;
  }

  // ponytail: one page-wide fallback queue; native Web Locks provide cross-tab coordination.
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
