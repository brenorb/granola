import { describe, expect, it } from "vitest";
import { finalizeEvent, getPublicKey, nip44 } from "nostr-tools";

import {
  createTradeRumor,
  termsHash,
  unwrapTradeMessage,
  wrapTradeRumor,
  type GranolaTradeMessage,
  type GranolaTradeTerms
} from "./messages.js";

const key = (last: number): Uint8Array => {
  const bytes = new Uint8Array(32);
  bytes[31] = last;
  return bytes;
};

const makerKey = key(1);
const takerKey = key(2);
const wrapperKeyA = key(3);
const wrapperKeyB = key(4);
const maker = getPublicKey(makerKey);
const taker = getPublicKey(takerKey);
const now = 1_800_000_000;

const terms: GranolaTradeTerms = {
  base_unit: "sat",
  base_mint: "https://testnut.cashu.space",
  base_keyset: "0184237e63ce3423df7db2dcedc7329cff722a12b90206db53185fc31a4ca5ed96",
  quote_unit: "usd",
  quote_mint: "https://nofee.testnut.cashu.space",
  quote_keyset: "00ba2e3e5779e035",
  base_amount: "1000",
  quote_amount: "20",
  limit_price: { numerator: "1", denominator: "50" }
};

async function proposal(overrides: Partial<GranolaTradeMessage> = {}): Promise<GranolaTradeMessage> {
  return {
    schema: "granola/dm/v1",
    deployment: "cashu-testnet-v1",
    type: "reserve_propose",
    message_id: "11111111-1111-4111-8111-111111111111",
    session_id: "55".repeat(32),
    reservation_id: "22222222-2222-4222-8222-222222222222",
    order_address: `30078:${maker}:granola:order:v1:33333333-3333-4333-8333-333333333333`,
    order_head: "44".repeat(32),
    maker_order_pubkey: maker,
    author_pubkey: taker,
    recipient_pubkey: maker,
    sequence: "0",
    previous_message_id: null,
    previous_transcript_hash: null,
    sent_at: now - 10,
    expires_at: now + 120,
    terms_hash: await termsHash(terms),
    terms,
    body: { taker_cashu_pubkey: "02" + "66".repeat(32) },
    ...overrides
  };
}

const wrapOptions = (ephemeralSecretKey: Uint8Array, nonceByte: number) => ({
  ephemeralSecretKey,
  sealCreatedAt: now - 20,
  wrapperCreatedAt: now - 30,
  outerExpiration: now + 120 + 3600,
  sealNonce: new Uint8Array(32).fill(nonceByte),
  wrapperNonce: new Uint8Array(32).fill(nonceByte + 1)
});

function expected(message: GranolaTradeMessage, extra: Partial<Parameters<typeof unwrapTradeMessage>[2]> = {}) {
  return {
    now,
    expectedAuthorPubkey: taker,
    expectedOrderAddress: message.order_address,
    expectedOrderHead: message.order_head,
    expectedTermsHash: message.terms_hash,
    ...extra
  };
}

describe("strict Granola NIP-17 messages", () => {
  it("wraps one exact rumor into distinct authenticated delivery copies", async () => {
    const message = await proposal();
    const rumor = await createTradeRumor(message, takerKey);
    const first = wrapTradeRumor(rumor, takerKey, wrapOptions(wrapperKeyA, 10));
    const second = wrapTradeRumor(rumor, takerKey, wrapOptions(wrapperKeyB, 20));

    expect(first.rumor.id).toBe(second.rumor.id);
    expect(first.wrapper.id).not.toBe(second.wrapper.id);

    for (const wrapped of [first, second]) {
      const opened = await unwrapTradeMessage(wrapped.wrapper, makerKey, expected(message, {
        expectedType: "reserve_propose"
      }));
      expect(opened.rumor.id).toBe(rumor.id);
      expect(opened.seal.pubkey).toBe(taker);
      expect(opened.message).toEqual(message);
    }
  });

  it("rejects an invalid outer signature before trusting ciphertext", async () => {
    const rumor = await createTradeRumor(await proposal(), takerKey);
    const { wrapper } = wrapTradeRumor(rumor, takerKey, wrapOptions(wrapperKeyA, 30));
    const tampered = { ...wrapper, sig: "00".repeat(64) };
    await expect(unwrapTradeMessage(tampered, makerKey, expected(await proposal())))
      .rejects.toThrow(/outer event signature/i);
  });

  it("rejects a wrapper addressed to another recipient", async () => {
    const rumor = await createTradeRumor(await proposal(), takerKey);
    const wrapped = wrapTradeRumor(rumor, takerKey, wrapOptions(wrapperKeyA, 40));
    const wrong = finalizeEvent({
      kind: 1059,
      created_at: wrapped.wrapper.created_at,
      tags: [["p", taker], wrapped.wrapper.tags[1]!],
      content: wrapped.wrapper.content
    }, wrapperKeyA);
    await expect(unwrapTradeMessage(wrong, makerKey, expected(await proposal())))
      .rejects.toThrow(/recipient/i);
  });

  it("freshly verifies the encrypted seal signature", async () => {
    const message = await proposal();
    const rumor = await createTradeRumor(message, takerKey);
    const wrapped = wrapTradeRumor(rumor, takerKey, wrapOptions(wrapperKeyA, 42));
    const tamperedSeal = { ...wrapped.seal, sig: "00".repeat(64) };
    const wrapper = finalizeEvent({
      kind: 1059,
      created_at: wrapped.wrapper.created_at,
      tags: wrapped.wrapper.tags,
      content: nip44.v2.encrypt(
        JSON.stringify(tamperedSeal),
        nip44.v2.utils.getConversationKey(wrapperKeyA, maker),
        new Uint8Array(32).fill(44)
      )
    }, wrapperKeyA);

    await expect(unwrapTradeMessage(wrapper, makerKey, expected(message)))
      .rejects.toThrow(/seal signature/i);
  });

  it("rejects a valid seal whose signer differs from the rumor author", async () => {
    const message = await proposal();
    const rumor = await createTradeRumor(message, takerKey);
    const seal = finalizeEvent({
      kind: 13,
      created_at: now - 20,
      tags: [],
      content: nip44.v2.encrypt(
        JSON.stringify(rumor),
        nip44.v2.utils.getConversationKey(makerKey, maker),
        new Uint8Array(32).fill(45)
      )
    }, makerKey);
    const wrapper = finalizeEvent({
      kind: 1059,
      created_at: now - 30,
      tags: [["p", maker], ["expiration", String(message.expires_at + 3600)]],
      content: nip44.v2.encrypt(
        JSON.stringify(seal),
        nip44.v2.utils.getConversationKey(wrapperKeyA, maker),
        new Uint8Array(32).fill(46)
      )
    }, wrapperKeyA);

    await expect(unwrapTradeMessage(wrapper, makerKey, expected(message)))
      .rejects.toThrow(/seal and rumor authors/i);
  });

  it("rejects an oversized encoded outer payload before decryption", async () => {
    const wrapper = finalizeEvent({
      kind: 1059,
      created_at: now,
      tags: [["p", maker], ["expiration", String(now + 3600)]],
      content: "A".repeat(32 * 1024 + 1)
    }, wrapperKeyA);
    await expect(unwrapTradeMessage(wrapper, makerKey, expected(await proposal())))
      .rejects.toThrow(/32 KiB/i);
  });

  it("rejects clock and outer-expiration policy violations", async () => {
    const rumor = await createTradeRumor(await proposal(), takerKey);
    const expired = wrapTradeRumor(rumor, takerKey, {
      ...wrapOptions(wrapperKeyA, 50),
      outerExpiration: now
    }).wrapper;
    await expect(unwrapTradeMessage(expired, makerKey, expected(await proposal())))
      .rejects.toThrow(/outer expiration/i);
  });

  it("rejects future encrypted timestamps and non-hour expiration jitter", async () => {
    const future = await proposal({ sent_at: now + 301, expires_at: now + 600 });
    const futureRumor = await createTradeRumor(future, takerKey);
    const futureWrapper = wrapTradeRumor(futureRumor, takerKey, {
      ...wrapOptions(wrapperKeyA, 52),
      sealCreatedAt: future.sent_at,
      wrapperCreatedAt: future.sent_at,
      outerExpiration: future.expires_at + 3600
    }).wrapper;
    await expect(unwrapTradeMessage(futureWrapper, makerKey, expected(future)))
      .rejects.toThrow(/future/i);

    const message = await proposal();
    const rumor = await createTradeRumor(message, takerKey);
    const jittered = wrapTradeRumor(rumor, takerKey, {
      ...wrapOptions(wrapperKeyB, 54),
      outerExpiration: message.expires_at + 3601
    }).wrapper;
    await expect(unwrapTradeMessage(jittered, makerKey, expected(message)))
      .rejects.toThrow(/expiration jitter/i);
  });

  it("rejects non-canonical Granola plaintext", async () => {
    const message = await proposal();
    const rumor = await createTradeRumor(message, takerKey);
    const noncanonical = {
      ...rumor,
      content: JSON.stringify(message, null, 2)
    };
    noncanonical.id = (await import("nostr-tools")).getEventHash(noncanonical);

    const seal = finalizeEvent({
      kind: 13,
      created_at: now - 20,
      tags: [],
      content: nip44.v2.encrypt(
        JSON.stringify(noncanonical),
        nip44.v2.utils.getConversationKey(takerKey, maker),
        new Uint8Array(32).fill(60)
      )
    }, takerKey);
    const wrapper = finalizeEvent({
      kind: 1059,
      created_at: now - 30,
      tags: [["p", maker], ["expiration", String(message.expires_at + 3600)]],
      content: nip44.v2.encrypt(
        JSON.stringify(seal),
        nip44.v2.utils.getConversationKey(wrapperKeyA, maker),
        new Uint8Array(32).fill(61)
      )
    }, wrapperKeyA);

    await expect(unwrapTradeMessage(wrapper, makerKey, expected(message)))
      .rejects.toThrow(/canonical/i);
  });

  it("rejects a changed terms hash", async () => {
    const message = await proposal({ terms_hash: "99".repeat(32) });
    await expect(createTradeRumor(message, takerKey)).rejects.toThrow(/terms hash/i);
  });

  it("requires an exact predecessor for later transcript messages", async () => {
    const message = await proposal({
      type: "ack",
      message_id: "77777777-7777-4777-8777-777777777777",
      sequence: "1",
      previous_message_id: "11111111-1111-4111-8111-111111111111",
      previous_transcript_hash: "88".repeat(32)
    });
    delete message.terms;
    const rumor = await createTradeRumor(message, takerKey, "77".repeat(32));
    const { wrapper } = wrapTradeRumor(rumor, takerKey, wrapOptions(wrapperKeyA, 70));
    await expect(unwrapTradeMessage(wrapper, makerKey, expected(message, {
      expectedPreviousRumorId: "66".repeat(32),
      expectedPreviousMessageId: message.previous_message_id!,
      expectedPreviousTranscriptHash: message.previous_transcript_hash!,
      expectedSequence: "1"
    }))).rejects.toThrow(/predecessor rumor/i);
  });
});
