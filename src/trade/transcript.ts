import type { AtomicSwapChoreography } from "./atomic-messages.js";
import type { GranolaTradeMessage } from "./messages.js";

const HEX_32 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/;

export interface PendingOutgoingCheckpoint {
  messageId: string;
  rumorId: string;
  transcriptHash: string;
  wrapper: string;
  recipientRelays: string[];
  nextChoreography: AtomicSwapChoreography;
}

export interface TradeTranscriptCheckpoint {
  choreography: AtomicSwapChoreography;
  nextSequence: string;
  lastRumorId: string | null;
  lastMessageId: string | null;
  lastTranscriptHash: string | null;
  pendingOutgoing: PendingOutgoingCheckpoint | null;
}

interface CheckpointAdvance {
  message: GranolaTradeMessage;
  rumorId: string;
  transcriptHash: string;
  nextChoreography: AtomicSwapChoreography;
}

interface OutgoingCheckpointAdvance extends CheckpointAdvance {
  wrapper: string;
  recipientRelays: string[];
}

function assertAdvance(state: TradeTranscriptCheckpoint, input: CheckpointAdvance): void {
  if (!CANONICAL_INTEGER.test(state.nextSequence) || input.message.sequence !== state.nextSequence) {
    throw new Error("Trade message sequence does not match the durable checkpoint");
  }
  if (!UUID_V4.test(input.message.message_id)) throw new Error("Trade message ID is invalid");
  if (!HEX_32.test(input.rumorId) || !HEX_32.test(input.transcriptHash)) {
    throw new Error("Trade transcript identifiers are invalid");
  }
  if (input.message.previous_message_id !== state.lastMessageId) {
    throw new Error("Trade previous message does not match the durable checkpoint");
  }
  if (input.message.previous_transcript_hash !== state.lastTranscriptHash) {
    throw new Error("Trade previous transcript hash does not match the durable checkpoint");
  }
}

function confirmed(
  state: TradeTranscriptCheckpoint,
  advance: {
    messageId: string;
    rumorId: string;
    transcriptHash: string;
    nextChoreography: AtomicSwapChoreography;
  }
): TradeTranscriptCheckpoint {
  return {
    choreography: structuredClone(advance.nextChoreography),
    nextSequence: (BigInt(state.nextSequence) + 1n).toString(),
    lastRumorId: advance.rumorId,
    lastMessageId: advance.messageId,
    lastTranscriptHash: advance.transcriptHash,
    pendingOutgoing: null
  };
}

export function stageOutgoingCheckpoint(
  state: TradeTranscriptCheckpoint,
  input: OutgoingCheckpointAdvance
): TradeTranscriptCheckpoint {
  if (state.pendingOutgoing) {
    throw new Error("An exact pending envelope must be retried before staging another message");
  }
  assertAdvance(state, input);
  if (!input.wrapper || input.recipientRelays.length < 1 || input.recipientRelays.length > 3) {
    throw new Error("Pending private delivery is invalid");
  }
  return {
    ...structuredClone(state),
    pendingOutgoing: {
      messageId: input.message.message_id,
      rumorId: input.rumorId,
      transcriptHash: input.transcriptHash,
      wrapper: input.wrapper,
      recipientRelays: [...input.recipientRelays],
      nextChoreography: structuredClone(input.nextChoreography)
    }
  };
}

export function confirmOutgoingCheckpoint(
  state: TradeTranscriptCheckpoint
): TradeTranscriptCheckpoint {
  const pending = state.pendingOutgoing;
  if (!pending) throw new Error("There is no pending private envelope to confirm");
  return confirmed(state, pending);
}

export function acceptIncomingCheckpoint(
  state: TradeTranscriptCheckpoint,
  input: CheckpointAdvance
): TradeTranscriptCheckpoint {
  if (state.pendingOutgoing) {
    throw new Error("A pending envelope must be resolved before accepting another message");
  }
  assertAdvance(state, input);
  return confirmed(state, {
    messageId: input.message.message_id,
    rumorId: input.rumorId,
    transcriptHash: input.transcriptHash,
    nextChoreography: input.nextChoreography
  });
}
