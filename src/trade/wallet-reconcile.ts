import {
  addProofs,
  normalizeMintUrl,
  replaceProofs,
  type WalletPocket,
  type WalletState
} from "../core/wallet.js";

export interface PreparedProofReplacement extends WalletPocket {
  spentSecrets: string[];
}

function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error("Proof data cannot contain undefined values");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function sameProof(left: WalletPocket["proofs"][number], right: WalletPocket["proofs"][number]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Adds the exact outputs from a completed claim/refund. An exact retry is a
 * no-op; partial presence, changed proof data, and cross-pocket collisions are
 * crash/corruption ambiguity and fail closed.
 */
export function reconcileExactProofOutputs(
  state: WalletState,
  output: WalletPocket
): WalletState {
  const mintUrl = normalizeMintUrl(output.mintUrl);
  const unit = output.unit.trim().toLowerCase();
  if (!unit) throw new Error("Cashu output unit is required");
  if (output.proofs.length === 0) throw new Error("Exact proof outputs cannot be empty");
  // Reuse the wallet domain's proof validation without mutating the live state.
  addProofs({ version: 1, revision: 0, pockets: [] }, {
    mintUrl,
    unit,
    proofs: output.proofs
  });
  const expectedSecrets = new Set<string>();
  for (const proof of output.proofs) {
    if (!proof.secret || expectedSecrets.has(proof.secret)) {
      throw new Error("Exact proof output secrets must be unique");
    }
    expectedSecrets.add(proof.secret);
  }

  const durable = new Map<string, {
    proof: WalletPocket["proofs"][number];
    mintUrl: string;
    unit: string;
  }>();
  for (const pocket of state.pockets) {
    for (const proof of pocket.proofs) {
      if (durable.has(proof.secret)) {
        throw new Error("Wallet has duplicate proof secrets");
      }
      durable.set(proof.secret, {
        proof,
        mintUrl: pocket.mintUrl,
        unit: pocket.unit
      });
    }
  }

  const present = output.proofs
    .map((proof) => durable.get(proof.secret))
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  if (present.length > 0 && present.length < output.proofs.length) {
    throw new Error("Exact proof output reconciliation is partial");
  }
  if (present.length === output.proofs.length) {
    output.proofs.forEach((expected) => {
      const current = durable.get(expected.secret);
      if (!current) throw new Error("Exact proof output reconciliation is partial");
      if (current.mintUrl !== mintUrl || current.unit !== unit) {
        throw new Error("Exact proof output exists in a different pocket");
      }
      if (!sameProof(current.proof, expected)) {
        throw new Error("Exact proof output has conflicting durable data");
      }
    });
    return state;
  }
  return addProofs(state, { mintUrl, unit, proofs: output.proofs });
}

/**
 * Reconciles the durable result of a Cashu operation with the local wallet.
 * A retry is accepted only when every input is gone and every exact output is
 * already present; mixed states are crash/corruption ambiguity and fail closed.
 */
export function reconcileProofReplacement(
  state: WalletState,
  replacement: PreparedProofReplacement
): WalletState {
  const mintUrl = normalizeMintUrl(replacement.mintUrl);
  const unit = replacement.unit.trim().toLowerCase();
  const pocket = state.pockets.find(
    (candidate) => candidate.mintUrl === mintUrl && candidate.unit === unit
  );
  const proofs = pocket?.proofs ?? [];
  const bySecret = new Map(proofs.map((proof) => [proof.secret, proof]));
  const spentPresent = replacement.spentSecrets.filter((secret) => bySecret.has(secret)).length;
  const outputsPresent = replacement.proofs.filter((proof) => bySecret.has(proof.secret)).length;

  if (spentPresent !== 0 && spentPresent !== replacement.spentSecrets.length) {
    throw new Error("Wallet proof reconciliation is ambiguous: only some prepared inputs remain");
  }
  if (outputsPresent !== 0 && outputsPresent !== replacement.proofs.length) {
    throw new Error("Wallet proof reconciliation is ambiguous: only some prepared outputs exist");
  }

  if (spentPresent === replacement.spentSecrets.length) {
    if (outputsPresent !== 0) {
      throw new Error("Replacement proof collides with an unrelated wallet proof");
    }
    return replaceProofs(state, { ...replacement, mintUrl, unit });
  }

  if (outputsPresent === replacement.proofs.length) {
    for (const expected of replacement.proofs) {
      const present = bySecret.get(expected.secret);
      if (!present || !sameProof(present, expected)) {
        throw new Error("Wallet proof reconciliation is ambiguous: persisted output differs");
      }
    }
    return state;
  }

  throw new Error("Wallet proof reconciliation is ambiguous: inputs and outputs are both absent");
}
