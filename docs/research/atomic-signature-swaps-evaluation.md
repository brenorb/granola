# Atomic Signature Swaps: keep the first experiment separate

- Status: proposal for maintainer review; not a protocol amendment
- Reviewed: 2026-11-05 UTC
- Scope: the design decision in [issue #33](https://github.com/brenorb/granola/issues/33)
- Granola baseline: [`8b127f7`](https://github.com/brenorb/granola/tree/8b127f74183bbd193ae3c9830a66a2d1f1a05721)

## Recommendation

Keep Atomic Signature Swaps in a separate experimental protocol/module for now.
Keep Granola's current NUT-14 Cashu-for-Cashu settlement as the default. Do not
add backend selection, new public events, or a generic settlement abstraction
as part of this proposal.

The smallest informative candidate is one Cashu payment in exchange for one
exact Nostr-event signature, using test keys and one test mint. Even that flow
needs an exact construction and recovery specification before it can be called
atomic. A separate module need not become a new repository: that packaging
choice can wait for a runnable, independently reviewed experiment.

This addresses the recommendation and dependency inventory in issue #33. It
does **not** complete that issue: no adaptor implementation, test-mint spend,
recovery prototype, or cryptographic security proof was produced here.

## Decision evidence

The following are source facts. The recommendation and experiment gates below
are engineering judgments based on them.

| Source | Relevant fact |
| --- | --- |
| [Granola specification](../protocol%20spec%20v0.1.md), sections 6–8, and [ADR 0004](../adr/0004-cashu-htlc-settlement.md) | The current testnet contract has receiver-bound HTLC legs, staggered deadlines, durable operations, and verified mint witnesses. Its atomicity already depends on honest, reachable mints and timing assumptions. |
| [Atomic Signature Swaps draft][draft] | The draft describes exchanging an adaptor for a useful signature; its Cashu-for-Cashu security note requires timelocked 2-of-2 payments. It does not supply the construction, verification algorithm, byte-level transcript, recovery state machine, or test vectors. |
| [BIP-340][bip340], signing, verification, and adaptor-signature sections | Adaptor completion/extraction depends on a matching message and nonce. BIP-340 fixes point parity, challenge hashing, and signature validation; its ordinary deterministic nonce procedure is not generally suitable for multiparty signing. |
| [NUT-10][nut10] and [NUT-11][nut11] | Mints enforce the spending condition. P2PK has specific signing messages, signature flags, multisignature thresholds, and refund conditions. NUT-11 threshold witnesses contain signatures by distinct keys; this is not automatically a MuSig aggregate-signing protocol. |
| [NUT-07][nut07] and [NUT-14][nut14] | Proof state and spend witnesses are observable through the mint. A state alone does not supply the extraction material. HTLC receiver spending remains possible after expiry while the refund path becomes available. |
| [NUT-17][nut17] | WebSocket notifications report proof-state changes; they do not replace validation of the exact mint evidence needed by the settlement protocol. |

The draft also leaves its listing undefined and uses inconsistent event-kind
references. These are symptoms of an incomplete wire contract, not the main
reason to reject integration. More materially, its execution example carries a
Cashu token while encryption is optional. That example cannot be copied into
Granola's public-event path under the current bearer-material policy.

## Comparison for maintainers

| Area | Current Granola NUT-14 backend | Separate signature-swap experiment |
| --- | --- | --- |
| Useful outcome | Exchange one Cashu leg for another. | Candidate first scope: Cashu for an exact Nostr-event signature. This does not establish Cashu-for-Cashu safety. |
| Link between legs | One reservation's hash/preimage, checked on every relevant proof. | An adaptor relation whose completion releases the desired signature. The reviewed draft has no complete algorithm or test vectors. |
| Mint requirements | Code preflights NUT-07/10/11/14, keysets and units; validates witnessed spends. | Ordinary completed P2PK signatures may fit existing NUT-11 machinery, but the exact mint transaction, signature flag, witness mapping, and refund path must be demonstrated. An advertised NUT number is insufficient. |
| Recovery | Persisted exact operations, observations, claim cutoffs, and refunds. | Must specify crashes before/after nonce publication, adaptor delivery, mint submission, acceptance, observation, and refund. No such prototype is established by this note. |
| Privacy | Per-order authority plus separate per-reservation transport, settlement and refund keys; private bearer messages. | Public nonces, event identities and witness observations introduce potential links. Signature appearance alone does not prove improved Cashu/Nostr privacy. Reusing social or order keys would violate current isolation. |
| Availability | Depends on each mint through the claim/refund windows; relays coordinate delivery. | Still depends on an accessible completed signature and accepted-spend evidence. Changing the revealed object does not remove mint outages or deadline races. |
| Implementation boundary | The existing effects, operation records and wire bodies explicitly describe HTLCs. | Requires new cryptographic state and a separately versioned contract; it is not a drop-in replacement for the `settlement_hash` field. |

The baseline implementation can be inspected in
[`client.ts`](../../src/cashu/client.ts),
[`htlc.ts`](../../src/cashu/htlc.ts),
[`trade-client.ts`](../../src/cashu/trade-client.ts),
[`atomic-messages.ts`](../../src/trade/atomic-messages.ts), and
[`effects.ts`](../../src/trade/effects.ts).
`PreparedTradeOperation` embeds `ExpectedHtlcLock`; accepted message bodies bind
hash locks and deadlines. Reusing those names for signature swaps would hide a
protocol and persistence migration.

## Topology and capability boundary

| Candidate | Minimum topology to investigate | What remains unproved |
| --- | --- | --- |
| Cashu ↔ Nostr signature | One Cashu leg at one test mint, plus one precisely fixed Nostr signing task. | Who controls every spend/refund key; how the adaptor is verified; when the desired signature becomes recoverable; and what happens if a completed payment signature is submitted but not accepted. |
| Cashu ↔ Cashu, same issuer | Both legs' units and active keysets supported by that issuer. | The complete 2-of-2, claim/refund and witness-extraction choreography in both maker directions. One issuer reduces availability domains, not the need for a proof. |
| Cashu ↔ Cashu, two issuers | Distinct mint URLs/keysets, with every required capability and recovery property verified independently for both legs. | All same-issuer obligations plus cross-mint timing, fee, witness-retention and outage behavior. Two wallets at one mint do not validate this case. |

For an experiment, first identify the exact NUT-10 condition and NUT-11 message
being signed. Under `SIG_INPUTS` this is per input; `SIG_ALL` has different
transaction-wide binding and witness placement. An array of adaptors without a
canonical proof/transaction mapping is not sufficient. Neither signature flags
nor the current HTLC refund rules should be carried over by analogy.

No configured mint's current experimental capability was measured for this
note. Existing HTLC demonstrations are not evidence of adaptor-swap support.

## Specification required before a funded prototype

These are missing design obligations, not new wire fields accepted by Granola.

| Obligation | Required decision and evidence |
| --- | --- |
| Intent and transcript | Fix protocol/scheme version, network, both participants and roles, order/reservation/session/attempt IDs, exact terms and fees, expiry, and predecessor/transcript hash. For a Nostr signature, fix the complete event bytes/ID and signing key, rather than an open-ended template. |
| Cashu transaction | Bind mint, unit, keyset, every input/proof identifier, canonical secret bytes, signature flag, threshold, ordered outputs and ownership, and refund keys/deadlines. Specify which signatures appear in which witnesses. |
| Nonce and adaptor exchange | Define point/scalar encodings, admissible points, commitments, verification equations and domain separation for every public nonce, adaptor point, adaptor signature and completion. Define exactly what each message author signs and verifies before releasing material. |
| Parity | Specify parity normalization for the desired signature and adapted signature, including any scalar sign changes; verify the reconstructed signature against its original key, message and nonce. Supply vectors covering both parity branches, malformed points and scalar bounds. |
| Durable signing state | Persist a unique attempt, nonce state and exact outbound artifact before publication. After uncertain delivery, resend only the same artifact. After abort or ambiguous signing progress, burn the nonce; do not reset it on reload, backup restore, duplicate reservation or a second tab. |
| Spend observation | Require an authenticated, correctly mapped accepted spend and the exact completed signature. Handle `UNSPENT`, `PENDING`, missing/malformed/mixed witnesses, and a competing spend without inferring success from a relay message or a notification alone. |
| Refund and fairness | Define which party can unilaterally spend at every stage; stagger deadlines, clock assumptions, claim cutoffs and post-expiry races. Analyze signature disclosure without successful payment, including rejected submissions and a mint that learns a submitted witness. |
| Privacy and storage | Use separate experiment keys and encrypted durable storage. Keep tokens, private scalars, preimages and witness bodies out of public events, fixtures, logs and screenshots. Record redacted outcomes and commitments, not bearer payloads. |

For BIP-340, a valid ordinary signature and a valid adaptor relation are
different checks. Subtracting unrelated signature scalars is not an extraction
algorithm. The protocol must prove and test the exact relation, including
message/nonce matching and parity, rather than relying on the mnemonic that
one signature reveals another.

The source draft's event-deletion suggestion is not a mint-enforced refund
mechanism. Once a payment condition or a signing artifact has been released,
recovery must follow its actual cryptographic and mint-state rules.

## Reconsideration gates

1. **Construction review:** choose a precise adaptor construction and pinned
   implementation; obtain independent cryptographic review and interoperable
   public verification vectors. No cryptographic library was selected here.
2. **Unfunded harness:** demonstrate completion/extraction, exact transcript
   verification and crash-safe nonce handling without a mint or public relay.
3. **One-mint test-key experiment:** execute the chosen Cashu ↔ Nostr-signature
   flow; retain redacted mint responses, witness-validation results, timings and
   recovery outcomes. Require the negative cases below. No spendable fixture or
   private signing material belongs in the report.
4. **Cashu-for-Cashu specification:** independently establish both maker
   directions, one-issuer and two-issuer cases, the exact 2-of-2/refund protocol,
   and all timing/availability assumptions. The smaller experiment does not
   satisfy this gate.
5. **Integration proposal:** only after the relevant gates, define a versioned
   backend interface covering prepare/validate/commit/observe/recover and durable
   state migration. Bind the backend and cryptographic suite into signed
   negotiation and the transcript. Both peers must explicitly opt in and
   validate each mint; absence, mismatch or unknown support must fail closed,
   never silently select the experiment or switch a funded session's backend.

NUT-14 remains the default throughout those gates. A future proposal must
separately justify any replacement, rather than treating an optional backend
as a migration decision already made.

### Required negative evidence

| Case | Required outcome to demonstrate |
| --- | --- |
| Replay or duplicate reservation | Idempotent exact retries; no second authorization or nonce reuse. |
| Expired offer or changed deadline | Reject before funding/signing; follow only the persisted refund plan afterward. |
| Wrong mint, unit or keyset | Reject the substituted leg and preserve local recoverable material. |
| Already-spent or `PENDING` proofs | Do not fund against them or report success; resolve from exact mint evidence. |
| Wrong session, event template, message or transcript | Reject before adaptor release, including a valid signature for a different message. |
| Invalid adaptor or completed signature | Reject with no secret release or monetary progression. |
| Odd/even nonce or key parity mismatch | Reject incorrect normalization; verify both intended parity branches. |
| Nonce reuse across attempts, reloads or restored storage | Refuse signing; preserve/burn the durable attempt instead of producing another challenge response. |
| Disconnect or lost acknowledgement | Reuse persisted artifacts; distinguish not-sent, submitted, accepted and observed states. |
| Mint outage before/after spend submission | Preserve recovery state and report uncertainty; demonstrate the availability assumptions rather than claiming a guaranteed refund. |
| Missing, reordered, mixed or wrong-proof witnesses | Do not extract from unrelated evidence or claim completion. |
| Mid-swap abort or expiry/refund race | Demonstrate who can claim/refund at each boundary without assuming event deletion revokes a payment. |
| Rejected spend after signature submission | Determine who learned usable signature material; do not equate submission with payment. |
| Diagnostics and public event inspection | No bearer material, raw witness, private scalar, or cross-reservation key reuse. |

## Coverage and confidence

This review read the current issue and all open Granola PRs at the snapshot
(only #36, CI enforcement; no overlapping design proposal), the normative
Granola contract and relevant implementation, and seven pinned external
specifications. The linked prior conversation supplies user context, not
cryptographic evidence. Research stayed within ten primary source groups and
the ninety-minute budget.

Confidence is high that the reviewed draft is insufficient for an integration
or replacement decision today. The proposed smaller experiment's feasibility,
fairness and mint behavior remain **unverified**. The next useful action is to
review the exact construction and ownership/refund model for that experiment,
not to modify the existing settlement engine.

[draft]: https://github.com/vstabile/nips/blob/559428b379eefaba837ebde2aeb897edc562836c/XX.md
[bip340]: https://github.com/bitcoin/bips/blob/a0c977f3755da6476b955677ca9318334a2432c4/bip-0340.mediawiki
[nut07]: https://github.com/cashubtc/nuts/blob/1363de413294e2ef3a57b16950f9506af38fffc2/07.md
[nut10]: https://github.com/cashubtc/nuts/blob/1363de413294e2ef3a57b16950f9506af38fffc2/10.md
[nut11]: https://github.com/cashubtc/nuts/blob/1363de413294e2ef3a57b16950f9506af38fffc2/11.md
[nut14]: https://github.com/cashubtc/nuts/blob/1363de413294e2ef3a57b16950f9506af38fffc2/14.md
[nut17]: https://github.com/cashubtc/nuts/blob/1363de413294e2ef3a57b16950f9506af38fffc2/17.md
