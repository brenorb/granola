import { describe, expect, it } from "vitest";

import { MemoryStorageDriver } from "./wallet-repository.js";
import { ProofReservationRepository } from "./proof-reservation-repository.js";

const sessionA = "11".repeat(32);
const sessionB = "22".repeat(32);

describe("proof reservation repository", () => {
  it("persists reservations and rejects a stale CAS revision under the wallet lock", async () => {
    const repository = new ProofReservationRepository(new MemoryStorageDriver());
    const firstRead = await repository.load();
    const staleRead = await repository.load();
    const reserved = await repository.reserve(firstRead.revision, {
      sessionId: sessionA,
      mintUrl: "https://mint.example",
      unit: "sat",
      proofSecrets: ["synthetic-proof-a"],
      reservedAt: 1_800_000_000
    });

    expect(reserved.revision).toBe(1);
    await expect(repository.reserve(staleRead.revision, {
      sessionId: sessionB,
      mintUrl: "https://mint.example",
      unit: "sat",
      proofSecrets: ["synthetic-proof-b"],
      reservedAt: 1_800_000_001
    })).rejects.toThrow(/revision changed/i);
    expect((await repository.load()).reservations).toHaveLength(1);
  });

  it("supports exact reserve and release retries without advancing revision", async () => {
    const repository = new ProofReservationRepository(new MemoryStorageDriver());
    const reserved = await repository.reserve(0, {
      sessionId: sessionA,
      mintUrl: "https://mint.example",
      unit: "sat",
      proofSecrets: ["synthetic-proof-a"],
      reservedAt: 1_800_000_000
    });
    const replayed = await repository.reserve(reserved.revision, {
      sessionId: sessionA,
      mintUrl: "https://mint.example",
      unit: "sat",
      proofSecrets: ["synthetic-proof-a"],
      reservedAt: 1_800_000_000
    });
    const released = await repository.release(replayed.revision, {
      sessionId: sessionA,
      proofSecrets: ["synthetic-proof-a"]
    });
    const releaseReplay = await repository.release(released.revision, {
      sessionId: sessionA,
      proofSecrets: ["synthetic-proof-a"]
    });

    expect(replayed.revision).toBe(1);
    expect(released.revision).toBe(2);
    expect(releaseReplay.revision).toBe(2);
  });

  it("fails closed on corrupt durable reservation state", async () => {
    const driver = new MemoryStorageDriver();
    await driver.set("granola.proof-reservations.v1", {
      version: 1,
      revision: 1,
      reservations: [{
        proofSecret: "",
        sessionId: "not-a-session",
        mintUrl: "http://mint.example",
        unit: "",
        reservedAt: -1
      }]
    });
    await expect(new ProofReservationRepository(driver).load())
      .rejects.toThrow(/corrupt/i);
  });
});
