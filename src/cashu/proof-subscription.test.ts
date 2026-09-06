import { CheckStateEnum, hashToCurve, type Proof, type ProofState, type Wallet } from "@cashu/cashu-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForProofsSpent } from "./proof-subscription.js";

function harness(supported = true) {
  const proofs = [{ secret: "synthetic-ws-one" }, { secret: "synthetic-ws-two" }] as Proof[];
  const ys = proofs.map(p => hashToCurve(new TextEncoder().encode(p.secret)).toHex(true));
  let update!: (state: ProofState) => void;
  let fail!: (error: Error) => void;
  const cancel = vi.fn();
  const disconnect = vi.fn();
  const subscribe = vi.fn(async (_proofs, onUpdate, onError): Promise<() => void> => {
    update = onUpdate;
    fail = onError;
    return cancel;
  });
  const wallet = {
    unit: "sat",
    getMintInfo: () => ({ cache: { nuts: { "17": { supported: supported
      ? [{ unit: "sat", commands: ["proof_state"] }] : [] } } } }),
    on: { proofStateUpdates: subscribe },
    mint: { disconnectWebSocket: disconnect }
  } as unknown as Wallet;
  return { wallet, proofs, ys, subscribe, cancel, disconnect,
    emit: (Y: string, state: ProofState["state"] = CheckStateEnum.SPENT) => update({ Y, state, witness: null }),
    fail: () => fail(new Error("socket closed")) };
}

describe("proof-state subscription wakeup", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for all expected proofs, ignoring duplicates, foreign IDs and pending states", async () => {
    const h = harness();
    let done = false;
    const wait = waitForProofsSpent(h.wallet, h.proofs).then(() => { done = true; });
    h.emit(h.ys[0]!, CheckStateEnum.UNSPENT);
    h.emit(h.ys[1]!, CheckStateEnum.PENDING);
    h.emit(h.ys[0]!);
    h.emit(h.ys[0]!);
    h.emit("unrelated");
    await Promise.resolve();
    expect(done).toBe(false);
    h.emit(h.ys[1]!);
    await wait;
    expect(h.cancel).toHaveBeenCalled();
    expect(h.disconnect).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls through to HTTP when unsupported or when the stream fails", async () => {
    const unsupported = harness(false);
    await waitForProofsSpent(unsupported.wallet, unsupported.proofs);
    expect(unsupported.subscribe).not.toHaveBeenCalled();
    const h = harness();
    const wait = waitForProofsSpent(h.wallet, h.proofs);
    h.fail();
    await wait;
    expect(h.disconnect).toHaveBeenCalled();
    h.subscribe.mockRejectedValueOnce(new Error("connection refused"));
    await waitForProofsSpent(h.wallet, h.proofs);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds missing notifications and cleans up a subscription that connects late", async () => {
    const h = harness();
    let connected!: (stop: () => void) => void;
    h.subscribe.mockImplementationOnce(() => new Promise(resolve => { connected = resolve; }));
    const wait = waitForProofsSpent(h.wallet, h.proofs);
    await vi.advanceTimersByTimeAsync(5_000);
    await wait;
    expect(h.disconnect).toHaveBeenCalledOnce();
    connected(h.cancel);
    await Promise.resolve();
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.disconnect).toHaveBeenCalledTimes(2);
  });
});
