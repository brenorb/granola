import {
  Amount,
  CheckStateEnum,
  OutputData,
  createHTLCsecret,
  hashToCurve,
  type P2PKOptions,
  type Proof,
  type ProofState,
  type SwapPreview,
  type Wallet
} from "@cashu/cashu-ts";
import { describe, expect, it, vi } from "vitest";

import type { WalletPocket } from "../core/wallet.js";
import { createHtlcMaterial, type ExpectedHtlcLock } from "./htlc.js";
import {
  CashuTradeClient,
  type CashuTradeDependencies,
  type TradeMintSnapshot
} from "./trade-client.js";

const mintUrl = "https://mint-trade.invalid";
const keysetId = "synthetic-keyset";
const receiverPubkey =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const refundPubkey =
  "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

function lockedProof(hash: string, amount: number, nonce: number): Proof {
  return {
    amount: Amount.from(amount),
    id: keysetId,
    secret: createHTLCsecret(hash, [
      ["locktime", "2200"],
      ["refund", refundPubkey],
      ["pubkeys", receiverPubkey]
    ]),
    C: `02${String(nonce).padStart(64, "0")}`
  };
}

function ordinaryProof(amount: number, nonce: number): Proof {
  return {
    amount: Amount.from(amount),
    id: keysetId,
    secret: `synthetic-secret-${nonce}`,
    C: `03${String(nonce).padStart(64, "0")}`
  };
}

function point(proof: Proof): string {
  return hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true);
}

function expected(hash: string): ExpectedHtlcLock {
  return {
    mintUrl,
    unit: "sat",
    binding: {
      protocolVersion: "granola/1",
      network: "cashu-testnet",
      orderId: "order-test",
      reservationId: "reservation-test",
      sessionId: "session-test",
      direction: "base",
      transcriptHash: "ab".repeat(32)
    },
    amount: "10",
    hash,
    receiverPubkey,
    refundPubkey,
    locktime: 2200,
    leg: "base",
    refundHorizon: 2800,
    deadlines: { short: 1600, long: 2200, minimumGap: 600 }
  };
}

function snapshot(proofs: Proof[], states?: ProofState[]): TradeMintSnapshot {
  return {
    capabilities: {
      nut07: true,
      nut10: true,
      nut11: true,
      nut12: false,
      nut14: true
    },
    keyset: {
      id: keysetId,
      unit: "sat",
      active: true,
      finalExpiry: 3000,
      inputFeePpk: 100,
      keys: { 1: receiverPubkey, 2: refundPubkey, 4: receiverPubkey, 8: refundPubkey }
    },
    states:
      states ??
      proofs.map((proof) => ({
        Y: point(proof),
        state: CheckStateEnum.UNSPENT,
        witness: null
      }))
  };
}

function harness(hash: string, withUnselected = false) {
  const locked = [lockedProof(hash, 6, 1), lockedProof(hash, 5, 2)];
  const change = [ordinaryProof(3, 3)];
  const claimed = [ordinaryProof(10, 4)];
  const calls: {
    sentProofs?: Proof[];
    options?: P2PKOptions;
    receiveInputs?: Proof[];
    receiveConfig?: unknown;
  } = {};
  const prepared = {
    amount: Amount.from(10),
    fees: Amount.from(1),
    keysetId,
    inputs: [ordinaryProof(14, 9)]
  } as SwapPreview;
  const builder = {
    asP2PK(options: P2PKOptions) {
      calls.options = options;
      return this;
    },
    keepAsRandom() {
      return this;
    },
    includeFees() {
      return this;
    },
    prepare: vi.fn(async () => {
      if (calls.options) {
        prepared.sendOutputs = [OutputData.createSingleP2PKData(calls.options, 11, keysetId)];
      }
      return prepared;
    })
  };
  const completeSwap = vi
    .fn()
    .mockResolvedValueOnce({ keep: change, send: locked })
    .mockResolvedValue({ keep: claimed, send: [] });
  const wallet = {
    ops: {
      send(_amount: unknown, proofs: Proof[]) {
        calls.sentProofs = proofs;
        prepared.inputs = withUnselected ? proofs.slice(0, 1) : proofs;
        if (withUnselected) prepared.unselectedProofs = proofs.slice(1);
        return builder;
      }
    },
    prepareSwapToReceive: vi.fn(async (proofs: Proof[], config: unknown) => {
      calls.receiveInputs = proofs;
      calls.receiveConfig = config;
      return { ...prepared, inputs: proofs };
    }),
    completeSwap,
    getFeesForKeyset: vi.fn(() => Amount.from(1)),
    decodeToken: vi.fn(() => ({ mint: mintUrl, unit: "sat", proofs: locked })),
    checkProofsStates: vi.fn(async (proofs: Proof[]) => snapshot(proofs).states)
  } as unknown as Wallet;

  let currentSnapshot = snapshot(locked);
  const dependencies: CashuTradeDependencies = {
    wallet: vi.fn(async () => wallet),
    inspectToken: vi.fn(() => ({ mintUrl, unit: "sat", amount: "11" })),
    encodeToken: vi.fn(() => "synthetic-encoded-lock"),
    snapshot: vi.fn(async () => currentSnapshot),
    commitment: vi.fn(async (value) =>
      value === "synthetic-encoded-lock" ? "cd".repeat(32) : value
    ),
    recover: vi.fn(async () => undefined)
  };
  const setSnapshot = (next: TradeMintSnapshot) => {
    currentSnapshot = next;
  };
  return {
    client: new CashuTradeClient(dependencies),
    wallet,
    locked,
    change,
    claimed,
    prepared,
    calls,
    dependencies,
    setSnapshot
  };
}

function pocket(): WalletPocket {
  return {
    mintUrl,
    unit: "sat",
    proofs: [
      {
        amount: "14",
        id: keysetId,
        secret: "synthetic-wallet-secret",
        C: `02${"09".repeat(32)}`
      }
    ]
  };
}

describe("CashuTradeClient durable outgoing locks", () => {
  it("prepares from stored proofs and returns a recoverable preview plus exact spent references", async () => {
    const material = createHtlcMaterial();
    const { client, calls } = harness(material.hash);

    const result = await client.prepareOutgoingLock({
      pocket: pocket(),
      expected: expected(material.hash),
      now: 1000
    });

    expect(result.kind).toBe("outgoing-lock");
    expect(result.preview.inputs).toHaveLength(1);
    expect(result.spentSecrets).toEqual(["synthetic-wallet-secret"]);
    expect(calls.sentProofs?.[0]?.amount.toString()).toBe("14");
    expect(result).not.toHaveProperty("proofs");
  });

  it("completes to change, an internal locked token, and a redacted verified summary", async () => {
    const material = createHtlcMaterial();
    const { client } = harness(material.hash);
    const prepared = await client.prepareOutgoingLock({
      pocket: pocket(),
      expected: expected(material.hash),
      now: 1000
    });

    const restored = JSON.parse(JSON.stringify(prepared)) as typeof prepared;
    const result = await client.completeOutgoingLock(restored, expected(material.hash));
    expect(result.change).toMatchObject({ mintUrl, unit: "sat" });
    expect(result.change.proofs).toHaveLength(1);
    expect(result.lockedToken).toBe("synthetic-encoded-lock");
    expect(result.summary).toEqual({
      mintUrl,
      unit: "sat",
      amount: "10",
      fee: "1",
      proofCount: 2,
      keysetId,
      commitment: "cd".repeat(32)
    });
    expect(result.summary).not.toHaveProperty("preimage");
    expect(result.summary).not.toHaveProperty("proofs");
  });

  it("rejects changed protocol terms before calling the mint", async () => {
    const material = createHtlcMaterial();
    const { client, wallet } = harness(material.hash);
    const terms = expected(material.hash);
    const prepared = await client.prepareOutgoingLock({ pocket: pocket(), expected: terms, now: 1000 });
    const substituted = { ...terms, amount: "9" };

    await expect(client.completeOutgoingLock(prepared, substituted)).rejects.toThrow(/artifact-terms/);
    expect(wallet.completeSwap).not.toHaveBeenCalled();
  });

  it("rejects a corrupted prepared output before calling the mint", async () => {
    const material = createHtlcMaterial();
    const { client, wallet } = harness(material.hash);
    const terms = expected(material.hash);
    const prepared = await client.prepareOutgoingLock({ pocket: pocket(), expected: terms, now: 1000 });
    const corrupted = JSON.parse(JSON.stringify(prepared)) as typeof prepared;
    corrupted.preview.keysetId = "substituted-keyset";

    await expect(client.completeOutgoingLock(corrupted, terms)).rejects.toThrow(/artifact-commitment/);
    expect(wallet.completeSwap).not.toHaveBeenCalled();
  });

  it("recovers exact outputs with NUT-09 after a response is lost", async () => {
    const material = createHtlcMaterial();
    const { client, dependencies, wallet, change, locked } = harness(material.hash);
    const terms = expected(material.hash);
    const prepared = await client.prepareOutgoingLock({ pocket: pocket(), expected: terms, now: 1000 });
    vi.mocked(dependencies.recover)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ keep: change, send: locked });
    vi.mocked(wallet.completeSwap).mockReset().mockRejectedValueOnce(new Error("response-lost"));

    await expect(client.completeOutgoingLock(prepared, terms)).rejects.toThrow("response-lost");
    const recovered = await client.completeOutgoingLock(prepared, terms);
    expect(recovered.lockedToken).toBe("synthetic-encoded-lock");
    expect(wallet.completeSwap).toHaveBeenCalledTimes(1);
  });

  it("returns only newly minted change in both normal and recovered reconciliation", async () => {
    const material = createHtlcMaterial();
    const { client, dependencies, wallet, change, locked } = harness(material.hash, true);
    const terms = expected(material.hash);
    const funding = pocket();
    funding.proofs.push({
      amount: "2",
      id: keysetId,
      secret: "synthetic-unselected-secret",
      C: `03${"08".repeat(32)}`
    });
    const prepared = await client.prepareOutgoingLock({ pocket: funding, expected: terms, now: 1000 });
    const unselected = ordinaryProof(2, 8);
    unselected.secret = "synthetic-unselected-secret";
    vi.mocked(wallet.completeSwap).mockReset().mockResolvedValue({
      keep: [unselected, ...change],
      send: locked
    });
    vi.mocked(dependencies.recover)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ keep: change, send: locked });

    const normal = await client.completeOutgoingLock(prepared, terms);
    const recovered = await client.completeOutgoingLock(prepared, terms);
    expect(normal.change).toEqual(recovered.change);
    expect(normal.change.proofs.map((proof) => proof.secret)).toEqual(["synthetic-secret-3"]);
  });
});

describe("incoming lock validation and settlement", () => {
  it("decodes and validates a token against live mint state without returning bearer proofs", async () => {
    const material = createHtlcMaterial();
    const { client, dependencies } = harness(material.hash);
    const result = await client.validateIncomingLock(
      "synthetic-encoded-lock",
      expected(material.hash)
    );
    expect(result).toMatchObject({
      mintUrl,
      unit: "sat",
      amount: "10",
      proofCount: 2,
      commitment: "cd".repeat(32)
    });
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("proofs");
    expect(dependencies.snapshot).toHaveBeenCalled();
  });

  it("fails closed when the live mint reports a pending proof", async () => {
    const material = createHtlcMaterial();
    const { client, locked, setSnapshot } = harness(material.hash);
    const states = snapshot(locked).states;
    states[0] = { ...states[0]!, state: CheckStateEnum.PENDING };
    setSnapshot(snapshot(locked, states));
    await expect(
      client.validateIncomingLock("synthetic-encoded-lock", expected(material.hash))
    ).rejects.toThrow(/proof-not-unspent/);
  });

  it("requires the exact token commitment before observing a spent witness", async () => {
    const material = createHtlcMaterial();
    const { client, dependencies } = harness(material.hash);
    await expect(
      client.observeSpentInternal(
        "synthetic-encoded-lock",
        expected(material.hash),
        "ef".repeat(32)
      )
    ).rejects.toThrow(/token-commitment/);
    expect(dependencies.snapshot).not.toHaveBeenCalled();
  });

  it("enforces NUT-12 DLEQ before exposing a spent witness", async () => {
    const material = createHtlcMaterial();
    const { client, locked, setSnapshot } = harness(material.hash);
    const live = snapshot(locked);
    live.capabilities.nut12 = true;
    setSnapshot(live);
    await expect(
      client.observeSpentInternal(
        "synthetic-encoded-lock",
        expected(material.hash),
        "cd".repeat(32)
      )
    ).rejects.toThrow(/dleq-missing/);
  });

  it("prepares and completes a claim while keeping the preimage and key out of redacted results", async () => {
    const material = createHtlcMaterial();
    const { client, calls } = harness(material.hash);
    const prepared = await client.prepareClaim({
      token: "synthetic-encoded-lock",
      expected: expected(material.hash),
      preimage: material.preimage,
      settlementPrivateKey: "synthetic-key-handle",
      now: 1400,
      claimCutoff: 1480
    });
    expect(prepared.kind).toBe("claim");
    expect(prepared).not.toHaveProperty("preimage");
    expect(prepared).not.toHaveProperty("privateKey");
    expect(calls.receiveInputs?.[0]?.witness).toEqual({ preimage: material.preimage });
    expect(calls.receiveConfig).toEqual({
      privkey: "synthetic-key-handle",
      requireDleq: false
    });

    const restored = JSON.parse(JSON.stringify(prepared)) as typeof prepared;
    const result = await client.completeClaim(
      restored,
      "synthetic-key-handle",
      expected(material.hash)
    );
    expect(result.pocket.proofs).toHaveLength(1);
    expect(result).not.toHaveProperty("preimage");
    expect(result).not.toHaveProperty("privateKey");
  });

  it("prepares refunds and observes a spent preimage only through the internal method", async () => {
    const material = createHtlcMaterial();
    const { client, locked, setSnapshot } = harness(material.hash);
    const prepared = await client.prepareRefund({
      token: "synthetic-encoded-lock",
      expected: expected(material.hash),
      refundPrivateKey: "synthetic-refund-key-handle",
      locktime: 2200,
      now: 2261,
      expiryGrace: 60
    });
    expect(prepared.kind).toBe("refund");
    const refunded = await client.completeRefund(
      prepared,
      "synthetic-refund-key-handle",
      expected(material.hash)
    );
    expect(refunded.pocket.proofs).toHaveLength(1);

    const states = locked.map((proof) => ({
      Y: point(proof),
      state: CheckStateEnum.SPENT,
      witness: JSON.stringify({ preimage: material.preimage, signatures: [] })
    }));
    setSnapshot(snapshot(locked, states));
    const observation = await client.observeSpentInternal(
      "synthetic-encoded-lock",
      expected(material.hash),
      "cd".repeat(32)
    );
    expect(observation).toEqual({
      status: "SPENT",
      proofCount: 2,
      preimage: material.preimage
    });
  });
});
