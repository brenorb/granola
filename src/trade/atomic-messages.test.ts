import { describe, expect, it } from "vitest";

import { termsHash, type GranolaTradeMessage, type GranolaTradeTerms } from "./messages.js";
import {
  advanceAtomicSwapChoreography,
  initialAtomicSwapChoreography,
  validateAtomicSwapMessage,
  type AtomicSwapBody,
  type AtomicSwapMessageType
} from "./atomic-messages.js";

const makerOrder = "11".repeat(32);
const makerSession = "22".repeat(32);
const takerSession = "33".repeat(32);
const makerCashu = `02${"44".repeat(32)}`;
const makerRefund = `03${"55".repeat(32)}`;
const takerCashu = `02${"66".repeat(32)}`;
const takerRefund = `03${"77".repeat(32)}`;
const reservationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId = "88".repeat(32);
const proposalHead = "99".repeat(32);
const reserveHead = "aa".repeat(32);
const settlementHash = "bb".repeat(32);
const baseValidationCommitment = "dd".repeat(32);
const quoteValidationCommitment = "ff".repeat(32);
const baseToken = `cashuB${"A".repeat(80)}`;
const quoteToken = `cashuB${"B".repeat(80)}`;

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const baseTokenCommitment = await digest(baseToken);
const quoteTokenCommitment = await digest(quoteToken);

const terms: GranolaTradeTerms = {
  base_unit: "sat",
  base_mint: "https://testnut.cashu.space",
  base_keyset: "0184237e63ce3423",
  quote_unit: "usd",
  quote_mint: "https://nofee.testnut.cashu.space",
  quote_keyset: "00ba2e3e5779e035",
  base_amount: "1000",
  quote_amount: "20",
  price_cents_per_btc: "2000000"
};

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
  "00000000-0000-4000-8000-000000000006",
  "00000000-0000-4000-8000-000000000007",
  "00000000-0000-4000-8000-000000000008",
  "00000000-0000-4000-8000-000000000009",
  "00000000-0000-4000-8000-00000000000a"
] as const;

function body<T extends AtomicSwapMessageType>(
  type: T,
  overrides: Record<string, unknown> = {}
): AtomicSwapBody<T> {
  const bodies: Record<AtomicSwapMessageType, Record<string, unknown>> = {
    reserve_propose: {
      schema: "granola/atomic-swap-body/v1",
      taker_session_pubkey: takerSession,
      taker_cashu_pubkey: takerCashu,
      taker_refund_pubkey: takerRefund,
      fill_amount: "1000"
    },
    reserve_accept: {
      schema: "granola/atomic-swap-body/v1",
      taker_session_pubkey: takerSession,
      maker_session_pubkey: makerSession,
      maker_cashu_pubkey: makerCashu,
      maker_refund_pubkey: makerRefund,
      reserve_projection_id: reserveHead,
      reserve_revision: "1",
      settlement_hash: settlementHash,
      short_locktime: 1_800_000_600,
      maker_claim_cutoff: 1_800_000_480,
      long_locktime: 1_800_001_200,
      taker_claim_cutoff: 1_800_001_080,
      reservation_expires_at: 1_800_001_800,
      base_lock: {
        schema: "granola/atomic-swap-body/v1",
        cashu_token: baseToken,
        token_commitment: baseTokenCommitment,
        validation_commitment: baseValidationCommitment,
        settlement_hash: settlementHash,
        mint: terms.base_mint,
        unit: terms.base_unit,
        keyset: terms.base_keyset,
        amount: terms.base_amount,
        receiver_cashu_pubkey: takerCashu,
        refund_cashu_pubkey: makerRefund,
        locktime: 1_800_001_200
      }
    },
    session_ack: {
      schema: "granola/atomic-swap-body/v1",
      reserve_accept_message_id: ids[1],
      reserve_accept_transcript_hash: "12".repeat(32),
      reserve_projection_id: reserveHead,
      reserve_revision: "1",
      settlement_hash: settlementHash
    },
    base_lock: {
      schema: "granola/atomic-swap-body/v1",
      cashu_token: baseToken,
      token_commitment: baseTokenCommitment,
      validation_commitment: baseValidationCommitment,
      settlement_hash: settlementHash,
      mint: terms.base_mint,
      unit: terms.base_unit,
      keyset: terms.base_keyset,
      amount: terms.base_amount,
      receiver_cashu_pubkey: takerCashu,
      refund_cashu_pubkey: makerRefund,
      locktime: 1_800_001_200
    },
    base_lock_ack: {
      schema: "granola/atomic-swap-body/v1",
      lock_message_id: ids[3],
      lock_transcript_hash: "14".repeat(32),
      token_commitment: baseTokenCommitment,
      validation_commitment: baseValidationCommitment,
      settlement_hash: settlementHash
    },
    quote_lock: {
      schema: "granola/atomic-swap-body/v1",
      cashu_token: quoteToken,
      token_commitment: quoteTokenCommitment,
      validation_commitment: quoteValidationCommitment,
      settlement_hash: settlementHash,
      mint: terms.quote_mint,
      unit: terms.quote_unit,
      keyset: terms.quote_keyset,
      amount: terms.quote_amount,
      receiver_cashu_pubkey: makerCashu,
      refund_cashu_pubkey: takerRefund,
      locktime: 1_800_000_600
    },
    quote_lock_ack: {
      schema: "granola/atomic-swap-body/v1",
      lock_message_id: ids[5],
      lock_transcript_hash: "16".repeat(32),
      token_commitment: quoteTokenCommitment,
      validation_commitment: quoteValidationCommitment,
      settlement_hash: settlementHash
    },
    claim_notice: {
      schema: "granola/atomic-swap-body/v1",
      quote_token_commitment: quoteTokenCommitment,
      claim_operation_commitment: "17".repeat(32),
      settlement_hash: settlementHash,
      claimed_at: 1_800_000_006
    },
    fill_request: {
      schema: "granola/atomic-swap-body/v1",
      base_token_commitment: baseTokenCommitment,
      quote_token_commitment: quoteTokenCommitment,
      base_spend_commitment: "18".repeat(32),
      quote_spend_commitment: "19".repeat(32),
      settlement_hash: settlementHash
    },
    settlement_ack: {
      schema: "granola/atomic-swap-body/v1",
      fill_projection_id: "20".repeat(32),
      fill_revision: "2",
      base_token_commitment: baseTokenCommitment,
      quote_token_commitment: quoteTokenCommitment,
      settlement_hash: settlementHash
    },
    refund: {
      schema: "granola/atomic-swap-body/v1",
      leg: "base",
      token_commitment: baseTokenCommitment,
      refund_operation_commitment: "21".repeat(32),
      settlement_hash: settlementHash,
      refunded_at: 1_800_001_261
    },
    error: {
      schema: "granola/atomic-swap-body/v1",
      code: "mint_unavailable",
      at_phase: "base_locked",
      failed_message_id: ids[3],
      retryable: true
    }
  };
  return { ...bodies[type], ...overrides } as unknown as AtomicSwapBody<T>;
}

async function message<T extends AtomicSwapMessageType>(
  type: T,
  index: number,
  overrides: Partial<GranolaTradeMessage> = {},
  bodyOverrides: Record<string, unknown> = {}
): Promise<GranolaTradeMessage> {
  const authors: Record<AtomicSwapMessageType, string> = {
    reserve_propose: takerSession,
    reserve_accept: makerOrder,
    session_ack: takerSession,
    base_lock: makerSession,
    base_lock_ack: takerSession,
    quote_lock: takerSession,
    quote_lock_ack: makerSession,
    claim_notice: makerSession,
    fill_request: takerSession,
    settlement_ack: makerSession,
    refund: makerSession,
    error: makerSession
  };
  const recipients: Record<AtomicSwapMessageType, string> = {
    reserve_propose: makerOrder,
    reserve_accept: takerSession,
    session_ack: makerSession,
    base_lock: takerSession,
    base_lock_ack: makerSession,
    quote_lock: makerSession,
    quote_lock_ack: takerSession,
    claim_notice: takerSession,
    fill_request: makerSession,
    settlement_ack: takerSession,
    refund: takerSession,
    error: takerSession
  };
  const includesTerms = type === "reserve_propose" || type === "reserve_accept";
  return {
    schema: "granola/dm/v1",
    deployment: "cashu-testnet-v1",
    type,
    message_id: ids[index] ?? "00000000-0000-4000-8000-00000000000b",
    session_id: sessionId,
    reservation_id: reservationId,
    order_address: `30078:${makerOrder}:granola:order:v1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
    order_projection_id:
      type === "reserve_propose" ? proposalHead :
      type === "settlement_ack" ? "20".repeat(32) :
      reserveHead,
    order_revision:
      type === "reserve_propose" ? "0" :
      type === "settlement_ack" ? "2" :
      "1",
    maker_order_pubkey: makerOrder,
    author_pubkey: authors[type],
    recipient_pubkey: recipients[type],
    sequence: String(index),
    previous_message_id: index === 0 ? null : ids[index - 1]!,
    previous_transcript_hash: index === 0 ? null : `${(16 + index).toString(16).padStart(2, "0")}`.repeat(32),
    sent_at: 1_800_000_000 + index,
    expires_at: 1_800_002_000,
    terms_hash: await termsHash(terms),
    ...(includesTerms ? { terms } : {}),
    body: body(type, bodyOverrides),
    ...overrides
  };
}

describe("atomic swap message bodies", () => {
  it("accepts the exact three-message happy-path choreography", async () => {
    let state = initialAtomicSwapChoreography(makerOrder);
    for (const [index, type] of [
      "reserve_propose",
      "reserve_accept",
      "quote_lock"
    ].entries()) {
      state = await advanceAtomicSwapChoreography(
        state,
        await message(type as AtomicSwapMessageType, index)
      );
    }
    expect(state.phase).toBe("settling");
    expect(state.participants).toEqual({
      makerOrderPubkey: makerOrder,
      makerSessionPubkey: makerSession,
      takerSessionPubkey: takerSession,
      makerCashuPubkey: makerCashu,
      makerRefundPubkey: makerRefund,
      takerCashuPubkey: takerCashu,
      takerRefundPubkey: takerRefund
    });
    expect(state.baseTokenCommitment).toBe(baseTokenCommitment);
    expect(state.quoteTokenCommitment).toBe(quoteTokenCommitment);
  });

  it.each([
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
  ] as const)("rejects unknown fields in %s", async (type) => {
    await expect(validateAtomicSwapMessage(
      await message(type, 0, {}, { unknown_field: "nope" })
    )).rejects.toThrow(/missing or unknown fields/i);
  });

  it("rejects non-canonical values and unbounded bearer material", async () => {
    await expect(validateAtomicSwapMessage(
      await message("reserve_propose", 0, {}, { fill_amount: "01000" })
    )).rejects.toThrow(/fill amount/i);
    await expect(validateAtomicSwapMessage(
      await message("reserve_propose", 0, {}, { taker_cashu_pubkey: "02aa" })
    )).rejects.toThrow(/Cashu public key/i);
    await expect(validateAtomicSwapMessage(
      await message("base_lock", 3, {}, { cashu_token: `cashuB${"A".repeat(24 * 1024)}` })
    )).rejects.toThrow(/token.*24 KiB/i);
    await expect(validateAtomicSwapMessage(
      await message("base_lock", 3, {}, { amount: "0" })
    )).rejects.toThrow(/amount/i);
    await expect(validateAtomicSwapMessage(
      await message("base_lock", 3, {}, { token_commitment: "cc".repeat(32) })
    )).rejects.toThrow(/token commitment/i);
  });

  it("requires exact testnet deadlines and canonical terms", async () => {
    await expect(validateAtomicSwapMessage(
      await message("reserve_accept", 1, {}, { long_locktime: 1_800_001_201 })
    )).rejects.toThrow(/deadline/i);
    await expect(validateAtomicSwapMessage(
      await message("reserve_accept", 1, {}, { reservation_expires_at: 1_800_001_799 })
    )).rejects.toThrow(/reservation expiry/i);
    await expect(validateAtomicSwapMessage(
      await message("reserve_propose", 0, {
        terms: { ...terms, base_amount: "999" }
      })
    )).rejects.toThrow(/terms|price/i);
  });

  it("binds lock data to the accepted participants, terms, and deadlines", async () => {
    let state = initialAtomicSwapChoreography(makerOrder);
    state = await advanceAtomicSwapChoreography(state, await message("reserve_propose", 0));

    await expect(advanceAtomicSwapChoreography(
      state,
      await message("reserve_accept", 1, {}, {
        base_lock: {
          ...body("base_lock"),
          receiver_cashu_pubkey: makerCashu
        }
      })
    )).rejects.toThrow(/receiver/i);
    await expect(advanceAtomicSwapChoreography(
      state,
      await message("reserve_accept", 1, {}, {
        base_lock: {
          ...body("base_lock"),
          mint: terms.quote_mint
        }
      })
    )).rejects.toThrow(/base mint/i);
    await expect(advanceAtomicSwapChoreography(
      state,
      await message("reserve_accept", 1, {}, {
        base_lock: {
          ...body("base_lock"),
          locktime: 1_800_000_600
        }
      })
    )).rejects.toThrow(/base locktime/i);
  });

  it("rejects role confusion, reordered phases, and changed payment commitments", async () => {
    let state = initialAtomicSwapChoreography(makerOrder);
    await expect(advanceAtomicSwapChoreography(
      state,
      await message("reserve_propose", 0, { author_pubkey: makerOrder })
    )).rejects.toThrow(/taker session author/i);

    state = await advanceAtomicSwapChoreography(state, await message("reserve_propose", 0));
    await expect(advanceAtomicSwapChoreography(
      state,
      await message("session_ack", 2)
    )).rejects.toThrow(/expected reserve_accept/i);

    state = await advanceAtomicSwapChoreography(state, await message("reserve_accept", 1));
    await expect(advanceAtomicSwapChoreography(
      state,
      await message("quote_lock", 2, {}, {
        receiver_cashu_pubkey: takerCashu
      })
    )).rejects.toThrow(/receiver/i);
  });

  it("permits a bound refund only after a leg is locked and makes error terminal", async () => {
    const start = initialAtomicSwapChoreography(makerOrder);
    await expect(advanceAtomicSwapChoreography(
      start,
      await message("refund", 3, { sent_at: 1_800_001_262 })
    )).rejects.toThrow(/refund.*locked/i);

    let state = await advanceAtomicSwapChoreography(start, await message("reserve_propose", 0));
    state = await advanceAtomicSwapChoreography(state, await message("reserve_accept", 1));
    const refund = await message("refund", 2, {
      author_pubkey: makerSession,
      recipient_pubkey: takerSession,
      sent_at: 1_800_001_262
    }, { leg: "base" });
    expect((await advanceAtomicSwapChoreography(state, refund)).phase).toBe("refunding");

    const failed = await advanceAtomicSwapChoreography(
      state,
      await message("error", 2, {
        author_pubkey: takerSession,
        recipient_pubkey: makerSession
      }, { at_phase: "base_locked", failed_message_id: ids[1] })
    );
    expect(failed.phase).toBe("failed");
    await expect(advanceAtomicSwapChoreography(
      failed,
      await message("quote_lock", 3)
    )).rejects.toThrow(/terminal/i);
  });

  it("rejects self-addressed errors and future-dated claims or refunds", async () => {
    let state = initialAtomicSwapChoreography(makerOrder);
    state = await advanceAtomicSwapChoreography(state, await message("reserve_propose", 0));
    state = await advanceAtomicSwapChoreography(state, await message("reserve_accept", 1));

    await expect(advanceAtomicSwapChoreography(
      state,
      await message("error", 2, {
        author_pubkey: makerSession,
        recipient_pubkey: makerSession
      }, { at_phase: "base_locked", failed_message_id: ids[1] })
    )).rejects.toThrow(/counterparties/i);
    await expect(validateAtomicSwapMessage(
      await message("claim_notice", 7, {}, { claimed_at: 1_800_000_008 })
    )).rejects.toThrow(/claim timestamp/i);
    await expect(validateAtomicSwapMessage(
      await message("refund", 4, {}, { refunded_at: 1_800_000_005 })
    )).rejects.toThrow(/refund timestamp/i);
    });
  });

  it("flips lock assets and actors for a buy-side maker", async () => {
    const buyTerms: GranolaTradeTerms = { ...terms, maker_side: "buy" };
    const buyHash = await termsHash(buyTerms);
    const buyBody: Partial<Record<AtomicSwapMessageType, Record<string, unknown>>> = {
      reserve_accept: {
        base_lock: {
          ...body("base_lock"),
          cashu_token: quoteToken,
          token_commitment: quoteTokenCommitment,
          mint: terms.quote_mint,
          unit: terms.quote_unit,
          keyset: terms.quote_keyset,
          amount: terms.quote_amount
        }
      },
      quote_lock: {
        cashu_token: baseToken,
        token_commitment: baseTokenCommitment,
        mint: terms.base_mint,
        unit: terms.base_unit,
        keyset: terms.base_keyset,
        amount: terms.base_amount,
        receiver_cashu_pubkey: makerCashu,
        refund_cashu_pubkey: takerRefund,
        locktime: 1_800_000_600
      }
    };
    let state = initialAtomicSwapChoreography(makerOrder);
    for (const [index, type] of [
      "reserve_propose", "reserve_accept", "quote_lock"
    ].entries()) {
      const messageOverrides: Partial<GranolaTradeMessage> = {
        terms_hash: buyHash,
        ...(type === "reserve_propose" || type === "reserve_accept"
          ? { terms: buyTerms }
          : {})
      };
      state = await advanceAtomicSwapChoreography(
        state,
        await message(
          type as AtomicSwapMessageType,
          index,
          messageOverrides,
          buyBody[type as AtomicSwapMessageType] ?? {}
        )
      );
    }
    expect(state.phase).toBe("settling");
  });
