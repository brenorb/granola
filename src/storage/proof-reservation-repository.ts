import {
  createEmptyProofReservations,
  releaseProofReservations,
  reserveProofs,
  type ProofReservationState,
  type ReleaseProofReservationsInput,
  type ReserveProofsInput
} from "../core/proof-reservations.js";
import { normalizeMintUrl } from "../core/wallet.js";
import type { StorageDriver } from "./wallet-repository.js";

const PROOF_RESERVATIONS_KEY = "granola.proof-reservations.v1";
const SESSION_ID = /^[0-9a-f]{64}$/;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertState(value: unknown): asserts value is ProofReservationState {
  if (!value || typeof value !== "object") {
    throw new Error("Proof reservation storage is corrupt");
  }
  const state = value as Partial<ProofReservationState>;
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision ?? -1) < 0 ||
    !Array.isArray(state.reservations)
  ) {
    throw new Error("Proof reservation storage is corrupt");
  }
  const seen = new Set<string>();
  for (const item of state.reservations) {
    if (
      !item ||
      typeof item.proofSecret !== "string" ||
      !item.proofSecret ||
      seen.has(item.proofSecret) ||
      typeof item.sessionId !== "string" ||
      !SESSION_ID.test(item.sessionId) ||
      typeof item.mintUrl !== "string" ||
      typeof item.unit !== "string" ||
      !/^[a-z][a-z0-9_-]{0,15}$/.test(item.unit) ||
      !Number.isSafeInteger(item.reservedAt) ||
      item.reservedAt < 0
    ) {
      throw new Error("Proof reservation storage is corrupt");
    }
    let normalized: string;
    try {
      normalized = normalizeMintUrl(item.mintUrl);
    } catch {
      throw new Error("Proof reservation storage is corrupt");
    }
    if (normalized !== item.mintUrl) {
      throw new Error("Proof reservation storage is corrupt");
    }
    seen.add(item.proofSecret);
  }
}

/**
 * Call mutations while holding the profile's `withWalletLock`. The expected
 * revision rejects stale in-memory decisions within that exclusive boundary.
 */
export class ProofReservationRepository {
  constructor(private readonly driver: StorageDriver) {}

  async load(): Promise<ProofReservationState> {
    const stored = await this.driver.get(PROOF_RESERVATIONS_KEY);
    if (stored === undefined || stored === null) return createEmptyProofReservations();
    assertState(stored);
    return clone(stored);
  }

  async reserve(
    expectedRevision: number,
    input: ReserveProofsInput
  ): Promise<ProofReservationState> {
    return this.update(expectedRevision, (state) => reserveProofs(state, input));
  }

  async release(
    expectedRevision: number,
    input: ReleaseProofReservationsInput
  ): Promise<ProofReservationState> {
    return this.update(expectedRevision, (state) => releaseProofReservations(state, input));
  }

  private async update(
    expectedRevision: number,
    mutate: (state: ProofReservationState) => ProofReservationState
  ): Promise<ProofReservationState> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("Expected proof reservation revision is invalid");
    }
    const current = await this.load();
    if (current.revision !== expectedRevision) {
      throw new Error("Proof reservation revision changed");
    }
    const next = mutate(current);
    if (next === current) return current;
    assertState(next);
    await this.driver.set(PROOF_RESERVATIONS_KEY, clone(next));
    return clone(next);
  }
}
