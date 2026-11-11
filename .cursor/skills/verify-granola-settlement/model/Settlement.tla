---- MODULE Settlement ----
EXTENDS Integers
CONSTANT Broken
VARIABLE s

\* Protocol slots are offer/payment on both buy and sell orders.
\* Claim cutoffs, refund guards and reservation expiry are ordered buckets.
Init ==
  \E role \in {"maker", "taker"}, direct \in BOOLEAN :
    s = [role |-> role, direct |-> direct, wire |-> 0, phase |-> "negotiating",
         time |-> 0, reserve |-> FALSE, offer |-> FALSE, payment |-> FALSE,
         spentOffer |-> FALSE, spentPayment |-> FALSE, witness |-> role = "maker",
         payClaim |-> FALSE, offerClaim |-> FALSE,
         fill |-> "none", refund |-> "none"]

Clock ==
  /\ s.time < 5
  /\ s.phase \notin {"filled", "frozen", "released"}
  /\ s' = [s EXCEPT !.time = @ + 1]

Propose ==
  /\ s.wire = 0 /\ s.time = 0 /\ s.phase = "negotiating"
  /\ s' = [s EXCEPT !.wire = 1]

StageReserve ==
  /\ s.wire = 1 /\ ~s.reserve /\ s.time = 0 /\ s.phase = "negotiating"
  /\ s' = [s EXCEPT !.reserve = TRUE]

OfferLockReady ==
  /\ s.reserve /\ ~s.offer /\ s.wire = 1 /\ s.time = 0
  /\ s.phase = "negotiating"
  /\ s' = [s EXCEPT !.offer = TRUE]

Accept ==
  /\ s.wire = 1 /\ s.offer /\ s.time = 0 /\ s.phase = "negotiating"
  /\ s' = [s EXCEPT !.wire = 2, !.phase = "base_locked"]

PaymentLockReady ==
  /\ s.wire = 2 /\ ~s.payment /\ s.time = 0 /\ s.phase = "base_locked"
  /\ s' = [s EXCEPT !.payment = TRUE]

SendPayment ==
  /\ s.wire = 2 /\ s.payment /\ s.time = 0 /\ s.phase = "base_locked"
  /\ s' = [s EXCEPT !.wire = 3, !.phase = "quote_locked"]

StartPaymentClaim ==
  /\ s.wire = 3 /\ s.phase = "quote_locked" /\ s.time = 0 /\ ~s.payClaim
  /\ s' = [s EXCEPT !.payClaim = TRUE]

ObservePaymentSpent ==
  /\ s.payClaim /\ ~s.spentPayment
  /\ s.phase \in {"quote_locked", "waiting_refund"}
  /\ s.refund = "none"
  /\ s' = [s EXCEPT !.spentPayment = TRUE, !.witness = TRUE]

StartOfferClaim ==
  /\ s.phase = "quote_locked" /\ s.time < 3 /\ s.spentPayment /\ s.witness
  /\ ~s.offerClaim
  /\ s' = [s EXCEPT !.offerClaim = TRUE]

ObserveOfferSpent ==
  /\ s.offerClaim /\ ~s.spentOffer
  /\ s.phase \in {"quote_locked", "waiting_refund"}
  /\ s.refund = "none"
  /\ s' = [s EXCEPT !.spentOffer = TRUE]

StageFill ==
  /\ s.role = "maker" /\ s.phase = "quote_locked" /\ s.fill = "none"
  /\ s.spentOffer /\ s.spentPayment
  /\ s' = [s EXCEPT !.fill = "staged"]

ConfirmPublicFill ==
  /\ ~s.direct /\ s.phase = "quote_locked" /\ s.spentOffer /\ s.spentPayment
  /\ IF s.role = "maker" THEN s.fill = "staged" ELSE s.fill = "none"
  /\ s' = [s EXCEPT !.fill = "confirmed", !.phase = "filled"]

CompleteDirect ==
  /\ s.direct /\ s.phase = "quote_locked"
  /\ s.spentPayment /\ (s.spentOffer \/ Broken)
  /\ (s.role = "taker" \/ s.fill = "staged")
  /\ s' = [s EXCEPT !.phase = "filled"]

EnterRecovery ==
  /\ s.phase \in {"negotiating", "base_locked", "quote_locked"}
  /\ s.time >= IF s.role = "taker" /\ s.wire = 3 THEN 3 ELSE 1
  /\ s' = [s EXCEPT !.phase =
       IF (s.role = "maker" /\ s.offer) \/ (s.role = "taker" /\ s.payment)
       THEN "waiting_refund" ELSE "frozen"]

ObserveRefundable ==
  /\ s.phase = "waiting_refund" /\ s.refund = "none"
  /\ IF s.role = "maker" THEN s.time >= 4 /\ ~s.spentOffer
                          ELSE s.time >= 2 /\ ~s.spentPayment
  /\ s' = [s EXCEPT !.refund = "unspent_after_guard"]

ApplyRefund ==
  /\ s.refund = "unspent_after_guard"
  /\ s' = [s EXCEPT !.refund = "wallet_applied"]

CommitRelease ==
  /\ s.role = "maker" /\ s.reserve /\ s.time = 5 /\ s.refund = "wallet_applied"
  /\ s.phase = "waiting_refund"
  /\ s' = [s EXCEPT !.phase = "released"]

Next == Propose \/ StageReserve \/ OfferLockReady \/ Accept \/ PaymentLockReady
        \/ SendPayment \/ StartPaymentClaim \/ ObservePaymentSpent
        \/ StartOfferClaim \/ ObserveOfferSpent \/ StageFill
        \/ ConfirmPublicFill \/ CompleteDirect \/ Clock \/ EnterRecovery
        \/ ObserveRefundable \/ ApplyRefund \/ CommitRelease

FilledNeedsEvidence ==
  s.phase = "filled" => s.spentOffer /\ s.spentPayment
====
