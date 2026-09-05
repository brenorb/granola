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
