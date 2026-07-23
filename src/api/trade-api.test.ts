import { createHTLCHash, getPubKeyFromPrivKey } from "@cashu/cashu-ts";
import { getPublicKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import type {
  TradeMintPreflight,
  TradeSpendability
} from "../cashu/client.js";
import { createOrderState, type ExactMarket, type OrderRecord } from "../order/model.js";
import type { LoadedOrderBook } from "../order/service.js";
import type { WalletState } from "../core/wallet.js";
import {
  createTradeRumor,
  termsHash,
  unwrapInitialReserveProposal,
  wrapTradeRumor,
  type GranolaTradeMessage,
  type VerifiedInitialReserveProposal
} from "../trade/messages.js";
import {
  createMakerSession,
  createTakerSession,
  type SessionFactoryEntropy,
  type SessionMarketSelection
} from "../trade/session-factory.js";
import { publicTradeView, type PublicTradeView, type TradeSession } from "../trade/session.js";
import {
  TradeApi,
  type TradeApiOptions,
  type TradeSessionFactoryPort,
  type TakerStartIntent
} from "./trade-api.js";

const now = 1_800_000_000;
const baseMint = "https://testnut.cashu.space";
const quoteMint = "https://nofee.testnut.cashu.space";
const baseKeyset = "00deadbeefcafeee";
const quoteKeyset = "00deadbeefcafeff";
const orderId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22".repeat(32);
const reservationId = "33333333-3333-4333-8333-333333333333";
const requestId = "88888888-8888-4888-8888-888888888888";
const makerOrderSecret = Uint8Array.from(
  { length: 32 },
  (_, index) => index === 31 ? 9 : 0
);
const maker = getPublicKey(makerOrderSecret);

const market: ExactMarket = {
  baseUnit: "sat",
  baseMint,
  quoteUnit: "usd",
  quoteMint
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

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
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
  return {
    address: `30078:${maker}:granola:order:v2:${orderId}`,
    eventId: "55".repeat(32),
    headEventId: "44".repeat(32),
    makerPubkey: maker,
    verified: true,
    state,
    ...overrides
  };
}

async function proposal(current = order()): Promise<VerifiedInitialReserveProposal> {
  const takerEntropy = entropy();
  const takerSecret = bytes(takerEntropy.privateKey("nostr"));
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
    order_address: current.address,
    order_head: current.headEventId,
    maker_order_pubkey: maker,
    author_pubkey: getPublicKey(takerSecret),
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
      taker_session_pubkey: getPublicKey(takerSecret),
      taker_cashu_pubkey: cashuPubkey(takerEntropy.privateKey("cashu")),
      taker_refund_pubkey: cashuPubkey(takerEntropy.privateKey("refund")),
      fill_amount: "1000"
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
  return unwrapInitialReserveProposal(wrapped.wrapper, makerOrderSecret, {
    now,
    expectedOrderAddress: current.address,
    expectedOrderHead: current.headEventId,
    expectedTermsHash: message.terms_hash
  });
}

class BookPort {
  current: OrderRecord | null = order();
  readonly loadBook = vi.fn(async (): Promise<LoadedOrderBook> => {
    const asks = this.current === null ? [] : [structuredClone(this.current)];
    return {
      book: {
        market,
        marketId: "market",
        asks,
        bids: [],
        ...(asks[0] ? { topAsk: asks[0] } : {})
      },
      rejected: 0
    };
  });
}

class MintPort {
  readonly inspectTradeMint = vi.fn(async (
    mintUrl: string,
    unit: string
  ): Promise<TradeMintPreflight> => ({
    mintUrl,
    unit,
    keysetId: mintUrl === baseMint ? baseKeyset : quoteKeyset,
    inputFeePpk: 0,
    supportsDleq: true
  }));
}

class SessionRepository {
  readonly values = new Map<string, TradeSession>();
  readonly takerStarts = new Map<string, {
    intent: TakerStartIntent;
    sessionId: string;
  }>();
  readonly save = vi.fn(async (session: TradeSession, expected: number | null) => {
    if (expected !== null || this.values.has(session.sessionId)) {
      throw new Error("Trade session already exists");
    }
    this.values.set(session.sessionId, structuredClone(session));
  });
  readonly createTakerForRequest = vi.fn(async (
    intent: TakerStartIntent,
    session: TradeSession
  ): Promise<TradeSession> => {
    const existing = this.takerStarts.get(intent.requestId);
    if (existing !== undefined) {
      if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) {
        throw new Error("Taker request ID conflicts with another start intent");
      }
      return structuredClone(this.values.get(existing.sessionId)!);
    }
    this.takerStarts.set(intent.requestId, {
      intent: structuredClone(intent),
      sessionId: session.sessionId
    });
    this.values.set(session.sessionId, structuredClone(session));
    return structuredClone(session);
  });
  readonly getTakerForRequest = vi.fn(async (
    intent: TakerStartIntent
  ): Promise<TradeSession | undefined> => {
    const existing = this.takerStarts.get(intent.requestId);
    if (existing === undefined) return undefined;
    if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) {
      throw new Error("Taker request ID conflicts with another start intent");
    }
    return structuredClone(this.values.get(existing.sessionId)!);
  });

  async list(): Promise<TradeSession[]> {
    return [...this.values.values()].map((value) => structuredClone(value));
  }

  async get(id: string): Promise<TradeSession | undefined> {
    const value = this.values.get(id);
    return value === undefined ? undefined : structuredClone(value);
  }
}

function walletWithProofs(
  mintUrl: string,
  unit: string,
  proofs: Array<{ amount: string; id?: string }>
): WalletState {
  return {
    version: 1,
    revision: 1,
    pockets: [{
      mintUrl,
      unit,
      proofs: proofs.map((proof, index) => ({
        amount: proof.amount,
        id: proof.id ?? (unit === "sat" ? baseKeyset : quoteKeyset),
        secret: `${unit}-secret-${index}`,
        C: "02".repeat(33)
      }))
    }]
  };
}

function wallet(mintUrl: string, unit: string, amount: string): WalletState {
  return walletWithProofs(mintUrl, unit, [{ amount }]);
}

class SpendPort {
  fee = "0";
  readonly inspectTradeSpendability = vi.fn(async (
    pocket: WalletState["pockets"][number]
  ): Promise<TradeSpendability> => {
    const face = pocket.proofs
      .reduce((sum, proof) => sum + BigInt(proof.amount), 0n);
    const fee = BigInt(this.fee);
    return {
      mintUrl: pocket.mintUrl,
      unit: pocket.unit,
      faceAmount: face.toString(),
      spendableAmount: (face - fee).toString(),
      inputFee: this.fee,
      proofCount: pocket.proofs.length
    };
  });
}

function factory(): TradeSessionFactoryPort {
  return {
    createTaker: (input) => createTakerSession(input, entropy()),
    createMaker: (input) => createMakerSession(input, entropy(3))
  };
}

function options(overrides: Partial<TradeApiOptions> = {}): {
  api: TradeApi;
  books: BookPort;
  mints: MintPort;
  sessions: SessionRepository;
  spendability: SpendPort;
} {
  const books = new BookPort();
  const mints = new MintPort();
  const sessions = new SessionRepository();
  const spendability = new SpendPort();
  const coordinator = {
    list: vi.fn(async (): Promise<PublicTradeView[]> => []),
    get: vi.fn(async (): Promise<PublicTradeView | undefined> => undefined),
    advance: vi.fn(async (): Promise<PublicTradeView> => {
      throw new Error("not configured");
    })
  };
  const settings: TradeApiOptions = {
    coordinator,
    orders: books,
    cashu: mints,
    wallets: { load: async () => wallet(quoteMint, "usd", "20") },
    spendability,
    sessions,
    market,
    now: () => now,
    sessionFactory: factory(),
    ...overrides
  };
  return {
    api: new TradeApi(settings),
    books,
    mints,
    sessions,
    spendability
  };
}

describe("trade start API", () => {
  it("delegates list/get/advance through redacted coordinator views", async () => {
    const session = await createTakerSession({
      order: order(),
      expectedOrderHead: order().headEventId,
      market: {
        ...market,
        baseKeyset,
        quoteKeyset
      },
      fillBaseAmount: "1000",
      clocks: { localNow: now, baseMintNow: now, quoteMintNow: now }
    }, entropy());
    const view = publicTradeView(session);
    const coordinator = {
      list: vi.fn(async () => [view]),
      get: vi.fn(async () => view),
      advance: vi.fn(async () => view)
    };
    const { api } = options({ coordinator });

    await expect(api.listTrades()).resolves.toEqual([view]);
    await expect(api.getTrade(session.sessionId)).resolves.toEqual(view);
    await expect(api.advanceTrade(session.sessionId)).resolves.toEqual(view);
    expect(JSON.stringify(await api.getTrade(session.sessionId)))
      .not.toContain(session.privateState.nostrPrivateKey);
  });

  it("starts a taker session only after exact two-mint preflight and quote balance", async () => {
    let selectedMarket: SessionMarketSelection | undefined;
    const capturingFactory: TradeSessionFactoryPort = {
      ...factory(),
      createTaker: async (input) => {
        selectedMarket = input.market;
        return createTakerSession(input, entropy());
      }
    };
    const { api, mints, sessions } = options({ sessionFactory: capturingFactory });
    const current = order();

    const view = await api.takeOrder({
      requestId,
      address: current.address,
      expectedHeadId: current.headEventId,
      fillBaseAmount: "1000"
    });

    expect(mints.inspectTradeMint.mock.calls).toEqual([
      [baseMint, "sat"],
      [quoteMint, "usd"]
    ]);
    expect(selectedMarket).toEqual({ ...market, baseKeyset, quoteKeyset });
    expect(sessions.createTakerForRequest).toHaveBeenCalledWith(
      {
        requestId,
        address: current.address,
        expectedHeadId: current.headEventId,
        fillBaseAmount: "1000"
      },
      expect.objectContaining({ revision: 0, role: "taker" })
    );
    expect(view.terms).toMatchObject({
      baseAmount: "1000",
      quoteAmount: "20",
      baseKeyset,
      quoteKeyset
    });
    expect(JSON.stringify(view)).not.toContain("privateState");
  });

  it("rejects missing, stale, unverified, and non-sell orders before preflight", async () => {
    const cases: Array<[string, OrderRecord | null, { address: string; expectedHeadId: string }]> = [
      ["missing", null, { address: order().address, expectedHeadId: order().headEventId }],
      ["stale", order(), { address: order().address, expectedHeadId: "99".repeat(32) }],
      ["unverified", order({ verified: false }), {
        address: order().address,
        expectedHeadId: order().headEventId
      }],
      ["non-sell", order({
        state: { ...order().state, side: "buy" }
      }), { address: order().address, expectedHeadId: order().headEventId }]
    ];
    for (const [, current, request] of cases) {
      const { api, books, mints, sessions } = options();
      books.current = current;
      await expect(api.takeOrder({
        requestId,
        ...request,
        fillBaseAmount: "1000"
      }))
        .rejects.toThrow();
      expect(mints.inspectTradeMint).not.toHaveBeenCalled();
      expect(sessions.save).not.toHaveBeenCalled();
    }
  });

  it("blocks mint capability, response mismatch, and unusable keysets before save", async () => {
    const blockers = [
      () => {
        throw new Error("Trade mint does not support required NUT-11");
      },
      async (mintUrl: string, unit: string): Promise<TradeMintPreflight> => ({
        mintUrl: mintUrl === baseMint ? "https://wrong.example" : mintUrl,
        unit,
        keysetId: baseKeyset,
        inputFeePpk: 0,
        supportsDleq: true
      }),
      async (mintUrl: string, unit: string): Promise<TradeMintPreflight> => ({
        mintUrl,
        unit,
        keysetId: "not-a-keyset",
        inputFeePpk: 0,
        supportsDleq: true
      })
    ];
    for (const blocker of blockers) {
      const mints = new MintPort();
      mints.inspectTradeMint.mockImplementation(blocker);
      const { api, sessions } = options({ cashu: mints });
      await expect(api.takeOrder({
        requestId,
        address: order().address,
        expectedHeadId: order().headEventId,
        fillBaseAmount: "1000"
      })).rejects.toThrow();
      expect(sessions.save).not.toHaveBeenCalled();
    }
  });

  it("runs both preflights but blocks an insufficient exact quote pocket", async () => {
    const { api, mints, sessions } = options({
      wallets: { load: async () => wallet(quoteMint, "usd", "19") }
    });
    await expect(api.takeOrder({
      requestId,
      address: order().address,
      expectedHeadId: order().headEventId,
      fillBaseAmount: "1000"
    })).rejects.toThrow(/quote.*fund/i);
    expect(mints.inspectTradeMint).toHaveBeenCalledTimes(2);
    expect(sessions.save).not.toHaveBeenCalled();
    expect(sessions.createTakerForRequest).not.toHaveBeenCalled();
  });

  it("uses exact mixed-keyset proof selection and nonzero fees for taker funding", async () => {
    const spendable = new SpendPort();
    spendable.fee = "1";
    const enough = options({
      wallets: {
        load: async () => walletWithProofs(quoteMint, "usd", [
          { amount: "10", id: "00aaaaaaaaaaaaaaaa" },
          { amount: "11", id: quoteKeyset }
        ])
      },
      spendability: spendable
    });
    await expect(enough.api.takeOrder({
      requestId,
      address: order().address,
      expectedHeadId: order().headEventId,
      fillBaseAmount: "1000"
    })).resolves.toMatchObject({ role: "taker" });
    expect(spendable.inspectTradeSpendability.mock.calls[0]?.[0].proofs
      .map((proof) => proof.id)).toEqual([
      "00aaaaaaaaaaaaaaaa",
      quoteKeyset
    ]);

    const shortSelector = new SpendPort();
    shortSelector.fee = "1";
    const short = options({
      wallets: {
        load: async () => walletWithProofs(quoteMint, "usd", [
          { amount: "10", id: "00aaaaaaaaaaaaaaaa" },
          { amount: "10", id: quoteKeyset }
        ])
      },
      spendability: shortSelector
    });
    await expect(short.api.takeOrder({
      requestId,
      address: order().address,
      expectedHeadId: order().headEventId,
      fillBaseAmount: "1000"
    })).rejects.toThrow(/quote.*fund/i);
    expect(short.sessions.createTakerForRequest).not.toHaveBeenCalled();
  });

  it("starts a maker session only from a verified inbox proposal after base balance preflight", async () => {
    const verified = await proposal();
    const { api, mints, sessions } = options({
      wallets: { load: async () => wallet(baseMint, "sat", "1000") }
    });

    const view = await api.acceptReserveProposal(verified);

    expect(mints.inspectTradeMint).toHaveBeenCalledTimes(2);
    expect(sessions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        reservationId,
        revision: 0,
        role: "maker"
      }),
      null
    );
    expect(JSON.stringify(view)).not.toContain(verified.wrapper.content);
    expect(JSON.stringify(view)).not.toContain("privateState");
  });

  it("rejects unverified proposals and insufficient maker base balance without save", async () => {
    const unverified = structuredClone(await proposal()) as VerifiedInitialReserveProposal;
    const first = options({
      wallets: { load: async () => wallet(baseMint, "sat", "1000") }
    });
    await expect(first.api.acceptReserveProposal(unverified))
      .rejects.toThrow(/verified initial reserve proposal/i);
    expect(first.mints.inspectTradeMint).not.toHaveBeenCalled();
    expect(first.sessions.save).not.toHaveBeenCalled();

    const second = options({
      wallets: { load: async () => wallet(baseMint, "sat", "999") }
    });
    await expect(second.api.acceptReserveProposal(await proposal()))
      .rejects.toThrow(/base.*fund/i);
    expect(second.mints.inspectTradeMint).toHaveBeenCalledTimes(2);
    expect(second.sessions.save).not.toHaveBeenCalled();
  });

  it("uses exact mixed-keyset proof selection and nonzero fees for maker funding", async () => {
    const spendable = new SpendPort();
    spendable.fee = "1";
    const enough = options({
      wallets: {
        load: async () => walletWithProofs(baseMint, "sat", [
          { amount: "600", id: "00bbbbbbbbbbbbbbbb" },
          { amount: "401", id: baseKeyset }
        ])
      },
      spendability: spendable
    });
    await expect(enough.api.acceptReserveProposal(await proposal()))
      .resolves.toMatchObject({ role: "maker" });

    const shortSelector = new SpendPort();
    shortSelector.fee = "1";
    const short = options({
      wallets: {
        load: async () => walletWithProofs(baseMint, "sat", [
          { amount: "600", id: "00bbbbbbbbbbbbbbbb" },
          { amount: "400", id: baseKeyset }
        ])
      },
      spendability: shortSelector
    });
    await expect(short.api.acceptReserveProposal(await proposal()))
      .rejects.toThrow(/base.*fund/i);
    expect(short.sessions.save).not.toHaveBeenCalled();
  });

  it("converges sequential and raced request retries despite fresh taker session IDs", async () => {
    const current = order();
    const request = {
      requestId,
      address: current.address,
      expectedHeadId: current.headEventId,
      fillBaseAmount: "1000"
    };
    let generated = 0;
    const generatedIds: string[] = [];
    const randomFactory: TradeSessionFactoryPort = {
      ...factory(),
      createTaker: async (input) => {
        generated += 1;
        const id = (generated + 15).toString(16).padStart(2, "0").repeat(32);
        generatedIds.push(id);
        return createTakerSession(input, {
          ...entropy(),
          sessionId: () => id
        });
      }
    };
    const exact = options({ sessionFactory: randomFactory });
    const first = await exact.api.takeOrder(request);
    await expect(exact.api.takeOrder(request)).resolves.toEqual(first);
    expect(generatedIds).toHaveLength(1);

    const racedRequest = {
      ...request,
      requestId: "99999999-9999-4999-8999-999999999999"
    };
    const [left, right] = await Promise.all([
      exact.api.takeOrder(racedRequest),
      exact.api.takeOrder(racedRequest)
    ]);
    expect(left).toEqual(right);

    exact.sessions.takerStarts.get(requestId)!.intent = {
      ...request,
      fillBaseAmount: "500"
    };
    await expect(exact.api.takeOrder(request))
      .rejects.toThrow(/request ID conflicts/i);
  });

  it("resolves a durable request binding before stale order and moved-funding checks", async () => {
    const current = order();
    const request = {
      requestId,
      address: current.address,
      expectedHeadId: current.headEventId,
      fillBaseAmount: "1000"
    };
    let currentWallet = wallet(quoteMint, "usd", "20");
    const fixture = options({
      wallets: { load: async () => currentWallet }
    });
    const first = await fixture.api.takeOrder(request);
    const bookCalls = fixture.books.loadBook.mock.calls.length;
    const mintCalls = fixture.mints.inspectTradeMint.mock.calls.length;
    const spendCalls =
      fixture.spendability.inspectTradeSpendability.mock.calls.length;

    fixture.books.current = order({
      headEventId: "99".repeat(32),
      state: {
        ...current.state,
        status: "reserved",
        reserved_amount: "1000",
        remaining_amount: "0"
      }
    });
    currentWallet = { version: 1, revision: 2, pockets: [] };

    await expect(fixture.api.takeOrder(request)).resolves.toEqual(first);
    expect(fixture.books.loadBook).toHaveBeenCalledTimes(bookCalls);
    expect(fixture.mints.inspectTradeMint).toHaveBeenCalledTimes(mintCalls);
    expect(fixture.spendability.inspectTradeSpendability)
      .toHaveBeenCalledTimes(spendCalls);
  });
});
