import type {
  CashuOperationJournal,
  PrivateLegJournal,
  TradeLegEvidence,
  TradeOutboxJournal,
  TradeSession,
  TradeTranscriptJournal
} from "../trade/session.js";
import type { StorageDriver } from "./wallet-repository.js";

const TRADE_SESSIONS_KEY = "granola.trade-sessions.v2";
const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_INTEGER = /^(0|[1-9]\d*)$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const KEYSET = /^[0-9a-f]{16,66}$/;
const TRADE_PHASES = new Set([
  "negotiating", "reserved", "base_locked", "quote_locked", "quote_claimed",
  "base_claimed", "filled", "waiting_quote_refund", "waiting_base_refund",
  "waiting_base_claim", "released", "frozen"
]);
const CHOREOGRAPHY_PHASES = new Set([
  "awaiting_reserve_propose", "awaiting_reserve_accept", "awaiting_session_ack",
  "awaiting_base_lock", "awaiting_base_lock_ack", "awaiting_quote_lock",
  "awaiting_quote_lock_ack", "awaiting_claim_notice", "awaiting_fill_request",
  "awaiting_settlement_ack", "settled", "refunding", "failed"
]);
const MINT_STATES = new Set(["UNKNOWN", "UNSPENT", "PENDING", "SPENT"]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function safeTime(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function optionalHex(value: unknown, label: string): void {
  if (value !== null && (typeof value !== "string" || !HEX_32.test(value))) {
    throw new Error(`${label} is invalid`);
  }
}

function uniqueStrings(
  value: unknown,
  pattern: RegExp,
  label: string,
  allowEmpty = true
): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string" || !pattern.test(item)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function normalizedHttps(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.toString().replace(/\/$/, "") !== value
  ) throw new Error(`${label} is invalid`);
  return value;
}

function validateEvent(
  value: unknown,
  expectedKind: number,
  label: string,
  signed = true
): void {
  const event = object(value, label);
  if (
    event.kind !== expectedKind ||
    !Number.isSafeInteger(event.created_at) ||
    typeof event.content !== "string" ||
    !Array.isArray(event.tags) ||
    event.tags.some((tag) =>
      !Array.isArray(tag) || tag.some((item) => typeof item !== "string")
    ) ||
    typeof event.id !== "string" ||
    !HEX_32.test(event.id) ||
    typeof event.pubkey !== "string" ||
    !HEX_32.test(event.pubkey) ||
    (signed && (typeof event.sig !== "string" || !HEX_64.test(event.sig)))
  ) throw new Error(`${label} is invalid`);
}

function validateChoreography(value: unknown): void {
  const choreography = object(value, "Trade choreography");
  if (
    typeof choreography.phase !== "string" ||
    !CHOREOGRAPHY_PHASES.has(choreography.phase) ||
    !Array.isArray(choreography.refundedLegs) ||
    choreography.refundedLegs.some((leg) => leg !== "base" && leg !== "quote") ||
    new Set(choreography.refundedLegs).size !== choreography.refundedLegs.length
  ) throw new Error("Trade choreography is invalid");
  const participants = object(choreography.participants, "Trade participants");
  if (
    typeof participants.makerOrderPubkey !== "string" ||
    !HEX_32.test(participants.makerOrderPubkey)
  ) throw new Error("Trade participants are invalid");
  for (const field of ["makerSessionPubkey", "takerSessionPubkey"] as const) {
    if (participants[field] !== undefined &&
      (typeof participants[field] !== "string" || !HEX_32.test(participants[field] as string))) {
      throw new Error("Trade participants are invalid");
    }
  }
}

function validateTranscript(value: unknown): asserts value is TradeTranscriptJournal {
  const transcript = object(value, "Trade transcript");
  validateChoreography(transcript.choreography);
  if (typeof transcript.nextSequence !== "string" || !CANONICAL_INTEGER.test(transcript.nextSequence)) {
    throw new Error("Trade transcript sequence is invalid");
  }
  optionalHex(transcript.lastRumorId, "Last rumor ID");
  if (
    transcript.lastMessageId !== null &&
    (typeof transcript.lastMessageId !== "string" || !UUID_V4.test(transcript.lastMessageId))
  ) throw new Error("Last message ID is invalid");
  optionalHex(transcript.lastTranscriptHash, "Last transcript hash");
  uniqueStrings(transcript.acceptedRumorIds, HEX_32, "Accepted rumor IDs");
  uniqueStrings(transcript.acceptedMessageIds, UUID_V4, "Accepted message IDs");
  const lastValues = [
    transcript.lastRumorId,
    transcript.lastMessageId,
    transcript.lastTranscriptHash
  ];
  if (lastValues.some((item) => item === null) && lastValues.some((item) => item !== null)) {
    throw new Error("Trade transcript head is incomplete");
  }
}

function validateMessage(value: unknown): void {
  const message = object(value, "Trade outbox message");
  if (
    message.schema !== "granola/dm/v1" ||
    message.deployment !== "cashu-testnet-v1" ||
    typeof message.message_id !== "string" ||
    !UUID_V4.test(message.message_id) ||
    typeof message.session_id !== "string" ||
    !HEX_32.test(message.session_id) ||
    typeof message.reservation_id !== "string" ||
    !UUID_V4.test(message.reservation_id) ||
    typeof message.sequence !== "string" ||
    !CANONICAL_INTEGER.test(message.sequence) ||
    typeof message.body !== "object" ||
    message.body === null
  ) throw new Error("Trade outbox message is invalid");
}

function validateOutbox(value: unknown): asserts value is TradeOutboxJournal {
  const outbox = object(value, "Trade outbox");
  validateMessage(outbox.message);
  validateEvent(outbox.rumor, 14, "Trade rumor", false);
  validateEvent(outbox.seal, 13, "Trade seal");
  validateEvent(outbox.wrapper, 1059, "Trade wrapper");
  if (typeof outbox.recipientInboxListId !== "string" || !HEX_32.test(outbox.recipientInboxListId)) {
    throw new Error("Recipient inbox list ID is invalid");
  }
  const relays = uniqueStrings(
    outbox.recipientRelays,
    /^wss:\/\/[^?#]+$/,
    "Recipient relays",
    false
  );
  if (relays.length > 3) throw new Error("Recipient relays are invalid");
  if (
    !Array.isArray(outbox.receipts) ||
    outbox.receipts.some((receipt) =>
      !receipt || typeof receipt !== "object" ||
      typeof receipt.relay !== "string" ||
      typeof receipt.ok !== "boolean" ||
      typeof receipt.message !== "string"
    ) ||
    (outbox.status !== "staged" && outbox.status !== "acknowledged")
  ) throw new Error("Trade outbox receipts or status are invalid");
  validateChoreography(outbox.nextChoreography);
}

function validateExpectedLock(value: unknown): void {
  const expected = object(value, "Expected HTLC lock");
  normalizedHttps(expected.mintUrl, "Expected HTLC mint");
  if (
    typeof expected.unit !== "string" ||
    !/^[a-z][a-z0-9_-]{0,31}$/.test(expected.unit) ||
    typeof expected.amount !== "string" ||
    !POSITIVE_INTEGER.test(expected.amount) ||
    typeof expected.hash !== "string" ||
    !HEX_32.test(expected.hash) ||
    typeof expected.receiverPubkey !== "string" ||
    !/^(02|03)[0-9a-f]{64}$/.test(expected.receiverPubkey) ||
    typeof expected.refundPubkey !== "string" ||
    !/^(02|03)[0-9a-f]{64}$/.test(expected.refundPubkey) ||
    (expected.leg !== "base" && expected.leg !== "quote")
  ) throw new Error("Expected HTLC lock is invalid");
  safeTime(expected.locktime, "Expected HTLC locktime");
  safeTime(expected.refundHorizon, "Expected HTLC refund horizon");
  const binding = object(expected.binding, "Expected HTLC binding");
  if (
    typeof binding.sessionId !== "string" || !HEX_32.test(binding.sessionId) ||
    typeof binding.reservationId !== "string" || !UUID_V4.test(binding.reservationId) ||
    typeof binding.transcriptHash !== "string" || !HEX_32.test(binding.transcriptHash) ||
    binding.direction !== expected.leg
  ) throw new Error("Expected HTLC binding is invalid");
}

function validateCashuOperation(value: unknown): asserts value is CashuOperationJournal {
  const operation = object(value, "Cashu operation journal");
  if (
    typeof operation.operationId !== "string" ||
    !UUID_V4.test(operation.operationId) ||
    (operation.leg !== "base" && operation.leg !== "quote") ||
    !["outgoing-lock", "claim", "refund"].includes(operation.kind as string) ||
    !["prepared", "completed", "wallet_applied"].includes(operation.status as string)
  ) throw new Error("Cashu operation metadata is invalid");
  const artifact = object(operation.artifact, "Cashu operation artifact");
  if (
    artifact.version !== 1 ||
    artifact.kind !== operation.kind ||
    typeof artifact.mintUrl !== "string" ||
    typeof artifact.unit !== "string" ||
    typeof artifact.operationCommitment !== "string" ||
    !HEX_32.test(artifact.operationCommitment) ||
    !Array.isArray(artifact.spentSecrets) ||
    artifact.spentSecrets.length === 0 ||
    artifact.spentSecrets.some((secret) => typeof secret !== "string" || !secret) ||
    new Set(artifact.spentSecrets).size !== artifact.spentSecrets.length
  ) throw new Error("Cashu operation artifact is invalid");
  object(artifact.preview, "Cashu operation preview");
  validateExpectedLock(artifact.expected);
  if (operation.status === "prepared" && operation.result !== null) {
    throw new Error("Prepared Cashu operation cannot have a completed result");
  }
  if (operation.status !== "prepared" && operation.result === null) {
    throw new Error("Completed Cashu operation requires an exact result");
  }
  if (operation.result !== null) {
    const result = object(operation.result, "Cashu operation result");
    if (
      (result.walletMutation !== "replace" && result.walletMutation !== "receive") ||
      typeof result.mintUrl !== "string" ||
      typeof result.unit !== "string" ||
      !Array.isArray(result.proofs) ||
      result.proofs.some((proof) => {
        if (!proof || typeof proof !== "object") return true;
        const item = proof as Record<string, unknown>;
        return typeof item.amount !== "string" || !POSITIVE_INTEGER.test(item.amount) ||
          typeof item.id !== "string" || typeof item.secret !== "string" ||
          typeof item.C !== "string";
      }) ||
      !(typeof result.lockedToken === "string" || result.lockedToken === null) ||
      typeof result.amount !== "string" ||
      !POSITIVE_INTEGER.test(result.amount) ||
      !Number.isSafeInteger(result.proofCount) ||
      (result.proofCount as number) < 1
    ) throw new Error("Cashu operation result is invalid");
  }
}

function validatePrivateLeg(value: unknown): asserts value is PrivateLegJournal {
  const leg = object(value, "Private trade leg");
  if (!(typeof leg.token === "string" || leg.token === null)) {
    throw new Error("Private trade token is invalid");
  }
  if (leg.expected !== null) validateExpectedLock(leg.expected);
  if (
    !Array.isArray(leg.observations) ||
    leg.observations.some((observation) => {
      if (!observation || typeof observation !== "object") return true;
      const item = observation as Record<string, unknown>;
      return !Number.isSafeInteger(item.observedAt) ||
        typeof item.state !== "string" || !MINT_STATES.has(item.state) ||
        !Number.isSafeInteger(item.proofCount) || (item.proofCount as number) < 1 ||
        !(item.witnessCommitment === null ||
          (typeof item.witnessCommitment === "string" && HEX_32.test(item.witnessCommitment)));
    })
  ) throw new Error("Private trade observations are invalid");
}

function validateLegEvidence(value: unknown): asserts value is TradeLegEvidence {
  const leg = object(value, "Trade leg evidence");
  optionalHex(leg.tokenCommitment, "Token commitment");
  optionalHex(leg.validationCommitment, "Validation commitment");
  optionalHex(leg.spendCommitment, "Spend commitment");
  optionalHex(leg.claimOperationCommitment, "Claim operation commitment");
  optionalHex(leg.refundOperationCommitment, "Refund operation commitment");
  if (
    typeof leg.keysetId !== "string" ||
    !KEYSET.test(leg.keysetId) ||
    !(leg.proofCount === null || (Number.isSafeInteger(leg.proofCount) && (leg.proofCount as number) > 0)) ||
    !(leg.fee === null || (typeof leg.fee === "string" && CANONICAL_INTEGER.test(leg.fee))) ||
    typeof leg.mintState !== "string" ||
    !MINT_STATES.has(leg.mintState) ||
    !(leg.observedAt === null || (Number.isSafeInteger(leg.observedAt) && (leg.observedAt as number) >= 0))
  ) throw new Error("Trade leg evidence is invalid");
}

function validateSpentEvidence(
  evidence: TradeLegEvidence,
  privateLeg: PrivateLegJournal
): void {
  if (evidence.mintState !== "SPENT") return;
  if (
    evidence.observedAt === null ||
    evidence.proofCount === null ||
    evidence.spendCommitment === null
  ) {
    throw new Error("SPENT trade evidence is incomplete");
  }
  const matchesPrivateObservation = privateLeg.observations.some((observation) =>
    observation.state === "SPENT" &&
    observation.observedAt === evidence.observedAt &&
    observation.proofCount === evidence.proofCount &&
    observation.witnessCommitment === evidence.spendCommitment
  );
  if (!matchesPrivateObservation) {
    throw new Error("SPENT trade evidence lacks its matching private observation");
  }
}

function assertSession(value: unknown): asserts value is TradeSession {
  const session = object(value, "Trade session storage");
  if (session.schema !== "granola/trade-session/v2") {
    throw new Error(`Unsupported trade session schema: ${String(session.schema)}`);
  }
  if (
    !Number.isSafeInteger(session.revision) ||
    (session.revision as number) < 0 ||
    typeof session.sessionId !== "string" ||
    !HEX_32.test(session.sessionId) ||
    typeof session.reservationId !== "string" ||
    !UUID_V4.test(session.reservationId) ||
    (session.role !== "maker" && session.role !== "taker") ||
    typeof session.phase !== "string" ||
    !TRADE_PHASES.has(session.phase) ||
    typeof session.orderAddress !== "string" ||
    typeof session.offeredOrderHead !== "string" ||
    !HEX_32.test(session.offeredOrderHead)
  ) throw new Error("Trade session metadata is invalid");
  optionalHex(session.reserveTransitionId, "Reserve transition ID");
  optionalHex(session.fillTransitionId, "Fill transition ID");
  const createdAt = safeTime(session.createdAt, "Trade creation time");
  const updatedAt = safeTime(session.updatedAt, "Trade update time");
  if (updatedAt < createdAt) throw new Error("Trade update time is invalid");

  const terms = object(session.terms, "Trade terms");
  normalizedHttps(terms.baseMint, "Base mint");
  normalizedHttps(terms.quoteMint, "Quote mint");
  if (
    typeof terms.baseUnit !== "string" ||
    typeof terms.quoteUnit !== "string" ||
    typeof terms.baseKeyset !== "string" ||
    !KEYSET.test(terms.baseKeyset) ||
    typeof terms.quoteKeyset !== "string" ||
    !KEYSET.test(terms.quoteKeyset) ||
    typeof terms.baseAmount !== "string" ||
    !POSITIVE_INTEGER.test(terms.baseAmount) ||
    typeof terms.quoteAmount !== "string" ||
    !POSITIVE_INTEGER.test(terms.quoteAmount)
  ) throw new Error("Trade terms are invalid");
  const price = object(terms.price, "Trade price");
  if (
    typeof price.numerator !== "string" || !POSITIVE_INTEGER.test(price.numerator) ||
    typeof price.denominator !== "string" || !POSITIVE_INTEGER.test(price.denominator)
  ) throw new Error("Trade price is invalid");

  const plan = object(session.plan, "Settlement plan");
  for (const field of [
    "anchor", "shortLocktime", "makerClaimCutoff", "longLocktime",
    "takerClaimCutoff", "reservationExpiresAt", "refundGuardSeconds"
  ]) safeTime(plan[field], `Settlement plan ${field}`);
  if (
    plan.makerClaimCutoff !== (plan.shortLocktime as number) - 120 ||
    plan.longLocktime !== (plan.shortLocktime as number) + 600 ||
    plan.takerClaimCutoff !== (plan.longLocktime as number) - 120 ||
    plan.refundGuardSeconds !== 60
  ) throw new Error("Settlement plan profile is invalid");

  const evidence = object(session.evidence, "Trade evidence");
  if (
    typeof evidence.makerPubkey !== "string" ||
    !HEX_32.test(evidence.makerPubkey) ||
    !Array.isArray(evidence.commitments) ||
    evidence.commitments.some((item) => typeof item !== "string" || !HEX_32.test(item)) ||
    !Array.isArray(evidence.mintStates) ||
    evidence.mintStates.some((item) => typeof item !== "string")
  ) throw new Error("Trade evidence is invalid");
  const evidenceLegs = object(evidence.legs, "Trade evidence legs");
  validateLegEvidence(evidenceLegs.base);
  validateLegEvidence(evidenceLegs.quote);

  if (session.pendingOrderPublication !== null) {
    const pending = object(session.pendingOrderPublication, "Pending order publication");
    if (
      (pending.operation !== "reserve" && pending.operation !== "fill") ||
      (pending.stage !== "transition" && pending.stage !== "projection") ||
      typeof pending.orderId !== "string" ||
      !UUID_V4.test(pending.orderId) ||
      typeof pending.transitionId !== "string" ||
      !HEX_32.test(pending.transitionId) ||
      typeof pending.projectionId !== "string" ||
      !HEX_32.test(pending.projectionId)
    ) throw new Error("Pending order publication is invalid");
  }

  const privateState = object(session.privateState, "Trade private state");
  for (const field of ["nostrPrivateKey", "cashuPrivateKey", "refundPrivateKey"]) {
    if (typeof privateState[field] !== "string" || !HEX_32.test(privateState[field] as string)) {
      throw new Error("Trade private key is invalid");
    }
  }
  optionalHex(privateState.preimage, "Trade preimage");
  optionalHex(privateState.settlementTranscriptHash, "Settlement transcript hash");
  const inbox = object(privateState.inbox, "Trade inbox checkpoint");
  optionalHex(inbox.listEventId, "Trade inbox list event ID");
  if (
    !(inbox.registeredAt === null ||
      (Number.isSafeInteger(inbox.registeredAt) && (inbox.registeredAt as number) >= 0)) ||
    !Array.isArray(inbox.relays) ||
    inbox.relays.some((relay) => typeof relay !== "string" || !/^wss:\/\/[^?#]+$/.test(relay)) ||
    new Set(inbox.relays).size !== inbox.relays.length ||
    inbox.relays.length > 3
  ) throw new Error("Trade inbox checkpoint is invalid");
  const unregistered = inbox.listEventId === null && inbox.registeredAt === null;
  const registered = inbox.listEventId !== null && inbox.registeredAt !== null &&
    inbox.relays.length > 0;
  if ((!unregistered && !registered) || (unregistered && inbox.relays.length !== 0)) {
    throw new Error("Trade inbox checkpoint is incomplete");
  }
  validateTranscript(privateState.transcript);
  if (privateState.outbox !== null) validateOutbox(privateState.outbox);
  if (privateState.cashuOperation !== null) validateCashuOperation(privateState.cashuOperation);
  const privateLegs = object(privateState.legs, "Private trade legs");
  const privateBase = privateLegs.base;
  const privateQuote = privateLegs.quote;
  validatePrivateLeg(privateBase);
  validatePrivateLeg(privateQuote);
  validateSpentEvidence(evidenceLegs.base, privateBase);
  validateSpentEvidence(evidenceLegs.quote, privateQuote);
}

function assertSessions(value: unknown): asserts value is TradeSession[] {
  if (!Array.isArray(value)) throw new Error("Trade session storage is corrupt");
  const seen = new Set<string>();
  for (const session of value) {
    assertSession(session);
    if (seen.has(session.sessionId)) throw new Error("Trade session storage has duplicate IDs");
    seen.add(session.sessionId);
  }
}

export type TradeSessionExclusiveRunner = <T>(action: () => Promise<T>) => Promise<T>;

const withoutCrossTabLock: TradeSessionExclusiveRunner = async <T>(
  action: () => Promise<T>
): Promise<T> => action();

export class TradeSessionRepository {
  constructor(
    private readonly driver: StorageDriver,
    private readonly runExclusive: TradeSessionExclusiveRunner = withoutCrossTabLock
  ) {}

  async list(): Promise<TradeSession[]> {
    const stored = await this.driver.get(TRADE_SESSIONS_KEY);
    if (stored === undefined || stored === null) return [];
    assertSessions(stored);
    return clone(stored);
  }

  async get(sessionId: string): Promise<TradeSession | undefined> {
    return (await this.list()).find((session) => session.sessionId === sessionId);
  }

  async save(session: TradeSession, expectedRevision: number | null): Promise<void> {
    assertSession(session);
    await this.runExclusive(async () => {
      const sessions = await this.list();
      const index = sessions.findIndex((item) => item.sessionId === session.sessionId);
      const current = sessions[index];
      if (!current) {
        if (expectedRevision !== null || session.revision !== 0) {
          throw new Error("Trade session creation requires revision zero");
        }
        sessions.push(clone(session));
      } else {
        if (expectedRevision === null) throw new Error("Trade session already exists");
        if (current.revision !== expectedRevision) {
          throw new Error("Trade session compare-and-swap revision failed");
        }
        if (session.revision !== expectedRevision + 1) {
          throw new Error("Trade session revision must advance exactly one step");
        }
        if (session.updatedAt < current.updatedAt) {
          throw new Error("Trade session update time regressed");
        }
        sessions[index] = clone(session);
      }
      assertSessions(sessions);
      await this.driver.set(TRADE_SESSIONS_KEY, sessions);
    });
  }
}
