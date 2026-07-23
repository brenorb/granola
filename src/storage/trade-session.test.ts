import { describe, expect, it } from "vitest";

import { publicTradeView, type TradeSession } from "../trade/session.js";
import { MemoryStorageDriver } from "./wallet-repository.js";
import { TradeSessionRepository } from "./trade-session.js";

const session: TradeSession = {
  schema: "granola/trade-session/v1",
  sessionId: "11".repeat(32),
  reservationId: "11111111-1111-4111-8111-111111111111",
  role: "maker",
  phase: "base_locked",
  orderAddress: `30078:${"22".repeat(32)}:granola:order:v1:22222222-2222-4222-8222-222222222222`,
  orderHead: "33".repeat(32),
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_010,
  terms: {
    baseMint: "https://testnut.cashu.space",
    baseUnit: "sat",
    baseKeyset: "base-keyset",
    baseAmount: "20",
    quoteMint: "https://nofee.testnut.cashu.space",
    quoteUnit: "usd",
    quoteKeyset: "quote-keyset",
    quoteAmount: "1",
    price: { numerator: "1", denominator: "20" }
  },
  plan: {
    anchor: 1_700_000_000,
    shortLocktime: 1_700_000_600,
    makerClaimCutoff: 1_700_000_480,
    longLocktime: 1_700_001_200,
    takerClaimCutoff: 1_700_001_080,
    reservationExpiresAt: 1_700_001_800,
    refundGuardSeconds: 60
  },
  evidence: {
    makerPubkey: "22".repeat(32),
    commitments: ["44".repeat(32)],
    mintStates: ["base:UNSPENT"]
  },
  privateState: {
    nostrPrivateKey: "nostr-secret",
    cashuPrivateKey: "cashu-secret",
    refundPrivateKey: "refund-secret",
    preimage: "preimage-secret",
    baseToken: "cashu-private-token",
    quoteToken: null,
    exactOutbox: ["encrypted-private-wrapper"]
  }
};

describe("trade session repository", () => {
  it("durably round-trips recovery material without returning shared references", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());

    await repository.save(session);
    const restored = await repository.get(session.sessionId);

    expect(restored).toEqual(session);
    expect(restored).not.toBe(session);
    expect(await repository.list()).toEqual([session]);
  });

  it("rejects rollback of an existing session update time", async () => {
    const repository = new TradeSessionRepository(new MemoryStorageDriver());
    await repository.save(session);

    await expect(repository.save({ ...session, updatedAt: session.updatedAt - 1 }))
      .rejects.toThrow("older trade session");
  });

  it("produces a secret-free view for humans and agents", () => {
    const view = publicTradeView(session);
    const serialized = JSON.stringify(view);

    expect(view).toMatchObject({
      sessionId: session.sessionId,
      reservationId: session.reservationId,
      role: "maker",
      phase: "base_locked",
      terms: session.terms,
      evidence: session.evidence
    });
    for (const forbidden of [
      "privateState",
      "nostr-secret",
      "cashu-secret",
      "refund-secret",
      "preimage-secret",
      "cashu-private-token",
      "encrypted-private-wrapper"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("fails closed on corrupt or unknown stored sessions", async () => {
    const driver = new MemoryStorageDriver();
    await driver.set("granola.trade-sessions.v1", [{ ...session, schema: "granola/trade-session/v2" }]);

    await expect(new TradeSessionRepository(driver).list()).rejects.toThrow(
      "Unsupported trade session schema"
    );
  });
});
