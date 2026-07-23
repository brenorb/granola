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
  reserveTransitionId?: string;
  fillTransitionId?: string;
  legs: {
    base: TradeLegEvidence;
    quote: TradeLegEvidence;
  };
}

export interface TradeTranscriptJournal {
  choreography: AtomicSwapChoreography;
  nextSequence: string;
  lastRumorId: string | null;
  lastMessageId: string | null;
  lastTranscriptHash: string | null;
  acceptedRumorIds: string[];
  acceptedMessageIds: string[];
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

export interface TradePrivateState {
  nostrPrivateKey: string;
  cashuPrivateKey: string;
  refundPrivateKey: string;
  preimage: string | null;
  settlementTranscriptHash: string | null;
  inbox: {
    listEventId: string | null;
    registeredAt: number | null;
    relays: string[];
  };
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
    operation: "reserve" | "fill";
    stage: "transition" | "projection";
    orderId: string;
    transitionId: string;
    projectionId: string;
  } | null;
  createdAt: number;
  updatedAt: number;
  terms: TradeTerms;
  plan: SettlementPlan;
  evidence: TradeEvidence;
  privateState: TradePrivateState;
}

export type PublicTradeView = Omit<TradeSession, "privateState" | "schema">;

export function publicTradeView(session: TradeSession): PublicTradeView {
  const { privateState: _privateState, schema: _schema, ...view } = structuredClone(session);
  return view;
}
