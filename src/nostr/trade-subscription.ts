import { getPublicKey } from "nostr-tools";

import type { NostrEvent } from "../order/events.js";
import {
  createNip42AuthEvent,
  normalizeInboxListRelays,
  type AuthHandler
} from "./inbox.js";
import type { PersistentInboxSubscription } from "./inbox-relay.js";

export interface TradeSubscriptionCallbacks {
  onevent(event: NostrEvent): void;
  onclose(reason: string): void;
}

export interface TradeSubscriptionRelayPort {
  subscribe(
    relay: string,
    filter: Record<string, unknown>,
    auth: AuthHandler,
    callbacks: TradeSubscriptionCallbacks
  ): Promise<PersistentInboxSubscription>;
}

export interface TradeSubscriptionError {
  relay: string;
  kind: "relay_start" | "relay_closed" | "event_callback" | "subscription_stop";
  message: string;
}

export interface TradeSubscriptionCursor {
  since: number;
}

export interface TradeSubscriptionRestart {
  recipientPubkey: string;
  inboxRelays: readonly string[];
  cursor: Readonly<TradeSubscriptionCursor>;
}

export interface TradeSubscription {
  /**
   * Non-secret configuration needed to call startTradeSubscription again with
   * the caller's latest durably saved cursor and a freshly supplied key.
   */
  readonly restart: Readonly<TradeSubscriptionRestart>;
  stop(): void;
}

export interface StartTradeSubscriptionInput {
  recipientPubkey: string;
  recipientSecretKey: Uint8Array;
  inboxRelays: readonly string[];
  cursor: TradeSubscriptionCursor;
  port: TradeSubscriptionRelayPort;
  now(): number;
  onEvent(event: NostrEvent, relay: string): void | Promise<void>;
  onError(error: TradeSubscriptionError): void;
}

const HEX_32 = /^[0-9a-f]{64}$/;

function timestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe Unix timestamp`);
  }
  return value;
}

function reportSafely(
  callback: (error: TradeSubscriptionError) => void,
  error: TradeSubscriptionError
): void {
  try {
    callback(error);
  } catch {
    // Error reporting must not break subscription cleanup or event ordering.
  }
}

/**
 * Opens the live half of the durable inbox. The caller owns cursor persistence:
 * after a stop or relay failure, call this function again with the last saved
 * `cursor.since` and a newly loaded secret key.
 */
export async function startTradeSubscription(
  input: StartTradeSubscriptionInput
): Promise<TradeSubscription> {
  const retainedKey = Uint8Array.from(input.recipientSecretKey);
  const opened: PersistentInboxSubscription[] = [];
  let stopped = false;
  try {
    if (!HEX_32.test(input.recipientPubkey)) {
      throw new Error("Trade subscription recipient pubkey must be lowercase hex");
    }
    if (
      retainedKey.length !== 32 ||
      getPublicKey(retainedKey) !== input.recipientPubkey
    ) {
      throw new Error("Trade subscription requires the exact recipient key");
    }
    const since = timestamp(input.cursor.since, "Trade subscription cursor");
    const relays = normalizeInboxListRelays(input.inboxRelays);
    const seen = new Set<string>();
    let eventQueue = Promise.resolve();

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      for (let index = 0; index < opened.length; index += 1) {
        try {
          opened[index]!.close("granola trade subscription stopped");
        } catch {
          reportSafely(input.onError, {
            relay: relays[index]!,
            kind: "subscription_stop",
            message: "Inbox relay subscription failed to stop cleanly"
          });
        }
      }
      opened.length = 0;
      seen.clear();
      retainedKey.fill(0);
    };

    for (const relay of relays) {
      try {
        const subscription = await input.port.subscribe(
          relay,
          { kinds: [1059], "#p": [input.recipientPubkey], since },
          async (challenge) => createNip42AuthEvent(
            relay,
            challenge,
            retainedKey,
            timestamp(input.now(), "Trade subscription AUTH time")
          ),
          {
            onevent: (event) => {
              if (stopped || seen.has(event.id)) return;
              seen.add(event.id);
              const snapshot = structuredClone(event);
              eventQueue = eventQueue
                .then(async () => {
                  if (!stopped) await input.onEvent(snapshot, relay);
                })
                .catch(() => {
                  reportSafely(input.onError, {
                    relay,
                    kind: "event_callback",
                    message: "Trade inbox event callback failed"
                  });
                });
            },
            onclose: () => {
              if (!stopped) {
                reportSafely(input.onError, {
                  relay,
                  kind: "relay_closed",
                  message: "Inbox relay subscription closed unexpectedly"
                });
              }
            }
          }
        );
        opened.push(subscription);
      } catch {
        reportSafely(input.onError, {
          relay,
          kind: "relay_start",
          message: "Inbox relay subscription failed to start"
        });
        stop();
        throw new Error(`Inbox relay subscription failed: ${relay}`);
      }
    }

    const restart = Object.freeze({
      recipientPubkey: input.recipientPubkey,
      inboxRelays: Object.freeze([...relays]),
      cursor: Object.freeze({ since })
    });
    return Object.freeze({ restart, stop });
  } catch (error) {
    if (!stopped) {
      for (const subscription of opened) {
        try {
          subscription.close("granola trade subscription start failed");
        } catch {
          // Best-effort cleanup continues for every already-opened relay.
        }
      }
      retainedKey.fill(0);
    }
    throw error;
  }
}
