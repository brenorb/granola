import {
  Amount,
  CheckStateEnum,
  Wallet,
  deserializeProofs,
  getDataField,
  getTag,
  getTagInt,
  getP2PKSigFlag,
  parseHTLCSecret,
  sumProofs,
  type Proof,
  type ProofState,
  type SendResponse,
  type SwapPreview
} from "@cashu/cashu-ts";

import { normalizeMintUrl, type StoredProof, type WalletPocket } from "../core/wallet.js";
import { CashuClient, type TokenSummary } from "./client.js";
import {
  completeHtlcClaim,
  completeHtlcLock,
  completeHtlcRefund,
  deserializeSwapPreview,
  extractSpentPreimage,
  prepareHtlcClaim,
  prepareHtlcLock,
  prepareHtlcRefund,
  serializeSwapPreview,
  validateHtlcLock,
  type ExpectedHtlcLock,
  type HtlcCapabilities,
  type HtlcKeysetSnapshot,
  type HtlcValidationSummary,
  type SerializedSwapPreview
} from "./htlc.js";

export interface TradeMintSnapshot {
  capabilities: HtlcCapabilities;
  keyset: HtlcKeysetSnapshot;
  states: Awaited<ReturnType<Wallet["checkProofsStates"]>>;
}

export interface CashuTradeDependencies {
  wallet(mintUrl: string, unit: string): Promise<Wallet>;
  inspectToken(token: string): TokenSummary;
  encodeToken(pocket: WalletPocket): string;
  snapshot(wallet: Wallet, proofs: Proof[]): Promise<TradeMintSnapshot>;
  commitment(value: string): Promise<string>;
  recover(wallet: Wallet, preview: SwapPreview): Promise<SendResponse | undefined>;
}

/** @internal Contains bearer proofs/blinding material. Persist encrypted; never return from a browser API. */
export interface PreparedTradeOperation {
  version: 1;
  kind: "outgoing-lock" | "claim" | "refund";
  mintUrl: string;
  unit: string;
  preview: SerializedSwapPreview;
  spentSecrets: string[];
  expected: ExpectedHtlcLock;
  operationCommitment: string;
}

export interface RedactedLockSummary extends HtlcValidationSummary {
  mintUrl: string;
  unit: string;
  commitment: string;
}

export interface CompletedLock {
  change: WalletPocket;
  /** Internal bearer artifact. Encrypt it before transport; never expose it on `window.granola`. */
  lockedToken: string;
  summary: RedactedLockSummary;
}

export interface CompletedHtlcSpend {
  pocket: WalletPocket;
  summary: {
    mintUrl: string;
    unit: string;
    amount: string;
    proofCount: number;
  };
}

export class CashuTradeError extends Error {
  constructor(readonly code: string) {
    super(`Cashu trade operation failed: ${code}`);
    this.name = "CashuTradeError";
  }
}

function assertTrade(condition: unknown, code: string): asserts condition {
  if (!condition) throw new CashuTradeError(code);
}

function toProofs(pocket: WalletPocket): Proof[] {
  assertTrade(pocket.proofs.length > 0, "empty-pocket");
  try {
    return deserializeProofs(pocket.proofs.map((proof) => JSON.stringify(proof)));
  } catch {
    throw new CashuTradeError("stored-proofs");
  }
}

function toStoredProof(proof: Proof): StoredProof {
  return {
    amount: proof.amount.toString(),
    id: proof.id,
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq ? { dleq: proof.dleq } : {})
  };
}

function toPocket(mintUrl: string, unit: string, proofs: Proof[]): WalletPocket {
  return {
    mintUrl: normalizeMintUrl(mintUrl),
    unit: unit.trim().toLowerCase(),
    proofs: proofs.map(toStoredProof)
  };
}

function canonicalExpected(expected: ExpectedHtlcLock): string {
  return JSON.stringify({
    mintUrl: normalizeMintUrl(expected.mintUrl),
    unit: expected.unit.trim().toLowerCase(),
    binding: {
      protocolVersion: expected.binding.protocolVersion,
      network: expected.binding.network,
      orderId: expected.binding.orderId,
      reservationId: expected.binding.reservationId,
      sessionId: expected.binding.sessionId,
      direction: expected.binding.direction,
      transcriptHash: expected.binding.transcriptHash.toLowerCase()
    },
    amount: Amount.from(expected.amount).toString(),
    hash: expected.hash.toLowerCase(),
    receiverPubkey: expected.receiverPubkey.toLowerCase(),
    refundPubkey: expected.refundPubkey.toLowerCase(),
    locktime: expected.locktime,
    leg: expected.leg,
    refundHorizon: expected.refundHorizon,
    deadlines: expected.deadlines
  });
}

async function assertArtifact(
  dependencies: CashuTradeDependencies,
  artifact: PreparedTradeOperation,
  kind: PreparedTradeOperation["kind"],
  expected: ExpectedHtlcLock
): Promise<SwapPreview> {
  assertTrade(artifact.version === 1, "artifact-version");
  assertTrade(artifact.kind === kind, "artifact-kind");
  assertTrade(artifact.spentSecrets.length > 0, "artifact-inputs");
  const unique = new Set(artifact.spentSecrets);
  assertTrade(unique.size === artifact.spentSecrets.length, "artifact-inputs");
  const preview = deserializeSwapPreview(artifact.preview);
  assertTrade(
    preview.inputs.length === artifact.spentSecrets.length &&
      preview.inputs.every((proof, index) => proof.secret === artifact.spentSecrets[index]),
    "artifact-inputs"
  );
  const expectedTerms = canonicalExpected(expected);
  assertTrade(canonicalExpected(artifact.expected) === expectedTerms, "artifact-terms");
  assertTrade(artifact.operationCommitment === await operationCommitment(dependencies, {
    kind: artifact.kind,
    mintUrl: artifact.mintUrl,
    unit: artifact.unit,
    preview: artifact.preview,
    spentSecrets: artifact.spentSecrets,
    expected: artifact.expected
  }), "artifact-commitment");
  assertTrade(normalizeMintUrl(artifact.mintUrl) === normalizeMintUrl(expected.mintUrl), "artifact-mint");
  assertTrade(artifact.unit.trim().toLowerCase() === expected.unit.trim().toLowerCase(), "artifact-unit");
  assertTrade(preview.amount.toString() === Amount.from(expected.amount).toString(), "artifact-amount");
  return preview;
}

async function operationCommitment(
  dependencies: CashuTradeDependencies,
  artifact: Omit<PreparedTradeOperation, "version" | "operationCommitment">
): Promise<string> {
  return dependencies.commitment(JSON.stringify({
    kind: artifact.kind,
    mintUrl: normalizeMintUrl(artifact.mintUrl),
    unit: artifact.unit.trim().toLowerCase(),
    expected: canonicalExpected(artifact.expected),
    preview: artifact.preview,
    spentSecrets: artifact.spentSecrets
  }));
}

async function sha256Hex(value: string): Promise<string> {
  assertTrade(globalThis.crypto?.subtle !== undefined, "crypto-unavailable");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function defaultDependencies(): CashuTradeDependencies {
  const cashu = new CashuClient();
  return {
    async wallet(mintUrl, unit) {
      const wallet = new Wallet(normalizeMintUrl(mintUrl), { unit: unit.trim().toLowerCase() });
      await wallet.loadMint();
      return wallet;
    },
    inspectToken(token) {
      return cashu.inspectToken(token);
    },
    encodeToken(pocket) {
      return cashu.encodeToken(pocket);
    },
    async snapshot(wallet, proofs) {
      assertTrade(proofs.length > 0, "empty-token");
      const ids = [...new Set(proofs.map((proof) => proof.id))];
      assertTrade(ids.length === 1 && ids[0] !== undefined, "keyset-count");
      let selected;
      try {
        selected = wallet.keyChain.getKeyset(ids[0]);
      } catch {
        throw new CashuTradeError("unknown-keyset");
      }
      const info = wallet.getMintInfo();
      return {
        capabilities: {
          nut07: info.isSupported(7).supported,
          nut10: info.isSupported(10).supported,
          nut11: info.isSupported(11).supported,
          nut12: info.isSupported(12).supported,
          nut14: info.isSupported(14).supported
        },
        keyset: {
          id: selected.id,
          unit: selected.unit,
          active: selected.isActive,
          ...(selected.expiry !== undefined ? { finalExpiry: selected.expiry } : {}),
          inputFeePpk: selected.fee,
          keys: selected.keys
        },
        states: await wallet.checkProofsStates(proofs)
      };
    },
    commitment: sha256Hex,
    async recover(wallet, preview) {
      const keepOutputs = preview.keepOutputs ?? [];
      const sendOutputs = preview.sendOutputs ?? [];
      const outputs = [...keepOutputs, ...sendOutputs];
      assertTrade(outputs.length > 0, "artifact-outputs");
      const restored = await wallet.mint.restore({
        outputs: outputs.map((item) => item.blindedMessage)
      });
      if (restored.outputs.length === 0 && restored.signatures.length === 0) return undefined;
      assertTrade(
        restored.outputs.length === outputs.length && restored.signatures.length === outputs.length,
        "restore-partial"
      );
      const restoredByPoint = new Map(
        restored.outputs.map((output, index) => [output.B_, restored.signatures[index]])
      );
      const proofs = outputs.map((output) => {
        const signature = restoredByPoint.get(output.blindedMessage.B_);
        assertTrade(signature !== undefined, "restore-mismatch");
        return output.toProof(signature, wallet.keyChain.getKeyset(signature.id));
      });
      return {
        keep: proofs.slice(0, keepOutputs.length),
        send: proofs.slice(keepOutputs.length)
      };
    }
  };
}

interface OpenedLock {
  wallet: Wallet;
  proofs: Proof[];
  requireDleq: boolean;
  summary: RedactedLockSummary;
}

export class CashuTradeClient {
  constructor(private readonly dependencies: CashuTradeDependencies = defaultDependencies()) {}

  async prepareOutgoingLock(input: {
    pocket: WalletPocket;
    expected: ExpectedHtlcLock;
    now: number;
  }): Promise<PreparedTradeOperation> {
    const mintUrl = normalizeMintUrl(input.pocket.mintUrl);
    const unit = input.pocket.unit.trim().toLowerCase();
    assertTrade(unit.length > 0, "unit");
    const fundingProofs = toProofs(input.pocket);
    const wallet = await this.dependencies.wallet(mintUrl, unit);
    assertTrade(mintUrl === normalizeMintUrl(input.expected.mintUrl), "expected-mint");
    assertTrade(unit === input.expected.unit.trim().toLowerCase(), "expected-unit");
    const preview = await prepareHtlcLock(wallet, {
      amount: input.expected.amount,
      fundingProofs,
      hash: input.expected.hash,
      receiverPubkey: input.expected.receiverPubkey,
      refundPubkey: input.expected.refundPubkey,
      locktime: input.expected.locktime,
      now: input.now
    });
    const spentSecrets = preview.inputs.map((proof) => proof.secret);
    assertTrade(spentSecrets.length > 0, "prepared-inputs");
    assertTrade(new Set(spentSecrets).size === spentSecrets.length, "prepared-inputs");
    const artifact = {
      version: 1,
      kind: "outgoing-lock",
      mintUrl,
      unit,
      preview: serializeSwapPreview(preview),
      spentSecrets,
      expected: input.expected,
      operationCommitment: ""
    } satisfies PreparedTradeOperation;
    artifact.operationCommitment = await operationCommitment(this.dependencies, artifact);
    return artifact;
  }

  async completeOutgoingLock(
    artifact: PreparedTradeOperation,
    expected: ExpectedHtlcLock
  ): Promise<CompletedLock> {
    const preview = await assertArtifact(this.dependencies, artifact, "outgoing-lock", expected);
    const wallet = await this.dependencies.wallet(artifact.mintUrl, artifact.unit);
    this.assertOutgoingOutputs(wallet, preview, expected);
    const recovered = await this.dependencies.recover(wallet, preview);
    const completed = recovered
      ? { changeProofs: recovered.keep, lockedProofs: recovered.send }
      : await completeHtlcLock(wallet, preview);
    const unselectedSecrets = new Set((preview.unselectedProofs ?? []).map((proof) => proof.secret));
    const newChangeProofs = completed.changeProofs.filter(
      (proof) => !unselectedSecrets.has(proof.secret)
    );
    assertTrade(completed.lockedProofs.length > 0, "empty-lock-output");
    const change = toPocket(artifact.mintUrl, artifact.unit, newChangeProofs);
    const lockedPocket = toPocket(artifact.mintUrl, artifact.unit, completed.lockedProofs);
    const lockedToken = this.dependencies.encodeToken(lockedPocket);
    const opened = await this.openValidated(lockedToken, expected);
    return { change, lockedToken, summary: opened.summary };
  }

  async validateIncomingLock(
    token: string,
    expected: ExpectedHtlcLock
  ): Promise<RedactedLockSummary> {
    return (await this.openValidated(token, expected)).summary;
  }

  async prepareClaim(input: {
    token: string;
    expected: ExpectedHtlcLock;
    preimage: string;
    settlementPrivateKey: string | string[];
    now: number;
    claimCutoff: number;
  }): Promise<PreparedTradeOperation> {
    const opened = await this.openValidated(input.token, input.expected);
    const preview = await prepareHtlcClaim(opened.wallet, {
      lockedProofs: opened.proofs,
      hash: input.expected.hash,
      preimage: input.preimage,
      settlementPrivateKey: input.settlementPrivateKey,
      now: input.now,
      claimCutoff: input.claimCutoff,
      requireDleq: opened.requireDleq
    });
    return this.preparedSpend("claim", opened, preview, input.expected);
  }

  async completeClaim(
    artifact: PreparedTradeOperation,
    settlementPrivateKey: string | string[],
    expected: ExpectedHtlcLock
  ): Promise<CompletedHtlcSpend> {
    const preview = await assertArtifact(this.dependencies, artifact, "claim", expected);
    const wallet = await this.dependencies.wallet(artifact.mintUrl, artifact.unit);
    const recovered = await this.dependencies.recover(wallet, preview);
    const proofs = recovered?.keep ?? await completeHtlcClaim(wallet, preview, settlementPrivateKey);
    return this.completedSpend(artifact, proofs);
  }

  async prepareRefund(input: {
    token: string;
    expected: ExpectedHtlcLock;
    refundPrivateKey: string | string[];
    locktime: number;
    now: number;
    expiryGrace?: number;
  }): Promise<PreparedTradeOperation> {
    const opened = await this.openValidated(input.token, input.expected);
    const preview = await prepareHtlcRefund(opened.wallet, {
      lockedProofs: opened.proofs,
      refundPrivateKey: input.refundPrivateKey,
      locktime: input.locktime,
      now: input.now,
      ...(input.expiryGrace !== undefined ? { expiryGrace: input.expiryGrace } : {}),
      requireDleq: opened.requireDleq
    });
    return this.preparedSpend("refund", opened, preview, input.expected);
  }

  async completeRefund(
    artifact: PreparedTradeOperation,
    refundPrivateKey: string | string[],
    expected: ExpectedHtlcLock
  ): Promise<CompletedHtlcSpend> {
    const preview = await assertArtifact(this.dependencies, artifact, "refund", expected);
    const wallet = await this.dependencies.wallet(artifact.mintUrl, artifact.unit);
    const recovered = await this.dependencies.recover(wallet, preview);
    const proofs = recovered?.keep ?? await completeHtlcRefund(wallet, preview, refundPrivateKey);
    return this.completedSpend(artifact, proofs);
  }

  /** @internal Never expose this return value through the browser agent API. */
  async observeSpentInternal(
    token: string,
    expected: ExpectedHtlcLock,
    expectedCommitment: string
  ): Promise<
    | { status: "UNSPENT"; proofCount: number }
    | { status: "SPENT"; proofCount: number; preimage: string }
  > {
    assertTrade(
      (await this.dependencies.commitment(token)) === expectedCommitment,
      "token-commitment"
    );
    const opened = await this.openToken(token);
    const live = await this.dependencies.snapshot(opened.wallet, opened.proofs);
    this.validateStaticLock(opened, live, expected);
    if (live.states.every((state) => state.state === CheckStateEnum.UNSPENT)) {
      return { status: "UNSPENT", proofCount: opened.proofs.length };
    }
    return {
      status: "SPENT",
      proofCount: opened.proofs.length,
      preimage: extractSpentPreimage(opened.proofs, live.states, expected.hash)
    };
  }

  private async preparedSpend(
    kind: "claim" | "refund",
    opened: OpenedLock,
    preview: SwapPreview,
    expected: ExpectedHtlcLock
  ): Promise<PreparedTradeOperation> {
    const spentSecrets = preview.inputs.map((proof) => proof.secret);
    assertTrade(spentSecrets.length > 0, "prepared-inputs");
    const artifact = {
      version: 1,
      kind,
      mintUrl: opened.summary.mintUrl,
      unit: opened.summary.unit,
      preview: serializeSwapPreview(preview),
      spentSecrets,
      expected,
      operationCommitment: ""
    } satisfies PreparedTradeOperation;
    artifact.operationCommitment = await operationCommitment(this.dependencies, artifact);
    return artifact;
  }

  private completedSpend(
    artifact: PreparedTradeOperation,
    proofs: Proof[]
  ): CompletedHtlcSpend {
    assertTrade(proofs.length > 0, "empty-output");
    const pocket = toPocket(artifact.mintUrl, artifact.unit, proofs);
    return {
      pocket,
      summary: {
        mintUrl: pocket.mintUrl,
        unit: pocket.unit,
        amount: sumProofs(proofs).toString(),
        proofCount: proofs.length
      }
    };
  }

  private assertOutgoingOutputs(
    wallet: Wallet,
    preview: SwapPreview,
    expected: ExpectedHtlcLock
  ): void {
    const outputs = preview.sendOutputs ?? [];
    assertTrade(outputs.length > 0, "artifact-lock-outputs");
    assertTrade(
      outputs.reduce((sum, output) => sum + output.blindedMessage.amount.toBigInt(), 0n) -
        wallet.getFeesForKeyset(outputs.length, preview.keysetId).toBigInt() ===
          Amount.from(expected.amount).toBigInt(),
      "artifact-lock-amount"
    );
    for (const output of outputs) {
      assertTrade(output.blindedMessage.id === preview.keysetId, "artifact-lock-keyset");
      let secret;
      try {
        secret = parseHTLCSecret(new TextDecoder().decode(output.secret));
      } catch {
        throw new CashuTradeError("artifact-lock-secret");
      }
      const canonicalKey = (key: string) => key.toLowerCase().replace(/^(02|03)/, "");
      assertTrade(getDataField(secret).toLowerCase() === expected.hash.toLowerCase(), "artifact-hash");
      assertTrade(
        (getTag(secret, "pubkeys") ?? []).length === 1 &&
          canonicalKey(getTag(secret, "pubkeys")![0]!) === canonicalKey(expected.receiverPubkey),
        "artifact-receiver"
      );
      assertTrade(
        (getTag(secret, "refund") ?? []).length === 1 &&
          canonicalKey(getTag(secret, "refund")![0]!) === canonicalKey(expected.refundPubkey),
        "artifact-refund"
      );
      assertTrade(getTagInt(secret, "locktime") === expected.locktime, "artifact-locktime");
      assertTrade(getP2PKSigFlag(secret) === "SIG_INPUTS", "artifact-sigflag");
    }
  }

  private validateStaticLock(
    opened: { metadata: TokenSummary; proofs: Proof[] },
    live: TradeMintSnapshot,
    expected: ExpectedHtlcLock
  ): void {
    const staticStates: ProofState[] = live.states.map((state) => ({
      Y: state.Y,
      state: CheckStateEnum.UNSPENT,
      witness: null
    }));
    validateHtlcLock({
      envelope: {
        mintUrl: opened.metadata.mintUrl,
        unit: opened.metadata.unit,
        binding: { ...expected.binding },
        proofs: opened.proofs
      },
      expected,
      capabilities: live.capabilities,
      keyset: live.keyset,
      states: staticStates
    });
  }

  private async openValidated(token: string, expected: ExpectedHtlcLock): Promise<OpenedLock> {
    const opened = await this.openToken(token);
    const live = await this.dependencies.snapshot(opened.wallet, opened.proofs);
    const validated = validateHtlcLock({
      envelope: {
        mintUrl: opened.metadata.mintUrl,
        unit: opened.metadata.unit,
        binding: { ...expected.binding },
        proofs: opened.proofs
      },
      expected,
      capabilities: live.capabilities,
      keyset: live.keyset,
      states: live.states
    });
    return {
      wallet: opened.wallet,
      proofs: opened.proofs,
      requireDleq: live.capabilities.nut12,
      summary: {
        mintUrl: normalizeMintUrl(opened.metadata.mintUrl),
        unit: opened.metadata.unit.trim().toLowerCase(),
        ...validated,
        commitment: await this.dependencies.commitment(token)
      }
    };
  }

  private async openToken(token: string): Promise<{
    metadata: TokenSummary;
    wallet: Wallet;
    proofs: Proof[];
  }> {
    assertTrade(token.trim().length > 0, "token");
    let metadata: TokenSummary;
    try {
      metadata = this.dependencies.inspectToken(token);
    } catch {
      throw new CashuTradeError("token-metadata");
    }
    const mintUrl = normalizeMintUrl(metadata.mintUrl);
    const unit = metadata.unit.trim().toLowerCase();
    assertTrade(unit.length > 0, "unit");
    const wallet = await this.dependencies.wallet(mintUrl, unit);
    let proofs: Proof[];
    try {
      const decoded = wallet.decodeToken(token);
      assertTrade(
        normalizeMintUrl(decoded.mint) === mintUrl &&
          (decoded.unit ?? "sat").trim().toLowerCase() === unit,
        "token-metadata"
      );
      proofs = decoded.proofs;
    } catch (error) {
      if (error instanceof CashuTradeError) throw error;
      throw new CashuTradeError("token-decode");
    }
    assertTrade(proofs.length > 0, "empty-token");
    assertTrade(sumProofs(proofs).toString() === Amount.from(metadata.amount).toString(), "token-amount");
    return { metadata: { ...metadata, mintUrl, unit }, wallet, proofs };
  }
}
