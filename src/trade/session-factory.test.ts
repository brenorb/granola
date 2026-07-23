import { createHTLCHash, getPubKeyFromPrivKey } from "@cashu/cashu-ts";
import { getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { createOrderState, type OrderRecord } from "../order/model.js";
import { EncryptedStorageDriver } from "../storage/encrypted-storage.js";
import { TradeSessionRepository } from "../storage/trade-session.js";
import { MemoryStorageDriver } from "../storage/wallet-repository.js";
import {
  createTradeRumor,
  termsHash,
  unwrapInitialReserveProposal,
  wrapTradeRumor,
  type GranolaTradeMessage,
  type SignedNostrEvent,
  type VerifiedInitialReserveProposal
} from "./messages.js";
import {
  createMakerSession,
  createTakerSession,
  type SessionFactoryEntropy,
  type SessionMarketSelection
} from "./session-factory.js";

const now = 1_800_000_000;
const baseMint = "https://testnut.cashu.space";
const quoteMint = "https://nofee.testnut.cashu.space";
const baseKeyset = "00deadbeefcafeee";
const quoteKeyset = "00deadbeefcafeff";
const orderId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22".repeat(32);
const reservationId = "33333333-3333-4333-8333-333333333333";
const secp256k1Order =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const makerOrderSecret = Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 9 : 0);
const maker = getPublicKey(makerOrderSecret);

const market: SessionMarketSelection = {
  baseMint,
  baseUnit: "sat",
  baseKeyset,
  quoteMint,
  quoteUnit: "usd",
  quoteKeyset
};

function hexKey(last: number): string {
  const bytes = new Uint8Array(32);
  bytes[31] = last;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
}

function cashuPubkey(privateKey: string): string {
  return [...getPubKeyFromPrivKey(bytes(privateKey))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function entropy(offset = 0): SessionFactoryEntropy {
  const keys = {
    nostr: hexKey(1 + offset),
    cashu: hexKey(2 + offset),
    refund: hexKey(3 + offset)
  };
  return {
    sessionId: () => sessionId,
    reservationId: () => reservationId,
    privateKey: (purpose) => keys[purpose],
    htlcMaterial: () => createHTLCHash("ab".repeat(32))
  };
}

function record(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const state = createOrderState({
    orderId,
    createdAt: now - 100,
    expiresAt: now + 9 * 86_400,
    side: "sell",
    baseUnit: "sat",
    quoteUnit: "usd",
    offered: { unit: "sat", mint: baseMint },
    requested: { unit: "usd", acceptableMints: [quoteMint] },
    amount: "1000",
    priceCentsPerBtc: "2000000"
  });
  const head = "44".repeat(32);
  return {
    address: `30078:${maker}:granola:order:v2:${orderId}`,
    eventId: "55".repeat(32),
    headEventId: head,
    makerPubkey: maker,
    verified: true,
    state,
    ...overrides
  };
}

const clocks = {
  localNow: now,
  baseMintNow: now + 1,
  quoteMintNow: now - 1
};

async function wrappedProposal(
  order = record(),
  bodyOverrides: Record<string, string> = {}
): Promise<{
  proposal: VerifiedInitialReserveProposal;
  wrapper: SignedNostrEvent;
}> {
  const takerEntropy = entropy();
  const takerSecret = bytes(takerEntropy.privateKey("nostr"));
  const takerNostr = getPublicKey(bytes(takerEntropy.privateKey("nostr")));
  const terms = {
    base_unit: "sat",
    base_mint: baseMint,
    base_keyset: baseKeyset,
    quote_unit: "usd",
    quote_mint: quoteMint,
    quote_keyset: quoteKeyset,
    base_amount: "1000",
    quote_amount: "20",
    price_cents_per_btc: "2000000"
  };
  const message: GranolaTradeMessage = {
    schema: "granola/dm/v2",
    deployment: "cashu-testnet-v1",
    type: "reserve_propose",
    message_id: "66666666-6666-4666-8666-666666666666",
    session_id: sessionId,
    reservation_id: reservationId,
    order_address: order.address,
    order_head: order.headEventId,
    maker_order_pubkey: maker,
    author_pubkey: takerNostr,
    recipient_pubkey: maker,
    sequence: "0",
    previous_message_id: null,
    previous_transcript_hash: null,
    sent_at: now,
    expires_at: now + 300,
    terms_hash: await termsHash(terms),
    terms,
    body: {
      schema: "granola/atomic-swap-body/v1",
      taker_session_pubkey: takerNostr,
      taker_cashu_pubkey: cashuPubkey(takerEntropy.privateKey("cashu")),
      taker_refund_pubkey: cashuPubkey(takerEntropy.privateKey("refund")),
      fill_amount: "1000",
      ...bodyOverrides
    }
  };
  const rumor = await createTradeRumor(message, takerSecret);
  const wrapped = wrapTradeRumor(rumor, takerSecret, {
    ephemeralSecretKey: bytes(hexKey(8)),
    sealCreatedAt: now - 10,
    wrapperCreatedAt: now - 20,
    outerExpiration: message.expires_at + 3_600,
    sealNonce: new Uint8Array(32).fill(9),
    wrapperNonce: new Uint8Array(32).fill(10)
  });
  return {
    proposal: await unwrapInitialReserveProposal(
      wrapped.wrapper,
      makerOrderSecret,
      {
        now,
        expectedOrderAddress: message.order_address,
        expectedOrderHead: message.order_head,
        expectedTermsHash: message.terms_hash
      }
    ),
    wrapper: wrapped.wrapper
  };
}

async function proposal(order = record()): Promise<VerifiedInitialReserveProposal> {
  return (await wrappedProposal(order)).proposal;
}

describe("trade session factory", () => {
  it("creates an encrypted-journal-ready taker session while preserving the offered head", async () => {
    const session = await createTakerSession({
      order: record(),
      expectedOrderHead: "44".repeat(32),
      market,
      fillBaseAmount: "1000",
      clocks
    }, entropy());
    const raw = new MemoryStorageDriver();
    const repository = new TradeSessionRepository(
      new EncryptedStorageDriver(raw, "factory-test")
    );
    await repository.save(session, null);

    expect(await repository.get(session.sessionId)).toEqual(session);
    expect(session).toMatchObject({
      schema: "granola/trade-session/v2",
      revision: 0,
      role: "taker",
      phase: "negotiating",
      offeredOrderHead: "44".repeat(32),
      reserveTransitionId: null,
      terms: { baseAmount: "1000", quoteAmount: "20" },
      privateState: {
        preimage: null,
        htlcHash: null,
        settlementTranscriptHash: null,
        inbox: {
          status: "unregistered",
          quorum: 2,
          event: null,
          discoveryRelays: [],
          inboxRelays: [],
          receipts: [],
          readbacks: [],
          stagedAt: null,
          acknowledgedAt: null,
          registeredAt: null
        },
        pendingIncoming: null,
        transcript: { nextSequence: "0", lastRumorId: null }
      }
    });
    expect(JSON.stringify(await raw.get("factory-test.data.granola.trade-sessions.v2")))
      .not.toContain(session.privateState.nostrPrivateKey);
  });

  it("creates a maker session from the validated proposal with a durable transcript head and material", async () => {
    const opened = await proposal();
    const session = await createMakerSession({
      order: record(),
      proposal: opened,
      market,
      clocks
    }, entropy(3));

    expect(session).toMatchObject({
      sessionId,
      reservationId,
      role: "maker",
      phase: "negotiating",
      offeredOrderHead: "44".repeat(32),
      evidence: {
        commitments: [entropy(3).htlcMaterial().hash],
        reservation: {
          proposalSealId: opened.seal.id,
          takerCommitment: null,
          abortSeal: null
        }
      },
      privateState: {
        preimage: entropy(3).htlcMaterial().preimage,
        htlcHash: entropy(3).htlcMaterial().hash,
        settlementTranscriptHash: null,
        inbox: {
          status: "unregistered",
          quorum: 2,
          event: null,
          discoveryRelays: [],
          inboxRelays: [],
          receipts: [],
          readbacks: [],
          stagedAt: null,
          acknowledgedAt: null,
          registeredAt: null
        },
        pendingIncoming: null,
        transcript: {
          nextSequence: "1",
          lastRumorId: opened.rumor.id,
          lastMessageId: opened.message.message_id,
          lastTranscriptHash: opened.transcriptHash,
          accepted: [{
            sequence: "0",
            messageId: opened.message.message_id,
            rumorId: opened.rumor.id,
            transcriptHash: opened.transcriptHash
          }],
          choreography: { phase: "awaiting_reserve_accept" }
        }
      }
    });
  });

  it("accepts only the opaque result of a cryptographically verified initial unwrap", async () => {
    const { proposal: opened, wrapper } = await wrappedProposal();
    expect(Object.isFrozen(opened)).toBe(true);
    expect(Object.isFrozen(opened.message)).toBe(true);
    expect(Object.isFrozen(opened.rumor.tags)).toBe(true);
    const partial = {
      message: opened.message,
      rumor: opened.rumor,
      transcriptHash: opened.transcriptHash
    } as VerifiedInitialReserveProposal;
    await expect(createMakerSession({
      order: record(),
      proposal: partial,
      market,
      clocks
    }, entropy(3))).rejects.toThrow(/verified initial/i);

    await expect(createMakerSession({
      order: record(),
      proposal: {
        ...opened,
        rumor: { ...opened.rumor, id: "99".repeat(32) }
      } as VerifiedInitialReserveProposal,
      market,
      clocks
    }, entropy(3))).rejects.toThrow(/verified initial/i);

    await expect(createMakerSession({
      order: record(),
      proposal: {
        ...opened,
        transcriptHash: "aa".repeat(32)
      } as VerifiedInitialReserveProposal,
      market,
      clocks
    }, entropy(3))).rejects.toThrow(/verified initial/i);

    await expect(unwrapInitialReserveProposal(
      { ...wrapper, sig: "00".repeat(64) },
      makerOrderSecret,
      {
        now,
        expectedOrderAddress: opened.message.order_address,
        expectedOrderHead: opened.message.order_head,
        expectedTermsHash: opened.message.terms_hash
      }
    )).rejects.toThrow(/signature/i);
  });

  it("prevents post-call mutation while maker-session validation is suspended", async () => {
    const opened = await proposal();
    const creation = createMakerSession({
      order: record(),
      proposal: opened,
      market,
      clocks
    }, entropy(3));

    expect(() => {
      (opened.rumor as { id: string }).id = "99".repeat(32);
    }).toThrow(TypeError);
    expect(() => {
      (opened as { transcriptHash: string }).transcriptHash = "aa".repeat(32);
    }).toThrow(TypeError);
    await expect(creation).resolves.toMatchObject({
      role: "maker",
      privateState: {
        transcript: {
          lastRumorId: opened.rumor.id,
          lastTranscriptHash: opened.transcriptHash
        }
      }
    });
  });

  it.each([
    ["unverified", { verified: false }],
    ["stale", { headEventId: "66".repeat(32) }],
    ["expired", { state: { ...record().state, expires_at: now } }],
    ["reserved", {
      state: {
        ...record().state,
        status: "reserved" as const,
        reserved_amount: "1000",
        reservation: {
          id: reservationId,
          amount: "1000",
          accepted_at: now - 1,
          expires_at: now + 100,
          proposal_event_id: "77".repeat(32),
          taker_commitment: "88".repeat(32)
        }
      }
    }]
  ])("rejects a %s order", async (_label, override) => {
    await expect(createTakerSession({
      order: record(override as Partial<OrderRecord>),
      expectedOrderHead: "44".repeat(32),
      market,
      fillBaseAmount: "1000",
      clocks
    }, entropy())).rejects.toThrow();
  });

  it("rejects bids, wrong mints, unsafe clocks, and non-canonical keysets", async () => {
    await expect(createTakerSession({
      order: record({ state: { ...record().state, side: "buy" } }),
      expectedOrderHead: "44".repeat(32),
      market,
      fillBaseAmount: "1000",
      clocks
    }, entropy())).rejects.toThrow(/sell/i);
    await expect(createTakerSession({
      order: record(),
      expectedOrderHead: "44".repeat(32),
      market: { ...market, quoteMint: "https://other.example" },
      fillBaseAmount: "1000",
      clocks
    }, entropy())).rejects.toThrow(/quote mint/i);
    await expect(createTakerSession({
      order: record(),
      expectedOrderHead: "44".repeat(32),
      market,
      fillBaseAmount: "1000",
      clocks: { ...clocks, baseMintNow: now + 31 }
    }, entropy())).rejects.toThrow(/clock/i);
    await expect(createTakerSession({
      order: record(),
      expectedOrderHead: "44".repeat(32),
      market: { ...market, baseKeyset: "UPPERCASE" },
      fillBaseAmount: "1000",
      clocks
    }, entropy())).rejects.toThrow(/keyset/i);
    await expect(createTakerSession({
      order: record({
        state: {
          ...record().state,
          offered: { unit: "sat", mint: `${baseMint}/` }
        }
      }),
      expectedOrderHead: "44".repeat(32),
      market,
      fillBaseAmount: "1000",
      clocks
    }, entropy())).rejects.toThrow(/canonical/i);
  });

  it("rejects invalid all-or-none fills and partial-fill dust", async () => {
    await expect(createTakerSession({
      order: record(),
      expectedOrderHead: "44".repeat(32),
      market,
      fillBaseAmount: "500",
      clocks
    }, entropy())).rejects.toThrow(/all-or-none/i);

    const partial = record({
      state: {
        ...record().state,
        execution: "partial",
        minimum_fill_amount: "300"
      }
    });
    await expect(createTakerSession({
      order: partial,
      expectedOrderHead: "44".repeat(32),
      market,
      fillBaseAmount: "800",
      clocks
    }, entropy())).rejects.toThrow(/dust/i);
  });

  it("rejects reused local keys and maker keys that collide with the taker", async () => {
    const reused = entropy();
    const same: SessionFactoryEntropy = {
      ...reused,
      privateKey: () => hexKey(1)
    };
    await expect(createTakerSession({
      order: record(),
      expectedOrderHead: "44".repeat(32),
      market,
      fillBaseAmount: "1000",
      clocks
    }, same)).rejects.toThrow(/independent/i);

    await expect(createMakerSession({
      order: record(),
      proposal: await proposal(),
      market,
      clocks
    }, entropy())).rejects.toThrow(/counterparty/i);

    const negated: SessionFactoryEntropy = {
      ...entropy(),
      privateKey: (purpose) => purpose === "nostr"
        ? hexKey(1)
        : purpose === "cashu"
          ? (secp256k1Order - 1n).toString(16).padStart(64, "0")
          : hexKey(3)
    };
    await expect(createTakerSession({
      order: record(),
      expectedOrderHead: "44".repeat(32),
      market,
      fillBaseAmount: "1000",
      clocks
    }, negated)).rejects.toThrow(/independent/i);
  });

  it.each([
    ["nostr", "nostr"],
    ["cashu", "cashu"],
    ["refund", "refund"]
  ] as const)("rejects a taker %s key equivalent to the maker order authority", async (
    _label,
    purpose
  ) => {
    const separated = entropy();
    const colliding: SessionFactoryEntropy = {
      ...separated,
      privateKey: (requested) =>
        requested === purpose ? hexKey(9) : separated.privateKey(requested)
    };
    await expect(createTakerSession({
      order: record(),
      expectedOrderHead: "44".repeat(32),
      market,
      fillBaseAmount: "1000",
      clocks
    }, colliding)).rejects.toThrow(/order authority/i);
  });

  it("rejects a maker session Nostr key equivalent to its persistent order authority", async () => {
    const separated = entropy(3);
    const colliding: SessionFactoryEntropy = {
      ...separated,
      privateKey: (purpose) =>
        purpose === "nostr" ? hexKey(9) : separated.privateKey(purpose)
    };
    await expect(createMakerSession({
      order: record(),
      proposal: await proposal(),
      market,
      clocks
    }, colliding)).rejects.toThrow(/order authority/i);
  });

  it("rejects authenticated proposals with cross-role or parity-equivalent taker keys", async () => {
    const takerX = getPublicKey(bytes(hexKey(1)));
    const oppositeParity = `03${takerX}`;
    const duplicate = (await wrappedProposal(record(), {
      taker_cashu_pubkey: oppositeParity
    })).proposal;
    await expect(createMakerSession({
      order: record(),
      proposal: duplicate,
      market,
      clocks
    }, entropy(3))).rejects.toThrow(/taker keys.*independent/i);

    const authorityCollision = (await wrappedProposal(record(), {
      taker_refund_pubkey: cashuPubkey(hexKey(9))
    })).proposal;
    await expect(createMakerSession({
      order: record(),
      proposal: authorityCollision,
      market,
      clocks
    }, entropy(3))).rejects.toThrow(/order authority/i);
  });

  it("rejects a proposal that expired after it was opened", async () => {
    const opened = await proposal();
    const expired = {
      ...opened,
      message: { ...opened.message, expires_at: now }
    } as VerifiedInitialReserveProposal;
    await expect(createMakerSession({
      order: record(),
      proposal: expired,
      market,
      clocks
    }, entropy(3))).rejects.toThrow(/verified initial/i);
  });
});
