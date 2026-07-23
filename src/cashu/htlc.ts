import {
  Amount,
  CheckStateEnum,
  OutputData,
  P2PKBuilder,
  createHTLCHash,
  deserializeProofs,
  getDataField,
  getHTLCWitnessPreimage,
  getP2PKSigFlag,
  getTag,
  getTagInt,
  getTags,
  hasValidDleq,
  hashToCurve,
  parseHTLCSecret,
  parseP2PKSecret,
  sumProofs,
  serializeProofs,
  verifyHTLCHash,
  type Keys,
  type Proof,
  type ProofState,
  type SendResponse,
  type SerializedOutputData,
  type SwapPreview,
  type Wallet
} from "@cashu/cashu-ts";

export interface SerializedSwapPreview {
  amount: string;
  fees: string;
  keysetId: string;
  inputs: string[];
  sendOutputs?: SerializedOutputData[];
  keepOutputs?: SerializedOutputData[];
  unselectedProofs?: string[];
}

export function serializeSwapPreview(preview: SwapPreview): SerializedSwapPreview {
  assertInvariant(preview.keysetId.length > 0, "keyset-id");
  return {
    amount: preview.amount.toString(),
    fees: preview.fees.toString(),
    keysetId: preview.keysetId,
    inputs: serializeProofs(preview.inputs),
    ...(preview.sendOutputs
      ? { sendOutputs: preview.sendOutputs.map((output) => OutputData.serialize(output)) }
      : {}),
    ...(preview.keepOutputs
      ? { keepOutputs: preview.keepOutputs.map((output) => OutputData.serialize(output)) }
      : {}),
    ...(preview.unselectedProofs
      ? { unselectedProofs: serializeProofs(preview.unselectedProofs) }
      : {})
  };
}

export function deserializeSwapPreview(stored: SerializedSwapPreview): SwapPreview {
  assertInvariant(stored && typeof stored === "object", "prepared-swap");
  assertInvariant(/^(0|[1-9]\d*)$/.test(stored.amount), "prepared-amount");
  assertInvariant(/^(0|[1-9]\d*)$/.test(stored.fees), "prepared-fees");
  assertInvariant(typeof stored.keysetId === "string" && stored.keysetId.length > 0, "keyset-id");
  assertInvariant(Array.isArray(stored.inputs), "prepared-inputs");
  return {
    amount: Amount.from(stored.amount),
    fees: Amount.from(stored.fees),
    keysetId: stored.keysetId,
    inputs: deserializeProofs(stored.inputs),
    ...(stored.sendOutputs
      ? { sendOutputs: stored.sendOutputs.map((output) => OutputData.deserialize(output)) }
      : {}),
    ...(stored.keepOutputs
      ? { keepOutputs: stored.keepOutputs.map((output) => OutputData.deserialize(output)) }
      : {}),
    ...(stored.unselectedProofs
      ? { unselectedProofs: deserializeProofs(stored.unselectedProofs) }
      : {})
  };
}

export type HtlcLeg = "base" | "quote";

export interface HtlcBinding {
  protocolVersion: string;
  network: string;
  orderId: string;
  reservationId: string;
  sessionId: string;
  direction: HtlcLeg;
  transcriptHash: string;
}

export interface HtlcLockEnvelope {
  mintUrl: string;
  unit: string;
  binding: HtlcBinding;
  proofs: Proof[];
}

export interface HtlcCapabilities {
  nut07: boolean;
  nut10: boolean;
  nut11: boolean;
  nut12: boolean;
  nut14: boolean;
}

export interface HtlcKeysetSnapshot {
  id: string;
  unit: string;
  active: boolean;
  finalExpiry?: number;
  inputFeePpk: number;
  keys: Keys;
}

export interface ExpectedHtlcLock {
  mintUrl: string;
  unit: string;
  binding: HtlcBinding;
  amount: string;
  hash: string;
  receiverPubkey: string;
  refundPubkey: string;
  locktime: number;
  leg: HtlcLeg;
  refundHorizon: number;
  deadlines: {
    short: number;
    long: number;
    minimumGap: number;
  };
}

export interface HtlcValidationInput {
  envelope: HtlcLockEnvelope;
  expected: ExpectedHtlcLock;
  capabilities: HtlcCapabilities;
  keyset: HtlcKeysetSnapshot;
  states: ProofState[];
}

export interface HtlcValidationSummary {
  amount: string;
  fee: string;
  proofCount: number;
  keysetId: string;
}

export class HtlcInvariantError extends Error {
  constructor(readonly code: string) {
    super(`Cashu HTLC invariant failed: ${code}`);
    this.name = "HtlcInvariantError";
  }
}

function assertInvariant(condition: unknown, code: string): asserts condition {
  if (!condition) throw new HtlcInvariantError(code);
}

function normalizedMintUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HtlcInvariantError("mint-url");
  }
  assertInvariant(parsed.protocol === "https:" || parsed.hostname === "localhost", "mint-url");
  assertInvariant(parsed.username === "" && parsed.password === "", "mint-url");
  assertInvariant(parsed.search === "" && parsed.hash === "", "mint-url");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function canonicalUnit(value: string): string {
  const unit = value.trim().toLowerCase();
  assertInvariant(/^[a-z][a-z0-9_-]{0,31}$/.test(unit), "unit");
  return unit;
}

function canonicalHash(value: string): string {
  assertInvariant(/^[0-9a-f]{64}$/i.test(value), "hash");
  return value.toLowerCase();
}

function canonicalPubkey(value: string): string {
  assertInvariant(/^(02|03)[0-9a-f]{64}$/i.test(value), "pubkey");
  return value.slice(2).toLowerCase();
}

function assertSafeTimestamp(value: number, code: string): void {
  assertInvariant(Number.isSafeInteger(value) && value >= 0, code);
}

function sameBinding(actual: HtlcBinding, expected: HtlcBinding): boolean {
  return (
    actual.protocolVersion === expected.protocolVersion &&
    actual.network === expected.network &&
    actual.orderId === expected.orderId &&
    actual.reservationId === expected.reservationId &&
    actual.sessionId === expected.sessionId &&
    actual.direction === expected.direction &&
    actual.transcriptHash === expected.transcriptHash
  );
}

function assertBinding(binding: HtlcBinding): void {
  assertInvariant(binding.protocolVersion.length > 0, "protocol-version");
  assertInvariant(binding.network.length > 0, "network");
  assertInvariant(binding.orderId.length > 0, "order-id");
  assertInvariant(binding.reservationId.length > 0, "reservation-id");
  assertInvariant(binding.sessionId.length > 0, "session-id");
  assertInvariant(/^[0-9a-f]{64}$/i.test(binding.transcriptHash), "transcript-hash");
}

function proofCurvePoint(proof: Proof): string {
  return hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true).toLowerCase();
}

function assertStateMapping(proofs: Proof[], states: ProofState[]): void {
  assertInvariant(states.length === proofs.length, "proof-state-count");
  proofs.forEach((proof, index) => {
    const observed = states[index];
    assertInvariant(observed !== undefined, "proof-state-count");
    assertInvariant(observed.Y.toLowerCase() === proofCurvePoint(proof), "proof-state-point");
  });
}

function assertCanonicalLockProof(proof: Proof, expected: ExpectedHtlcLock): void {
  let secret;
  try {
    secret = parseHTLCSecret(proof.secret);
    parseP2PKSecret(secret);
  } catch {
    throw new HtlcInvariantError("secret-shape");
  }

  assertInvariant(getDataField(secret).toLowerCase() === canonicalHash(expected.hash), "hash");
  const mainKeys = getTag(secret, "pubkeys") ?? [];
  const refundKeys = getTag(secret, "refund") ?? [];
  assertInvariant(mainKeys.length === 1, "receiver-key-count");
  assertInvariant(refundKeys.length === 1, "refund-key-count");
  assertInvariant(
    canonicalPubkey(mainKeys[0]!) === canonicalPubkey(expected.receiverPubkey),
    "receiver-key"
  );
  assertInvariant(
    canonicalPubkey(refundKeys[0]!) === canonicalPubkey(expected.refundPubkey),
    "refund-key"
  );
  assertInvariant(getTagInt(secret, "locktime") === expected.locktime, "locktime");
  assertInvariant(getP2PKSigFlag(secret) === "SIG_INPUTS", "signature-flag");
  assertInvariant((getTagInt(secret, "n_sigs") ?? 1) === 1, "signature-threshold");
  assertInvariant((getTagInt(secret, "n_sigs_refund") ?? 1) === 1, "refund-threshold");

  const allowedTags = new Set([
    "locktime",
    "pubkeys",
    "refund",
    "sigflag",
    "n_sigs",
    "n_sigs_refund"
  ]);
  assertInvariant(
    getTags(secret).every(([key]) => key !== undefined && allowedTags.has(key)),
    "unexpected-tag"
  );
}

export function createHtlcMaterial(): { hash: string; preimage: string } {
  return createHTLCHash();
}

export async function prepareHtlcLock(
  wallet: Wallet,
  input: {
    amount: string;
    fundingProofs: Proof[];
    hash: string;
    receiverPubkey: string;
    refundPubkey: string;
    locktime: number;
    now: number;
  }
): Promise<SwapPreview> {
  const amount = Amount.from(input.amount);
  assertInvariant(!amount.isZero(), "amount");
  assertInvariant(input.fundingProofs.length > 0, "funding-proofs");
  const hash = canonicalHash(input.hash);
  assertSafeTimestamp(input.locktime, "locktime");
  assertSafeTimestamp(input.now, "clock");
  assertInvariant(input.locktime > input.now, "locktime-not-future");
  assertInvariant(
    canonicalPubkey(input.receiverPubkey) !== canonicalPubkey(input.refundPubkey),
    "key-separation"
  );

  let options;
  try {
    options = new P2PKBuilder()
      .addHashlock(hash)
      .addLockPubkey(input.receiverPubkey)
      .lockUntil(input.locktime)
      .addRefundPubkey(input.refundPubkey)
      .toOptions();
  } catch {
    throw new HtlcInvariantError("lock-options");
  }

  return wallet.ops
    .send(input.amount, input.fundingProofs)
    .asP2PK(options)
    .keepAsRandom()
    .includeFees(true)
    .prepare();
}

export async function completeHtlcLock(
  wallet: Wallet,
  prepared: SwapPreview
): Promise<{ lockedProofs: Proof[]; changeProofs: Proof[] }> {
  const result: SendResponse = await wallet.completeSwap(prepared);
  assertInvariant(result.send.length > 0, "empty-lock-output");
  return { lockedProofs: result.send, changeProofs: result.keep };
}

export function validateHtlcLock(input: HtlcValidationInput): HtlcValidationSummary {
  const { envelope, expected, capabilities, keyset, states } = input;
  assertInvariant(
    normalizedMintUrl(envelope.mintUrl) === normalizedMintUrl(expected.mintUrl),
    "mint"
  );
  const unit = canonicalUnit(envelope.unit);
  assertInvariant(unit === canonicalUnit(expected.unit), "unit");
  assertBinding(envelope.binding);
  assertBinding(expected.binding);
  assertInvariant(sameBinding(envelope.binding, expected.binding), "binding");
  assertInvariant(envelope.binding.direction === expected.leg, "leg");
  assertInvariant(capabilities.nut07, "nut07");
  assertInvariant(capabilities.nut10, "nut10");
  assertInvariant(capabilities.nut11, "nut11");
  assertInvariant(capabilities.nut14, "nut14");
  assertInvariant(envelope.proofs.length > 0, "proofs-empty");

  assertInvariant(keyset.active, "keyset-inactive");
  assertInvariant(keyset.id.length > 0, "keyset-id");
  assertInvariant(canonicalUnit(keyset.unit) === unit, "keyset-unit");
  assertInvariant(
    keyset.finalExpiry === undefined || keyset.finalExpiry > expected.refundHorizon,
    "keyset-expiry"
  );
  assertInvariant(
    Number.isSafeInteger(keyset.inputFeePpk) && keyset.inputFeePpk >= 0,
    "input-fee"
  );

  assertSafeTimestamp(expected.deadlines.short, "short-deadline");
  assertSafeTimestamp(expected.deadlines.long, "long-deadline");
  assertSafeTimestamp(expected.deadlines.minimumGap, "deadline-gap");
  assertInvariant(expected.deadlines.long > expected.deadlines.short, "deadline-order");
  assertInvariant(
    expected.deadlines.long - expected.deadlines.short >= expected.deadlines.minimumGap,
    "deadline-gap"
  );
  // The market leg names the asset, not its protocol role. A buy-side maker
  // offers the quote asset in the long-lock slot and the taker pays the base
  // asset in the short-lock slot.
  assertInvariant(
    expected.locktime === expected.deadlines.long ||
      expected.locktime === expected.deadlines.short,
    "leg-deadline"
  );
  assertInvariant(expected.refundHorizon >= expected.locktime, "refund-horizon");

  const secrets = new Set<string>();
  const points = new Set<string>();
  for (const proof of envelope.proofs) {
    assertInvariant(proof.id === keyset.id, "proof-keyset");
    assertInvariant(!secrets.has(proof.secret), "duplicate-secret");
    secrets.add(proof.secret);
    const point = proofCurvePoint(proof);
    assertInvariant(!points.has(point), "duplicate-point");
    points.add(point);
    assertCanonicalLockProof(proof, expected);

    if (capabilities.nut12) assertInvariant(proof.dleq !== undefined, "dleq-missing");
    if (capabilities.nut12 || proof.dleq !== undefined) {
      let valid = false;
      try {
        valid = hasValidDleq(proof, keyset, { require: true });
      } catch {
        valid = false;
      }
      assertInvariant(valid, "dleq-invalid");
    }
  }

  assertStateMapping(envelope.proofs, states);
  assertInvariant(
    states.every((item) => item.state === CheckStateEnum.UNSPENT),
    "proof-not-unspent"
  );

  const face = sumProofs(envelope.proofs).toBigInt();
  const feePpk = BigInt(keyset.inputFeePpk) * BigInt(envelope.proofs.length);
  const fee = (feePpk + 999n) / 1000n;
  assertInvariant(face >= fee, "fee-exceeds-value");
  const net = face - fee;
  assertInvariant(net === Amount.from(expected.amount).toBigInt(), "net-amount");

  return {
    amount: net.toString(),
    fee: fee.toString(),
    proofCount: envelope.proofs.length,
    keysetId: keyset.id
  };
}

export async function prepareHtlcClaim(
  wallet: Wallet,
  input: {
    lockedProofs: Proof[];
    hash: string;
    preimage: string;
    settlementPrivateKey: string | string[];
    now: number;
    claimCutoff: number;
    requireDleq?: boolean;
  }
): Promise<SwapPreview> {
  assertInvariant(input.lockedProofs.length > 0, "proofs-empty");
  const hash = canonicalHash(input.hash);
  assertSafeTimestamp(input.now, "clock");
  assertSafeTimestamp(input.claimCutoff, "claim-cutoff");
  assertInvariant(input.now < input.claimCutoff, "claim-cutoff-reached");
  assertInvariant(verifyHTLCHash(input.preimage, hash), "preimage");
  assertInvariant(
    typeof input.settlementPrivateKey !== "string" || input.settlementPrivateKey.length > 0,
    "settlement-key"
  );

  const claimInputs = input.lockedProofs.map((proof) => {
    assertInvariant(proof.witness === undefined, "proof-not-pristine");
    let secret;
    try {
      secret = parseHTLCSecret(proof.secret);
    } catch {
      throw new HtlcInvariantError("secret-shape");
    }
    assertInvariant(getDataField(secret).toLowerCase() === hash, "hash");
    return { ...proof, witness: { preimage: input.preimage } };
  });

  return wallet.prepareSwapToReceive(claimInputs, {
    privkey: input.settlementPrivateKey,
    requireDleq: input.requireDleq ?? true
  });
}

async function completePreparedHtlcSpend(
  wallet: Wallet,
  prepared: SwapPreview,
  privateKey: string | string[]
): Promise<Proof[]> {
  assertInvariant(typeof privateKey !== "string" || privateKey.length > 0, "spend-key");
  const result = await wallet.completeSwap(prepared, privateKey);
  assertInvariant(result.keep.length > 0, "empty-spend-output");
  return result.keep;
}

export function completeHtlcClaim(
  wallet: Wallet,
  prepared: SwapPreview,
  settlementPrivateKey: string | string[]
): Promise<Proof[]> {
  return completePreparedHtlcSpend(wallet, prepared, settlementPrivateKey);
}

export function extractSpentPreimage(
  proofs: Proof[],
  states: ProofState[],
  expectedHash: string
): string {
  assertInvariant(proofs.length > 0, "proofs-empty");
  const hash = canonicalHash(expectedHash);
  assertStateMapping(proofs, states);
  let observed: string | undefined;

  proofs.forEach((proof, index) => {
    const item = states[index]!;
    assertInvariant(item.state === CheckStateEnum.SPENT, "proof-not-spent");
    let secret;
    try {
      secret = parseHTLCSecret(proof.secret);
    } catch {
      throw new HtlcInvariantError("secret-shape");
    }
    assertInvariant(getDataField(secret).toLowerCase() === hash, "hash");
    const preimage = getHTLCWitnessPreimage(item.witness ?? undefined);
    assertInvariant(preimage !== undefined && verifyHTLCHash(preimage, hash), "spent-witness");
    if (observed === undefined) observed = preimage;
    assertInvariant(preimage === observed, "mixed-witnesses");
  });

  assertInvariant(observed !== undefined, "spent-witness");
  return observed;
}

export async function observeHtlc(
  wallet: Wallet,
  proofs: Proof[],
  expectedHash: string
): Promise<
  | { status: "UNSPENT"; proofCount: number }
  | { status: "SPENT"; proofCount: number; preimage: string }
> {
  assertInvariant(proofs.length > 0, "proofs-empty");
  const states = await wallet.checkProofsStates(proofs);
  assertStateMapping(proofs, states);
  if (states.every((item) => item.state === CheckStateEnum.UNSPENT)) {
    return { status: "UNSPENT", proofCount: proofs.length };
  }
  return {
    status: "SPENT",
    proofCount: proofs.length,
    preimage: extractSpentPreimage(proofs, states, expectedHash)
  };
}

export async function prepareHtlcRefund(
  wallet: Wallet,
  input: {
    lockedProofs: Proof[];
    refundPrivateKey: string | string[];
    locktime: number;
    now: number;
    expiryGrace?: number;
    requireDleq?: boolean;
  }
): Promise<SwapPreview> {
  assertInvariant(input.lockedProofs.length > 0, "proofs-empty");
  assertSafeTimestamp(input.locktime, "locktime");
  assertSafeTimestamp(input.now, "clock");
  const grace = input.expiryGrace ?? 60;
  assertSafeTimestamp(grace, "expiry-grace");
  assertInvariant(input.now > input.locktime + grace, "refund-too-early");
  assertInvariant(
    typeof input.refundPrivateKey !== "string" || input.refundPrivateKey.length > 0,
    "refund-key"
  );

  for (const proof of input.lockedProofs) {
    assertInvariant(proof.witness === undefined, "proof-not-pristine");
    let secret;
    try {
      secret = parseHTLCSecret(proof.secret);
      parseP2PKSecret(secret);
    } catch {
      throw new HtlcInvariantError("secret-shape");
    }
    assertInvariant(getTagInt(secret, "locktime") === input.locktime, "locktime");
    assertInvariant((getTag(secret, "refund") ?? []).length > 0, "refund-key");
  }

  return wallet.prepareSwapToReceive(input.lockedProofs, {
    privkey: input.refundPrivateKey,
    requireDleq: input.requireDleq ?? true
  });
}

export function completeHtlcRefund(
  wallet: Wallet,
  prepared: SwapPreview,
  refundPrivateKey: string | string[]
): Promise<Proof[]> {
  return completePreparedHtlcSpend(wallet, prepared, refundPrivateKey);
}
