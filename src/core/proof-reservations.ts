import {
  normalizeMintUrl,
  type WalletPocket,
  type WalletState
} from "./wallet.js";

export interface ProofReservation {
  proofSecret: string;
  sessionId: string;
  mintUrl: string;
  unit: string;
  reservedAt: number;
}

export interface ProofReservationState {
  version: 1;
  revision: number;
  reservations: ProofReservation[];
}

export interface ReserveProofsInput {
  sessionId: string;
  mintUrl: string;
  unit: string;
  proofSecrets: string[];
  reservedAt: number;
}

export interface ReleaseProofReservationsInput {
  sessionId: string;
  proofSecrets: string[];
}

export interface ProofSelection {
  mintUrl: string;
  unit: string;
  proofSecrets: string[];
}

const SESSION_ID = /^[0-9a-f]{64}$/;

export function createEmptyProofReservations(): ProofReservationState {
  return { version: 1, revision: 0, reservations: [] };
}

function sessionId(value: string): string {
  if (!SESSION_ID.test(value)) throw new Error("Proof reservation session ID is invalid");
  return value;
}

function unit(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,15}$/.test(normalized)) {
    throw new Error("Proof reservation unit is invalid");
  }
  return normalized;
}

function proofSecrets(values: string[]): string[] {
  if (values.length === 0) throw new Error("At least one proof secret is required");
  const unique = new Set<string>();
  for (const value of values) {
    if (!value || unique.has(value)) {
      throw new Error("Proof reservation secrets must be non-empty and unique");
    }
    unique.add(value);
  }
  return [...unique].sort();
}

function safeTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Proof reservation timestamp is invalid");
  }
  return value;
}

function exactReservation(
  reservation: ProofReservation,
  expected: Omit<ProofReservation, "proofSecret">
): boolean {
  return (
    reservation.sessionId === expected.sessionId &&
    reservation.mintUrl === expected.mintUrl &&
    reservation.unit === expected.unit &&
    reservation.reservedAt === expected.reservedAt
  );
}

export function reserveProofs(
  state: ProofReservationState,
  input: ReserveProofsInput
): ProofReservationState {
  const owner = sessionId(input.sessionId);
  const mintUrl = normalizeMintUrl(input.mintUrl);
  const normalizedUnit = unit(input.unit);
  const reservedAt = safeTimestamp(input.reservedAt);
  const secrets = proofSecrets(input.proofSecrets);
  const bySecret = new Map(state.reservations.map((item) => [item.proofSecret, item]));
  const present = secrets
    .map((secret) => bySecret.get(secret))
    .filter((item): item is ProofReservation => item !== undefined);

  for (const reservation of present) {
    if (reservation.sessionId !== owner) {
      throw new Error("Proof is already reserved by another session");
    }
  }
  if (present.length > 0 && present.length < secrets.length) {
    throw new Error("Proof reservation is a partial retry");
  }
  const expected = { sessionId: owner, mintUrl, unit: normalizedUnit, reservedAt };
  if (present.length === secrets.length) {
    if (!present.every((item) => exactReservation(item, expected))) {
      throw new Error("Proof reservation retry conflicts with durable state");
    }
    return state;
  }

  const additions = secrets.map<ProofReservation>((proofSecret) => ({
    proofSecret,
    ...expected
  }));
  return {
    version: 1,
    revision: state.revision + 1,
    reservations: [...state.reservations, ...additions]
      .sort((left, right) => left.proofSecret.localeCompare(right.proofSecret))
  };
}

export function releaseProofReservations(
  state: ProofReservationState,
  input: ReleaseProofReservationsInput
): ProofReservationState {
  const owner = sessionId(input.sessionId);
  const secrets = proofSecrets(input.proofSecrets);
  const bySecret = new Map(state.reservations.map((item) => [item.proofSecret, item]));
  const present = secrets
    .map((secret) => bySecret.get(secret))
    .filter((item): item is ProofReservation => item !== undefined);

  if (present.length === 0) return state;
  if (present.length < secrets.length) {
    throw new Error("Proof reservation release is a partial retry");
  }
  if (present.some((item) => item.sessionId !== owner)) {
    throw new Error("Cannot release a proof reserved by another session");
  }
  const released = new Set(secrets);
  return {
    version: 1,
    revision: state.revision + 1,
    reservations: state.reservations.filter((item) => !released.has(item.proofSecret))
  };
}

export function assertProofSelectionUnreserved(
  wallet: WalletState,
  reservations: ProofReservationState,
  selection: ProofSelection
): void {
  const mintUrl = normalizeMintUrl(selection.mintUrl);
  const normalizedUnit = unit(selection.unit);
  const secrets = proofSecrets(selection.proofSecrets);
  const pocket = wallet.pockets.find(
    (item) => item.mintUrl === mintUrl && item.unit === normalizedUnit
  );
  if (!pocket) throw new Error("Selected proof pocket is not in the wallet");
  const walletSecrets = new Set(pocket.proofs.map((proof) => proof.secret));
  const reserved = new Set(reservations.reservations.map((item) => item.proofSecret));
  for (const secret of secrets) {
    if (!walletSecrets.has(secret)) throw new Error("Selected proof is not in the wallet pocket");
    if (reserved.has(secret)) throw new Error("Selected proof is already reserved");
  }
}

export function unreservedPocket(
  wallet: WalletState,
  reservations: ProofReservationState,
  mint: string,
  selectedUnit: string
): WalletPocket {
  const mintUrl = normalizeMintUrl(mint);
  const normalizedUnit = unit(selectedUnit);
  const pocket = wallet.pockets.find(
    (item) => item.mintUrl === mintUrl && item.unit === normalizedUnit
  );
  if (!pocket) throw new Error("Wallet pocket is not available");
  const reserved = new Set(reservations.reservations.map((item) => item.proofSecret));
  const proofs = pocket.proofs
    .filter((proof) => !reserved.has(proof.secret))
    .map((proof) => structuredClone(proof));
  if (proofs.length === 0) throw new Error("Wallet pocket has no unreserved proofs");
  return { mintUrl, unit: normalizedUnit, proofs };
}
