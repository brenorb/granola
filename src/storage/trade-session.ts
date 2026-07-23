import { verifyHTLCHash } from "@cashu/cashu-ts";
import { getEventHash, getPublicKey, verifyEvent } from "nostr-tools";

import type { NostrEvent } from "../order/events.js";
import type {
  CashuOperationJournal,
  PrivateLegJournal,
  TradeInboxJournal,
  TradePendingIncomingJournal,
  TradeLegEvidence,
  TradeOutboxJournal,
  TradeSession,
  TradeTranscriptJournal
} from "../trade/session.js";
import { EncryptedStorageDriver } from "./encrypted-storage.js";
import type { StorageDriver } from "./wallet-repository.js";

const TRADE_SESSIONS_KEY = "granola.trade-sessions.v2";
const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ORDER_ADDRESS = new RegExp(
  `^30078:[0-9a-f]{64}:granola:order:v1:${UUID_V4.source.slice(1, -1)}$`
);
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

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) throw new Error(`${label} contains missing or unknown fields`);
}

function exactAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) throw new Error(`${label} contains missing or unknown fields`);
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

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
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
  exactKeys(
    event,
    signed
      ? ["id", "pubkey", "created_at", "kind", "tags", "content", "sig"]
      : ["id", "pubkey", "created_at", "kind", "tags", "content"],
    label
  );
  if (
    event.kind !== expectedKind ||
    !Number.isSafeInteger(event.created_at) ||
    (event.created_at as number) < 0 ||
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
  if (signed) {
    const snapshot: NostrEvent = {
      id: event.id as string,
      pubkey: event.pubkey as string,
      created_at: event.created_at as number,
      kind: event.kind as number,
      tags: (event.tags as string[][]).map((tag) => [...tag]),
      content: event.content as string,
      sig: event.sig as string
    };
    if (!verifyEvent(snapshot)) {
      throw new Error(`${label} signature is invalid`);
    }
  } else if (getEventHash(event as never) !== event.id) {
    throw new Error(`${label} ID is invalid`);
  }
}

function validateRelayList(value: unknown, label: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} is invalid`);
  }
  const relays = value.map((value) => {
    if (typeof value !== "string") throw new Error(`${label} is invalid`);
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${label} is invalid`);
    }
    if (
      parsed.protocol !== "wss:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) throw new Error(`${label} is invalid`);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    const normalized = parsed.toString().replace(/\/$/, "");
    if (normalized !== value) throw new Error(`${label} is invalid`);
    return normalized;
  });
  if (new Set(relays).size !== relays.length || relays.length > 3) {
    throw new Error(`${label} is invalid`);
  }
  return relays;
}

function validateReceipts(
  value: unknown,
  relays: readonly string[],
  label: string
): Array<{ relay: string; ok: boolean; message: string }> {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid`);
  const receipts = value.map((receipt) => {
    const item = object(receipt, label);
    exactKeys(item, ["relay", "ok", "message"], label);
    if (
      typeof item.relay !== "string" ||
      !relays.includes(item.relay) ||
      typeof item.ok !== "boolean" ||
      typeof item.message !== "string"
    ) throw new Error(`${label} is invalid`);
    return item as { relay: string; ok: boolean; message: string };
  });
  if (new Set(receipts.map(({ relay }) => relay)).size !== receipts.length) {
    throw new Error(`${label} is invalid`);
  }
  return receipts;
}

function validateChoreography(value: unknown): void {
  const choreography = object(value, "Trade choreography");
  exactAllowedKeys(
    choreography,
    ["phase", "participants", "refundedLegs"],
    [
      "sessionId",
      "reservationId",
      "orderAddress",
      "orderProjectionId",
      "orderRevision",
      "termsHash",
      "terms",
      "lastMessageId",
      "settlementHash",
      "reserveProjectionId",
      "reserveProjectionRevision",
      "shortLocktime",
      "longLocktime",
      "baseTokenCommitment",
      "baseValidationCommitment",
      "quoteTokenCommitment",
      "quoteValidationCommitment"
    ],
    "Trade choreography"
  );
  if (
    typeof choreography.phase !== "string" ||
    !CHOREOGRAPHY_PHASES.has(choreography.phase) ||
    !Array.isArray(choreography.refundedLegs) ||
    choreography.refundedLegs.some((leg) => leg !== "base" && leg !== "quote") ||
    new Set(choreography.refundedLegs).size !== choreography.refundedLegs.length
  ) throw new Error("Trade choreography is invalid");
  const participants = object(choreography.participants, "Trade participants");
  exactAllowedKeys(
    participants,
    ["makerOrderPubkey"],
    [
      "makerSessionPubkey",
      "takerSessionPubkey",
      "makerCashuPubkey",
      "makerRefundPubkey",
      "takerCashuPubkey",
      "takerRefundPubkey"
    ],
    "Trade participants"
  );
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
  for (const field of [
    "makerCashuPubkey",
    "makerRefundPubkey",
    "takerCashuPubkey",
    "takerRefundPubkey"
  ] as const) {
    if (
      participants[field] !== undefined &&
      (typeof participants[field] !== "string" ||
        !/^(02|03)[0-9a-f]{64}$/.test(participants[field] as string))
    ) throw new Error("Trade participants are invalid");
  }
}

function validateTranscript(value: unknown): asserts value is TradeTranscriptJournal {
  const transcript = object(value, "Trade transcript");
  exactKeys(transcript, [
    "choreography",
    "nextSequence",
    "lastRumorId",
    "lastMessageId",
    "lastTranscriptHash",
    "accepted"
  ], "Trade transcript");
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
  if (!Array.isArray(transcript.accepted)) {
    throw new Error("Accepted trade transcript is invalid");
  }
  const accepted = transcript.accepted.map((value, index) => {
    const entry = object(value, "Accepted trade transcript entry");
    exactKeys(
      entry,
      ["sequence", "messageId", "rumorId", "transcriptHash"],
      "Accepted trade transcript entry"
    );
    if (
      entry.sequence !== String(index) ||
      typeof entry.messageId !== "string" ||
      !UUID_V4.test(entry.messageId) ||
      typeof entry.rumorId !== "string" ||
      !HEX_32.test(entry.rumorId) ||
      typeof entry.transcriptHash !== "string" ||
      !HEX_32.test(entry.transcriptHash)
    ) throw new Error("Accepted trade transcript entry is invalid");
    return entry as {
      sequence: string;
      messageId: string;
      rumorId: string;
      transcriptHash: string;
    };
  });
  for (const [field, values] of [
    ["sequence", accepted.map(({ sequence }) => sequence)],
    ["message ID", accepted.map(({ messageId }) => messageId)],
    ["rumor ID", accepted.map(({ rumorId }) => rumorId)],
    ["transcript hash", accepted.map(({ transcriptHash }) => transcriptHash)]
  ] as const) {
    if (new Set(values).size !== values.length) {
      throw new Error(`Accepted trade transcript has a duplicate ${field}`);
    }
  }
  if (transcript.nextSequence !== String(accepted.length)) {
    throw new Error("Trade transcript sequence does not follow accepted messages");
  }
  const lastValues = [
    transcript.lastRumorId,
    transcript.lastMessageId,
    transcript.lastTranscriptHash
  ];
  if (lastValues.some((item) => item === null) && lastValues.some((item) => item !== null)) {
    throw new Error("Trade transcript head is incomplete");
  }
  const head = accepted.at(-1);
  if (
    (head === undefined && lastValues.some((item) => item !== null)) ||
    (head !== undefined && (
      transcript.lastRumorId !== head.rumorId ||
      transcript.lastMessageId !== head.messageId ||
      transcript.lastTranscriptHash !== head.transcriptHash
    ))
  ) throw new Error("Trade transcript head does not match its accepted tuple");
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
  exactKeys(outbox, [
    "message",
    "rumor",
    "seal",
    "wrapper",
    "recipientInboxListId",
    "recipientRelays",
    "receipts",
    "nextChoreography",
    "status"
  ], "Trade outbox");
  validateMessage(outbox.message);
  validateEvent(outbox.rumor, 14, "Trade rumor", false);
  validateEvent(outbox.seal, 13, "Trade seal");
  validateEvent(outbox.wrapper, 1059, "Trade wrapper");
  if (typeof outbox.recipientInboxListId !== "string" || !HEX_32.test(outbox.recipientInboxListId)) {
    throw new Error("Recipient inbox list ID is invalid");
  }
  const relays = validateRelayList(outbox.recipientRelays, "Recipient relays", false);
  validateReceipts(outbox.receipts, relays, "Trade outbox receipts");
  if (
    (outbox.status !== "staged" && outbox.status !== "acknowledged")
  ) throw new Error("Trade outbox receipts or status are invalid");
  const receipts = outbox.receipts as Array<{ ok: boolean }>;
  if (
    (outbox.status === "acknowledged" && !receipts.some(({ ok }) => ok))
  ) throw new Error("Trade outbox status does not match its receipts");
  validateChoreography(outbox.nextChoreography);
}

function validateExpectedLock(value: unknown): void {
  const expected = object(value, "Expected HTLC lock");
  exactKeys(expected, [
    "mintUrl",
    "unit",
    "binding",
    "amount",
    "hash",
    "receiverPubkey",
    "refundPubkey",
    "locktime",
    "leg",
    "refundHorizon",
    "deadlines"
  ], "Expected HTLC lock");
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
  exactKeys(binding, [
    "protocolVersion",
    "network",
    "orderId",
    "reservationId",
    "sessionId",
    "direction",
    "transcriptHash"
  ], "Expected HTLC binding");
  if (
    typeof binding.sessionId !== "string" || !HEX_32.test(binding.sessionId) ||
    typeof binding.reservationId !== "string" || !UUID_V4.test(binding.reservationId) ||
    typeof binding.transcriptHash !== "string" || !HEX_32.test(binding.transcriptHash) ||
    binding.direction !== expected.leg
  ) throw new Error("Expected HTLC binding is invalid");
  const deadlines = object(expected.deadlines, "Expected HTLC deadlines");
  exactKeys(deadlines, ["short", "long", "minimumGap"], "Expected HTLC deadlines");
  const short = safeTime(deadlines.short, "Expected HTLC short deadline");
  const long = safeTime(deadlines.long, "Expected HTLC long deadline");
  const gap = long - short;
  if (
    (deadlines.minimumGap !== 600 && deadlines.minimumGap !== 3 * 86_400) ||
    deadlines.minimumGap !== gap
  ) {
    throw new Error("Expected HTLC deadlines are invalid");
  }
}

function validateCashuOperation(value: unknown): asserts value is CashuOperationJournal {
  const operation = object(value, "Cashu operation journal");
  exactKeys(operation, [
    "operationId",
    "leg",
    "kind",
    "status",
    "preparedAt",
    "inputsReserved",
    "artifact",
    "result"
  ], "Cashu operation journal");
  if (
    typeof operation.operationId !== "string" ||
    !UUID_V4.test(operation.operationId) ||
    (operation.leg !== "base" && operation.leg !== "quote") ||
    !["outgoing-lock", "claim", "refund"].includes(operation.kind as string) ||
    !["prepared", "completed", "wallet_applied"].includes(operation.status as string) ||
    typeof operation.inputsReserved !== "boolean"
  ) throw new Error("Cashu operation metadata is invalid");
  safeTime(operation.preparedAt, "Cashu operation prepared time");
  if (operation.status !== "prepared" && operation.inputsReserved !== true) {
    throw new Error("Completed Cashu operation requires reserved inputs");
  }
  const artifact = object(operation.artifact, "Cashu operation artifact");
  exactKeys(artifact, [
    "version",
    "kind",
    "mintUrl",
    "unit",
    "preview",
    "spentSecrets",
    "expected",
    "operationCommitment"
  ], "Cashu operation artifact");
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
  const expected = artifact.expected as Record<string, unknown>;
  if (
    artifact.mintUrl !== expected.mintUrl ||
    artifact.unit !== expected.unit ||
    operation.leg !== expected.leg
  ) throw new Error("Cashu operation artifact disagrees with its expected lock");
  if (operation.status === "prepared" && operation.result !== null) {
    throw new Error("Prepared Cashu operation cannot have a completed result");
  }
  if (operation.status !== "prepared" && operation.result === null) {
    throw new Error("Completed Cashu operation requires an exact result");
  }
  if (operation.result !== null) {
    const result = object(operation.result, "Cashu operation result");
    exactKeys(result, [
      "walletMutation",
      "mintUrl",
      "unit",
      "proofs",
      "lockedToken",
      "amount",
      "proofCount"
    ], "Cashu operation result");
    if (
      (result.walletMutation !== "replace" && result.walletMutation !== "receive") ||
      typeof result.mintUrl !== "string" ||
      typeof result.unit !== "string" ||
      !Array.isArray(result.proofs) ||
      result.proofs.some((proof) => {
        if (!proof || typeof proof !== "object") return true;
        const item = proof as Record<string, unknown>;
        try {
          exactAllowedKeys(
            item,
            ["amount", "id", "secret", "C"],
            ["dleq"],
            "Cashu operation proof"
          );
          if (item.dleq !== undefined) {
            exactKeys(
              object(item.dleq, "Cashu operation proof DLEQ"),
              ["e", "s", "r"],
              "Cashu operation proof DLEQ"
            );
          }
        } catch {
          return true;
        }
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
    if (
      result.mintUrl !== artifact.mintUrl ||
      result.unit !== artifact.unit ||
      result.amount !== expected.amount
    ) throw new Error("Cashu operation result disagrees with its prepared artifact");
    if (operation.kind === "outgoing-lock") {
      if (
        result.walletMutation !== "replace" ||
        typeof result.lockedToken !== "string" ||
        result.lockedToken.length === 0
      ) throw new Error("Outgoing lock result must retain its exact locked token");
    } else if (
      result.walletMutation !== "receive" ||
      result.lockedToken !== null ||
      (result.proofs as unknown[]).length === 0 ||
      result.proofCount !== (result.proofs as unknown[]).length
    ) {
      throw new Error("Claim or refund result must contain its exact received proofs");
    }
  }
}

function validatePrivateLeg(value: unknown): asserts value is PrivateLegJournal {
  const leg = object(value, "Private trade leg");
  exactKeys(leg, ["token", "expected", "observations"], "Private trade leg");
  if (!(leg.token === null || (typeof leg.token === "string" && leg.token.length > 0))) {
    throw new Error("Private trade token is invalid");
  }
  if (leg.expected !== null) validateExpectedLock(leg.expected);
  if (!Array.isArray(leg.observations)) {
    throw new Error("Private trade observations are invalid");
  }
  const observations = leg.observations;
  if (
    observations.some((observation, index) => {
      if (!observation || typeof observation !== "object") return true;
      const item = observation as Record<string, unknown>;
      try {
        exactKeys(
          item,
          ["observedAt", "state", "proofCount", "witnessCommitment"],
          "Private trade observation"
        );
      } catch {
        return true;
      }
      const previous = index === 0
        ? undefined
        : observations[index - 1] as Record<string, unknown>;
      return !Number.isSafeInteger(item.observedAt) ||
        (item.observedAt as number) < 0 ||
        (previous !== undefined &&
          (item.observedAt as number) <= (previous.observedAt as number)) ||
        typeof item.state !== "string" || !MINT_STATES.has(item.state) ||
        !Number.isSafeInteger(item.proofCount) || (item.proofCount as number) < 1 ||
        !(item.witnessCommitment === null ||
          (typeof item.witnessCommitment === "string" && HEX_32.test(item.witnessCommitment))) ||
        (item.state === "SPENT") !== (item.witnessCommitment !== null);
    })
  ) throw new Error("Private trade observations are invalid");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateInbox(value: unknown): asserts value is TradeInboxJournal {
  const inbox = object(value, "Trade inbox checkpoint");
  exactKeys(inbox, [
    "status",
    "quorum",
    "event",
    "discoveryRelays",
    "inboxRelays",
    "receipts",
    "readbacks",
    "stagedAt",
    "acknowledgedAt",
    "registeredAt"
  ], "Trade inbox checkpoint");
  if (!["unregistered", "staged", "acknowledged", "registered"].includes(inbox.status as string)) {
    throw new Error("Trade inbox status is invalid");
  }
  if (
    !Number.isSafeInteger(inbox.quorum) ||
    (inbox.quorum as number) < 1 ||
    (inbox.quorum as number) > 3
  ) throw new Error("Trade inbox quorum is invalid");
  const quorum = inbox.quorum as number;
  const discoveryRelays = validateRelayList(
    inbox.discoveryRelays,
    "Trade inbox discovery relays",
    inbox.status === "unregistered"
  );
  const inboxRelays = validateRelayList(
    inbox.inboxRelays,
    "Trade inbox recipient relays",
    inbox.status === "unregistered"
  );
  const receipts = validateReceipts(
    inbox.receipts,
    discoveryRelays,
    "Trade inbox receipts"
  );
  if (!Array.isArray(inbox.readbacks)) throw new Error("Trade inbox readbacks are invalid");
  const readbacks = inbox.readbacks.map((value) => {
    const readback = object(value, "Trade inbox readback");
    exactKeys(
      readback,
      ["relay", "found", "event", "observedAt"],
      "Trade inbox readback"
    );
    if (
      typeof readback.relay !== "string" ||
      !discoveryRelays.includes(readback.relay) ||
      typeof readback.found !== "boolean"
    ) {
      throw new Error("Trade inbox readback relay is invalid");
    }
    if (readback.found) {
      validateEvent(readback.event, 10050, "Trade inbox readback event");
    } else if (readback.event !== null) {
      throw new Error("Missing trade inbox readback contains an event");
    }
    safeTime(readback.observedAt, "Trade inbox readback time");
    return readback;
  });
  if (new Set(readbacks.map(({ relay }) => relay)).size !== readbacks.length) {
    throw new Error("Trade inbox readbacks are invalid");
  }
  for (const timestamp of ["stagedAt", "acknowledgedAt", "registeredAt"] as const) {
    if (inbox[timestamp] !== null) safeTime(inbox[timestamp], `Trade inbox ${timestamp}`);
  }
  if (inbox.status === "unregistered") {
    if (
      inbox.event !== null ||
      discoveryRelays.length !== 0 ||
      inboxRelays.length !== 0 ||
      receipts.length !== 0 ||
      readbacks.length !== 0 ||
      inbox.stagedAt !== null ||
      inbox.acknowledgedAt !== null ||
      inbox.registeredAt !== null
    ) throw new Error("Unregistered trade inbox contains publication state");
    return;
  }
  if (discoveryRelays.length < quorum) {
    throw new Error("Trade inbox publication relays cannot satisfy quorum");
  }
  validateEvent(inbox.event, 10050, "Trade inbox list event");
  const event = inbox.event as Record<string, unknown>;
  const advertisedRelays = (event.tags as string[][]).map((tag) => {
    if (tag.length !== 2 || tag[0] !== "relay" || !tag[1]) {
      throw new Error("Trade inbox list event has invalid relay tags");
    }
    return tag[1];
  });
  const normalizedAdvertised = validateRelayList(
    advertisedRelays,
    "Trade inbox advertised relays",
    false
  );
  if (
    event.content !== "" ||
    canonicalJson(normalizedAdvertised) !== canonicalJson(inboxRelays) ||
    normalizedAdvertised.some((relay, index) => relay !== advertisedRelays[index]) ||
    [...normalizedAdvertised].sort().some((relay, index) => relay !== normalizedAdvertised[index])
  ) throw new Error("Trade inbox list event is non-canonical");
  const stagedAt = safeTime(inbox.stagedAt, "Trade inbox staged time");
  const acknowledgedAt = inbox.acknowledgedAt === null
    ? null
    : safeTime(inbox.acknowledgedAt, "Trade inbox acknowledgement time");
  const registeredAt = inbox.registeredAt === null
    ? null
    : safeTime(inbox.registeredAt, "Trade inbox registration time");
  if (
    (acknowledgedAt !== null && acknowledgedAt < stagedAt) ||
    (registeredAt !== null && (
      acknowledgedAt === null ||
      registeredAt < acknowledgedAt
    ))
  ) throw new Error("Trade inbox timestamps are invalid");
  const successfulReceiptCount = receipts.filter(({ ok }) => ok).length;
  if (inbox.status === "staged") {
    if (inbox.acknowledgedAt !== null ||
      readbacks.length !== 0 || inbox.registeredAt !== null) {
      throw new Error("Staged trade inbox contains later state");
    }
  } else if (successfulReceiptCount < quorum || inbox.acknowledgedAt === null) {
    throw new Error("Acknowledged trade inbox lacks a relay acknowledgement");
  }
  if (inbox.status === "acknowledged") {
    if (readbacks.length !== 0 || inbox.registeredAt !== null) {
      throw new Error("Acknowledged trade inbox contains registration state");
    }
  } else if (inbox.status === "registered") {
    if (
      readbacks.filter((readback) => readback.found).length < quorum ||
      inbox.registeredAt === null ||
      readbacks.some((readback) =>
        (readback.found && canonicalJson(readback.event) !== canonicalJson(event)) ||
        (readback.observedAt as number) > (inbox.registeredAt as number)
      )
    ) throw new Error("Registered trade inbox lacks exact readback evidence");
  }
}

function validatePendingIncoming(
  value: unknown
): asserts value is TradePendingIncomingJournal {
  const incoming = object(value, "Pending incoming trade message");
  exactKeys(incoming, [
    "wrapper",
    "seal",
    "rumor",
    "message",
    "transcriptHash",
    "receivedAt",
    "validation"
  ], "Pending incoming trade message");
  validateEvent(incoming.wrapper, 1059, "Pending incoming wrapper");
  validateEvent(incoming.seal, 13, "Pending incoming seal");
  validateEvent(incoming.rumor, 14, "Pending incoming rumor", false);
  validateMessage(incoming.message);
  if (typeof incoming.transcriptHash !== "string" || !HEX_32.test(incoming.transcriptHash)) {
    throw new Error("Pending incoming transcript hash is invalid");
  }
  safeTime(incoming.receivedAt, "Pending incoming receive time");
  const rumor = incoming.rumor as Record<string, unknown>;
  const seal = incoming.seal as Record<string, unknown>;
  const message = incoming.message as Record<string, unknown>;
  let decoded: unknown;
  try {
    decoded = JSON.parse(rumor.content as string);
  } catch {
    throw new Error("Pending incoming rumor content is invalid");
  }
  if (
    canonicalJson(decoded) !== canonicalJson(message) ||
    rumor.pubkey !== seal.pubkey ||
    rumor.pubkey !== message.author_pubkey ||
    rumor.created_at !== message.sent_at
  ) throw new Error("Pending incoming artifacts disagree");
  const validation = object(incoming.validation, "Pending incoming validation");
  exactKeys(validation, ["status", "checkedAt", "error"], "Pending incoming validation");
  if (validation.status === "unvalidated") {
    if (validation.checkedAt !== null || validation.error !== null) {
      throw new Error("Unvalidated incoming message contains a validation result");
    }
  } else if (validation.status === "validated") {
    safeTime(validation.checkedAt, "Pending incoming validation time");
    if (validation.error !== null) {
      throw new Error("Validated incoming message contains an error");
    }
  } else if (validation.status === "rejected") {
    safeTime(validation.checkedAt, "Pending incoming rejection time");
    if (typeof validation.error !== "string" || !validation.error.trim()) {
      throw new Error("Rejected incoming message lacks an error");
    }
  } else {
    throw new Error("Pending incoming validation status is invalid");
  }
  if (
    validation.checkedAt !== null &&
    (validation.checkedAt as number) < (incoming.receivedAt as number)
  ) throw new Error("Pending incoming validation predates receipt");
}

function eventTag(event: Record<string, unknown>, key: string): string | null {
  const matches = (event.tags as string[][]).filter((tag) => tag[0] === key);
  return matches.length === 1 && matches[0]?.[1] ? matches[0][1] : null;
}

function expectedRumorTags(
  message: { sequence: string; recipient_pubkey: string },
  lastRumorId: string | null
): string[][] {
  if (message.sequence === "0") return [["p", message.recipient_pubkey]];
  if (lastRumorId === null) throw new Error("Later trade rumor lacks a predecessor");
  return [
    ["p", message.recipient_pubkey],
    ["e", lastRumorId, "", "reply"]
  ];
}

function validatePendingOrderPublication(
  value: unknown,
  context: {
    orderAddress: string;
    makerPubkey: string;
    reserveProjectionId: string | null;
    fillProjectionId: string | null;
  }
): void {
  const pending = object(value, "Pending order publication");
  exactKeys(pending, [
    "operation",
    "orderId",
    "projection",
    "receipts",
    "status",
    "stagedAt",
    "acknowledgedAt",
    "committedAt"
  ], "Pending order publication");
  if (
    !["reserve", "fill", "release"].includes(pending.operation as string) ||
    typeof pending.orderId !== "string" ||
    !UUID_V4.test(pending.orderId)
  ) throw new Error("Pending order publication is invalid");
  validateEvent(pending.projection, 30078, "Pending order projection");
  const projection = pending.projection as Record<string, unknown>;
  const addressParts = context.orderAddress.split(":");
  const addressOrderId = addressParts[5];
  if (
    addressParts.length !== 6 ||
    addressParts[0] !== "30078" ||
    addressParts[1] !== context.makerPubkey ||
    addressParts[2] !== "granola" ||
    addressParts[3] !== "order" ||
    addressParts[4] !== "v1" ||
    typeof addressOrderId !== "string" ||
    !UUID_V4.test(addressOrderId) ||
    pending.orderId !== addressOrderId ||
    projection.pubkey !== context.makerPubkey ||
    eventTag(projection, "d") !==
      `granola:order:v1:${String(pending.orderId)}`
  ) throw new Error("Pending order publication artifacts disagree");
  if (
    (pending.operation === "reserve" && (
      context.reserveProjectionId !== projection.id ||
      context.fillProjectionId !== null
    )) ||
    (pending.operation === "fill" && context.fillProjectionId !== projection.id) ||
    (pending.operation === "release" && context.fillProjectionId !== null)
  ) throw new Error("Pending order publication ID does not match session lineage");
  const relays = [...new Set(
    ((pending.receipts as Array<{ relay?: unknown }> | undefined) ?? [])
      .map(({ relay }) => relay)
      .filter((relay): relay is string => typeof relay === "string")
  )];
  validateRelayList(relays, "Pending order publication relays", true);
  const receipts = validateReceipts(
    pending.receipts,
    relays,
    "Pending order projection receipts"
  );
  safeTime(pending.stagedAt, "Pending order staged time");
  for (const timestamp of ["acknowledgedAt", "committedAt"] as const) {
    if (pending[timestamp] !== null) {
      safeTime(pending[timestamp], `Pending order ${timestamp}`);
    }
  }
  const projectionOk = receipts.some(({ ok }) => ok);
  const status = pending.status;
  const valid = status === "staged"
    ? !projectionOk &&
      pending.acknowledgedAt === null &&
      pending.committedAt === null
    : status === "acknowledged"
      ? projectionOk && pending.acknowledgedAt !== null &&
        pending.committedAt === null
      : status === "committed" &&
        projectionOk && pending.acknowledgedAt !== null &&
        pending.committedAt !== null;
  if (!valid) throw new Error("Pending order publication status is inconsistent");
  const ordered = [
    pending.stagedAt,
    pending.acknowledgedAt,
    pending.committedAt
  ].filter((time): time is number => typeof time === "number");
  if (ordered.some((time, index) => index > 0 && time < ordered[index - 1]!)) {
    throw new Error("Pending order publication timestamps regressed");
  }
}

function validateLegEvidence(value: unknown): asserts value is TradeLegEvidence {
  const leg = object(value, "Trade leg evidence");
  exactKeys(leg, [
    "tokenCommitment",
    "validationCommitment",
    "keysetId",
    "proofCount",
    "fee",
    "mintState",
    "observedAt",
    "spendCommitment",
    "claimOperationCommitment",
    "refundOperationCommitment"
  ], "Trade leg evidence");
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
  if (
    (leg.mintState === "UNKNOWN" && (
      leg.observedAt !== null ||
      leg.proofCount !== null ||
      leg.spendCommitment !== null
    )) ||
    (leg.mintState !== "UNKNOWN" && (
      leg.observedAt === null ||
      leg.proofCount === null
    )) ||
    (leg.mintState === "SPENT") !== (leg.spendCommitment !== null)
  ) throw new Error("Trade leg evidence state is inconsistent");
}

function validateObservedEvidence(
  evidence: TradeLegEvidence,
  privateLeg: PrivateLegJournal
): void {
  if (evidence.mintState === "UNKNOWN") {
    if (privateLeg.observations.length !== 0) {
      throw new Error("UNKNOWN trade evidence contains private observations");
    }
    return;
  }
  const observation = privateLeg.observations.at(-1);
  const matchesPrivateObservation = observation !== undefined &&
    observation.state === evidence.mintState &&
    observation.observedAt === evidence.observedAt &&
    observation.proofCount === evidence.proofCount &&
    observation.witnessCommitment === (
      evidence.mintState === "SPENT" ? evidence.spendCommitment : null
    );
  if (!matchesPrivateObservation) {
    throw new Error("Trade evidence lacks its matching private observation");
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
    typeof session.offeredProjectionId !== "string" ||
    !HEX_32.test(session.offeredProjectionId) ||
    typeof session.offeredProjectionRevision !== "string" ||
    !/^(0|[1-9]\d*)$/.test(session.offeredProjectionRevision)
  ) throw new Error("Trade session metadata is invalid");
  optionalHex(session.reserveProjectionId, "Reserve projection ID");
  optionalHex(session.fillProjectionId, "Fill projection ID");
  if (
    !(
      session.reserveProjectionRevision === null ||
      (typeof session.reserveProjectionRevision === "string" &&
        /^(0|[1-9]\d*)$/.test(session.reserveProjectionRevision))
    ) ||
    !(
      session.fillProjectionRevision === null ||
      (typeof session.fillProjectionRevision === "string" &&
        /^(0|[1-9]\d*)$/.test(session.fillProjectionRevision))
    )
  ) throw new Error("Trade projection revision is invalid");
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
  const locktimeGap =
    (plan.longLocktime as number) - (plan.shortLocktime as number);
  if (
    plan.makerClaimCutoff !== (plan.shortLocktime as number) - 120 ||
    (locktimeGap !== 600 && locktimeGap !== 3 * 86_400) ||
    plan.takerClaimCutoff !== (plan.longLocktime as number) - 120 ||
    plan.refundGuardSeconds !== 60
  ) throw new Error("Settlement plan profile is invalid");

  const evidence = object(session.evidence, "Trade evidence");
  exactKeys(evidence, [
    "makerPubkey",
    "commitments",
    "mintStates",
    "reserveProjectionId",
    "reserveProjectionRevision",
    "fillProjectionId",
    "fillProjectionRevision",
    "reservation",
    "legs"
  ], "Trade evidence");
  if (
    typeof evidence.makerPubkey !== "string" ||
    !HEX_32.test(evidence.makerPubkey) ||
    !Array.isArray(evidence.commitments) ||
    evidence.commitments.some((item) => typeof item !== "string" || !HEX_32.test(item)) ||
    !Array.isArray(evidence.mintStates) ||
    evidence.mintStates.some((item) => typeof item !== "string")
  ) throw new Error("Trade evidence is invalid");
  optionalHex(evidence.reserveProjectionId, "Reserve projection evidence");
  optionalHex(evidence.fillProjectionId, "Fill projection evidence");
  if (evidence.reserveProjectionRevision !== session.reserveProjectionRevision) {
    throw new Error("Reserve projection revision evidence disagrees with the session");
  }
  if (new Set(evidence.commitments as string[]).size !== (evidence.commitments as string[]).length) {
    throw new Error("Trade evidence commitments are duplicated");
  }
  const reservation = object(evidence.reservation, "Trade reservation evidence");
  exactKeys(
    reservation,
    ["proposalSealId", "takerCommitment", "abortSeal"],
    "Trade reservation evidence"
  );
  optionalHex(reservation.proposalSealId, "Proposal seal ID");
  optionalHex(reservation.takerCommitment, "Taker commitment");
  if (reservation.abortSeal !== null) {
    validateEvent(reservation.abortSeal, 13, "Authenticated abort seal");
  }
  if (
    (reservation.takerCommitment !== null && reservation.proposalSealId === null) ||
    (reservation.abortSeal !== null && (
      reservation.proposalSealId === null ||
      reservation.takerCommitment === null
    ))
  ) throw new Error("Trade reservation evidence is incomplete");
  if (
    (session.reserveProjectionId === null) !==
      (reservation.takerCommitment === null)
  ) throw new Error("Reserve projection and taker commitment evidence disagree");
  if (evidence.reserveProjectionId !== session.reserveProjectionId) {
    throw new Error("Reserve projection evidence disagrees with the session");
  }
  const fillPrivateState = object(session.privateState, "Trade private state");
  const fillTranscript = object(
    fillPrivateState.transcript,
    "Trade transcript"
  );
  const fillChoreography = object(
    fillTranscript.choreography,
    "Trade choreography"
  );
  const awaitingTakerFillVerification =
    session.role === "taker" &&
    session.phase === "filled" &&
    session.fillProjectionId !== null &&
    evidence.fillProjectionId === null &&
    fillChoreography.phase === "settled";
  if (
    (evidence.fillProjectionId !== session.fillProjectionId ||
      evidence.fillProjectionRevision !== session.fillProjectionRevision) &&
    !awaitingTakerFillVerification
  ) {
    throw new Error("Fill projection ID or revision evidence disagrees with the session");
  }
  if (
    awaitingTakerFillVerification &&
    evidence.fillProjectionRevision !== null
  ) {
    throw new Error("Unverified fill projection has revision evidence");
  }
  const evidenceLegs = object(evidence.legs, "Trade evidence legs");
  validateLegEvidence(evidenceLegs.base);
  validateLegEvidence(evidenceLegs.quote);
  if (
    (evidenceLegs.base as TradeLegEvidence).keysetId !== terms.baseKeyset ||
    (evidenceLegs.quote as TradeLegEvidence).keysetId !== terms.quoteKeyset
  ) throw new Error("Trade evidence keysets disagree with negotiated terms");

  if (session.pendingOrderPublication !== null) {
    validatePendingOrderPublication(session.pendingOrderPublication, {
      orderAddress: session.orderAddress as string,
      makerPubkey: evidence.makerPubkey as string,
      reserveProjectionId: session.reserveProjectionId as string | null,
      fillProjectionId: session.fillProjectionId as string | null
    });
    const pendingPublication = session.pendingOrderPublication as NonNullable<
      TradeSession["pendingOrderPublication"]
    >;
    const pendingTimes = [
      pendingPublication.stagedAt,
      pendingPublication.acknowledgedAt,
      pendingPublication.committedAt
    ].filter((time): time is number => time !== null);
    if (pendingTimes.some((time) => time > updatedAt)) {
      throw new Error("Pending order publication is newer than its session");
    }
  }

  const privateState = object(session.privateState, "Trade private state");
  for (const field of ["nostrPrivateKey", "cashuPrivateKey", "refundPrivateKey"]) {
    if (typeof privateState[field] !== "string" || !HEX_32.test(privateState[field] as string)) {
      throw new Error("Trade private key is invalid");
    }
  }
  const nostrKey = hexBytes(privateState.nostrPrivateKey as string);
  let localNostrPubkey: string;
  try {
    localNostrPubkey = getPublicKey(nostrKey);
  } finally {
    nostrKey.fill(0);
  }
  optionalHex(privateState.preimage, "Trade preimage");
  optionalHex(privateState.htlcHash, "Trade HTLC hash");
  optionalHex(privateState.settlementTranscriptHash, "Settlement transcript hash");
  if (
    privateState.preimage !== null && privateState.htlcHash === null
  ) throw new Error("Trade preimage lacks its HTLC hash");
  if (
    privateState.preimage !== null &&
    !verifyHTLCHash(privateState.preimage as string, privateState.htlcHash as string)
  ) throw new Error("Trade preimage does not match its HTLC hash");
  if (
    privateState.htlcHash !== null &&
    !(evidence.commitments as string[]).includes(privateState.htlcHash as string)
  ) throw new Error("Trade HTLC hash lacks public commitment evidence");
  if (
    privateState.htlcHash !== null &&
    privateState.settlementTranscriptHash === privateState.htlcHash
  ) throw new Error("HTLC hash and settlement transcript hash must remain distinct");
  validateInbox(privateState.inbox);
  if ([
    privateState.inbox.stagedAt,
    privateState.inbox.acknowledgedAt,
    privateState.inbox.registeredAt
  ].some((time) => time !== null && time > updatedAt)) {
    throw new Error("Trade inbox checkpoint is newer than its session");
  }
  if (privateState.inbox.event !== null) {
    if (privateState.inbox.event.pubkey !== localNostrPubkey) {
      throw new Error("Trade inbox list event is signed by another session key");
    }
  }
  if (privateState.pendingIncoming !== null) {
    validatePendingIncoming(privateState.pendingIncoming);
    const pending = privateState.pendingIncoming as TradePendingIncomingJournal;
    if (pending.message.session_id !== session.sessionId ||
      pending.message.reservation_id !== session.reservationId ||
      pending.message.order_address !== session.orderAddress) {
      throw new Error("Pending incoming message targets another trade session");
    }
    if (
      pending.message.recipient_pubkey !== localNostrPubkey ||
      eventTag(pending.wrapper as unknown as Record<string, unknown>, "p") !==
        localNostrPubkey
    ) throw new Error("Pending incoming message targets another session key");
    if (
      pending.receivedAt > updatedAt ||
      (pending.validation.checkedAt !== null &&
        pending.validation.checkedAt > updatedAt)
    ) throw new Error("Pending incoming message is newer than its session");
  }
  validateTranscript(privateState.transcript);
  const transcript = privateState.transcript as TradeTranscriptJournal;
  if (reservation.abortSeal !== null) {
    const participants = transcript.choreography.participants;
    const expectedAbortAuthor = session.role === "maker"
      ? participants.takerSessionPubkey
      : participants.makerSessionPubkey;
    if (
      expectedAbortAuthor === undefined ||
      (reservation.abortSeal as NostrEvent).pubkey !== expectedAbortAuthor
    ) throw new Error("Authenticated abort seal has the wrong counterparty author");
  }
  if (
    privateState.settlementTranscriptHash !== null &&
    !transcript.accepted.some(({ transcriptHash }) =>
      transcriptHash === privateState.settlementTranscriptHash)
  ) throw new Error("Settlement transcript hash lacks an accepted transcript tuple");
  if (privateState.pendingIncoming !== null) {
    const pending = privateState.pendingIncoming as TradePendingIncomingJournal;
    const participants = transcript.choreography.participants;
    const expectedCounterparty = session.role === "maker"
      ? participants.takerSessionPubkey
      : participants.makerSessionPubkey;
    const pendingBody = pending.message.body as Record<string, unknown>;
    const reserveAcceptanceHandoff =
      session.role === "taker" &&
      session.reserveProjectionId === null &&
      transcript.choreography.phase === "awaiting_reserve_accept" &&
      pending.message.type === "reserve_accept" &&
      typeof pendingBody.reserve_projection_id === "string" &&
      HEX_32.test(pendingBody.reserve_projection_id) &&
      pending.message.order_projection_id === pendingBody.reserve_projection_id &&
      pending.message.order_revision === pendingBody.reserve_revision;
    const settlementHandoff =
      session.role === "taker" &&
      transcript.choreography.phase === "awaiting_settlement_ack" &&
      pending.message.type === "settlement_ack" &&
      typeof pendingBody.fill_projection_id === "string" &&
      HEX_32.test(pendingBody.fill_projection_id) &&
      pending.message.order_projection_id === pendingBody.fill_projection_id &&
      pending.message.order_revision === pendingBody.fill_revision;
    if (
      pending.message.sequence !== transcript.nextSequence ||
      pending.message.maker_order_pubkey !== evidence.makerPubkey ||
      (
        pending.message.order_projection_id !==
          (session.fillProjectionId ??
            session.reserveProjectionId ??
            session.offeredProjectionId) &&
        !reserveAcceptanceHandoff &&
        !settlementHandoff
      ) ||
      (
        pending.message.order_revision !==
          (session.fillProjectionRevision ??
            session.reserveProjectionRevision ??
            session.offeredProjectionRevision) &&
        !reserveAcceptanceHandoff &&
        !settlementHandoff
      ) ||
      pending.message.previous_message_id !== transcript.lastMessageId ||
      pending.message.previous_transcript_hash !== transcript.lastTranscriptHash ||
      canonicalJson(pending.rumor.tags) !==
        canonicalJson(expectedRumorTags(pending.message, transcript.lastRumorId)) ||
      transcript.accepted.some(({ messageId, rumorId }) =>
        messageId === pending.message.message_id || rumorId === pending.rumor.id)
    ) throw new Error("Pending incoming message conflicts with the durable transcript");
    if (
      pending.validation.status === "validated" &&
      expectedCounterparty !== undefined &&
      pending.message.author_pubkey !== expectedCounterparty
    ) throw new Error("Validated incoming message is not signed by the counterparty");
  }
  if (privateState.outbox !== null) {
    validateOutbox(privateState.outbox);
    if (privateState.pendingIncoming !== null) {
      throw new Error("Trade session cannot stage incoming and outgoing messages together");
    }
    const outbox = privateState.outbox as TradeOutboxJournal;
    let decoded: unknown;
    try {
      decoded = JSON.parse(outbox.rumor.content);
    } catch {
      throw new Error("Trade outbox rumor content is invalid");
    }
    const messageBody = object(
      outbox.message.body,
      "Trade outbox message body"
    );
    const isMakerReserveAcceptance =
      session.role === "maker" &&
      outbox.message.type === "reserve_accept";
    const expectedOutboxAuthor = isMakerReserveAcceptance
      ? evidence.makerPubkey
      : localNostrPubkey;
    if (isMakerReserveAcceptance && (
      outbox.message.recipient_pubkey !==
        transcript.choreography.participants.takerSessionPubkey ||
      messageBody.maker_session_pubkey !== localNostrPubkey ||
      messageBody.taker_session_pubkey !== outbox.message.recipient_pubkey ||
      messageBody.reserve_projection_id !== session.reserveProjectionId ||
      messageBody.reserve_revision !== session.reserveProjectionRevision ||
      session.reserveProjectionId === null
    )) {
      throw new Error("Maker reserve acceptance does not bind the exact session handoff");
    }
    if (
      canonicalJson(decoded) !== canonicalJson(outbox.message) ||
      outbox.rumor.pubkey !== outbox.seal.pubkey ||
      outbox.rumor.pubkey !== outbox.message.author_pubkey ||
      outbox.message.author_pubkey !== expectedOutboxAuthor ||
      outbox.rumor.created_at !== outbox.message.sent_at ||
      outbox.message.session_id !== session.sessionId ||
      outbox.message.reservation_id !== session.reservationId ||
      outbox.message.order_address !== session.orderAddress ||
      outbox.message.order_projection_id !==
        (session.fillProjectionId ??
          session.reserveProjectionId ??
          session.offeredProjectionId) ||
      outbox.message.order_revision !==
        (session.fillProjectionRevision ??
          session.reserveProjectionRevision ??
          session.offeredProjectionRevision) ||
      outbox.message.maker_order_pubkey !== evidence.makerPubkey ||
      outbox.message.sequence !== transcript.nextSequence ||
      outbox.message.previous_message_id !== transcript.lastMessageId ||
      outbox.message.previous_transcript_hash !== transcript.lastTranscriptHash ||
      eventTag(outbox.wrapper as unknown as Record<string, unknown>, "p") !==
        outbox.message.recipient_pubkey ||
      canonicalJson(outbox.rumor.tags) !==
        canonicalJson(expectedRumorTags(outbox.message, transcript.lastRumorId)) ||
      transcript.accepted.some(({ messageId, rumorId }) =>
        messageId === outbox.message.message_id || rumorId === outbox.rumor.id)
    ) throw new Error("Trade outbox artifacts disagree with the durable transcript");
  }
  if (privateState.cashuOperation !== null) {
    validateCashuOperation(privateState.cashuOperation);
    if (privateState.cashuOperation.preparedAt > updatedAt) {
      throw new Error("Cashu operation preparation time is in the future");
    }
    const operationEvidence = privateState.cashuOperation.leg === "base"
      ? evidenceLegs.base as TradeLegEvidence
      : evidenceLegs.quote as TradeLegEvidence;
    const commitment = privateState.cashuOperation.artifact.operationCommitment;
    const expected = privateState.cashuOperation.artifact.expected;
    if (
      expected.binding.sessionId !== session.sessionId ||
      expected.binding.reservationId !== session.reservationId ||
      expected.binding.transcriptHash !== privateState.settlementTranscriptHash ||
      expected.hash !== privateState.htlcHash ||
      (privateState.cashuOperation.kind === "claim" &&
        operationEvidence.claimOperationCommitment !== commitment) ||
      (privateState.cashuOperation.kind === "refund" &&
        operationEvidence.refundOperationCommitment !== commitment)
    ) throw new Error("Cashu operation lacks matching public commitment evidence");
  }
  const privateLegs = object(privateState.legs, "Private trade legs");
  const privateBase = privateLegs.base;
  const privateQuote = privateLegs.quote;
  validatePrivateLeg(privateBase);
  validatePrivateLeg(privateQuote);
  validateObservedEvidence(evidenceLegs.base, privateBase);
  validateObservedEvidence(evidenceLegs.quote, privateQuote);
  for (const [legName, evidenceLeg, privateLeg] of [
    ["base", evidenceLegs.base as TradeLegEvidence, privateBase as PrivateLegJournal],
    ["quote", evidenceLegs.quote as TradeLegEvidence, privateQuote as PrivateLegJournal]
  ] as const) {
    const expected = privateLeg.expected;
    if (expected !== null && (
      expected.leg !== legName ||
      expected.mintUrl !== (legName === "base" ? terms.baseMint : terms.quoteMint) ||
      expected.unit !== (legName === "base" ? terms.baseUnit : terms.quoteUnit) ||
      expected.amount !== (legName === "base" ? terms.baseAmount : terms.quoteAmount) ||
      expected.binding.sessionId !== session.sessionId ||
      expected.binding.reservationId !== session.reservationId ||
      privateState.settlementTranscriptHash === null ||
      expected.binding.transcriptHash !== privateState.settlementTranscriptHash
    )) throw new Error("Expected HTLC lock disagrees with the trade session");
    if (
      evidenceLeg.tokenCommitment !== null &&
      (privateLeg.token === null || evidenceLeg.validationCommitment === null)
    ) throw new Error("Trade token commitment lacks exact private token evidence");
  }
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

export interface TakerStartIntent {
  requestId: string;
  address: string;
  expectedProjectionId: string;
  expectedRevision: string;
  fillBaseAmount: string;
}

interface StoredTakerStartBinding extends TakerStartIntent {
  sessionId: string;
}

interface TradeSessionStore {
  schema: "granola/trade-session-store/v1";
  sessions: TradeSession[];
  takerStarts: StoredTakerStartBinding[];
}

function assertTakerStartIntent(
  value: unknown,
  label: string,
  withSessionId: boolean
): asserts value is StoredTakerStartBinding {
  const intent = object(value, label);
  exactKeys(intent, [
    "requestId",
    "address",
    "expectedProjectionId",
    "expectedRevision",
    "fillBaseAmount",
    ...(withSessionId ? ["sessionId"] : [])
  ], label);
  if (
    typeof intent.requestId !== "string" ||
    !UUID_V4.test(intent.requestId) ||
    typeof intent.address !== "string" ||
    !ORDER_ADDRESS.test(intent.address) ||
    typeof intent.expectedProjectionId !== "string" ||
    !HEX_32.test(intent.expectedProjectionId) ||
    typeof intent.expectedRevision !== "string" ||
    !/^(0|[1-9]\d*)$/.test(intent.expectedRevision) ||
    typeof intent.fillBaseAmount !== "string" ||
    !POSITIVE_INTEGER.test(intent.fillBaseAmount) ||
    (withSessionId && (
      typeof intent.sessionId !== "string" ||
      !HEX_32.test(intent.sessionId)
    ))
  ) throw new Error(`${label} is invalid`);
}

function sameTakerStartIntent(
  left: TakerStartIntent,
  right: TakerStartIntent
): boolean {
  return left.requestId === right.requestId &&
    left.address === right.address &&
    left.expectedProjectionId === right.expectedProjectionId &&
    left.expectedRevision === right.expectedRevision &&
    left.fillBaseAmount === right.fillBaseAmount;
}

function assertTradeSessionStore(value: unknown): asserts value is TradeSessionStore {
  const store = object(value, "Trade session store");
  exactKeys(store, ["schema", "sessions", "takerStarts"], "Trade session store");
  if (store.schema !== "granola/trade-session-store/v1") {
    throw new Error("Trade session store schema is invalid");
  }
  assertSessions(store.sessions);
  if (!Array.isArray(store.takerStarts)) {
    throw new Error("Trade session start bindings are invalid");
  }
  const sessions = new Map(
    (store.sessions as TradeSession[]).map((item) => [item.sessionId, item])
  );
  const requestIds = new Set<string>();
  const boundSessions = new Set<string>();
  for (const value of store.takerStarts) {
    assertTakerStartIntent(value, "Taker start binding", true);
    const binding = value as StoredTakerStartBinding;
    const session = sessions.get(binding.sessionId);
    if (
      requestIds.has(binding.requestId) ||
      boundSessions.has(binding.sessionId) ||
      session === undefined ||
      session.role !== "taker" ||
      session.orderAddress !== binding.address ||
      session.offeredProjectionId !== binding.expectedProjectionId ||
      session.offeredProjectionRevision !== binding.expectedRevision ||
      session.terms.baseAmount !== binding.fillBaseAmount
    ) {
      throw new Error("Taker start binding is conflicting or orphaned");
    }
    requestIds.add(binding.requestId);
    boundSessions.add(binding.sessionId);
  }
}

function emptyTradeSessionStore(): TradeSessionStore {
  return {
    schema: "granola/trade-session-store/v1",
    sessions: [],
    takerStarts: []
  };
}

const INBOX_STATUS_RANK: Record<TradeInboxJournal["status"], number> = {
  unregistered: 0,
  staged: 1,
  acknowledged: 2,
  registered: 3
};

const OUTBOX_STATUS_RANK: Record<TradeOutboxJournal["status"], number> = {
  staged: 0,
  acknowledged: 1
};

const CASHU_STATUS_RANK: Record<CashuOperationJournal["status"], number> = {
  prepared: 0,
  completed: 1,
  wallet_applied: 2
};

const ORDER_STATUS_RANK: Record<
  NonNullable<TradeSession["pendingOrderPublication"]>["status"],
  number
> = {
  staged: 0,
  acknowledged: 1,
  committed: 2
};

const HAPPY_PATH_PHASES = new Set([
  "negotiating:reserved",
  "reserved:base_locked",
  "base_locked:quote_locked",
  "quote_locked:quote_claimed",
  "quote_claimed:base_claimed",
  "base_claimed:filled",
  "reserved:released",
  "base_locked:waiting_base_refund",
  "quote_locked:waiting_quote_refund",
  "quote_claimed:waiting_base_claim",
  "waiting_quote_refund:waiting_base_refund",
  "waiting_base_refund:released",
  "waiting_base_claim:base_claimed"
]);

function isPrefix(previous: unknown[], next: unknown[]): boolean {
  return previous.every((value, index) =>
    canonicalJson(value) === canonicalJson(next[index])
  );
}

function assertMonotonicUpdate(current: TradeSession, next: TradeSession): void {
  for (const field of [
    "sessionId",
    "reservationId",
    "role",
    "orderAddress",
    "offeredProjectionId",
    "offeredProjectionRevision",
    "createdAt"
  ] as const) {
    if (next[field] !== current[field]) {
      throw new Error(`Trade session ${field} cannot change`);
    }
  }
  if (
    next.phase !== current.phase &&
    !HAPPY_PATH_PHASES.has(`${current.phase}:${next.phase}`) &&
    next.phase !== "frozen"
  ) throw new Error("Trade session phase skipped a happy-path checkpoint");

  const previousInbox = current.privateState.inbox.status;
  const nextInbox = next.privateState.inbox.status;
  const inboxAdvance = INBOX_STATUS_RANK[nextInbox] - INBOX_STATUS_RANK[previousInbox];
  if (inboxAdvance < 0 || inboxAdvance > 1) {
    throw new Error("Trade inbox checkpoint regressed or skipped a durable stage");
  }
  if (
    previousInbox !== "unregistered" &&
    (
      canonicalJson(current.privateState.inbox.event) !==
        canonicalJson(next.privateState.inbox.event) ||
      canonicalJson(current.privateState.inbox.discoveryRelays) !==
        canonicalJson(next.privateState.inbox.discoveryRelays) ||
      canonicalJson(current.privateState.inbox.inboxRelays) !==
        canonicalJson(next.privateState.inbox.inboxRelays)
    )
  ) throw new Error("Trade inbox retry artifact changed after staging");

  if (
    !isPrefix(
      current.privateState.transcript.accepted,
      next.privateState.transcript.accepted
    )
  ) throw new Error("Trade transcript history regressed or changed");

  const currentOutbox = current.privateState.outbox;
  const nextOutbox = next.privateState.outbox;
  if (currentOutbox && nextOutbox) {
    if (
      canonicalJson(currentOutbox.message) !== canonicalJson(nextOutbox.message) ||
      canonicalJson(currentOutbox.rumor) !== canonicalJson(nextOutbox.rumor) ||
      canonicalJson(currentOutbox.seal) !== canonicalJson(nextOutbox.seal) ||
      canonicalJson(currentOutbox.wrapper) !== canonicalJson(nextOutbox.wrapper) ||
      currentOutbox.recipientInboxListId !== nextOutbox.recipientInboxListId ||
      canonicalJson(currentOutbox.recipientRelays) !==
        canonicalJson(nextOutbox.recipientRelays) ||
      canonicalJson(currentOutbox.nextChoreography) !==
        canonicalJson(nextOutbox.nextChoreography) ||
      OUTBOX_STATUS_RANK[nextOutbox.status] < OUTBOX_STATUS_RANK[currentOutbox.status] ||
      OUTBOX_STATUS_RANK[nextOutbox.status] > OUTBOX_STATUS_RANK[currentOutbox.status] + 1
    ) throw new Error("Trade outbox retry artifact regressed or changed");
  } else if (currentOutbox?.status === "staged" && nextOutbox === null) {
    throw new Error("A staged trade outbox cannot be cleared before acknowledgement");
  }

  const currentCashu = current.privateState.cashuOperation;
  const nextCashu = next.privateState.cashuOperation;
  if (currentCashu && nextCashu) {
    const advance = CASHU_STATUS_RANK[nextCashu.status] -
      CASHU_STATUS_RANK[currentCashu.status];
    if (
      currentCashu.operationId !== nextCashu.operationId ||
      currentCashu.artifact.operationCommitment !==
        nextCashu.artifact.operationCommitment ||
      advance < 0 ||
      advance > 1
    ) throw new Error("Cashu operation checkpoint regressed or changed");
  } else if (currentCashu && currentCashu.status !== "wallet_applied") {
    throw new Error("Cashu operation cannot be cleared before wallet application");
  }

  const currentOrder = current.pendingOrderPublication;
  const nextOrder = next.pendingOrderPublication;
  if (currentOrder && nextOrder &&
    currentOrder.projection.id === nextOrder.projection.id) {
    const advance = ORDER_STATUS_RANK[nextOrder.status] -
      ORDER_STATUS_RANK[currentOrder.status];
    if (
      currentOrder.projection.id !== nextOrder.projection.id ||
      advance < 0 ||
      advance > 1
    ) throw new Error("Order publication checkpoint regressed or changed");
  } else if (currentOrder && nextOrder === null && currentOrder.status !== "committed") {
    throw new Error("Order publication cannot be cleared before commit");
  }

  for (const leg of ["base", "quote"] as const) {
    if (
      !isPrefix(
        current.privateState.legs[leg].observations,
        next.privateState.legs[leg].observations
      ) ||
      (current.evidence.legs[leg].mintState === "SPENT" &&
        next.evidence.legs[leg].mintState !== "SPENT")
    ) throw new Error(`Trade ${leg} mint evidence regressed`);
  }
}

export type TradeSessionExclusiveRunner = <T>(action: () => Promise<T>) => Promise<T>;

const localLockTails = new Map<string, Promise<void>>();

async function withLocalLock<T>(
  name: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = localLockTails.get(name) ?? Promise.resolve();
  let release = (): void => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  localLockTails.set(name, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (localLockTails.get(name) === current) localLockTails.delete(name);
  }
}

async function withSharedLock<T>(
  name: string,
  action: () => Promise<T>
): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks !== undefined) {
    return await locks.request(
      name,
      { mode: "exclusive" },
      async () => action()
    );
  }
  return withLocalLock(name, action);
}

const withDefaultTradeSessionLock: TradeSessionExclusiveRunner = async <T>(
  action: () => Promise<T>
): Promise<T> => withSharedLock(
  "granola-trade-sessions-storage-write",
  action
);

const withDefaultTradeEncryptionLock: TradeSessionExclusiveRunner = async <T>(
  action: () => Promise<T>
): Promise<T> => withSharedLock(
  "granola-trade-sessions-encryption-key-write",
  action
);

export class TradeSessionRepository {
  private readonly driver: StorageDriver;
  private readonly legacyDriver: StorageDriver | null;
  private readonly runExclusive: TradeSessionExclusiveRunner;

  constructor(
    driver: StorageDriver,
    runExclusive: TradeSessionExclusiveRunner = withDefaultTradeSessionLock
  ) {
    this.legacyDriver = driver instanceof EncryptedStorageDriver ? null : driver;
    this.driver = driver instanceof EncryptedStorageDriver
      ? driver
      : new EncryptedStorageDriver(
        driver,
        "granola-trade-sessions",
        withDefaultTradeEncryptionLock
      );
    this.runExclusive = runExclusive;
  }

  private async loadStore(): Promise<TradeSessionStore> {
    const encrypted = await this.driver.get(TRADE_SESSIONS_KEY);
    const stored = encrypted ?? (
      this.legacyDriver === null
        ? undefined
        : await this.legacyDriver.get(TRADE_SESSIONS_KEY)
    );
    if (stored === undefined || stored === null) return emptyTradeSessionStore();
    if (Array.isArray(stored)) {
      assertSessions(stored);
      return {
        schema: "granola/trade-session-store/v1",
        sessions: clone(stored),
        takerStarts: []
      };
    }
    assertTradeSessionStore(stored);
    return clone(stored);
  }

  async list(): Promise<TradeSession[]> {
    return (await this.loadStore()).sessions;
  }

  async get(sessionId: string): Promise<TradeSession | undefined> {
    return (await this.list()).find((session) => session.sessionId === sessionId);
  }

  async getTakerForRequest(
    intent: TakerStartIntent
  ): Promise<TradeSession | undefined> {
    assertTakerStartIntent(intent, "Taker start intent", false);
    const store = await this.loadStore();
    const binding = store.takerStarts.find(
      (item) => item.requestId === intent.requestId
    );
    if (binding === undefined) return undefined;
    if (!sameTakerStartIntent(binding, intent)) {
      throw new Error("Taker request ID conflicts with another start intent");
    }
    return clone(store.sessions.find(
      (session) => session.sessionId === binding.sessionId
    )!);
  }

  async createTakerForRequest(
    intent: TakerStartIntent,
    session: TradeSession
  ): Promise<TradeSession> {
    assertTakerStartIntent(intent, "Taker start intent", false);
    assertSession(session);
    if (
      session.revision !== 0 ||
      session.role !== "taker"
    ) {
      throw new Error("Taker start requires a revision-zero taker session");
    }
    return this.runExclusive(async () => {
      const store = await this.loadStore();
      const binding = store.takerStarts.find(
        (item) => item.requestId === intent.requestId
      );
      if (binding !== undefined) {
        if (!sameTakerStartIntent(binding, intent)) {
          throw new Error("Taker request ID conflicts with another start intent");
        }
        return clone(store.sessions.find(
          (item) => item.sessionId === binding.sessionId
        )!);
      }
      if (
        session.orderAddress !== intent.address ||
        session.offeredProjectionId !== intent.expectedProjectionId ||
        session.terms.baseAmount !== intent.fillBaseAmount
      ) {
        throw new Error("Taker start session does not match its exact intent");
      }
      if (store.sessions.some((item) => item.sessionId === session.sessionId)) {
        throw new Error("Taker start session identity already exists");
      }
      store.sessions.push(clone(session));
      store.takerStarts.push({
        ...clone(intent),
        sessionId: session.sessionId
      });
      assertTradeSessionStore(store);
      await this.driver.set(TRADE_SESSIONS_KEY, store);
      return clone(session);
    });
  }

  async save(session: TradeSession, expectedRevision: number | null): Promise<void> {
    assertSession(session);
    await this.runExclusive(async () => {
      const store = await this.loadStore();
      const sessions = store.sessions;
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
        assertMonotonicUpdate(current, session);
        sessions[index] = clone(session);
      }
      assertTradeSessionStore(store);
      await this.driver.set(TRADE_SESSIONS_KEY, store);
    });
  }
}
