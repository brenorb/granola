import { CheckStateEnum, hashToCurve, type Proof, type Wallet } from "@cashu/cashu-ts";

/** Notifications schedule a fresh NUT-07 check; they never establish settlement evidence. */
export async function waitForProofsSpent(wallet: Wallet, proofs: Proof[]): Promise<void> {
  const advertised = wallet.getMintInfo().cache.nuts["17"]?.supported;
  const supported = Array.isArray(advertised) && advertised.some(
    (entry) => entry?.unit === wallet.unit && Array.isArray(entry.commands) && entry.commands.includes("proof_state")
  );
  if (!supported || proofs.length === 0) return;
  const expected = new Set(proofs.map((proof) =>
    hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true)
  ));
  const spent = new Set<string>();
  const startedAt = performance.now();
  let outcome: "spent" | "timeout" | "unavailable" = "timeout";
  let updates = 0;
  const abort = new AbortController();
  let cancel: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 5_000);
      void wallet.on.proofStateUpdates(proofs, (update) => {
        if (!expected.has(update.Y)) return;
        updates += 1;
        if (update.state === CheckStateEnum.SPENT) spent.add(update.Y);
        else spent.delete(update.Y);
        if (spent.size === expected.size) {
          outcome = "spent";
          resolve();
        }
      }, () => { outcome = "unavailable"; resolve(); }, { signal: abort.signal }).then((stop) => {
        cancel = stop;
        if (abort.signal.aborted) {
          stop();
          wallet.mint.disconnectWebSocket();
        }
      }, () => { outcome = "unavailable"; resolve(); });
    });
  } finally {
    clearTimeout(timer);
    try {
      if (cancel) cancel();
      else abort.abort();
    } finally {
      wallet.mint.disconnectWebSocket();
    }
    try {
      performance.measure("granola:proof-wait", {
        start: startedAt, end: performance.now(), detail: { outcome, updates, proofCount: proofs.length }
      });
    } catch {
      // Diagnostics must never change settlement behavior.
    }
  }
}
