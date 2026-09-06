import { getPublicKey, verifyEvent } from "nostr-tools/pure";
import { parseProjectionEvent, type NostrEvent } from "../order/events.js";
import type { PendingOrderReply } from "../storage/order-outbox.js";
import { validateAtomicSwapMessage } from "./atomic-messages.js";
import { assertVerifiedInitialReserveProposal, createTradeRumor, wrapTradeRumor,
  type GranolaTradeMessage, type JsonValue, type VerifiedInitialReserveProposal } from "./messages.js";

/** A refusal uses order authority, never a settlement identity or bearer material. */
export async function createOrderResponse(proposal: VerifiedInitialReserveProposal,
  projection: NostrEvent, availability: "preparing" | "changed", key: Uint8Array, now: number
): Promise<PendingOrderReply> {
  assertVerifiedInitialReserveProposal(proposal);
  await validateAtomicSwapMessage(proposal.message);
  const current = await parseProjectionEvent(projection, verifyEvent);
  const request = proposal.message;
  if (getPublicKey(key) !== request.maker_order_pubkey || current.address !== request.order_address ||
    current.makerPubkey !== request.maker_order_pubkey || request.expires_at <= now) {
    throw new Error("Order response does not match the authenticated proposal");
  }
  const { terms: _terms, ...binding } = request;
  const message: GranolaTradeMessage = {
    ...binding, type: "error", message_id: crypto.randomUUID(),
    author_pubkey: request.maker_order_pubkey, recipient_pubkey: request.author_pubkey,
    sequence: "1", previous_message_id: request.message_id,
    previous_transcript_hash: proposal.transcriptHash, sent_at: now,
    body: { schema: "granola/atomic-swap-body/v1", code: "order_changed", at_phase: "negotiating",
      failed_message_id: request.message_id, retryable: availability === "preparing" || current.state.status === "open",
      availability, current_projection: projection as unknown as JsonValue }
  };
  await validateAtomicSwapMessage(message);
  const rumor = await createTradeRumor(message, key, proposal.rumor.id);
  const randomTime = () => now - crypto.getRandomValues(new Uint32Array(1))[0]! % 172_800;
  const { wrapper } = wrapTradeRumor(rumor, key, { sealCreatedAt: randomTime(),
    wrapperCreatedAt: randomTime(), outerExpiration: request.expires_at + 3_600 });
  return { proposalRumorId: proposal.rumor.id, recipient: request.author_pubkey,
    relays: (request.body.response_relays as string[] | undefined) ?? [],
    expiresAt: request.expires_at, wrapper, delivered: false };
}
