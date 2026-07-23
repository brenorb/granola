import {
  Amount,
  CheckStateEnum,
  createHTLCsecret,
  hashToCurve,
  type P2PKOptions,
  type Proof,
  type ProofState,
  type SwapPreview,
  type Wallet
} from "@cashu/cashu-ts";
import { describe, expect, it, vi } from "vitest";

import {
  HtlcInvariantError,
  completeHtlcClaim,
  completeHtlcLock,
  completeHtlcRefund,
  createHtlcMaterial,
  extractSpentPreimage,
  observeHtlc,
  prepareHtlcClaim,
  prepareHtlcLock,
  prepareHtlcRefund,
  validateHtlcLock,
  type HtlcBinding,
  type HtlcLockEnvelope,
  type HtlcValidationInput
} from "./htlc.js";

const receiverPubkey =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const refundPubkey =
  "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const mintUrl = "https://mint-one.invalid";
const keysetId = "synthetic-keyset";

const binding: HtlcBinding = {
  protocolVersion: "granola/1",
  network: "cashu-testnet",
  orderId: "order-test",
  reservationId: "reservation-test",
  sessionId: "session-test",
  direction: "base",
  transcriptHash: "ab".repeat(32)
};

function proof(hash: string, amount: number, nonce: number): Proof {
  return {
    amount: Amount.from(amount),
    id: keysetId,
    secret: createHTLCsecret(hash, [
      ["locktime", "2200"],
      ["refund", refundPubkey],
      ["pubkeys", receiverPubkey]
    ]),
    C: `02${String(nonce).padStart(64, "0")}`,
  };
}

function curvePoint(item: Proof): string {
  return hashToCurve(new TextEncoder().encode(item.secret)).toHex(true);
}

function state(item: Proof, value: CheckStateEnum, witness: string | null = null): ProofState {
  return { Y: curvePoint(item), state: value, witness };
}

function validation(hash: string): HtlcValidationInput {
  const proofs = [proof(hash, 6, 1), proof(hash, 5, 2)];
  const envelope: HtlcLockEnvelope = {
    mintUrl,
    unit: "sat",
    binding: { ...binding },
    proofs
  };
  return {
    envelope,
    expected: {
      mintUrl,
      unit: "sat",
      binding: { ...binding },
      amount: "10",
      hash,
      receiverPubkey,
      refundPubkey,
      locktime: 2200,
      leg: "base",
      refundHorizon: 2800,
      deadlines: { short: 1600, long: 2200, minimumGap: 600 }
    },
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
    states: proofs.map((item) => state(item, CheckStateEnum.UNSPENT)),
  };
}

function walletMock() {
  const calls: {
    amount?: unknown;
    options?: P2PKOptions;
    includeFees?: boolean;
    claimInputs?: Proof[];
    claimConfig?: unknown;
    completed?: SwapPreview;
    completionKey: string | string[] | undefined;
  } = { completionKey: undefined };
  const preview = {
    amount: Amount.from(9),
    fees: Amount.from(1),
    keysetId,
    inputs: [] as Proof[],
    keepOutputs: [],
    sendOutputs: []
  } as unknown as SwapPreview;
  const builder = {
    asP2PK(options: P2PKOptions) {
      calls.options = options;
      return this;
    },
    keepAsRandom() {
      return this;
    },
    includeFees(value: boolean) {
      calls.includeFees = value;
      return this;
    },
    prepare: vi.fn(async () => preview)
  };
  const wallet = {
    ops: {
      send(amount: unknown) {
        calls.amount = amount;
        return builder;
      }
    },
    prepareSwapToReceive: vi.fn(async (inputs: Proof[], config: unknown) => {
      calls.claimInputs = inputs;
      calls.claimConfig = config;
      return { ...preview, inputs };
    }),
    completeSwap: vi.fn(async (prepared: SwapPreview, key?: string | string[]) => {
      calls.completed = prepared;
      calls.completionKey = key;
      return { keep: [proof("11".repeat(32), 1, 9)], send: [proof("22".repeat(32), 1, 8)] };
    }),
    checkProofsStates: vi.fn()
  } as unknown as Wallet;
  return { wallet, calls, preview };
}

describe("Cashu HTLC material and lock creation", () => {
  it("creates fresh 32-byte material and builds a receiver-bound refundable lock", async () => {
    const material = createHtlcMaterial();
    expect(material.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(material.preimage).toMatch(/^[0-9a-f]{64}$/);

    const { wallet, calls, preview } = walletMock();
    await expect(
      prepareHtlcLock(wallet, {
        amount: "9",
        fundingProofs: [proof(material.hash, 10, 3)],
        hash: material.hash,
        receiverPubkey,
        refundPubkey,
        locktime: 2200,
        now: 1000
      })
    ).resolves.toBe(preview);

    expect(calls.amount).toBe("9");
    expect(calls.includeFees).toBe(true);
    expect(calls.options).toMatchObject({
      hashlock: material.hash,
      pubkey: receiverPubkey,
      refundKeys: [refundPubkey],
      locktime: 2200
    });

    const completed = await completeHtlcLock(wallet, preview);
    expect(completed.lockedProofs).toHaveLength(1);
    expect(completed.changeProofs).toHaveLength(1);
  });

  it("rejects non-future locks and malformed hash material before touching a wallet", async () => {
    const { wallet } = walletMock();
    await expect(
      prepareHtlcLock(wallet, {
        amount: "1",
        fundingProofs: [],
        hash: "not-a-hash",
        receiverPubkey,
        refundPubkey,
        locktime: 1000,
        now: 1000
      })
    ).rejects.toBeInstanceOf(HtlcInvariantError);
  });
});

describe("strict HTLC lock validation", () => {
  it("accepts only the exact canonical lock and net amount", () => {
    const material = createHtlcMaterial();
    expect(validateHtlcLock(validation(material.hash))).toEqual({
      amount: "10",
      fee: "1",
      proofCount: 2,
      keysetId
    });
  });

  it.each([
    ["wrong mint", (input: HtlcValidationInput) => (input.envelope.mintUrl = "https://other.invalid")],
    [
      "insecure remote mint",
      (input: HtlcValidationInput) => {
        input.envelope.mintUrl = "http://remote.invalid";
        input.expected.mintUrl = "http://remote.invalid";
      }
    ],
    ["inactive keyset", (input: HtlcValidationInput) => (input.keyset.active = false)],
    ["expired keyset", (input: HtlcValidationInput) => (input.keyset.finalExpiry = 2700)],
    ["missing capability", (input: HtlcValidationInput) => (input.capabilities.nut14 = false)],
    ["missing required DLEQ", (input: HtlcValidationInput) => (input.capabilities.nut12 = true)],
    [
      "invalid DLEQ",
      (input: HtlcValidationInput) => {
        input.capabilities.nut12 = true;
        input.envelope.proofs[0]!.dleq = {
          e: "01".repeat(32),
          s: "02".repeat(32),
          r: "03".repeat(32)
        };
      }
    ],
    ["pending proof", (input: HtlcValidationInput) => (input.states[0]!.state = CheckStateEnum.PENDING)],
    ["wrong amount", (input: HtlcValidationInput) => (input.expected.amount = "9")],
    ["unsafe deadline gap", (input: HtlcValidationInput) => (input.expected.deadlines.long = 2199)],
    ["wrong binding", (input: HtlcValidationInput) => (input.envelope.binding.sessionId = "other-session")]
  ])("fails closed for %s", (_name, mutate) => {
    const material = createHtlcMaterial();
    const input = validation(material.hash);
    mutate(input);
    expect(() => validateHtlcLock(input)).toThrow(HtlcInvariantError);
  });

  it("rejects duplicate proofs and a substituted lock profile", () => {
    const material = createHtlcMaterial();
    const duplicate = validation(material.hash);
    duplicate.envelope.proofs[1] = duplicate.envelope.proofs[0]!;
    duplicate.states = duplicate.envelope.proofs.map((item) =>
      state(item, CheckStateEnum.UNSPENT)
    );
    expect(() => validateHtlcLock(duplicate)).toThrow(HtlcInvariantError);

    const substituted = validation(material.hash);
    substituted.envelope.proofs[0]!.secret = createHTLCsecret(material.hash, [
      ["locktime", "2200"],
      ["refund", receiverPubkey],
      ["pubkeys", receiverPubkey]
    ]);
    substituted.states[0] = state(substituted.envelope.proofs[0]!, CheckStateEnum.UNSPENT);
    expect(() => validateHtlcLock(substituted)).toThrow(HtlcInvariantError);
  });
});

describe("claim observation and refund", () => {
  it("attaches a verified preimage, preserves it while signing, and obeys the claim cutoff", async () => {
    const material = createHtlcMaterial();
    const locked = [proof(material.hash, 2, 4)];
    const { wallet, calls } = walletMock();

    const prepared = await prepareHtlcClaim(wallet, {
      lockedProofs: locked,
      hash: material.hash,
      preimage: material.preimage,
      settlementPrivateKey: "synthetic-key-handle",
      now: 1400,
      claimCutoff: 1480,
      requireDleq: true
    });
    expect(calls.claimInputs?.[0]?.witness).toEqual({ preimage: material.preimage });
    expect(calls.claimConfig).toEqual({
      privkey: "synthetic-key-handle",
      requireDleq: true
    });
    await expect(
      completeHtlcClaim(wallet, prepared, "synthetic-key-handle")
    ).resolves.toHaveLength(1);
    expect(calls.completionKey).toBe("synthetic-key-handle");

    await expect(
      prepareHtlcClaim(wallet, {
        lockedProofs: locked,
        hash: material.hash,
        preimage: material.preimage,
        settlementPrivateKey: "synthetic-key-handle",
        now: 1480,
        claimCutoff: 1480
      })
    ).rejects.toBeInstanceOf(HtlcInvariantError);
  });

  it("extracts one matching preimage only after every proof is spent", async () => {
    const material = createHtlcMaterial();
    const proofs = [proof(material.hash, 2, 5), proof(material.hash, 1, 6)];
    const spent = proofs.map((item) =>
      state(
        item,
        CheckStateEnum.SPENT,
        JSON.stringify({ preimage: material.preimage, signatures: [] })
      )
    );
    expect(extractSpentPreimage(proofs, spent, material.hash)).toBe(material.preimage);

    const { wallet } = walletMock();
    vi.mocked(wallet.checkProofsStates).mockResolvedValue(spent);
    await expect(observeHtlc(wallet, proofs, material.hash)).resolves.toEqual({
      status: "SPENT",
      proofCount: 2,
      preimage: material.preimage
    });

    spent[0] = { ...spent[0]!, state: CheckStateEnum.PENDING };
    expect(() => extractSpentPreimage(proofs, spent, material.hash)).toThrow(
      HtlcInvariantError
    );
  });

  it("prepares a refund only from pristine proofs after the mint-expiry grace", async () => {
    const material = createHtlcMaterial();
    const locked = [proof(material.hash, 2, 7)];
    const { wallet, calls } = walletMock();

    const prepared = await prepareHtlcRefund(wallet, {
      lockedProofs: locked,
      refundPrivateKey: "synthetic-refund-key-handle",
      locktime: 2200,
      now: 2261,
      expiryGrace: 60,
      requireDleq: true
    });
    expect(calls.claimInputs).toEqual(locked);
    expect(calls.claimConfig).toEqual({
      privkey: "synthetic-refund-key-handle",
      requireDleq: true
    });
    await expect(
      completeHtlcRefund(wallet, prepared, "synthetic-refund-key-handle")
    ).resolves.toHaveLength(1);

    await expect(
      prepareHtlcRefund(wallet, {
        lockedProofs: [{ ...locked[0]!, witness: { preimage: material.preimage } }],
        refundPrivateKey: "synthetic-refund-key-handle",
        locktime: 2200,
        now: 2261
      })
    ).rejects.toBeInstanceOf(HtlcInvariantError);
  });
});
