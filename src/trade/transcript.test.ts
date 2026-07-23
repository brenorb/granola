import { describe, expect, it } from "vitest";

import type { AtomicSwapChoreography } from "./atomic-messages.js";
import type { GranolaTradeMessage } from "./messages.js";
import {
  acceptIncomingCheckpoint,
  confirmOutgoingCheckpoint,
  stageOutgoingCheckpoint,
  type TradeTranscriptCheckpoint
} from "./transcript.js";

const maker = "11".repeat(32);
const taker = "22".repeat(32);
const initial: TradeTranscriptCheckpoint = {
  choreography: {
    phase: "awaiting_reserve_propose",
    participants: { makerOrderPubkey: maker },
    refundedLegs: []
  },
  nextSequence: "0",
  lastRumorId: null,
  lastMessageId: null,
  lastTranscriptHash: null,
  pendingOutgoing: null
};

const postProposal: AtomicSwapChoreography = {
  phase: "awaiting_reserve_accept",
  participants: { makerOrderPubkey: maker, takerSessionPubkey: taker },
  sessionId: "33".repeat(32),
  reservationId: "11111111-1111-4111-8111-111111111111",
  orderAddress: `30078:${maker}:granola:order:v2:22222222-2222-4222-8222-222222222222`,
  orderHead: "44".repeat(32),
  termsHash: "55".repeat(32),
  lastMessageId: "33333333-3333-4333-8333-333333333333",
  refundedLegs: []
};

const proposal = {
  sequence: "0",
  message_id: "33333333-3333-4333-8333-333333333333",
  previous_message_id: null,
  previous_transcript_hash: null
} as GranolaTradeMessage;

describe("durable trade transcript checkpoints", () => {
  it("stages an exact outgoing envelope before committing its transcript state", () => {
    const staged = stageOutgoingCheckpoint(initial, {
      message: proposal,
      rumorId: "66".repeat(32),
      transcriptHash: "77".repeat(32),
      wrapper: "secret-wrapper-json",
      recipientRelays: ["wss://inbox.example"],
      nextChoreography: postProposal
    });

    expect(staged.choreography).toEqual(initial.choreography);
    expect(staged.pendingOutgoing?.wrapper).toBe("secret-wrapper-json");

    const confirmed = confirmOutgoingCheckpoint(staged);
    expect(confirmed.choreography).toEqual(postProposal);
    expect(confirmed.nextSequence).toBe("1");
    expect(confirmed.lastRumorId).toBe("66".repeat(32));
    expect(confirmed.pendingOutgoing).toBeNull();
  });

  it("accepts an exact incoming successor and rejects replay or transcript substitution", () => {
    const accepted = acceptIncomingCheckpoint(initial, {
      message: proposal,
      rumorId: "66".repeat(32),
      transcriptHash: "77".repeat(32),
      nextChoreography: postProposal
    });

    expect(accepted.nextSequence).toBe("1");
    expect(() => acceptIncomingCheckpoint(accepted, {
      message: proposal,
      rumorId: "66".repeat(32),
      transcriptHash: "77".repeat(32),
      nextChoreography: postProposal
    })).toThrow(/sequence/i);

    expect(() => stageOutgoingCheckpoint(accepted, {
      message: {
        ...proposal,
        sequence: "1",
        previous_message_id: "88".repeat(16),
        previous_transcript_hash: "77".repeat(32)
      },
      rumorId: "99".repeat(32),
      transcriptHash: "aa".repeat(32),
      wrapper: "other",
      recipientRelays: ["wss://inbox.example"],
      nextChoreography: postProposal
    })).toThrow(/previous message/i);
  });

  it("forces an exact pending envelope retry before another message can be staged", () => {
    const staged = stageOutgoingCheckpoint(initial, {
      message: proposal,
      rumorId: "66".repeat(32),
      transcriptHash: "77".repeat(32),
      wrapper: "secret-wrapper-json",
      recipientRelays: ["wss://inbox.example"],
      nextChoreography: postProposal
    });

    expect(() => stageOutgoingCheckpoint(staged, {
      message: proposal,
      rumorId: "88".repeat(32),
      transcriptHash: "99".repeat(32),
      wrapper: "replacement-wrapper",
      recipientRelays: ["wss://inbox.example"],
      nextChoreography: postProposal
    })).toThrow(/pending envelope/i);
  });
});
