import {
  normalizeMintUrl,
  replaceProofs,
  type WalletPocket,
  type WalletState
} from "../core/wallet.js";

export interface PreparedProofReplacement extends WalletPocket {
  spentSecrets: string[];
}

function sameProof(left: WalletPocket["proofs"][number], right: WalletPocket["proofs"][number]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
