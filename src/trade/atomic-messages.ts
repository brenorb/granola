import {
  canonicalJson,
  termsHash,
  type GranolaTradeMessage,
  type GranolaTradeTerms,
  type JsonValue
} from "./messages.js";

export const ATOMIC_SWAP_BODY_SCHEMA = "granola/atomic-swap-body/v1" as const;

export const ATOMIC_SWAP_MESSAGE_TYPES = [
  "reserve_propose",
  "reserve_accept",
  "session_ack",
  "base_lock",
  "base_lock_ack",
  "quote_lock",
  "quote_lock_ack",
  "claim_notice",
  "fill_request",
  "settlement_ack",
  "refund",
  "error"
] as const;

export type AtomicSwapMessageType = (typeof ATOMIC_SWAP_MESSAGE_TYPES)[number];

interface VersionedBody {
  [key: string]: JsonValue;
  schema: typeof ATOMIC_SWAP_BODY_SCHEMA;
}

export interface ReserveProposeBody extends VersionedBody {
  taker_session_pubkey: string;
  taker_cashu_pubkey: string;
  taker_refund_pubkey: string;
  fill_amount: string;
}

export interface ReserveAcceptBody extends VersionedBody {
  taker_session_pubkey: string;
  maker_session_pubkey: string;
  maker_cashu_pubkey: string;
  maker_refund_pubkey: string;
  reserve_transition_id: string;
  settlement_hash: string;
  short_locktime: number;
  maker_claim_cutoff: number;
  long_locktime: number;
  taker_claim_cutoff: number;
  reservation_expires_at: number;
}

export interface SessionAckBody extends VersionedBody {
  reserve_accept_message_id: string;
  reserve_accept_transcript_hash: string;
  reserve_transition_id: string;
  settlement_hash: string;
}

export interface LockBody extends VersionedBody {
  cashu_token: string;
  token_commitment: string;
  validation_commitment: string;
  settlement_hash: string;
  mint: string;
  unit: string;
  keyset: string;
  amount: string;
  receiver_cashu_pubkey: string;
  refund_cashu_pubkey: string;
  locktime: number;
}

export interface LockAckBody extends VersionedBody {
  lock_message_id: string;
  lock_transcript_hash: string;
  token_commitment: string;
  validation_commitment: string;
  settlement_hash: string;
}

export interface ClaimNoticeBody extends VersionedBody {
  quote_token_commitment: string;
  claim_operation_commitment: string;
  settlement_hash: string;
  claimed_at: number;
}

export interface FillRequestBody extends VersionedBody {
  base_token_commitment: string;
  quote_token_commitment: string;
  base_spend_commitment: string;
  quote_spend_commitment: string;
  settlement_hash: string;
}

export interface SettlementAckBody extends VersionedBody {
  fill_transition_id: string;
  base_token_commitment: string;
  quote_token_commitment: string;
  settlement_hash: string;
}

export type RefundLeg = "base" | "quote";

export interface RefundBody extends VersionedBody {
  leg: RefundLeg;
  token_commitment: string;
  refund_operation_commitment: string;
  settlement_hash: string;
  refunded_at: number;
}

export const ATOMIC_SWAP_ERROR_CODES = [
  "invalid_message",
  "protocol_violation",
  "terms_mismatch",
  "order_changed",
  "relay_unavailable",
  "mint_unavailable",
  "mint_rejected",
  "proof_state_invalid",
  "witness_invalid",
  "deadline_reached",
  "counterparty_abort",
  "internal_error"
] as const;

export type AtomicSwapErrorCode = (typeof ATOMIC_SWAP_ERROR_CODES)[number];

export const ATOMIC_SWAP_ERROR_PHASES = [
  "negotiating",
  "reserved",
  "base_locked",
  "quote_locked",
  "quote_claimed",
  "base_claimed",
  "filled",
  "waiting_quote_refund",
  "waiting_base_refund",
  "waiting_base_claim",
  "released",
  "frozen"
] as const;

export type AtomicSwapErrorPhase = (typeof ATOMIC_SWAP_ERROR_PHASES)[number];

export interface ErrorBody extends VersionedBody {
  code: AtomicSwapErrorCode;
  at_phase: AtomicSwapErrorPhase;
  failed_message_id: string | null;
  retryable: boolean;
}

interface AtomicSwapBodyMap {
  reserve_propose: ReserveProposeBody;
  reserve_accept: ReserveAcceptBody;
  session_ack: SessionAckBody;
  base_lock: LockBody;
  base_lock_ack: LockAckBody;
  quote_lock: LockBody;
  quote_lock_ack: LockAckBody;
  claim_notice: ClaimNoticeBody;
  fill_request: FillRequestBody;
  settlement_ack: SettlementAckBody;
  refund: RefundBody;
  error: ErrorBody;
}

export type AtomicSwapBody<T extends AtomicSwapMessageType = AtomicSwapMessageType> =
  AtomicSwapBodyMap[T];

export type AtomicSwapMessage<T extends AtomicSwapMessageType = AtomicSwapMessageType> =
  Omit<GranolaTradeMessage, "type" | "body"> & {
    type: T;
    body: AtomicSwapBody<T>;
  };

const HEX_32 = /^[0-9a-f]{64}$/;
const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const UNIT = /^[a-z][a-z0-9_-]{0,15}$/;
const KEYSET = /^[0-9a-f]{16,66}$/;
const TOKEN_PREFIX = /^cashu[AB][A-Za-z0-9_-]+$/;
const utf8 = new TextEncoder();

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Atomic swap body must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("Atomic swap body contains missing or unknown fields");
  }
}

function exactBody(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const body = bodyRecord(value);
  exactKeys(body, ["schema", ...fields]);
  if (body.schema !== ATOMIC_SWAP_BODY_SCHEMA) {
    throw new Error("Unknown atomic swap body schema");
  }
  return body;
}

function requiredString(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function hex32(value: unknown, label: string): string {
  return requiredString(value, label, HEX_32);
}

function cashuPubkey(value: unknown, label: string): string {
  return requiredString(value, label, COMPRESSED_PUBKEY);
}

function uuid(value: unknown, label: string): string {
  return requiredString(value, label, UUID_V4);
}

function amount(value: unknown, label: string): string {
  return requiredString(value, label, POSITIVE_INTEGER);
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe Unix timestamp`);
  }
  return value;
}

function normalizedMint(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a normalized HTTPS URL`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a normalized HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.toString().replace(/\/$/, "") !== value
  ) {
    throw new Error(`${label} must be a normalized HTTPS URL`);
  }
  return value;
}

function token(value: unknown): string {
  if (typeof value !== "string" || !TOKEN_PREFIX.test(value)) {
    throw new Error("Cashu token has an invalid encoding");
  }
  if (utf8.encode(value).length > 24 * 1024) {
    throw new Error("Cashu token exceeds the 24 KiB body limit");
  }
  return value;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function reservePropose(value: unknown): ReserveProposeBody {
  const body = exactBody(value, [
    "taker_session_pubkey",
    "taker_cashu_pubkey",
    "taker_refund_pubkey",
    "fill_amount"
  ]);
  hex32(body.taker_session_pubkey, "Taker session public key");
  cashuPubkey(body.taker_cashu_pubkey, "Taker Cashu public key");
  cashuPubkey(body.taker_refund_pubkey, "Taker refund Cashu public key");
  amount(body.fill_amount, "Fill amount");
  if (body.taker_cashu_pubkey === body.taker_refund_pubkey) {
    throw new Error("Taker Cashu settlement and refund keys must differ");
  }
  return body as unknown as ReserveProposeBody;
}

function reserveAccept(value: unknown): ReserveAcceptBody {
  const body = exactBody(value, [
    "taker_session_pubkey",
    "maker_session_pubkey",
    "maker_cashu_pubkey",
    "maker_refund_pubkey",
    "reserve_transition_id",
    "settlement_hash",
    "short_locktime",
    "maker_claim_cutoff",
    "long_locktime",
    "taker_claim_cutoff",
    "reservation_expires_at"
  ]);
  hex32(body.taker_session_pubkey, "Taker session public key");
  hex32(body.maker_session_pubkey, "Maker session public key");
  cashuPubkey(body.maker_cashu_pubkey, "Maker Cashu public key");
  cashuPubkey(body.maker_refund_pubkey, "Maker refund Cashu public key");
  hex32(body.reserve_transition_id, "Reserve transition ID");
  hex32(body.settlement_hash, "Settlement hash");
  const short = timestamp(body.short_locktime, "Short locktime");
  const makerCutoff = timestamp(body.maker_claim_cutoff, "Maker claim cutoff");
  const long = timestamp(body.long_locktime, "Long locktime");
  const takerCutoff = timestamp(body.taker_claim_cutoff, "Taker claim cutoff");
  const reservationExpiry = timestamp(body.reservation_expires_at, "Reservation expiry");
  if (
    makerCutoff !== short - 120 ||
    long !== short + 600 ||
    takerCutoff !== long - 120
  ) {
    throw new Error("Settlement deadline profile is invalid");
  }
  if (reservationExpiry < long + 600) {
    throw new Error("Reservation expiry does not cover the recovery window");
  }
  if (body.maker_cashu_pubkey === body.maker_refund_pubkey) {
    throw new Error("Maker Cashu settlement and refund keys must differ");
  }
  return body as unknown as ReserveAcceptBody;
}

function sessionAck(value: unknown): SessionAckBody {
  const body = exactBody(value, [
    "reserve_accept_message_id",
    "reserve_accept_transcript_hash",
    "reserve_transition_id",
    "settlement_hash"
  ]);
  uuid(body.reserve_accept_message_id, "Reserve acceptance message ID");
  hex32(body.reserve_accept_transcript_hash, "Reserve acceptance transcript hash");
  hex32(body.reserve_transition_id, "Reserve transition ID");
  hex32(body.settlement_hash, "Settlement hash");
  return body as unknown as SessionAckBody;
}

function lock(value: unknown): LockBody {
  const body = exactBody(value, [
    "cashu_token",
    "token_commitment",
    "validation_commitment",
    "settlement_hash",
    "mint",
    "unit",
    "keyset",
    "amount",
    "receiver_cashu_pubkey",
    "refund_cashu_pubkey",
    "locktime"
  ]);
  token(body.cashu_token);
  hex32(body.token_commitment, "Token commitment");
  hex32(body.validation_commitment, "Validation commitment");
  hex32(body.settlement_hash, "Settlement hash");
  normalizedMint(body.mint, "Mint");
  requiredString(body.unit, "Unit", UNIT);
  requiredString(body.keyset, "Keyset", KEYSET);
  amount(body.amount, "Lock amount");
  cashuPubkey(body.receiver_cashu_pubkey, "Receiver Cashu public key");
  cashuPubkey(body.refund_cashu_pubkey, "Refund Cashu public key");
  timestamp(body.locktime, "Locktime");
  if (body.receiver_cashu_pubkey === body.refund_cashu_pubkey) {
    throw new Error("Lock receiver and refund keys must differ");
  }
  return body as unknown as LockBody;
}

function lockAck(value: unknown): LockAckBody {
  const body = exactBody(value, [
    "lock_message_id",
    "lock_transcript_hash",
    "token_commitment",
    "validation_commitment",
    "settlement_hash"
  ]);
  uuid(body.lock_message_id, "Lock message ID");
  hex32(body.lock_transcript_hash, "Lock transcript hash");
  hex32(body.token_commitment, "Token commitment");
  hex32(body.validation_commitment, "Validation commitment");
  hex32(body.settlement_hash, "Settlement hash");
  return body as unknown as LockAckBody;
}

function claimNotice(value: unknown): ClaimNoticeBody {
  const body = exactBody(value, [
    "quote_token_commitment",
    "claim_operation_commitment",
    "settlement_hash",
    "claimed_at"
  ]);
  hex32(body.quote_token_commitment, "Quote token commitment");
  hex32(body.claim_operation_commitment, "Claim operation commitment");
  hex32(body.settlement_hash, "Settlement hash");
  timestamp(body.claimed_at, "Claim timestamp");
  return body as unknown as ClaimNoticeBody;
}

function fillRequest(value: unknown): FillRequestBody {
  const body = exactBody(value, [
    "base_token_commitment",
    "quote_token_commitment",
    "base_spend_commitment",
    "quote_spend_commitment",
    "settlement_hash"
  ]);
  hex32(body.base_token_commitment, "Base token commitment");
  hex32(body.quote_token_commitment, "Quote token commitment");
  hex32(body.base_spend_commitment, "Base spend commitment");
  hex32(body.quote_spend_commitment, "Quote spend commitment");
  hex32(body.settlement_hash, "Settlement hash");
  return body as unknown as FillRequestBody;
}

function settlementAck(value: unknown): SettlementAckBody {
  const body = exactBody(value, [
    "fill_transition_id",
    "base_token_commitment",
    "quote_token_commitment",
    "settlement_hash"
  ]);
  hex32(body.fill_transition_id, "Fill transition ID");
  hex32(body.base_token_commitment, "Base token commitment");
  hex32(body.quote_token_commitment, "Quote token commitment");
  hex32(body.settlement_hash, "Settlement hash");
  return body as unknown as SettlementAckBody;
}

function refund(value: unknown): RefundBody {
  const body = exactBody(value, [
    "leg",
    "token_commitment",
    "refund_operation_commitment",
    "settlement_hash",
    "refunded_at"
  ]);
  if (body.leg !== "base" && body.leg !== "quote") throw new Error("Refund leg is invalid");
  hex32(body.token_commitment, "Refund token commitment");
  hex32(body.refund_operation_commitment, "Refund operation commitment");
  hex32(body.settlement_hash, "Settlement hash");
  timestamp(body.refunded_at, "Refund timestamp");
  return body as unknown as RefundBody;
}

function errorBody(value: unknown): ErrorBody {
  const body = exactBody(value, ["code", "at_phase", "failed_message_id", "retryable"]);
  if (!ATOMIC_SWAP_ERROR_CODES.includes(body.code as AtomicSwapErrorCode)) {
    throw new Error("Atomic swap error code is invalid");
  }
  if (!ATOMIC_SWAP_ERROR_PHASES.includes(body.at_phase as AtomicSwapErrorPhase)) {
    throw new Error("Atomic swap error phase is invalid");
  }
  if (body.failed_message_id !== null) uuid(body.failed_message_id, "Failed message ID");
  if (typeof body.retryable !== "boolean") throw new Error("Error retryable flag is invalid");
  return body as unknown as ErrorBody;
}

const parsers: {
  [T in AtomicSwapMessageType]: (value: unknown) => AtomicSwapBodyMap[T];
} = {
  reserve_propose: reservePropose,
  reserve_accept: reserveAccept,
  session_ack: sessionAck,
  base_lock: lock,
  base_lock_ack: lockAck,
  quote_lock: lock,
  quote_lock_ack: lockAck,
  claim_notice: claimNotice,
  fill_request: fillRequest,
  settlement_ack: settlementAck,
  refund,
  error: errorBody
};

export async function validateAtomicSwapMessage(
  message: GranolaTradeMessage
): Promise<AtomicSwapMessage> {
  if (!ATOMIC_SWAP_MESSAGE_TYPES.includes(message.type as AtomicSwapMessageType)) {
    throw new Error("Message is not a Granola atomic swap message");
  }
  const type = message.type as AtomicSwapMessageType;
  const parsedBody = parsers[type](message.body);
  const sentAt = timestamp(message.sent_at, "Message sent_at");
  const hasTerms = message.terms !== undefined;
  if (type === "reserve_propose" || type === "reserve_accept") {
    if (!hasTerms) throw new Error(`${type} must carry canonical terms`);
    const computed = await termsHash(message.terms!);
    if (computed !== message.terms_hash) throw new Error("Atomic swap terms hash is invalid");
  } else if (hasTerms) {
    throw new Error(`${type} must not repeat complete terms`);
  }
  if (
    type === "reserve_propose" &&
    (parsedBody as ReserveProposeBody).fill_amount !== message.terms!.base_amount
  ) {
    throw new Error("Fill amount differs from canonical terms");
  }
  if (type === "reserve_accept") {
    const body = parsedBody as ReserveAcceptBody;
    if (body.maker_claim_cutoff <= sentAt) {
      throw new Error("Settlement deadlines are already unsafe at acceptance");
    }
  }
  if (type === "base_lock" || type === "quote_lock") {
    const body = parsedBody as LockBody;
    if (body.token_commitment !== await sha256Text(body.cashu_token)) {
      throw new Error("Token commitment does not match the Cashu token");
    }
    if (body.locktime <= sentAt) throw new Error("Locktime has already passed");
  }
  if (type === "claim_notice" && (parsedBody as ClaimNoticeBody).claimed_at > sentAt) {
    throw new Error("Claim timestamp is later than the message");
  }
  if (type === "refund" && (parsedBody as RefundBody).refunded_at > sentAt) {
    throw new Error("Refund timestamp is later than the message");
  }
  return { ...message, type, body: parsedBody } as AtomicSwapMessage;
}

export type AtomicSwapChoreographyPhase =
  | "awaiting_reserve_propose"
  | "awaiting_reserve_accept"
  | "awaiting_session_ack"
  | "awaiting_base_lock"
  | "awaiting_base_lock_ack"
  | "awaiting_quote_lock"
  | "awaiting_quote_lock_ack"
  | "awaiting_claim_notice"
  | "awaiting_fill_request"
  | "awaiting_settlement_ack"
  | "settled"
  | "refunding"
  | "failed";

export interface AtomicSwapParticipants {
  makerOrderPubkey: string;
  makerSessionPubkey?: string;
  takerSessionPubkey?: string;
  makerCashuPubkey?: string;
  makerRefundPubkey?: string;
  takerCashuPubkey?: string;
  takerRefundPubkey?: string;
}

export interface AtomicSwapChoreography {
  phase: AtomicSwapChoreographyPhase;
  participants: AtomicSwapParticipants;
  sessionId?: string;
  reservationId?: string;
  orderAddress?: string;
  orderHead?: string;
  termsHash?: string;
  terms?: GranolaTradeTerms;
  lastMessageId?: string;
  settlementHash?: string;
  reserveTransitionId?: string;
  shortLocktime?: number;
  longLocktime?: number;
  baseTokenCommitment?: string;
  baseValidationCommitment?: string;
  quoteTokenCommitment?: string;
  quoteValidationCommitment?: string;
  refundedLegs: RefundLeg[];
}

export function initialAtomicSwapChoreography(makerOrderPubkey: string): AtomicSwapChoreography {
  hex32(makerOrderPubkey, "Maker order public key");
  return {
    phase: "awaiting_reserve_propose",
    participants: { makerOrderPubkey },
    refundedLegs: []
  };
}

function nextState(
  state: AtomicSwapChoreography,
  message: AtomicSwapMessage,
  patch: Partial<AtomicSwapChoreography>
): AtomicSwapChoreography {
  return {
    ...state,
    ...patch,
    participants: patch.participants ?? state.participants,
    refundedLegs: patch.refundedLegs ?? state.refundedLegs,
    lastMessageId: message.message_id
  };
}

function expectedType(state: AtomicSwapChoreography, type: AtomicSwapMessageType): void {
  const expected: Partial<Record<AtomicSwapChoreographyPhase, AtomicSwapMessageType>> = {
    awaiting_reserve_propose: "reserve_propose",
    awaiting_reserve_accept: "reserve_accept",
    awaiting_session_ack: "session_ack",
    awaiting_base_lock: "base_lock",
    awaiting_base_lock_ack: "base_lock_ack",
    awaiting_quote_lock: "quote_lock",
    awaiting_quote_lock_ack: "quote_lock_ack",
    awaiting_claim_notice: "claim_notice",
    awaiting_fill_request: "fill_request",
    awaiting_settlement_ack: "settlement_ack"
  };
  const required = expected[state.phase];
  if (required !== type) throw new Error(`Expected ${required ?? "no further message"}, received ${type}`);
}

function sameCommonSession(state: AtomicSwapChoreography, message: AtomicSwapMessage): void {
  if (
    message.maker_order_pubkey !== state.participants.makerOrderPubkey ||
    message.session_id !== state.sessionId ||
    message.reservation_id !== state.reservationId ||
    message.order_address !== state.orderAddress ||
    message.terms_hash !== state.termsHash
  ) {
    throw new Error("Atomic swap message does not match the bound session");
  }
  if (state.orderHead !== undefined && message.order_head !== state.orderHead) {
    throw new Error("Atomic swap message does not match the reserved order head");
  }
  if (message.previous_message_id !== state.lastMessageId) {
    throw new Error("Atomic swap message predecessor is not the last accepted message");
  }
}

function assertRole(message: AtomicSwapMessage, author: string | undefined, recipient: string | undefined): void {
  if (!author || message.author_pubkey !== author) throw new Error("Atomic swap message author role is invalid");
  if (!recipient || message.recipient_pubkey !== recipient) {
    throw new Error("Atomic swap message recipient role is invalid");
  }
}

function assertSettlement(state: AtomicSwapChoreography, settlementHash: string): void {
  if (!state.settlementHash || settlementHash !== state.settlementHash) {
    throw new Error("Settlement hash changed during the session");
  }
}

function semanticPhase(phase: AtomicSwapChoreographyPhase): AtomicSwapErrorPhase {
  const phases: Record<AtomicSwapChoreographyPhase, AtomicSwapErrorPhase> = {
    awaiting_reserve_propose: "negotiating",
    awaiting_reserve_accept: "negotiating",
    awaiting_session_ack: "reserved",
    awaiting_base_lock: "reserved",
    awaiting_base_lock_ack: "base_locked",
    awaiting_quote_lock: "base_locked",
    awaiting_quote_lock_ack: "quote_locked",
    awaiting_claim_notice: "quote_locked",
    awaiting_fill_request: "quote_claimed",
    awaiting_settlement_ack: "base_claimed",
    settled: "filled",
    refunding: "waiting_base_refund",
    failed: "frozen"
  };
  return phases[phase];
}

function assertLockTerms(
  state: AtomicSwapChoreography,
  body: LockBody,
  leg: "base" | "quote"
): void {
  const terms = state.terms;
  if (!terms) throw new Error("Canonical terms are unavailable");
  const prefix = leg === "base" ? "base" : "quote";
  if (body.mint !== terms[`${prefix}_mint`]) throw new Error(`${prefix} mint differs from terms`);
  if (body.unit !== terms[`${prefix}_unit`]) throw new Error(`${prefix} unit differs from terms`);
  if (body.keyset !== terms[`${prefix}_keyset`]) throw new Error(`${prefix} keyset differs from terms`);
  if (body.amount !== terms[`${prefix}_amount`]) throw new Error(`${prefix} amount differs from terms`);
  if (body.locktime !== (leg === "base" ? state.longLocktime : state.shortLocktime)) {
    throw new Error(`${prefix} locktime differs from accepted deadlines`);
  }
  assertSettlement(state, body.settlement_hash);
}

export async function advanceAtomicSwapChoreography(
  state: AtomicSwapChoreography,
  rawMessage: GranolaTradeMessage
): Promise<AtomicSwapChoreography> {
  if (state.phase === "settled" || state.phase === "failed") {
    throw new Error("Atomic swap choreography is terminal");
  }
  const message = await validateAtomicSwapMessage(rawMessage);

  if (message.type === "error") {
    if (state.phase === "awaiting_reserve_propose") {
      throw new Error("An error cannot precede the reservation proposal");
    }
    sameCommonSession(state, message);
    const body = message.body as ErrorBody;
    if (body.at_phase !== semanticPhase(state.phase)) {
      throw new Error("Error phase does not match the current choreography");
    }
    if (body.failed_message_id !== null && body.failed_message_id !== state.lastMessageId) {
      throw new Error("Error does not reference the last accepted message");
    }
    const maker = state.participants.makerSessionPubkey ??
      state.participants.makerOrderPubkey;
    const taker = state.participants.takerSessionPubkey;
    if (
      !taker ||
      !(
        (message.author_pubkey === maker && message.recipient_pubkey === taker) ||
        (message.author_pubkey === taker && message.recipient_pubkey === maker)
      )
    ) {
      throw new Error("Error must be exchanged between the current session counterparties");
    }
    return nextState(state, message, { phase: "failed" });
  }

  if (message.type === "refund") {
    if (!state.baseTokenCommitment) throw new Error("A refund requires a locked leg");
    sameCommonSession(state, message);
    const body = message.body as RefundBody;
    assertSettlement(state, body.settlement_hash);
    if (body.leg === "base") {
      assertRole(
        message,
        state.participants.makerSessionPubkey,
        state.participants.takerSessionPubkey
      );
      if (
        body.token_commitment !== state.baseTokenCommitment ||
        state.longLocktime === undefined ||
        body.refunded_at <= state.longLocktime + 60
      ) {
        throw new Error("Base refund is not bound to the locked leg or its recovery deadline");
      }
    } else {
      if (!state.quoteTokenCommitment) throw new Error("A quote refund requires a locked quote leg");
      assertRole(
        message,
        state.participants.takerSessionPubkey,
        state.participants.makerSessionPubkey
      );
      if (
        body.token_commitment !== state.quoteTokenCommitment ||
        state.shortLocktime === undefined ||
        body.refunded_at <= state.shortLocktime + 60
      ) {
        throw new Error("Quote refund is not bound to the locked leg or its recovery deadline");
      }
    }
    return nextState(state, message, {
      phase: "refunding",
      refundedLegs: [...new Set([...state.refundedLegs, body.leg])]
    });
  }

  expectedType(state, message.type);

  if (message.type === "reserve_propose") {
    const body = message.body as ReserveProposeBody;
    if (
      message.maker_order_pubkey !== state.participants.makerOrderPubkey ||
      message.recipient_pubkey !== state.participants.makerOrderPubkey ||
      message.author_pubkey !== body.taker_session_pubkey ||
      message.author_pubkey === message.recipient_pubkey
    ) {
      throw new Error("Reservation proposal must use the taker session author and maker order recipient");
    }
    if (message.previous_message_id !== null || message.previous_transcript_hash !== null) {
      throw new Error("Reservation proposal cannot have a predecessor");
    }
    return nextState(state, message, {
      phase: "awaiting_reserve_accept",
      sessionId: message.session_id,
      reservationId: message.reservation_id,
      orderAddress: message.order_address,
      termsHash: message.terms_hash,
      terms: structuredClone(message.terms!),
      participants: {
        makerOrderPubkey: state.participants.makerOrderPubkey,
        takerSessionPubkey: body.taker_session_pubkey,
        takerCashuPubkey: body.taker_cashu_pubkey,
        takerRefundPubkey: body.taker_refund_pubkey
      }
    });
  }

  sameCommonSession(state, message);
  const makerOrder = state.participants.makerOrderPubkey;
  const makerSession = state.participants.makerSessionPubkey;
  const takerSession = state.participants.takerSessionPubkey;

  if (message.type === "reserve_accept") {
    const body = message.body as ReserveAcceptBody;
    assertRole(message, makerOrder, takerSession);
    if (
      body.taker_session_pubkey !== takerSession ||
      body.reserve_transition_id !== message.order_head ||
      body.maker_session_pubkey === makerOrder ||
      body.maker_session_pubkey === takerSession
    ) {
      throw new Error("Reservation acceptance key handoff or transition is invalid");
    }
    if (
      body.maker_cashu_pubkey === state.participants.takerCashuPubkey ||
      body.maker_cashu_pubkey === state.participants.takerRefundPubkey ||
      body.maker_refund_pubkey === state.participants.takerCashuPubkey ||
      body.maker_refund_pubkey === state.participants.takerRefundPubkey
    ) {
      throw new Error("Cashu settlement and refund keys must be independent");
    }
    if (
      !message.terms ||
      canonicalJson(message.terms) !== canonicalJson(state.terms)
    ) {
      throw new Error("Reservation acceptance terms differ from the proposal");
    }
    return nextState(state, message, {
      phase: "awaiting_session_ack",
      orderHead: body.reserve_transition_id,
      settlementHash: body.settlement_hash,
      reserveTransitionId: body.reserve_transition_id,
      shortLocktime: body.short_locktime,
      longLocktime: body.long_locktime,
      participants: {
        ...state.participants,
        makerSessionPubkey: body.maker_session_pubkey,
        makerCashuPubkey: body.maker_cashu_pubkey,
        makerRefundPubkey: body.maker_refund_pubkey
      }
    });
  }

  if (message.type === "session_ack") {
    const body = message.body as SessionAckBody;
    assertRole(message, takerSession, makerSession);
    if (
      body.reserve_accept_message_id !== message.previous_message_id ||
      body.reserve_accept_transcript_hash !== message.previous_transcript_hash
    ) {
      throw new Error("Session acknowledgement does not bind the acceptance message");
    }
    if (
      body.reserve_transition_id !== state.reserveTransitionId ||
      body.settlement_hash !== state.settlementHash
    ) {
      throw new Error("Session acknowledgement changed the accepted reservation");
    }
    return nextState(state, message, { phase: "awaiting_base_lock" });
  }

  if (message.type === "base_lock") {
    const body = message.body as LockBody;
    assertRole(message, makerSession, takerSession);
    assertLockTerms(state, body, "base");
    if (
      body.receiver_cashu_pubkey !== state.participants.takerCashuPubkey ||
      body.refund_cashu_pubkey !== state.participants.makerRefundPubkey
    ) {
      throw new Error("Base lock receiver or refund key differs from the accepted participants");
    }
    return nextState(state, message, {
      phase: "awaiting_base_lock_ack",
      baseTokenCommitment: body.token_commitment,
      baseValidationCommitment: body.validation_commitment
    });
  }

  if (message.type === "base_lock_ack") {
    const body = message.body as LockAckBody;
    assertRole(message, takerSession, makerSession);
    if (
      body.lock_message_id !== message.previous_message_id ||
      body.lock_transcript_hash !== message.previous_transcript_hash
    ) {
      throw new Error("Base lock acknowledgement does not bind the lock message");
    }
    if (body.token_commitment !== state.baseTokenCommitment) {
      throw new Error("Base token commitment changed in the acknowledgement");
    }
    if (body.validation_commitment !== state.baseValidationCommitment) {
      throw new Error("Base validation commitment changed in the acknowledgement");
    }
    assertSettlement(state, body.settlement_hash);
    return nextState(state, message, { phase: "awaiting_quote_lock" });
  }

  if (message.type === "quote_lock") {
    const body = message.body as LockBody;
    assertRole(message, takerSession, makerSession);
    assertLockTerms(state, body, "quote");
    if (
      body.receiver_cashu_pubkey !== state.participants.makerCashuPubkey ||
      body.refund_cashu_pubkey !== state.participants.takerRefundPubkey
    ) {
      throw new Error("Quote lock receiver or refund key differs from the accepted participants");
    }
    return nextState(state, message, {
      phase: "awaiting_quote_lock_ack",
      quoteTokenCommitment: body.token_commitment,
      quoteValidationCommitment: body.validation_commitment
    });
  }

  if (message.type === "quote_lock_ack") {
    const body = message.body as LockAckBody;
    assertRole(message, makerSession, takerSession);
    if (
      body.lock_message_id !== message.previous_message_id ||
      body.lock_transcript_hash !== message.previous_transcript_hash
    ) {
      throw new Error("Quote lock acknowledgement does not bind the lock message");
    }
    if (body.token_commitment !== state.quoteTokenCommitment) {
      throw new Error("Quote token commitment changed in the acknowledgement");
    }
    if (body.validation_commitment !== state.quoteValidationCommitment) {
      throw new Error("Quote validation commitment changed in the acknowledgement");
    }
    assertSettlement(state, body.settlement_hash);
    return nextState(state, message, { phase: "awaiting_claim_notice" });
  }

  if (message.type === "claim_notice") {
    const body = message.body as ClaimNoticeBody;
    assertRole(message, makerSession, takerSession);
    if (body.quote_token_commitment !== state.quoteTokenCommitment) {
      throw new Error("Claim notice quote token commitment changed");
    }
    assertSettlement(state, body.settlement_hash);
    if (state.shortLocktime === undefined || body.claimed_at >= state.shortLocktime - 120) {
      throw new Error("Claim notice is outside the maker claim window");
    }
    return nextState(state, message, { phase: "awaiting_fill_request" });
  }

  if (message.type === "fill_request") {
    const body = message.body as FillRequestBody;
    assertRole(message, takerSession, makerSession);
    if (
      body.base_token_commitment !== state.baseTokenCommitment ||
      body.quote_token_commitment !== state.quoteTokenCommitment
    ) {
      throw new Error("Fill request token commitment changed");
    }
    assertSettlement(state, body.settlement_hash);
    return nextState(state, message, { phase: "awaiting_settlement_ack" });
  }

  const body = message.body as SettlementAckBody;
  assertRole(message, makerSession, takerSession);
  if (
    body.base_token_commitment !== state.baseTokenCommitment ||
    body.quote_token_commitment !== state.quoteTokenCommitment
  ) {
    throw new Error("Settlement acknowledgement token commitment changed");
  }
  assertSettlement(state, body.settlement_hash);
  return nextState(state, message, { phase: "settled" });
}
