// Test-only capability validation. Never print invoices, keys, proofs or witnesses.
import process from "node:process";
import { Buffer } from "node:buffer";
import { getPubKeyFromPrivKey } from "@cashu/cashu-ts";
import { generateSecretKey } from "nostr-tools/pure";
import { CashuClient } from "../src/cashu/client.js";
import { CashuTradeClient } from "../src/cashu/trade-client.js";
import { createHtlcMaterial } from "../src/cashu/htlc.js";

const mintUrl = process.env.GRANOLA_PROBE_MINT ?? "https://testnut.cashudevkit.org";
if (!["https://testnut.cashu.space", "https://testnut.cashu.exchange", "https://testnut.cashudevkit.org"].includes(mintUrl)) {
  throw new Error("Only known FakeWallet test mints are permitted");
}
let stage = "preflight";
try {
  const funding = new CashuClient(), trade = new CashuTradeClient();
  const preflight = await funding.inspectTradeMint(mintUrl, "usd");
  stage = "funding";
  const quote = await funding.createMintQuote({ mintUrl, unit: "usd", amount: "100" });
  let pocket;
  for (let attempt = 0; attempt < 30 && !pocket; attempt++) {
    pocket = (await funding.checkAndMint(quote)).batch;
    if (!pocket) await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!pocket) throw new Error("Test funding unavailable");
  const receiver = generateSecretKey(), refund = generateSecretKey();
  const material = createHtlcMaterial(), now = Math.floor(Date.now() / 1000);
  const expected = {
    mintUrl, unit: "usd", amount: "1", hash: material.hash,
    receiverPubkey: Buffer.from(getPubKeyFromPrivKey(receiver)).toString("hex"),
    refundPubkey: Buffer.from(getPubKeyFromPrivKey(refund)).toString("hex"),
    locktime: now + 3600, leg: "base", refundHorizon: now + 4200,
    deadlines: { short: now + 1800, long: now + 3600, minimumGap: 600 },
    binding: { protocolVersion: "granola/1", network: "cashu-testnet", orderId: "test-probe",
      reservationId: "test-probe", sessionId: "test-probe", direction: "base", transcriptHash: "ab".repeat(32) }
  };
  stage = "lock";
  const prepared = await trade.prepareOutgoingLock({ pocket, expected, now });
  const locked = await trade.completeOutgoingLock(prepared, expected);
  stage = "claim";
  const privateKey = Buffer.from(receiver).toString("hex");
  const claim = await trade.prepareClaim({ token: locked.lockedToken, expected,
    preimage: material.preimage, settlementPrivateKey: privateKey, now, claimCutoff: now + 1800 });
  await trade.completeClaim(claim, privateKey, expected);
  stage = "spent-witness";
  const observed = await trade.observeSpentInternal(locked.lockedToken, expected, locked.summary.commitment);
  if (observed.status !== "SPENT" || observed.preimage !== material.preimage) throw new Error("Witness not validated");
  console.log(JSON.stringify({ mintUrl, keysetId: preflight.keysetId, status: "SPENT", witnessValidated: true }));
} catch (error) {
  const failure = error;
  console.log(JSON.stringify({ mintUrl, stage, errorClass: failure.name,
    ...(failure.name === "HtlcInvariantError" || failure.name === "CashuTradeError" ? { code: failure.code } : {}) }));
  process.exitCode = 1;
}
