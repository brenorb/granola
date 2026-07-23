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

export interface TradeEvidence {
  makerPubkey: string;
  commitments: string[];
  mintStates: string[];
  reserveTransitionId?: string;
  fillTransitionId?: string;
}

export interface TradePrivateState {
  nostrPrivateKey: string;
  cashuPrivateKey: string;
  refundPrivateKey: string;
  preimage: string | null;
  baseToken: string | null;
  quoteToken: string | null;
  exactOutbox: string[];
}

export interface TradeSession {
  schema: "granola/trade-session/v1";
  sessionId: string;
  reservationId: string;
  role: "maker" | "taker";
  phase: TradePhase;
  orderAddress: string;
  orderHead: string;
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
