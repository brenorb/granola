import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip44,
  verifyEvent
} from "nostr-tools";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const TRADE_MESSAGE_TYPES = [
  "reserve_propose",
  "reserve_accept",
  "reserve_reject",
  "session_ack",
  "base_lock",
  "base_lock_ack",
  "quote_lock",
  "quote_lock_ack",
  "claim_notice",
  "ack",
  "abort",
  "fill_request",
  "settlement_ack",
  "refund",
  "error"
] as const;

export type TradeMessageType = (typeof TRADE_MESSAGE_TYPES)[number];

export interface GranolaTradeTerms {
  base_unit: string;
  base_mint: string;
  base_keyset: string;
  quote_unit: string;
  quote_mint: string;
  quote_keyset: string;
  base_amount: string;
  quote_amount: string;
  limit_price: { numerator: string; denominator: string };
}

export interface GranolaTradeMessage {
  schema: "granola/dm/v1";
  deployment: "cashu-testnet-v1";
  type: TradeMessageType;
  message_id: string;
  session_id: string;
  reservation_id: string;
  order_address: string;
  order_head: string;
  maker_order_pubkey: string;
  author_pubkey: string;
  recipient_pubkey: string;
  sequence: string;
  previous_message_id: string | null;
  previous_transcript_hash: string | null;
  sent_at: number;
  expires_at: number;
  terms_hash: string;
  terms?: GranolaTradeTerms;
  body: { [key: string]: JsonValue };
}

export interface UnsignedRumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: 14;
  tags: string[][];
  content: string;
}

export interface SignedNostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface WrappedTradeRumor {
  rumor: UnsignedRumor;
  seal: SignedNostrEvent;
  wrapper: SignedNostrEvent;
}

export interface WrapTradeRumorOptions {
  ephemeralSecretKey?: Uint8Array;
  sealCreatedAt: number;
  wrapperCreatedAt: number;
  outerExpiration: number;
  sealNonce?: Uint8Array;
  wrapperNonce?: Uint8Array;
}

export interface UnwrapTradeMessageOptions {
  now: number;
  expectedAuthorPubkey: string;
  expectedOrderAddress: string;
  expectedOrderHead: string;
  expectedTermsHash: string;
  expectedType?: TradeMessageType;
  expectedSequence?: string;
  expectedPreviousRumorId?: string;
  expectedPreviousMessageId?: string;
  expectedPreviousTranscriptHash?: string;
}

export type InitialReserveProposalOptions = Omit<
  UnwrapTradeMessageOptions,
  | "expectedAuthorPubkey"
  | "expectedType"
  | "expectedSequence"
  | "expectedPreviousRumorId"
  | "expectedPreviousMessageId"
  | "expectedPreviousTranscriptHash"
>;

export type ReserveAcceptanceOptions = Omit<
  UnwrapTradeMessageOptions,
  "expectedOrderHead" | "expectedType" | "expectedSequence"
> & {
  expectedPreviousRumorId: string;
  expectedPreviousMessageId: string;
  expectedPreviousTranscriptHash: string;
};

export interface OpenedTradeMessage {
  wrapper: SignedNostrEvent;
  seal: SignedNostrEvent;
  rumor: UnsignedRumor;
  message: GranolaTradeMessage;
  transcriptHash: string;
}

declare const VERIFIED_INITIAL_PROPOSAL: unique symbol;

export type VerifiedInitialReserveProposal = Readonly<OpenedTradeMessage> & {
  readonly [VERIFIED_INITIAL_PROPOSAL]: true;
};

const authenticatedTradeMessages = new WeakMap<object, string>();
const verifiedInitialProposals = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function assertAuthenticatedOpenedTradeMessage(
  value: OpenedTradeMessage
): void {
  if (
    !value ||
    typeof value !== "object" ||
    authenticatedTradeMessages.get(value) !== canonicalJson(value)
  ) {
    throw new Error("Trade message is not an authenticated private-message artifact");
  }
}

export function assertVerifiedInitialReserveProposal(
  value: unknown
): asserts value is VerifiedInitialReserveProposal {
  if (!value || typeof value !== "object" || !verifiedInitialProposals.has(value)) {
    throw new Error("Maker session requires a verified initial reserve proposal");
  }
  assertAuthenticatedOpenedTradeMessage(value as OpenedTradeMessage);
}

const HEX_32 = /^[0-9a-f]{64}$/;
const UUID_V4_BODY = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_V4 = new RegExp(`^${UUID_V4_BODY}$`);
const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const utf8 = new TextEncoder();

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Canonical JSON does not allow non-finite numbers");
  return JSON.stringify(value);
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return canonicalNumber(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object).sort().map((key) => {
      const item = object[key];
      if (item === undefined) throw new Error("Canonical JSON does not allow undefined values");
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new Error(`Canonical JSON does not allow ${typeof value}`);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(parts: Uint8Array[]): Promise<string> {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return hex(await crypto.subtle.digest("SHA-256", joined));
}

function fromHex(value: string): Uint8Array {
  if (!HEX_32.test(value)) throw new Error("Expected 32-byte lowercase hexadecimal value");
  return Uint8Array.from(value.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
}

function positiveInteger(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !CANONICAL_INTEGER.test(value) || value === "0") {
    throw new Error(`${label} must be a canonical positive integer string`);
  }
  return BigInt(value);
}

function normalizedMint(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an HTTPS URL`);
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must be a normalized HTTPS URL`);
  }
  const normalized = parsed.toString().replace(/\/$/, "");
  if (normalized !== value) throw new Error(`${label} must be normalized`);
  return value;
}

function assertTerms(value: unknown): asserts value is GranolaTradeTerms {
  const terms = record(value, "Terms");
  exactKeys(terms, [
    "base_unit", "base_mint", "base_keyset", "quote_unit", "quote_mint",
    "quote_keyset", "base_amount", "quote_amount", "limit_price"
  ], "Terms");
  for (const field of ["base_unit", "quote_unit"] as const) {
    const unit = terms[field];
    if (typeof unit !== "string" || !/^[a-z][a-z0-9_-]{0,15}$/.test(unit)) {
      throw new Error(`${field} is invalid`);
    }
  }
  normalizedMint(terms.base_mint, "base_mint");
  normalizedMint(terms.quote_mint, "quote_mint");
  for (const field of ["base_keyset", "quote_keyset"] as const) {
    if (typeof terms[field] !== "string" || !/^[0-9a-f]{16,66}$/.test(terms[field])) {
      throw new Error(`${field} is invalid`);
    }
  }
  const base = positiveInteger(terms.base_amount, "base_amount");
  const quote = positiveInteger(terms.quote_amount, "quote_amount");
  const price = record(terms.limit_price, "Limit price");
  exactKeys(price, ["numerator", "denominator"], "Limit price");
  const numerator = positiveInteger(price.numerator, "Price numerator");
  const denominator = positiveInteger(price.denominator, "Price denominator");
  const quoteNumerator = base * numerator;
  const expectedQuote = quoteNumerator / denominator;
  if (expectedQuote === 0n) {
    throw new Error("Trade quote amount must be at least one quote unit");
  }
  if (quote !== expectedQuote) {
    throw new Error("Trade terms quote amount does not match truncated settlement");
  }
}

export async function termsHash(terms: GranolaTradeTerms): Promise<string> {
  assertTerms(terms);
  return sha256([utf8.encode("granola-terms-v1\n"), utf8.encode(canonicalJson(terms))]);
}

function safeTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe Unix timestamp`);
  }
  return value;
}

function requiredString(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== "string" || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

async function assertMessage(value: unknown): Promise<GranolaTradeMessage> {
  const message = record(value, "Granola message");
  const hasTerms = Object.hasOwn(message, "terms");
  exactKeys(message, [
    "schema", "deployment", "type", "message_id", "session_id", "reservation_id",
    "order_address", "order_head", "maker_order_pubkey", "author_pubkey",
    "recipient_pubkey", "sequence", "previous_message_id",
    "previous_transcript_hash", "sent_at", "expires_at", "terms_hash",
    ...(hasTerms ? ["terms"] : []), "body"
  ], "Granola message");
  if (message.schema !== "granola/dm/v1" || message.deployment !== "cashu-testnet-v1") {
    throw new Error("Unknown Granola message schema or deployment");
  }
  if (!TRADE_MESSAGE_TYPES.includes(message.type as TradeMessageType)) {
    throw new Error("Unknown Granola message type");
  }
  requiredString(message.message_id, "Message ID", UUID_V4);
  requiredString(message.session_id, "Session ID", HEX_32);
  requiredString(message.reservation_id, "Reservation ID", UUID_V4);
  const maker = requiredString(message.maker_order_pubkey, "Maker order pubkey", HEX_32);
  requiredString(message.author_pubkey, "Author pubkey", HEX_32);
  requiredString(message.recipient_pubkey, "Recipient pubkey", HEX_32);
  requiredString(message.order_head, "Order head", HEX_32);
  const orderAddress = requiredString(message.order_address, "Order address");
  const addressPattern = new RegExp(`^30078:${maker}:granola:order:v1:${UUID_V4_BODY}$`);
  if (!addressPattern.test(orderAddress)) throw new Error("Order address is invalid");
  const sequence = requiredString(message.sequence, "Sequence", CANONICAL_INTEGER);
  const sentAt = safeTimestamp(message.sent_at, "sent_at");
  const expiresAt = safeTimestamp(message.expires_at, "expires_at");
  if (sentAt >= expiresAt) throw new Error("Message must expire after it was sent");
  requiredString(message.terms_hash, "Terms hash", HEX_32);
  record(message.body, "Message body");

  if (sequence === "0") {
    if (message.previous_message_id !== null || message.previous_transcript_hash !== null) {
      throw new Error("Initial message cannot name a predecessor");
    }
  } else {
    requiredString(message.previous_message_id, "Previous message ID", UUID_V4);
    requiredString(message.previous_transcript_hash, "Previous transcript hash", HEX_32);
  }
  if (message.type === "reserve_propose" || message.type === "reserve_accept") {
    if (!hasTerms) throw new Error(`${message.type} must contain complete terms`);
  }
  if (hasTerms) {
    assertTerms(message.terms);
    if (await termsHash(message.terms) !== message.terms_hash) {
      throw new Error("Terms hash does not match canonical terms");
    }
  }

  if (message.type === "reserve_propose" && message.recipient_pubkey !== maker) {
    throw new Error("Reservation proposal recipient must be the maker order key");
  }
  if (["reserve_accept", "reserve_reject"].includes(message.type as string) && message.author_pubkey !== maker) {
    throw new Error("Reservation response must be authored by the maker order key");
  }
  return message as unknown as GranolaTradeMessage;
}

function expectedRumorTags(message: GranolaTradeMessage, previousRumorId?: string): string[][] {
  if (message.sequence === "0") {
    if (previousRumorId !== undefined) throw new Error("Initial message cannot reference a predecessor rumor");
    return [["p", message.recipient_pubkey]];
  }
  if (!previousRumorId || !HEX_32.test(previousRumorId)) {
    throw new Error("Later message requires an exact predecessor rumor ID");
  }
  return [["p", message.recipient_pubkey], ["e", previousRumorId, "", "reply"]];
}

export async function createTradeRumor(
  message: GranolaTradeMessage,
  authorSecretKey: Uint8Array,
  previousRumorId?: string
): Promise<UnsignedRumor> {
  const checked = await assertMessage(message);
  const author = getPublicKey(authorSecretKey);
  if (checked.author_pubkey !== author) throw new Error("Message author does not match signing key");
  const rumor = {
    pubkey: author,
    created_at: checked.sent_at,
    kind: 14 as const,
    tags: expectedRumorTags(checked, previousRumorId),
    content: canonicalJson(checked)
  };
  return { ...rumor, id: getEventHash(rumor) };
}

function exactTagArrays(actual: string[][], expected: string[][], label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} tags are invalid`);
}

function parseSignedEvent(value: unknown, label: string): SignedNostrEvent {
  const event = record(value, label);
  exactKeys(event, ["id", "pubkey", "created_at", "kind", "tags", "content", "sig"], label);
  requiredString(event.id, `${label} ID`, HEX_32);
  requiredString(event.pubkey, `${label} pubkey`, HEX_32);
  requiredString(event.sig, `${label} signature`, /^[0-9a-f]{128}$/);
  safeTimestamp(event.created_at, `${label} created_at`);
  if (!Number.isSafeInteger(event.kind)) throw new Error(`${label} kind is invalid`);
  if (!Array.isArray(event.tags) || event.tags.some((tag) => !Array.isArray(tag) || tag.some((item) => typeof item !== "string"))) {
    throw new Error(`${label} tags are invalid`);
  }
  if (typeof event.content !== "string") throw new Error(`${label} content is invalid`);
  return event as unknown as SignedNostrEvent;
}

function verifyFresh(event: SignedNostrEvent): boolean {
  return verifyEvent({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig
  });
}

function parseRumor(value: unknown): UnsignedRumor {
  const rumor = record(value, "Rumor");
  exactKeys(rumor, ["id", "pubkey", "created_at", "kind", "tags", "content"], "Rumor");
  requiredString(rumor.id, "Rumor ID", HEX_32);
  requiredString(rumor.pubkey, "Rumor pubkey", HEX_32);
  safeTimestamp(rumor.created_at, "Rumor created_at");
  if (rumor.kind !== 14) throw new Error("Rumor kind must be 14");
  if (!Array.isArray(rumor.tags) || rumor.tags.some((tag) => !Array.isArray(tag) || tag.some((item) => typeof item !== "string"))) {
    throw new Error("Rumor tags are invalid");
  }
  if (typeof rumor.content !== "string") throw new Error("Rumor content is invalid");
  return rumor as unknown as UnsignedRumor;
}

function assertRandomizedTimestamp(value: number, rumorTime: number, label: string): void {
  if (value < rumorTime - 172_800 || value > rumorTime) {
    throw new Error(`${label} timestamp is outside the NIP-17 randomization window`);
  }
}

export function wrapTradeRumor(
  rumor: UnsignedRumor,
  authorSecretKey: Uint8Array,
  options: WrapTradeRumorOptions
): WrappedTradeRumor {
  if (getEventHash(rumor) !== rumor.id) throw new Error("Rumor ID is invalid");
  if (rumor.pubkey !== getPublicKey(authorSecretKey)) throw new Error("Rumor author does not match seal key");
  const recipientTag = rumor.tags[0];
  if (!recipientTag || recipientTag.length !== 2 || recipientTag[0] !== "p" || !HEX_32.test(recipientTag[1] ?? "")) {
    throw new Error("Rumor recipient tag is invalid");
  }
  const recipient = recipientTag[1] as string;
  safeTimestamp(options.sealCreatedAt, "Seal created_at");
  safeTimestamp(options.wrapperCreatedAt, "Wrapper created_at");
  safeTimestamp(options.outerExpiration, "Outer expiration");
  assertRandomizedTimestamp(options.sealCreatedAt, rumor.created_at, "Seal");
  assertRandomizedTimestamp(options.wrapperCreatedAt, rumor.created_at, "Wrapper");

  const seal = finalizeEvent({
    kind: 13,
    created_at: options.sealCreatedAt,
    tags: [],
    content: nip44.v2.encrypt(
      canonicalJson(rumor),
      nip44.v2.utils.getConversationKey(authorSecretKey, recipient),
      options.sealNonce
    )
  }, authorSecretKey);
  const ephemeral = options.ephemeralSecretKey ?? generateSecretKey();
  const wrapper = finalizeEvent({
    kind: 1059,
    created_at: options.wrapperCreatedAt,
    tags: [["p", recipient], ["expiration", String(options.outerExpiration)]],
    content: nip44.v2.encrypt(
      canonicalJson(seal),
      nip44.v2.utils.getConversationKey(ephemeral, recipient),
      options.wrapperNonce
    )
  }, ephemeral);
  return { rumor, seal, wrapper };
}

export async function transcriptHash(previousTranscriptHash: string | null, rumorId: string): Promise<string> {
  return sha256([
    utf8.encode("granola-transcript-v1\n"),
    previousTranscriptHash === null ? new Uint8Array(32) : fromHex(previousTranscriptHash),
    fromHex(rumorId)
  ]);
}

async function unwrapTradeMessageInternal(
  outerValue: SignedNostrEvent,
  recipientSecretKey: Uint8Array,
  options: Omit<
    UnwrapTradeMessageOptions,
    | "expectedAuthorPubkey"
    | "expectedOrderAddress"
    | "expectedOrderHead"
    | "expectedTermsHash"
  > & {
    expectedAuthorPubkey?: string;
    expectedOrderAddress?: string;
    expectedOrderHead?: string;
    expectedTermsHash?: string;
  }
): Promise<OpenedTradeMessage> {
  safeTimestamp(options.now, "Current time");
  if (options.expectedAuthorPubkey !== undefined) {
    requiredString(options.expectedAuthorPubkey, "Expected author pubkey", HEX_32);
  }
  const recipient = getPublicKey(recipientSecretKey);
  const outer = parseSignedEvent(outerValue, "Outer event");
  if (utf8.encode(outer.content).length > 32 * 1024) {
    throw new Error("Outer encoded payload exceeds the 32 KiB Granola limit");
  }
  if (outer.kind !== 1059 || !verifyFresh(outer)) throw new Error("Outer event signature or kind is invalid");
  if (outer.pubkey === recipient) throw new Error("Outer one-time pubkey must differ from recipient");
  if (outer.tags.length !== 2) throw new Error("Outer recipient and expiration tags are required");
  const expirationValue = outer.tags[1]?.[1];
  if (typeof expirationValue !== "string" || !CANONICAL_INTEGER.test(expirationValue)) {
    throw new Error("Outer expiration is invalid");
  }
  if (outer.tags[0]?.[0] !== "p" || outer.tags[0]?.[1] !== recipient) {
    throw new Error("Outer recipient tag does not match the receiving key");
  }
  exactTagArrays(outer.tags, [["p", recipient], ["expiration", expirationValue]], "Outer");
  const outerExpiration = Number(expirationValue);
  if (!Number.isSafeInteger(outerExpiration) || options.now >= outerExpiration) {
    throw new Error("Outer expiration has passed");
  }

  let seal: SignedNostrEvent;
  try {
    const plaintext = nip44.v2.decrypt(
      outer.content,
      nip44.v2.utils.getConversationKey(recipientSecretKey, outer.pubkey)
    );
    seal = parseSignedEvent(JSON.parse(plaintext), "Seal");
  } catch (error) {
    throw new Error("Outer payload decryption or seal parsing failed", { cause: error });
  }
  if (seal.kind !== 13 || !verifyFresh(seal)) throw new Error("Seal signature or kind is invalid");
  exactTagArrays(seal.tags, [], "Seal");

  let rumor: UnsignedRumor;
  try {
    const plaintext = nip44.v2.decrypt(
      seal.content,
      nip44.v2.utils.getConversationKey(recipientSecretKey, seal.pubkey)
    );
    rumor = parseRumor(JSON.parse(plaintext));
  } catch (error) {
    throw new Error("Seal decryption or rumor parsing failed", { cause: error });
  }
  if (getEventHash(rumor) !== rumor.id) throw new Error("Rumor ID is invalid");
  if (seal.pubkey !== rumor.pubkey) throw new Error("Seal and rumor authors differ");

  let parsed: unknown;
  try {
    parsed = JSON.parse(rumor.content);
  } catch (error) {
    throw new Error("Granola plaintext is not valid JSON", { cause: error });
  }
  if (canonicalJson(parsed) !== rumor.content) throw new Error("Granola plaintext is not canonical JSON");
  const message = await assertMessage(parsed);

  if (rumor.pubkey !== message.author_pubkey || seal.pubkey !== message.author_pubkey) {
    throw new Error("Content, rumor, and seal authors differ");
  }
  if (
    options.expectedAuthorPubkey !== undefined &&
    message.author_pubkey !== options.expectedAuthorPubkey
  ) throw new Error("Unexpected message author");
  if (message.recipient_pubkey !== recipient) throw new Error("Unexpected message recipient");
  if (
    options.expectedOrderAddress !== undefined &&
    message.order_address !== options.expectedOrderAddress
  ) throw new Error("Unexpected order address");
  if (options.expectedOrderHead !== undefined && message.order_head !== options.expectedOrderHead) {
    throw new Error("Unexpected order head");
  }
  if (
    options.expectedTermsHash !== undefined &&
    message.terms_hash !== options.expectedTermsHash
  ) throw new Error("Unexpected terms hash");
  if (outer.pubkey === message.author_pubkey) throw new Error("Outer one-time pubkey must differ from author");
  if (options.expectedType !== undefined && message.type !== options.expectedType) {
    throw new Error("Unexpected message type");
  }

  if (rumor.created_at !== message.sent_at) throw new Error("Rumor timestamp must equal sent_at");
  if (message.sent_at > options.now + 300) throw new Error("Message is too far in the future");
  if (options.now >= message.expires_at) throw new Error("Encrypted message has expired");
  assertRandomizedTimestamp(seal.created_at, rumor.created_at, "Seal");
  assertRandomizedTimestamp(outer.created_at, rumor.created_at, "Wrapper");
  const expiryJitter = outerExpiration - message.expires_at;
  if (expiryJitter < 3600 || expiryJitter > 86_400 || expiryJitter % 3600 !== 0) {
    throw new Error("Outer expiration jitter is outside Granola policy");
  }

  const sequence = BigInt(message.sequence);
  if (options.expectedSequence !== undefined && message.sequence !== options.expectedSequence) {
    throw new Error("Unexpected message sequence");
  }
  if (sequence === 0n) {
    exactTagArrays(rumor.tags, [["p", recipient]], "Rumor");
  } else {
    const predecessor = options.expectedPreviousRumorId;
    if (!predecessor || !HEX_32.test(predecessor)) throw new Error("Expected predecessor rumor is required");
    exactTagArrays(rumor.tags, [["p", recipient], ["e", predecessor, "", "reply"]], "Predecessor rumor");
    if (options.expectedPreviousMessageId === undefined || message.previous_message_id !== options.expectedPreviousMessageId) {
      throw new Error("Previous message ID does not match transcript state");
    }
    if (options.expectedPreviousTranscriptHash === undefined || message.previous_transcript_hash !== options.expectedPreviousTranscriptHash) {
      throw new Error("Previous transcript hash does not match transcript state");
    }
  }

  const opened: OpenedTradeMessage = {
    wrapper: outer,
    seal,
    rumor,
    message,
    transcriptHash: await transcriptHash(message.previous_transcript_hash, rumor.id)
  };
  authenticatedTradeMessages.set(opened, canonicalJson(opened));
  return opened;
}

export async function unwrapTradeMessage(
  outerValue: SignedNostrEvent,
  recipientSecretKey: Uint8Array,
  options: UnwrapTradeMessageOptions
): Promise<OpenedTradeMessage> {
  return unwrapTradeMessageInternal(outerValue, recipientSecretKey, options);
}

/**
 * Opens only the first reservation proposal, where the taker's fresh session
 * public key cannot be known until its authenticated NIP-17 seal is decrypted.
 */
export async function unwrapInitialReserveProposal(
  outerValue: SignedNostrEvent,
  recipientSecretKey: Uint8Array,
  options: InitialReserveProposalOptions
): Promise<VerifiedInitialReserveProposal> {
  const opened = await unwrapTradeMessageInternal(outerValue, recipientSecretKey, {
    ...options,
    expectedType: "reserve_propose",
    expectedSequence: "0"
  });
  if (
    opened.message.type !== "reserve_propose" ||
    opened.message.sequence !== "0" ||
    opened.message.previous_message_id !== null ||
    opened.message.previous_transcript_hash !== null
  ) {
    throw new Error("Message is not an initial reservation proposal");
  }
  deepFreeze(opened);
  verifiedInitialProposals.add(opened);
  return opened as VerifiedInitialReserveProposal;
}

/**
 * Opens the maker order key's initial rendezvous message before its encrypted
 * order address, head, and terms hash are available to the subscriber. The
 * returned proposal is still fully authenticated and self-validating; callers
 * must bind it to the current verified public order before accepting it.
 */
export async function unwrapInitialReserveProposalForMaker(
  outerValue: SignedNostrEvent,
  recipientSecretKey: Uint8Array,
  options: { now: number }
): Promise<VerifiedInitialReserveProposal> {
  const opened = await unwrapTradeMessageInternal(
    outerValue,
    recipientSecretKey,
    {
      now: options.now,
      expectedType: "reserve_propose",
      expectedSequence: "0"
    }
  );
  if (
    opened.message.type !== "reserve_propose" ||
    opened.message.sequence !== "0" ||
    opened.message.previous_message_id !== null ||
    opened.message.previous_transcript_hash !== null
  ) {
    throw new Error("Message is not an initial reservation proposal");
  }
  deepFreeze(opened);
  verifiedInitialProposals.add(opened);
  return opened as VerifiedInitialReserveProposal;
}

/**
 * Opens the one maker-order-key response that introduces the newly published
 * reserve head. The head is accepted only when the signed body binds it too.
 */
export async function unwrapReserveAcceptance(
  outerValue: SignedNostrEvent,
  recipientSecretKey: Uint8Array,
  options: ReserveAcceptanceOptions
): Promise<OpenedTradeMessage> {
  const opened = await unwrapTradeMessageInternal(outerValue, recipientSecretKey, {
    ...options,
    expectedType: "reserve_accept",
    expectedSequence: "1"
  });
  const body = record(opened.message.body, "Reserve acceptance body");
  if (
    requiredString(body.reserve_transition_id, "Reserve transition ID", HEX_32) !==
    opened.message.order_head
  ) {
    throw new Error("Reserve transition ID does not match the accepted order head");
  }
  return opened;
}
