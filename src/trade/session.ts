import { getPublicKey } from "nostr-tools/pure";

import type { PreparedTradeOperation } from "../cashu/trade-client.js";
import type { ExpectedHtlcLock } from "../cashu/htlc.js";
import type { RelayReceipt } from "../nostr/relay.js";
import type { NostrEvent } from "../order/events.js";
import type { OrderSide } from "../order/model.js";
import type { AtomicSwapChoreography } from "./atomic-messages.js";
import type {
  GranolaTradeMessage,
  SignedNostrEvent,
  UnsignedRumor,
  TradeMessageType
} from "./messages.js";
import type { SettlementPlan, TradePhase } from "./model.js";

export interface TradeTerms {
  makerSide?: OrderSide;
  baseMint: string;
  baseUnit: string;
  baseKeyset: string;
  baseAmount: string;
  quoteMint: string;
  quoteUnit: string;
  quoteKeyset: string;
  quoteAmount: string;
  priceCentsPerBtc: string;
}

export type PersistedMintState = "UNKNOWN" | "UNSPENT" | "PENDING" | "SPENT";

export interface TradeLegEvidence {
  tokenCommitment: string | null;
  validationCommitment: string | null;
  keysetId: string;
  proofCount: number | null;
  fee: string | null;
  mintState: PersistedMintState;
  observedAt: number | null;
  spendCommitment: string | null;
  claimOperationCommitment: string | null;
  refundOperationCommitment: string | null;
}

export interface TradeEvidence {
  makerPubkey: string;
  commitments: string[];
  mintStates: string[];
  reserveProjectionId: string | null;
  reserveProjectionRevision: string | null;
  fillProjectionId: string | null;
  fillProjectionRevision: string | null;
  reservation: {
    proposalSealId: string | null;
    takerCommitment: string | null;
    abortSeal: SignedNostrEvent | null;
  };
  legs: {
    base: TradeLegEvidence;
    quote: TradeLegEvidence;
  };
}

export interface AcceptedTradeMessage {
  sequence: string;
  messageId: string;
  rumorId: string;
  transcriptHash: string;
  /** Public message metadata retained for the protocol trace. */
  type?: TradeMessageType;
  authorPubkey?: string;
  recipientPubkey?: string;
}

export interface TradeTranscriptJournal {
  choreography: AtomicSwapChoreography;
  nextSequence: string;
  lastRumorId: string | null;
  lastMessageId: string | null;
  lastTranscriptHash: string | null;
  accepted: AcceptedTradeMessage[];
}

export interface TradeOutboxJournal {
  message: GranolaTradeMessage;
  rumor: UnsignedRumor;
  seal: SignedNostrEvent;
  wrapper: SignedNostrEvent;
  recipientInboxListId: string;
  recipientRelays: string[];
  receipts: RelayReceipt[];
  nextChoreography: AtomicSwapChoreography;
  status: "staged" | "acknowledged";
}

export interface CashuOperationResult {
  walletMutation: "replace" | "receive";
  mintUrl: string;
  unit: string;
  proofs: Array<{
    amount: string;
    id: string;
    secret: string;
    C: string;
    dleq?: { e: string; s: string; r: string };
  }>;
  lockedToken: string | null;
  amount: string;
  proofCount: number;
}

export interface CashuOperationJournal {
  operationId: string;
  leg: "base" | "quote";
  kind: "outgoing-lock" | "claim" | "refund";
  status: "prepared" | "completed" | "wallet_applied";
  preparedAt: number;
  inputsReserved: boolean;
  artifact: PreparedTradeOperation;
  result: CashuOperationResult | null;
}

export interface PrivateLegJournal {
  token: string | null;
  expected: ExpectedHtlcLock | null;
  observations: Array<{
    observedAt: number;
    state: PersistedMintState;
    proofCount: number;
    witnessCommitment: string | null;
  }>;
}

export interface TradeInboxJournal {
  status: "unregistered" | "staged" | "acknowledged" | "registered";
  quorum: number;
  event: SignedNostrEvent | null;
  discoveryRelays: string[];
  inboxRelays: string[];
  receipts: RelayReceipt[];
  readbacks: Array<{
    relay: string;
    found: boolean;
    event: SignedNostrEvent | null;
    observedAt: number;
  }>;
  stagedAt: number | null;
  acknowledgedAt: number | null;
  registeredAt: number | null;
}

export interface TradePendingIncomingJournal {
  wrapper: SignedNostrEvent;
  seal: SignedNostrEvent;
  rumor: UnsignedRumor;
  message: GranolaTradeMessage;
  transcriptHash: string;
  receivedAt: number;
  validation:
    | { status: "unvalidated"; checkedAt: null; error: null }
    | { status: "validated"; checkedAt: number; error: null }
    | { status: "rejected"; checkedAt: number; error: string };
}

export interface TradePrivateState {
  nostrPrivateKey: string;
  cashuPrivateKey: string;
  refundPrivateKey: string;
  preimage: string | null;
  htlcHash: string | null;
  settlementTranscriptHash: string | null;
  inbox: TradeInboxJournal;
  pendingIncoming: TradePendingIncomingJournal | null;
  transcript: TradeTranscriptJournal;
  outbox: TradeOutboxJournal | null;
  cashuOperation: CashuOperationJournal | null;
  legs: {
    base: PrivateLegJournal;
    quote: PrivateLegJournal;
  };
}

export interface TradeSession {
  schema: "granola/trade-session/v2";
  revision: number;
  sessionId: string;
  reservationId: string;
  role: "maker" | "taker";
  phase: TradePhase;
  /** The maker's published order side; absent only on legacy ask sessions. */
  orderSide?: OrderSide;
  orderAddress: string;
  offeredProjectionId: string;
  offeredProjectionRevision: string;
  reserveProjectionId: string | null;
  reserveProjectionRevision: string | null;
  fillProjectionId: string | null;
  fillProjectionRevision: string | null;
  pendingOrderPublication: {
    operation: "reserve" | "fill" | "release";
    orderId: string;
    projection: NostrEvent;
    receipts: RelayReceipt[];
    status: "staged" | "acknowledged" | "committed";
    stagedAt: number;
    acknowledgedAt: number | null;
    committedAt: number | null;
  } | null;
  createdAt: number;
  updatedAt: number;
  terms: TradeTerms;
  plan: SettlementPlan;
  evidence: TradeEvidence;
  privateState: TradePrivateState;
}

export type PublicTradeEvidence = Omit<TradeEvidence, "reservation"> & {
  reservation: {
    proposalSealId: string | null;
    takerCommitment: string | null;
    abortSealId: string | null;
  };
};

export interface PublicTradeMessageTrace {
  sequence: string;
  messageId: string;
  rumorId: string;
  transcriptHash: string;
  type?: TradeMessageType;
  authorPubkey?: string;
  recipientPubkey?: string;
}

export interface PublicTradeProtocolTrace {
  localNostrPubkey: string | null;
  orderAuthorityPubkey: string;
  counterpartyNostrPubkey: string | null;
  inbox: {
    status: TradeInboxJournal["status"];
    registrationEventId: string | null;
    relayCount: number;
    acknowledgements: number;
  };
  messages: PublicTradeMessageTrace[];
}

export type PublicTradeView = Omit<
  TradeSession,
  "privateState" | "schema" | "evidence"
> & {
  evidence: PublicTradeEvidence;
  protocol: PublicTradeProtocolTrace;
};

function privateKeyBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  return Uint8Array.from(value.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
}

function localNostrPubkey(session: TradeSession): string | null {
  const key = privateKeyBytes(session.privateState.nostrPrivateKey);
  if (key === null) return null;
  try {
    return getPublicKey(key);
  } finally {
    key.fill(0);
  }
}

export function publicTradeView(session: TradeSession): PublicTradeView {
  const participants = session.privateState.transcript.choreography.participants;
  const localPubkey = localNostrPubkey(session);
  const counterpartyNostrPubkey = session.role === "maker"
    ? participants.takerSessionPubkey ?? null
    : participants.makerSessionPubkey ?? participants.makerOrderPubkey;
  return structuredClone({
    revision: session.revision,
    sessionId: session.sessionId,
    reservationId: session.reservationId,
    role: session.role,
    phase: session.phase,
    ...(session.orderSide === undefined ? {} : { orderSide: session.orderSide }),
    orderAddress: session.orderAddress,
    offeredProjectionId: session.offeredProjectionId,
    offeredProjectionRevision: session.offeredProjectionRevision,
    reserveProjectionId: session.reserveProjectionId,
    reserveProjectionRevision: session.reserveProjectionRevision,
    fillProjectionId: session.fillProjectionId,
    fillProjectionRevision: session.fillProjectionRevision,
    pendingOrderPublication: session.pendingOrderPublication,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    terms: session.terms,
    plan: session.plan,
    protocol: {
      localNostrPubkey: localPubkey,
      orderAuthorityPubkey: session.evidence.makerPubkey,
      counterpartyNostrPubkey,
      inbox: {
        status: session.privateState.inbox.status,
        registrationEventId: session.privateState.inbox.event?.id ?? null,
        relayCount: session.privateState.inbox.inboxRelays.length,
        acknowledgements: session.privateState.inbox.receipts.filter(({ ok }) => ok).length
      },
      messages: session.privateState.transcript.accepted.map((message) => ({
        sequence: message.sequence,
        messageId: message.messageId,
        rumorId: message.rumorId,
        transcriptHash: message.transcriptHash,
        ...(message.type === undefined ? {} : { type: message.type }),
        ...(message.authorPubkey === undefined ? {} : { authorPubkey: message.authorPubkey }),
        ...(message.recipientPubkey === undefined ? {} : { recipientPubkey: message.recipientPubkey })
      }))
    },
    evidence: {
      makerPubkey: session.evidence.makerPubkey,
      commitments: session.evidence.commitments,
      mintStates: session.evidence.mintStates,
      reserveProjectionId: session.evidence.reserveProjectionId,
      reserveProjectionRevision: session.evidence.reserveProjectionRevision,
      fillProjectionId: session.evidence.fillProjectionId,
      fillProjectionRevision: session.evidence.fillProjectionRevision,
      reservation: {
        proposalSealId: session.evidence.reservation.proposalSealId,
        takerCommitment: session.evidence.reservation.takerCommitment,
        abortSealId: session.evidence.reservation.abortSeal?.id ?? null
      },
      legs: session.evidence.legs
    }
  });
}
