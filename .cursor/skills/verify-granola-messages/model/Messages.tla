---- MODULE Messages ----
EXTENDS Integers
CONSTANT Broken
VARIABLE s

Init ==
  \E role \in {"maker", "taker"}, direct \in BOOLEAN :
    s = [role |-> role, direct |-> direct, seq |-> IF role = "maker" THEN 1 ELSE 0,
         inbox |-> "unregistered", outbox |-> "empty", incoming |-> "empty",
         route |-> "unset", inFlight |-> FALSE, lastAcked |-> -1,
         lastOutgoing |-> -1, recovering |-> FALSE, fallback |-> FALSE]

SendTurn == IF s.role = "maker" THEN s.seq = 1 ELSE s.seq \in {0, 2}
Ready == s.inbox = "registered" \/ (s.direct /\ s.inbox = "staged")
Open == s.seq < 3 /\ ~s.recovering

StageRegistration ==
  /\ s.inbox = "unregistered"
  /\ s' = [s EXCEPT !.inbox = "staged"]

RegisterInbox ==
  /\ s.inbox \in {"staged", "acknowledged"}
  /\ s' = [s EXCEPT !.inbox = "registered"]

StageOutgoing ==
  /\ Open /\ Ready /\ SendTurn /\ s.outbox = "empty"
  /\ \E route \in IF s.direct THEN {"direct", "discovered"} ELSE {"discovered"} :
       s' = [s EXCEPT !.outbox = "staged", !.route = route, !.fallback = FALSE]

StartDelivery ==
  /\ s.outbox = "staged" /\ ~s.inFlight /\ ~s.recovering
  /\ s' = [s EXCEPT !.inFlight = TRUE]

DeliveryFailed ==
  /\ s.inFlight
  /\ s' = [s EXCEPT !.inFlight = FALSE]

DiscoverFallback ==
  /\ s.inFlight /\ s.route = "direct"
  /\ s' = [s EXCEPT !.inFlight = FALSE, !.route = IF Broken THEN @ ELSE "discovered",
           !.fallback = TRUE]

\* ACK and transcript commit are one session save in the current executor.
DeliverAndCommit ==
  /\ s.inFlight
  /\ \E ack \in {TRUE} :
       s' = [s EXCEPT !.inFlight = FALSE, !.outbox = "empty", !.route = "unset",
             !.lastAcked = IF ack THEN s.seq ELSE @,
             !.lastOutgoing = s.seq, !.seq = @ + 1]

StageIncoming ==
  /\ Open /\ Ready /\ ~SendTurn /\ s.incoming = "empty"
  /\ s' = [s EXCEPT !.incoming = "unvalidated"]

ValidateAndCommit ==
  /\ s.incoming = "unvalidated" /\ ~s.recovering
  /\ s' = [s EXCEPT !.incoming = "empty", !.seq = @ + 1]

\* Validation throws with the staged incoming record intact.
ValidationFails ==
  /\ s.incoming = "unvalidated"
  /\ UNCHANGED s

DeadlinePasses ==
  /\ s.outbox = "staged" /\ ~s.inFlight /\ ~s.recovering
  /\ s' = [s EXCEPT !.recovering = TRUE]

Restart ==
  /\ s.inFlight
  /\ s' = [s EXCEPT !.inFlight = FALSE]

Next == StageRegistration \/ RegisterInbox \/ StageOutgoing \/ StartDelivery
        \/ DeliveryFailed \/ DiscoverFallback \/ DeliverAndCommit \/ StageIncoming
        \/ ValidateAndCommit \/ ValidationFails \/ DeadlinePasses \/ Restart

OutgoingCommitNeedsAck == s.lastOutgoing <= s.lastAcked
DiscoveredRouteIsSaved == (s.fallback /\ s.outbox = "staged") => s.route = "discovered"
====
