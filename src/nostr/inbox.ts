import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools";

import type { NostrEvent } from "../order/events.js";

export interface InboxRelayCapabilities {
  supportedNips: number[];
  authRequired: boolean;
}

export type AuthHandler = (challenge: string) => Promise<NostrEvent>;

export interface InboxRelayPort {
  info(relay: string): Promise<InboxRelayCapabilities>;
  publish(relay: string, event: NostrEvent, auth: AuthHandler): Promise<string>;
  query(
    relay: string,
    filter: Record<string, unknown>,
    auth: AuthHandler
  ): Promise<NostrEvent[]>;
}

export interface ValidatedInboxList {
  event: NostrEvent;
  relays: string[];
}

export interface InboxObservation {
  relay: string;
  event: NostrEvent;
}

export interface InboxReceipt {
  relay: string;
  ok: boolean;
  message: string;
}

export interface InboxPublicationResult {
  event: NostrEvent;
  receipts: InboxReceipt[];
  readback: Array<{
    relay: string;
    found: boolean;
    event: NostrEvent | null;
    observedAt: number;
  }>;
  confirmed: string[];
}

export interface InboxLiveProbeResult {
  relay: string;
  checkedAt: number;
  listReadback: boolean;
  recipientReadback: boolean;
  otherKeyExcluded: boolean;
}

declare const VERIFIED_INBOX_LIVE_PROBE: unique symbol;

export type VerifiedInboxLiveProbeResult = Readonly<InboxLiveProbeResult> & {
  readonly [VERIFIED_INBOX_LIVE_PROBE]: true;
};

const verifiedInboxLiveProbes = new WeakSet<object>();

export function assertVerifiedInboxLiveProbe(
  value: unknown
): asserts value is VerifiedInboxLiveProbeResult {
  if (!value || typeof value !== "object" || !verifiedInboxLiveProbes.has(value)) {
    throw new Error("Inbox relay requires verified live probe evidence");
  }
}

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const SEVEN_DAYS = 7 * 24 * 60 * 60;

function timestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe Unix timestamp`);
  }
  return value;
}

export function normalizeInboxRelay(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Inbox relay must be a valid wss:// URL");
  }
  if (
    parsed.protocol !== "wss:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Inbox relay must be a credential-free wss:// URL without query or fragment");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function normalizeRelays(
  values: readonly string[],
  label: string,
  minimum: number,
  maximum: number
): string[] {
  if (values.length < minimum || values.length > maximum) {
    throw new Error(`${label} requires ${minimum}-${maximum} relays`);
  }
  const relays = values.map(normalizeInboxRelay);
  if (new Set(relays).size !== relays.length) throw new Error(`${label} contains a duplicate relay`);
  return relays.sort();
}

export function normalizeInboxListRelays(values: readonly string[]): string[] {
  return normalizeRelays(values, "Inbox list", 1, 3);
}

export function normalizeDiscoveryRelays(values: readonly string[]): string[] {
  return normalizeRelays(values, "Discovery", 3, 3);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export function snapshotNostrEvent(event: NostrEvent): NostrEvent {
  return immutableSnapshot(event);
}

function verifyFresh(event: NostrEvent): boolean {
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

function assertEventShape(event: NostrEvent, label: string): void {
  if (!HEX_32.test(event.id) || !HEX_32.test(event.pubkey) || !HEX_64.test(event.sig)) {
    throw new Error(`${label} identifiers or signature are malformed`);
  }
  timestamp(event.created_at, `${label} created_at`);
  if (!Array.isArray(event.tags) || event.tags.some((tag) =>
    !Array.isArray(tag) || tag.some((item) => typeof item !== "string")
  )) throw new Error(`${label} tags are malformed`);
  if (typeof event.content !== "string") throw new Error(`${label} content is malformed`);
}

export function createInboxList(
  relayValues: readonly string[],
  protocolSecretKey: Uint8Array,
  createdAt: number
): NostrEvent {
  timestamp(createdAt, "Inbox-list created_at");
  const relays = normalizeInboxListRelays(relayValues);
  return finalizeEvent({
    kind: 10050,
    created_at: createdAt,
    tags: relays.map((relay) => ["relay", relay]),
    content: ""
  }, protocolSecretKey);
}

export function validateInboxList(
  event: NostrEvent,
  expectedAuthor: string,
  now: number
): ValidatedInboxList {
  timestamp(now, "Current time");
  if (!HEX_32.test(expectedAuthor)) throw new Error("Expected inbox-list author is malformed");
  assertEventShape(event, "Inbox list");
  if (event.kind !== 10050 || !verifyFresh(event)) throw new Error("Inbox-list signature or kind is invalid");
  if (event.pubkey !== expectedAuthor) throw new Error("Inbox-list author is unexpected");
  if (event.content !== "") throw new Error("Inbox-list content must be empty");
  if (event.created_at > now + 300) throw new Error("Inbox list is too far in the future");
  if (event.created_at < now - SEVEN_DAYS) throw new Error("Inbox list is stale");
  if (event.tags.length < 1 || event.tags.length > 3) throw new Error("Inbox list requires 1-3 relay tags");
  const raw = event.tags.map((tag) => {
    if (tag.length !== 2 || tag[0] !== "relay" || !tag[1]) {
      throw new Error("Inbox list contains an invalid relay tag");
    }
    const normalized = normalizeInboxRelay(tag[1]);
    if (normalized !== tag[1]) throw new Error("Inbox-list relay tags must already be normalized");
    return normalized;
  });
  const sorted = [...raw].sort();
  if (new Set(raw).size !== raw.length) throw new Error("Inbox list contains duplicate relays");
  if (raw.some((relay, index) => relay !== sorted[index])) {
    throw new Error("Inbox-list relay tags must be sorted");
  }
  return immutableSnapshot({ event, relays: raw });
}

export function selectInboxList(
  observations: readonly InboxObservation[],
  expectedAuthor: string,
  now: number,
  quorum = 1
): ValidatedInboxList {
  if (!Number.isSafeInteger(quorum) || quorum < 1) throw new Error("Inbox discovery quorum is invalid");
  const valid: Array<{ relay: string; list: ValidatedInboxList }> = [];
  for (const observation of observations) {
    try {
      valid.push({
        relay: normalizeInboxRelay(observation.relay),
        list: validateInboxList(observation.event, expectedAuthor, now)
      });
    } catch {
      // An untrusted discovery relay may inject invalid candidates. They never count.
    }
  }
  if (valid.length === 0) throw new Error("No valid inbox list was discovered");
  valid.sort((left, right) =>
    right.list.event.created_at - left.list.event.created_at ||
    left.list.event.id.localeCompare(right.list.event.id)
  );
  const selected = valid[0]!.list;
  const readableFrom = new Set(
    valid.filter(({ list }) => list.event.id === selected.event.id).map(({ relay }) => relay)
  );
  if (readableFrom.size < quorum) {
    throw new Error("Latest inbox list has split or missing discovery quorum");
  }
  return selected;
}

export function createNip42AuthEvent(
  relayValue: string,
  challenge: string,
  protocolSecretKey: Uint8Array,
  createdAt: number
): NostrEvent {
  const relay = normalizeInboxRelay(relayValue);
  timestamp(createdAt, "AUTH created_at");
  if (!challenge || challenge.length > 1024) throw new Error("NIP-42 challenge is invalid");
  return finalizeEvent({
    kind: 22242,
    created_at: createdAt,
    tags: [["relay", relay], ["challenge", challenge]],
    content: ""
  }, protocolSecretKey);
}

function authHandler(relay: string, protocolSecretKey: Uint8Array, now: number): AuthHandler {
  return async (challenge) => createNip42AuthEvent(relay, challenge, protocolSecretKey, now);
}

export function assertInboxCapabilities(capabilities: InboxRelayCapabilities): void {
  for (const required of [17, 40, 42]) {
    if (!capabilities.supportedNips.includes(required)) {
      throw new Error(`Inbox relay does not advertise NIP-${required}`);
    }
  }
  if (!capabilities.authRequired) throw new Error("Inbox relay must require NIP-42 authentication");
}

function relayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function publishInboxList(
  event: NostrEvent,
  discoveryRelayValues: readonly string[],
  protocolSecretKey: Uint8Array,
  port: InboxRelayPort,
  now: number,
  quorum = 1
): Promise<InboxPublicationResult> {
  const eventSnapshot = snapshotNostrEvent(event);
  const keySnapshot = Uint8Array.from(protocolSecretKey);
  try {
    const relays = normalizeDiscoveryRelays(discoveryRelayValues);
    const author = getPublicKey(keySnapshot);
    validateInboxList(eventSnapshot, author, now);
    if (!Number.isSafeInteger(quorum) || quorum < 1 || quorum > relays.length) {
      throw new Error("Inbox publication quorum is invalid");
    }

    type Attempt = {
      relay: string;
      receipt: InboxReceipt;
      readback: InboxPublicationResult["readback"][number];
      confirmed: boolean;
    };

    const attempts = relays.map((relay) => (async (): Promise<Attempt> => {
      const relayKey = Uint8Array.from(keySnapshot);
      try {
        let receipt: InboxReceipt;
        try {
          receipt = {
            relay,
            ok: true,
            message: await port.publish(
              relay,
              eventSnapshot,
              authHandler(relay, relayKey, now)
            )
          };
        } catch (error) {
          return {
            relay,
            receipt: { relay, ok: false, message: relayError(error) },
            readback: { relay, found: false, event: null, observedAt: now },
            confirmed: false
          };
        }

        try {
          const events = await port.query(relay, {
            ids: [eventSnapshot.id],
            authors: [eventSnapshot.pubkey],
            kinds: [10050],
            limit: 1
          }, authHandler(relay, relayKey, now));
          const exactCandidate = events.find((candidate) => {
            try {
              validateInboxList(candidate, eventSnapshot.pubkey, now);
              return candidate.id === eventSnapshot.id;
            } catch {
              return false;
            }
          }) ?? null;
          const exact = exactCandidate === null ? null : snapshotNostrEvent(exactCandidate);
          return {
            relay,
            receipt,
            readback: { relay, found: exact !== null, event: exact, observedAt: now },
            confirmed: exact !== null
          };
        } catch {
          return {
            relay,
            receipt,
            readback: { relay, found: false, event: null, observedAt: now },
            confirmed: false
          };
        }
      } finally {
        relayKey.fill(0);
      }
    })());

    const pending = attempts.map((promise, index) => ({
      index,
      promise: promise.then((attempt) => ({ index, attempt }))
    }));
    const completed: Array<Attempt | undefined> = [];
    let confirmedCount = 0;
    while (pending.length > 0 && confirmedCount < quorum) {
      const outcome = await Promise.race(pending.map(({ promise }) => promise));
      const pendingIndex = pending.findIndex(({ index }) => index === outcome.index);
      if (pendingIndex >= 0) pending.splice(pendingIndex, 1);
      completed[outcome.index] = outcome.attempt;
      if (outcome.attempt.confirmed) confirmedCount += 1;
    }

    if (confirmedCount < quorum) {
      const remaining = await Promise.all(pending.map(({ promise }) => promise));
      for (const outcome of remaining) completed[outcome.index] = outcome.attempt;
    }

    const settled = completed.filter((attempt): attempt is Attempt => attempt !== undefined);
    const receipts = settled.map(({ receipt }) => receipt);
    const readback = settled.map(({ readback: result }) => result);
    const confirmed = settled.filter(({ confirmed: isConfirmed }) => isConfirmed).map(({ relay }) => relay);
    if (confirmed.length < quorum) {
      throw new Error("Inbox-list ACK and readback quorum was not reached");
    }
    return immutableSnapshot({ event: eventSnapshot, receipts, readback, confirmed });
  } finally {
    keySnapshot.fill(0);
  }
}

function validateGiftWrap(event: NostrEvent, expectedRecipient: string, now: number): void {
  assertEventShape(event, "Gift wrap");
  if (event.kind !== 1059 || !verifyFresh(event)) throw new Error("Gift-wrap signature or kind is invalid");
  if (event.tags.length !== 2 || event.tags[0]?.length !== 2 || event.tags[0]?.[0] !== "p" || event.tags[0]?.[1] !== expectedRecipient) {
    throw new Error("Gift-wrap recipient tag is invalid");
  }
  const expiration = event.tags[1];
  const expirationValue = Number(expiration?.[1]);
  if (
    expiration?.length !== 2 || expiration[0] !== "expiration" ||
    !CANONICAL_INTEGER.test(expiration[1] ?? "") ||
    !Number.isSafeInteger(expirationValue) ||
    expirationValue <= now
  ) throw new Error("Gift-wrap expiration tag is invalid or expired");
}

async function requireInboxRelay(relay: string, port: InboxRelayPort): Promise<void> {
  assertInboxCapabilities(await port.info(relay));
}

export async function publishGiftWrap(
  wrapper: NostrEvent,
  inboxRelayValues: readonly string[],
  senderProtocolSecretKey: Uint8Array,
  port: InboxRelayPort,
  now: number
): Promise<InboxReceipt[]> {
  const wrapperSnapshot = snapshotNostrEvent(wrapper);
  const keySnapshot = Uint8Array.from(senderProtocolSecretKey);
  try {
    timestamp(now, "Current time");
    const relays = normalizeRelays(inboxRelayValues, "Gift-wrap publication", 1, 3);
    const recipient = wrapperSnapshot.tags[0]?.[1] ?? "";
    if (!HEX_32.test(recipient)) throw new Error("Gift-wrap recipient is malformed");
    validateGiftWrap(wrapperSnapshot, recipient, now);
    const receipts = await Promise.all(relays.map(async (relay): Promise<InboxReceipt> => {
      try {
        await requireInboxRelay(relay, port);
        const message = await port.publish(
          relay,
          wrapperSnapshot,
          authHandler(relay, keySnapshot, now)
        );
        return { relay, ok: true, message };
      } catch (error) {
        return { relay, ok: false, message: relayError(error) };
      }
    }));
    return immutableSnapshot(receipts);
  } finally {
    keySnapshot.fill(0);
  }
}

export async function queryGiftWraps(
  recipientPubkey: string,
  inboxRelayValues: readonly string[],
  recipientProtocolSecretKey: Uint8Array,
  port: InboxRelayPort,
  since: number,
  now: number
): Promise<NostrEvent[]> {
  const keySnapshot = Uint8Array.from(recipientProtocolSecretKey);
  try {
    timestamp(since, "Gift-wrap query start");
    timestamp(now, "Current time");
    if (since > now) throw new Error("Gift-wrap query start is in the future");
    if (getPublicKey(keySnapshot) !== recipientPubkey) {
      throw new Error("Gift-wrap query requires the exact recipient protocol key");
    }
    const relays = normalizeRelays(inboxRelayValues, "Gift-wrap query", 1, 3);
    const observations = await Promise.all(relays.map(async (relay): Promise<NostrEvent[] | null> => {
      try {
        await requireInboxRelay(relay, port);
        return await port.query(relay, {
          kinds: [1059], "#p": [recipientPubkey], since, limit: 500
        }, authHandler(relay, keySnapshot, now));
      } catch {
        return null;
      }
    }));
    const successful = observations.filter((events): events is NostrEvent[] => events !== null);
    if (successful.length === 0) throw new Error("All inbox relays were unavailable");
    const events = successful.flat();
    const unique = new Map<string, NostrEvent>();
    for (const event of events) {
      try {
        validateGiftWrap(event, recipientPubkey, now);
        unique.set(event.id, snapshotNostrEvent(event));
      } catch {
        // Invalid relay data is never surfaced to the decryption pipeline.
      }
    }
    return immutableSnapshot([...unique.values()]);
  } finally {
    keySnapshot.fill(0);
  }
}

export async function probeInboxRelayLive(input: {
  relay: string;
  inboxList: NostrEvent;
  wrapper: NostrEvent;
  recipientProtocolSecretKey: Uint8Array;
  senderProtocolSecretKey: Uint8Array;
  otherProtocolSecretKey: Uint8Array;
  port: InboxRelayPort;
  now: number;
}): Promise<VerifiedInboxLiveProbeResult> {
  const relay = normalizeInboxRelay(input.relay);
  const inboxList = snapshotNostrEvent(input.inboxList);
  const wrapper = snapshotNostrEvent(input.wrapper);
  const recipientKey = Uint8Array.from(input.recipientProtocolSecretKey);
  const senderKey = Uint8Array.from(input.senderProtocolSecretKey);
  const otherKey = Uint8Array.from(input.otherProtocolSecretKey);
  const port = input.port;
  try {
    const now = timestamp(input.now, "Current time");
    await requireInboxRelay(relay, port);
    const recipient = getPublicKey(recipientKey);
    validateInboxList(inboxList, recipient, now);
    validateGiftWrap(wrapper, recipient, now);

    await port.publish(
      relay,
      inboxList,
      authHandler(relay, recipientKey, now)
    );
    const lists = await port.query(relay, {
      ids: [inboxList.id], authors: [recipient], kinds: [10050], limit: 1
    }, authHandler(relay, recipientKey, now));
    await port.publish(
      relay,
      wrapper,
      authHandler(relay, senderKey, now)
    );
    const filter = immutableSnapshot({
      ids: [wrapper.id],
      kinds: [1059],
      "#p": [recipient],
      limit: 1
    });
    const recipientEvents = await port.query(
      relay,
      filter,
      authHandler(relay, recipientKey, now)
    );
    const otherEvents = await port.query(
      relay,
      filter,
      authHandler(relay, otherKey, now)
    );
    const listReadback = lists.some((event) => {
      try {
        return validateInboxList(event, recipient, now).event.id === inboxList.id;
      } catch {
        return false;
      }
    });
    const recipientReadback = recipientEvents.some((event) => {
      try {
        validateGiftWrap(event, recipient, now);
        return event.id === wrapper.id;
      } catch {
        return false;
      }
    });
    const result = {
      relay,
      checkedAt: now,
      listReadback,
      recipientReadback,
      otherKeyExcluded: !otherEvents.some((event) => event.id === wrapper.id)
    };
    if (!result.listReadback || !result.recipientReadback || !result.otherKeyExcluded) {
      throw new Error("Inbox relay failed the Granola recipient-only live probe");
    }
    const verified = immutableSnapshot(result);
    verifiedInboxLiveProbes.add(verified);
    return verified as VerifiedInboxLiveProbeResult;
  } finally {
    recipientKey.fill(0);
    senderKey.fill(0);
    otherKey.fill(0);
  }
}
