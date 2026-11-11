---- MODULE PostOrder ----
VARIABLES phase, signed, acked
vars == <<phase, signed, acked>>
Init == phase = "editing" /\ signed = FALSE /\ acked = FALSE
Submit ==
  /\ phase = "editing"
  /\ phase' = "publishing" /\ signed' = TRUE /\ UNCHANGED acked
NoAck ==
  /\ phase = "publishing"
  /\ phase' = "pending" /\ UNCHANGED <<signed, acked>>
Retry ==
  /\ phase = "pending" /\ signed
  /\ phase' = "publishing" /\ UNCHANGED <<signed, acked>>
Publish ==
  /\ phase = "publishing" /\ signed
  /\ phase' = "posted" /\ acked' = TRUE /\ UNCHANGED signed
Cancel ==
  /\ phase = "posted"
  /\ phase' = "canceling" /\ acked' = FALSE /\ UNCHANGED signed
CancelFailed ==
  /\ phase = "canceling"
  /\ phase' = "pendingCancel" /\ UNCHANGED <<signed, acked>>
RetryCancel ==
  /\ phase = "pendingCancel"
  /\ phase' = "canceling" /\ UNCHANGED <<signed, acked>>
CancelAck ==
  /\ phase = "canceling"
  /\ phase' = "canceled" /\ acked' = TRUE /\ UNCHANGED signed
Expire ==
  /\ phase = "posted"
  /\ phase' = "expired" /\ UNCHANGED <<signed, acked>>
Done ==
  /\ phase \in {"canceled", "expired"}
  /\ UNCHANGED vars
Next == Submit \/ NoAck \/ Retry \/ Publish \/ Cancel \/ CancelFailed
        \/ RetryCancel \/ CancelAck \/ Expire \/ Done
ConfirmedOrderHasAck == phase \in {"posted", "canceled"} => signed /\ acked
====
