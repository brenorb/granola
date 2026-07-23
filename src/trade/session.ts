import type { PreparedTradeOperation } from "../cashu/trade-client.js";
import type { ExpectedHtlcLock } from "../cashu/htlc.js";
import type { RelayReceipt } from "../nostr/relay.js";
import type { NostrEvent } from "../order/events.js";
import type { AtomicSwapChoreography } from "./atomic-messages.js";
import type {
  GranolaTradeMessage,
  SignedNostrEvent,
  UnsignedRumor
} from "./messages.js";
import type { SettlementPlan, TradePhase } from "./model.js";

export interface TradeTerms {
  baseMint: string;
  baseUnit: string;
  baseKeyset: string;
  baseAmount: string;
  quoteMint: string;
  quoteUnit: string;
  quoteKeyset: string;
  quoteAmount: string;
  price: { numerator: string; denominator: string };
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
  reserveTransitionId: string | null;
  fillTransitionId: string | null;
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
  orderAddress: string;
  offeredOrderHead: string;
  reserveTransitionId: string | null;
  fillTransitionId: string | null;
  pendingOrderPublication: {
    operation: "reserve" | "fill" | "release";
    orderId: string;
    transition: NostrEvent;
    projection: NostrEvent;
    transitionReceipts: RelayReceipt[];
    projectionReceipts: RelayReceipt[];
    status:
      | "staged"
      | "transition_acknowledged"
      | "projection_acknowledged"
      | "committed";
    stagedAt: number;
    transitionAcknowledgedAt: number | null;
    projectionAcknowledgedAt: number | null;
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

export type PublicTradeView = Omit<
  TradeSession,
  "privateState" | "schema" | "evidence"
> & {
  evidence: PublicTradeEvidence;
};

export function publicTradeView(session: TradeSession): PublicTradeView {
  return structuredClone({
    revision: session.revision,
    sessionId: session.sessionId,
    reservationId: session.reservationId,
    role: session.role,
    phase: session.phase,
    orderAddress: session.orderAddress,
    offeredOrderHead: session.offeredOrderHead,
    reserveTransitionId: session.reserveTransitionId,
    fillTransitionId: session.fillTransitionId,
    pendingOrderPublication: session.pendingOrderPublication,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    terms: session.terms,
    plan: session.plan,
    evidence: {
      makerPubkey: session.evidence.makerPubkey,
      commitments: session.evidence.commitments,
      mintStates: session.evidence.mintStates,
      reserveTransitionId: session.evidence.reserveTransitionId,
      fillTransitionId: session.evidence.fillTransitionId,
      reservation: {
        proposalSealId: session.evidence.reservation.proposalSealId,
        takerCommitment: session.evidence.reservation.takerCommitment,
        abortSealId: session.evidence.reservation.abortSeal?.id ?? null
      },
      legs: session.evidence.legs
    }
  });
}
