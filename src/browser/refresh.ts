// Coalesce bursts, but run again when state changes during an outstanding read.
export function coalesceRefresh(refresh: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  let dirty = false;
  return () => {
    dirty = true;
    pending ??= Promise.resolve().then(async () => {
      try {
        do {
          dirty = false;
          await refresh();
        } while (dirty);
      } finally { pending = undefined; }
    });
    return pending;
  };
}

// Share one in-flight or successful result, but forget a failure so the next
// caller starts a fresh attempt instead of replaying a stale rejection.
export function singleFlightUntilSuccess<T>(start: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | undefined;
  return () => {
    if (current !== undefined) return current;
    const attempt = start();
    current = attempt;
    attempt.catch(() => {
      if (current === attempt) current = undefined;
    });
    return attempt;
  };
}
