---- MODULE RecoverSwap ----
VARIABLES role, phase, guardPassed, unspentObserved, walletApplied, bothSpends
vars == <<role, phase, guardPassed, unspentObserved, walletApplied, bothSpends>>
Init ==
  /\ role \in {"maker", "taker"}
  /\ phase = "interrupted" /\ guardPassed = FALSE /\ unspentObserved = FALSE /\ walletApplied = FALSE /\ bothSpends = FALSE
Resume ==
  /\ phase = "interrupted"
  /\ phase' = "settling" /\ UNCHANGED <<role, guardPassed, unspentObserved, walletApplied, bothSpends>>
VerifySpends ==
  /\ phase = "settling" /\ ~bothSpends
  /\ bothSpends' = TRUE /\ UNCHANGED <<role, phase, guardPassed, unspentObserved, walletApplied>>
Finish ==
  /\ phase = "settling" /\ bothSpends
  /\ phase' = "filled" /\ UNCHANGED <<role, guardPassed, unspentObserved, walletApplied, bothSpends>>
Freeze ==
  /\ phase = "settling"
  /\ phase' = "frozen" /\ UNCHANGED <<role, guardPassed, unspentObserved, walletApplied, bothSpends>>
WaitRefund ==
  /\ phase = "settling"
  /\ phase' = "waitingRefund" /\ UNCHANGED <<role, guardPassed, unspentObserved, walletApplied, bothSpends>>
PassGuard ==
  /\ phase = "waitingRefund" /\ ~guardPassed
  /\ guardPassed' = TRUE /\ UNCHANGED <<role, phase, unspentObserved, walletApplied, bothSpends>>
ObserveUnspent ==
  /\ phase = "waitingRefund" /\ guardPassed
  /\ phase' = "refunding" /\ unspentObserved' = TRUE
  /\ UNCHANGED <<role, guardPassed, walletApplied, bothSpends>>
ApplyRefund ==
  /\ phase = "refunding"
  /\ phase' = IF role = "maker" THEN "waitingRelease" ELSE "paymentReturned"
  /\ walletApplied' = TRUE /\ UNCHANGED <<role, guardPassed, unspentObserved, bothSpends>>
ReleaseOrder ==
  /\ phase = "waitingRelease" /\ role = "maker"
  /\ phase' = "released" /\ UNCHANGED <<role, guardPassed, unspentObserved, walletApplied, bothSpends>>
Done ==
  /\ phase \in {"filled", "frozen", "released", "paymentReturned"}
  /\ UNCHANGED vars
Next == Resume \/ VerifySpends \/ Finish \/ Freeze \/ WaitRefund \/ PassGuard
        \/ ObserveUnspent \/ ApplyRefund \/ ReleaseOrder \/ Done
RefundNeedsFreshUnspent == walletApplied => guardPassed /\ unspentObserved
ReleaseNeedsAppliedRefund == phase = "released" => role = "maker" /\ walletApplied
====
