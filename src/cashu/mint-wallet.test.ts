import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), version: 1 }));
vi.mock("@cashu/cashu-ts", () => ({
  Wallet: class {
    info = { version: mocks.version };
    keyChain = { cache: { keysets: [], mintUrl: "" } };
    constructor(readonly mint: string, readonly options: { unit: string }) {}
    async loadMint() { await mocks.load(); }
    getMintInfo() { return { cache: this.info }; }
    loadMintFromCache(info: typeof this.info, cache: typeof this.keyChain.cache) {
      this.info = info;
      this.keyChain.cache = cache;
    }
  }
}));

describe("mint metadata reuse", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.load.mockReset().mockResolvedValue(undefined);
    mocks.version = 1;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("coalesces concurrent loads but isolates wallet state, mint and unit", async () => {
    const { loadMintWallet } = await import("./mint-wallet.js");
    const [first, second] = await Promise.all([
      loadMintWallet("https://mint.example/", " SAT "),
      loadMintWallet("https://mint.example", "sat")
    ]);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(first).not.toBe(second);
    expect(first.getMintInfo().cache).not.toBe(second.getMintInfo().cache);
    first.getMintInfo().cache.version = "mutated";
    expect((await loadMintWallet("https://mint.example")).getMintInfo().cache.version).toBe(1);
    await loadMintWallet("https://mint.example", "usd");
    await loadMintWallet("https://another-mint.example", "sat");
    expect(mocks.load).toHaveBeenCalledTimes(3);
  });

  it("refreshes at preflight and after expiry, without serving stale data on failure", async () => {
    const { loadMintWallet } = await import("./mint-wallet.js");
    await loadMintWallet("https://mint.example");
    mocks.version = 2;
    expect((await loadMintWallet("https://mint.example", "sat", true)).getMintInfo().cache.version).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    mocks.load.mockRejectedValueOnce(new Error("mint unavailable"));
    await expect(loadMintWallet("https://mint.example")).rejects.toThrow("mint unavailable");
    mocks.version = 3;
    expect((await loadMintWallet("https://mint.example")).getMintInfo().cache.version).toBe(3);
    expect(mocks.load).toHaveBeenCalledTimes(4);
  });
});
