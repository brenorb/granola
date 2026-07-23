import {
  createHTLCHash,
  getPubKeyFromPrivKey,
  verifyHTLCHash
} from "@cashu/cashu-ts";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { normalizeMintUrl } from "../core/wallet.js";
import type { OrderRecord } from "../order/model.js";
import {
  advanceAtomicSwapChoreography,
  initialAtomicSwapChoreography,
  validateAtomicSwapMessage,
  type ReserveProposeBody
} from "./atomic-messages.js";
import {
  assertVerifiedInitialReserveProposal,
  type VerifiedInitialReserveProposal
} from "./messages.js";
import {
  createSettlementPlan,
  settlementAmounts,
  type SettlementPlanInput
} from "./model.js";
import type {
  TradeEvidence,
  TradeSession,
  TradeTerms,
  TradeTranscriptJournal
} from "./session.js";

export interface SessionMarketSelection {
  baseMint: string;
  baseUnit: string;
  baseKeyset: string;
  quoteMint: string;
  quoteUnit: string;
  quoteKeyset: string;
}

export type SessionKeyPurpose = "nostr" | "cashu" | "refund";

export interface SessionFactoryEntropy {
  sessionId(): string;
  reservationId(): string;
  privateKey(purpose: SessionKeyPurpose): string;
  htlcMaterial(): { preimage: string; hash: string };
}

export interface TakerSessionInput {
  order: OrderRecord;
  expectedOrderProjectionId: string;
  expectedOrderRevision: string;
  market: SessionMarketSelection;
  fillBaseAmount: string;
  clocks: Omit<SettlementPlanInput, "orderExpiresAt">;
}

export interface MakerSessionInput {
  order: OrderRecord;
  proposal: VerifiedInitialReserveProposal;
  market: SessionMarketSelection;
  clocks: Omit<SettlementPlanInput, "orderExpiresAt">;
}

const HEX_32 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEYSET = /^[0-9a-f]{16,66}$/;
const UNIT = /^[a-z][a-z0-9_-]{0,15}$/;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string, label: string): Uint8Array {
  if (!HEX_32.test(value)) throw new Error(`${label} must be 32-byte lowercase hex`);
  return Uint8Array.from(value.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
}

const defaultEntropy: SessionFactoryEntropy = {
  sessionId: () => hex(generateSecretKey()),
  reservationId: () => crypto.randomUUID(),
  privateKey: () => hex(generateSecretKey()),
  htlcMaterial: () => createHTLCHash()
};

function canonicalMarket(input: SessionMarketSelection): SessionMarketSelection {
  const baseMint = normalizeMintUrl(input.baseMint);
  const quoteMint = normalizeMintUrl(input.quoteMint);
  if (baseMint !== input.baseMint || quoteMint !== input.quoteMint) {
    throw new Error("Session market mint URLs must be canonical");
  }
  if (baseMint === quoteMint) throw new Error("Base and quote mints must be independent");
  for (const [label, unit] of [["Base", input.baseUnit], ["Quote", input.quoteUnit]] as const) {
    if (!UNIT.test(unit)) throw new Error(`${label} unit is not canonical`);
  }
  if (input.baseUnit === input.quoteUnit) throw new Error("Base and quote units must differ");
  if (!KEYSET.test(input.baseKeyset) || !KEYSET.test(input.quoteKeyset)) {
    throw new Error("Session keyset IDs must be canonical lowercase hex");
  }
  return { ...input, baseMint, quoteMint };
}

function assertOpenSellOrder(
  order: OrderRecord,
  expectedProjectionId: string,
  expectedRevision: string,
  marketInput: SessionMarketSelection,
  now: number
): SessionMarketSelection {
  const market = canonicalMarket(marketInput);
  if (!order.verified) throw new Error("Order must be verified");
  if (
    !HEX_32.test(expectedProjectionId) ||
    order.eventId !== expectedProjectionId ||
    order.state.revision !== expectedRevision
  ) {
    throw new Error("Order projection is stale");
  }
  if (!HEX_32.test(order.eventId) || !HEX_32.test(order.makerPubkey)) {
    throw new Error("Order authority or projection ID is invalid");
  }
  const expectedAddress =
    `30078:${order.makerPubkey}:granola:order:v1:${order.state.order_id}`;
  if (order.address !== expectedAddress) throw new Error("Order address does not match its authority");
  const state = order.state;
  if (
    state.schema !== "granola/order/v1" ||
    state.side !== "sell" ||
    state.status !== "open"
  ) throw new Error("Session factory accepts only open maker sell orders");
  if (
    state.reservation !== null ||
    state.reserved_amount !== "0" ||
    state.remaining_amount !== state.original_amount
  ) throw new Error("Open order contains stale reservation state");
  if (!Number.isSafeInteger(now) || now < 0 || now >= state.expires_at) {
    throw new Error("Order has expired");
  }
  if (normalizeMintUrl(state.offered.mint) !== state.offered.mint) {
    throw new Error("Order offered mint must be canonical");
  }
  if (
    state.base_unit !== market.baseUnit ||
    state.quote_unit !== market.quoteUnit ||
    state.offered.unit !== market.baseUnit ||
    state.offered.mint !== market.baseMint
  ) throw new Error("Order base market does not match the selected market");
  if (
    state.requested.acceptable_mints.some(
      (mint) => normalizeMintUrl(mint) !== mint
    )
  ) throw new Error("Order acceptable mints must be canonical");
  if (
    state.requested.unit !== market.quoteUnit ||
    !state.requested.acceptable_mints.includes(market.quoteMint)
  ) throw new Error("Order quote mint does not match the selected quote mint");
  return market;
}

function amounts(order: OrderRecord, fillBaseAmount: string): { base: string; quote: string } {
  const result = settlementAmounts({
    remainingBaseAmount: order.state.remaining_amount,
    fillBaseAmount,
    priceCentsPerBtc: order.state.price_cents_per_btc,
    execution: order.state.execution,
    minimumFillAmount: order.state.minimum_fill_amount
  });
  const remainder = BigInt(order.state.remaining_amount) - BigInt(result.base);
  if (remainder > 0n && remainder < BigInt(order.state.minimum_fill_amount)) {
    throw new Error("Partial fill would leave dust below the order minimum");
  }
  return result;
}

interface LocalKeys {
  nostrPrivateKey: string;
  nostrPubkey: string;
  cashuPrivateKey: string;
  cashuPubkey: string;
  refundPrivateKey: string;
  refundPubkey: string;
}

function localKeys(entropy: SessionFactoryEntropy): LocalKeys {
  const nostrPrivateKey = entropy.privateKey("nostr");
  const cashuPrivateKey = entropy.privateKey("cashu");
  const refundPrivateKey = entropy.privateKey("refund");
  if (new Set([nostrPrivateKey, cashuPrivateKey, refundPrivateKey]).size !== 3) {
    throw new Error("Nostr, Cashu settlement, and refund keys must be independent");
  }
  const nostrBytes = fromHex(nostrPrivateKey, "Nostr private key");
  const cashuBytes = fromHex(cashuPrivateKey, "Cashu private key");
  const refundBytes = fromHex(refundPrivateKey, "Refund private key");
  let nostrPubkey: string;
  let cashuPubkey: string;
  let refundPubkey: string;
  try {
    nostrPubkey = getPublicKey(nostrBytes);
    cashuPubkey = hex(getPubKeyFromPrivKey(cashuBytes));
    refundPubkey = hex(getPubKeyFromPrivKey(refundBytes));
  } catch {
    throw new Error("Session private key is not a valid secp256k1 scalar");
  }
  const publicIdentities = [nostrPubkey, cashuPubkey.slice(2), refundPubkey.slice(2)];
  if (new Set(publicIdentities).size !== publicIdentities.length) {
    throw new Error("Nostr, Cashu settlement, and refund keys must be independent");
  }
  return {
    nostrPrivateKey,
    nostrPubkey,
    cashuPrivateKey,
    cashuPubkey,
    refundPrivateKey,
    refundPubkey
  };
}

function keyIdentities(keys: LocalKeys): string[] {
  return [keys.nostrPubkey, keys.cashuPubkey.slice(2), keys.refundPubkey.slice(2)];
}

function assertSeparatedFromOrderAuthority(keys: LocalKeys, makerPubkey: string): void {
  if (keyIdentities(keys).includes(makerPubkey)) {
    throw new Error("Session keys must be independent from the maker order authority");
  }
}

function tradeTerms(
  market: SessionMarketSelection,
  selected: { base: string; quote: string },
  order: OrderRecord
): TradeTerms {
  return {
    baseMint: market.baseMint,
    baseUnit: market.baseUnit,
    baseKeyset: market.baseKeyset,
    baseAmount: selected.base,
    quoteMint: market.quoteMint,
    quoteUnit: market.quoteUnit,
    quoteKeyset: market.quoteKeyset,
    quoteAmount: selected.quote,
    priceCentsPerBtc: order.state.price_cents_per_btc
  };
}

function emptyEvidence(order: OrderRecord, market: SessionMarketSelection): TradeEvidence {
  const leg = (keysetId: string) => ({
    tokenCommitment: null,
    validationCommitment: null,
    keysetId,
    proofCount: null,
    fee: null,
    mintState: "UNKNOWN" as const,
    observedAt: null,
    spendCommitment: null,
    claimOperationCommitment: null,
    refundOperationCommitment: null
  });
  return {
    makerPubkey: order.makerPubkey,
    commitments: [],
    mintStates: [],
    reserveProjectionId: null,
    reserveProjectionRevision: null,
    fillProjectionId: null,
    fillProjectionRevision: null,
    reservation: {
      proposalSealId: null,
      takerCommitment: null,
      abortSeal: null
    },
    legs: {
      base: leg(market.baseKeyset),
      quote: leg(market.quoteKeyset)
    }
  };
}

function baseSession(input: {
  role: "maker" | "taker";
  order: OrderRecord;
  sessionId: string;
  reservationId: string;
  terms: TradeTerms;
  plan: ReturnType<typeof createSettlementPlan>;
  keys: LocalKeys;
  transcript: TradeTranscriptJournal;
  evidence: TradeEvidence;
  preimage: string | null;
  htlcHash: string | null;
  createdAt: number;
}): TradeSession {
  if (!HEX_32.test(input.sessionId)) throw new Error("Session ID is invalid");
  if (!UUID_V4.test(input.reservationId)) throw new Error("Reservation ID is invalid");
  return {
    schema: "granola/trade-session/v2",
    revision: 0,
    sessionId: input.sessionId,
    reservationId: input.reservationId,
    role: input.role,
    phase: "negotiating",
    orderAddress: input.order.address,
    offeredProjectionId: input.order.eventId,
    offeredProjectionRevision: input.order.state.revision,
    reserveProjectionId: null,
    reserveProjectionRevision: null,
    fillProjectionId: null,
    fillProjectionRevision: null,
    pendingOrderPublication: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    terms: input.terms,
    plan: input.plan,
    evidence: input.evidence,
    privateState: {
      nostrPrivateKey: input.keys.nostrPrivateKey,
      cashuPrivateKey: input.keys.cashuPrivateKey,
      refundPrivateKey: input.keys.refundPrivateKey,
      preimage: input.preimage,
      htlcHash: input.htlcHash,
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
      transcript: input.transcript,
      outbox: null,
      cashuOperation: null,
      legs: {
        base: { token: null, expected: null, observations: [] },
        quote: { token: null, expected: null, observations: [] }
      }
    }
  };
}

function plan(order: OrderRecord, clocks: Omit<SettlementPlanInput, "orderExpiresAt">) {
  return createSettlementPlan({ ...clocks, orderExpiresAt: order.state.expires_at });
}

export async function createTakerSession(
  input: TakerSessionInput,
  entropy: SessionFactoryEntropy = defaultEntropy
): Promise<TradeSession> {
  const market = assertOpenSellOrder(
    input.order,
    input.expectedOrderProjectionId,
    input.expectedOrderRevision,
    input.market,
    input.clocks.localNow
  );
  const selected = amounts(input.order, input.fillBaseAmount);
  const keys = localKeys(entropy);
  assertSeparatedFromOrderAuthority(keys, input.order.makerPubkey);
  const sessionId = entropy.sessionId();
  const reservationId = entropy.reservationId();
  return baseSession({
    role: "taker",
    order: input.order,
    sessionId,
    reservationId,
    terms: tradeTerms(market, selected, input.order),
    plan: plan(input.order, input.clocks),
    keys,
    transcript: {
      choreography: initialAtomicSwapChoreography(input.order.makerPubkey),
      nextSequence: "0",
      lastRumorId: null,
      lastMessageId: null,
      lastTranscriptHash: null,
      accepted: []
    },
    evidence: emptyEvidence(input.order, market),
    preimage: null,
    htlcHash: null,
    createdAt: input.clocks.localNow
  });
}

export async function createMakerSession(
  input: MakerSessionInput,
  entropy: SessionFactoryEntropy = defaultEntropy
): Promise<TradeSession> {
  assertVerifiedInitialReserveProposal(input.proposal);
  const message = await validateAtomicSwapMessage(input.proposal.message);
  if (message.type !== "reserve_propose") {
    throw new Error("Maker session requires a validated reserve proposal");
  }
  if (message.sequence !== "0") {
    throw new Error("Maker session requires an initial reserve proposal");
  }
  if (input.clocks.localNow >= message.expires_at) {
    throw new Error("Reserve proposal has expired");
  }
  if (message.sent_at > input.clocks.localNow + 300) {
    throw new Error("Reserve proposal is too far in the future");
  }
  const market = assertOpenSellOrder(
    input.order,
    message.order_projection_id,
    message.order_revision,
    input.market,
    input.clocks.localNow
  );
  if (
    message.order_address !== input.order.address ||
    message.maker_order_pubkey !== input.order.makerPubkey ||
    message.recipient_pubkey !== input.order.makerPubkey
  ) throw new Error("Reserve proposal targets a different order");
  const proposalBody = message.body as ReserveProposeBody;
  const selected = amounts(input.order, proposalBody.fill_amount);
  const terms = message.terms!;
  if (
    terms.base_mint !== market.baseMint ||
    terms.base_unit !== market.baseUnit ||
    terms.base_keyset !== market.baseKeyset ||
    terms.quote_mint !== market.quoteMint ||
    terms.quote_unit !== market.quoteUnit ||
    terms.quote_keyset !== market.quoteKeyset ||
    terms.base_amount !== selected.base ||
    terms.quote_amount !== selected.quote ||
    terms.price_cents_per_btc !== input.order.state.price_cents_per_btc
  ) throw new Error("Reserve proposal terms do not match the selected order market");

  const choreography = await advanceAtomicSwapChoreography(
    initialAtomicSwapChoreography(input.order.makerPubkey),
    message
  );
  const keys = localKeys(entropy);
  assertSeparatedFromOrderAuthority(keys, input.order.makerPubkey);
  const makerIdentities = keyIdentities(keys);
  const takerIdentities = [
    proposalBody.taker_session_pubkey,
    proposalBody.taker_cashu_pubkey.slice(2),
    proposalBody.taker_refund_pubkey.slice(2)
  ];
  if (
    new Set(takerIdentities).size !== takerIdentities.length ||
    takerIdentities.includes(input.order.makerPubkey)
  ) {
    throw new Error("Taker keys must be independent from each other and the maker order authority");
  }
  if (makerIdentities.some((identity) => takerIdentities.includes(identity))) {
    throw new Error("Maker keys collide with counterparty session keys");
  }

  const material = entropy.htlcMaterial();
  if (
    !HEX_32.test(material.preimage) ||
    !HEX_32.test(material.hash) ||
    !verifyHTLCHash(material.preimage, material.hash)
  ) throw new Error("Maker HTLC material is invalid");
  if ([
    keys.nostrPrivateKey,
    keys.cashuPrivateKey,
    keys.refundPrivateKey,
    message.session_id
  ].includes(material.preimage)) {
    throw new Error("Maker HTLC preimage must be independent");
  }
  if (!HEX_32.test(input.proposal.rumor.id) || !HEX_32.test(input.proposal.transcriptHash)) {
    throw new Error("Validated proposal transcript identifiers are invalid");
  }
  const evidence = emptyEvidence(input.order, market);
  evidence.commitments = [material.hash];
  evidence.reservation.proposalSealId = input.proposal.seal.id;
  return baseSession({
    role: "maker",
    order: input.order,
    sessionId: message.session_id,
    reservationId: message.reservation_id,
    terms: tradeTerms(market, selected, input.order),
    plan: plan(input.order, input.clocks),
    keys,
    transcript: {
      choreography,
      nextSequence: "1",
      lastRumorId: input.proposal.rumor.id,
      lastMessageId: message.message_id,
      lastTranscriptHash: input.proposal.transcriptHash,
      accepted: [{
        sequence: "0",
        messageId: message.message_id,
        rumorId: input.proposal.rumor.id,
        transcriptHash: input.proposal.transcriptHash
      }]
    },
    evidence,
    preimage: material.preimage,
    htlcHash: material.hash,
    createdAt: input.clocks.localNow
  });
}
