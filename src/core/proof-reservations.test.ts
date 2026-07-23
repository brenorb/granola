import { describe, expect, it } from "vitest";

import { addProofs, createEmptyWallet, type StoredProof } from "./wallet.js";
import {
  assertProofSelectionUnreserved,
  createEmptyProofReservations,
  releaseProofReservations,
  reserveProofs,
  unreservedPocket
} from "./proof-reservations.js";

const sessionA = "11".repeat(32);
const sessionB = "22".repeat(32);

function proof(secret: string, amount = "1"): StoredProof {
  return { amount, id: "synthetic-keyset", secret, C: `synthetic-C-${secret}` };
}

function wallet() {
  return addProofs(createEmptyWallet(), {
    mintUrl: "https://mint.example",
    unit: "sat",
    proofs: [proof("synthetic-proof-a", "8"), proof("synthetic-proof-b", "4")]
  });
}

describe("proof reservations", () => {
  it("exclusively reserves proof secrets for one session and replays exactly", () => {
    const empty = createEmptyProofReservations();
    const reserved = reserveProofs(empty, {
      sessionId: sessionA,
      mintUrl: "https://mint.example/",
      unit: "SAT",
      proofSecrets: ["synthetic-proof-a"],
      reservedAt: 1_800_000_000
    });
    const replayed = reserveProofs(reserved, {
      sessionId: sessionA,
      mintUrl: "https://mint.example",
      unit: "sat",
      proofSecrets: ["synthetic-proof-a"],
      reservedAt: 1_800_000_000
    });

    expect(reserved).toEqual({
      version: 1,
      revision: 1,
      reservations: [{
        proofSecret: "synthetic-proof-a",
        sessionId: sessionA,
        mintUrl: "https://mint.example",
        unit: "sat",
        reservedAt: 1_800_000_000
      }]
    });
    expect(replayed).toBe(reserved);
    expect(() => reserveProofs(reserved, {
      sessionId: sessionB,
      mintUrl: "https://mint.example",
      unit: "sat",
      proofSecrets: ["synthetic-proof-a"],
      reservedAt: 1_800_000_001
    })).toThrow(/already reserved/i);
  });

  it("fails closed on partial reserve or release replays", () => {
    const once = reserveProofs(createEmptyProofReservations(), {
      sessionId: sessionA,
      mintUrl: "https://mint.example",
      unit: "sat",
      proofSecrets: ["synthetic-proof-a"],
      reservedAt: 1_800_000_000
    });
    expect(() => reserveProofs(once, {
      sessionId: sessionA,
      mintUrl: "https://mint.example",
      unit: "sat",
      proofSecrets: ["synthetic-proof-a", "synthetic-proof-b"],
      reservedAt: 1_800_000_000
    })).toThrow(/partial/i);
    expect(() => releaseProofReservations(once, {
      sessionId: sessionA,
      proofSecrets: ["synthetic-proof-a", "synthetic-proof-b"]
    })).toThrow(/partial/i);
  });

  it("releases an exact reservation idempotently and rejects another owner", () => {
    const reserved = reserveProofs(createEmptyProofReservations(), {
      sessionId: sessionA,
      mintUrl: "https://mint.example",
      unit: "sat",
      proofSecrets: ["synthetic-proof-a"],
      reservedAt: 1_800_000_000
    });
    expect(() => releaseProofReservations(reserved, {
      sessionId: sessionB,
      proofSecrets: ["synthetic-proof-a"]
    })).toThrow(/another session/i);

    const released = releaseProofReservations(reserved, {
      sessionId: sessionA,
      proofSecrets: ["synthetic-proof-a"]
    });
    const replayed = releaseProofReservations(released, {
      sessionId: sessionA,
      proofSecrets: ["synthetic-proof-a"]
    });
    expect(released.revision).toBe(2);
    expect(released.reservations).toEqual([]);
    expect(replayed).toBe(released);
  });

  it("rejects a selected reserved proof and produces a pocket that excludes reservations", () => {
    const reservations = reserveProofs(createEmptyProofReservations(), {
      sessionId: sessionA,
      mintUrl: "https://mint.example",
      unit: "sat",
      proofSecrets: ["synthetic-proof-a"],
      reservedAt: 1_800_000_000
    });
    expect(() => assertProofSelectionUnreserved(wallet(), reservations, {
      mintUrl: "https://mint.example",
      unit: "sat",
      proofSecrets: ["synthetic-proof-a"]
    })).toThrow(/reserved/i);
    expect(() => assertProofSelectionUnreserved(wallet(), reservations, {
      mintUrl: "https://mint.example",
      unit: "sat",
      proofSecrets: ["missing"]
    })).toThrow(/not in the wallet/i);

    const available = unreservedPocket(
      wallet(),
      reservations,
      "https://mint.example",
      "sat"
    );
    expect(available.proofs.map((item) => item.secret)).toEqual(["synthetic-proof-b"]);
  });
});
