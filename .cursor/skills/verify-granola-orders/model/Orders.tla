---- MODULE Orders ----
EXTENDS Integers, Sequences
CONSTANT Broken
VARIABLE s

Terminal == {"filled", "canceled", "expired"}
Open == {"open", "partially_filled"}
LocalRev == Len(s.history)
Current == s.history[LocalRev]

Init ==
  s = [history |-> <<"open">>, pending |-> "staged", expired |-> FALSE,
       key |-> TRUE, relayed |-> {}, cached |-> 0, high |-> 0,
       inFlight |-> 0, reply |-> "none"]

StartPublish ==
  /\ s.pending = "staged" /\ s.inFlight = 0
  /\ s' = [s EXCEPT !.inFlight = LocalRev]

RelayAccepts ==
  /\ s.inFlight # 0 /\ s.inFlight \notin s.relayed
  /\ s' = [s EXCEPT !.relayed = @ \cup {s.inFlight}]

RecordAck ==
  /\ s.inFlight # 0 /\ s.inFlight \in s.relayed
  /\ s' = [s EXCEPT !.inFlight = 0,
           !.pending = IF s.inFlight = LocalRev THEN "acknowledged" ELSE @]

PublishFails ==
  /\ s.inFlight # 0
  /\ s' = [s EXCEPT !.inFlight = 0]

Commit ==
  /\ s.pending = "acknowledged"
  /\ s' = [s EXCEPT !.pending = "committed"]

DestroyOrderKey ==
  /\ s.pending \in {"acknowledged", "committed"} /\ Current \in Terminal /\ s.key
  /\ s' = [s EXCEPT !.key = FALSE]

Stage(next) ==
  /\ LocalRev < 5 /\ s.key
  /\ s' = [s EXCEPT !.history = Append(@, next), !.pending = "staged"]

Reserve ==
  /\ Current \in Open /\ ~s.expired /\ s.pending = "committed"
  /\ Stage("reserved")

Fill ==
  /\ Current = "reserved"
  /\ \E next \in {"filled", "partially_filled"} : Stage(next)

Release ==
  /\ Current = "reserved"
  /\ \E next \in Open : Stage(next)

Cancel ==
  /\ Current \in Open /\ s.pending = "committed"
  /\ Stage("canceled")

Expire ==
  /\ Current \in Open /\ s.expired /\ s.pending = "committed"
  /\ Stage("expired")

Clock ==
  /\ ~s.expired
  /\ s' = [s EXCEPT !.expired = TRUE]

ReadSnapshot ==
  \E rev \in s.relayed :
    s' = [s EXCEPT !.cached = IF Broken \/ rev > @ THEN rev ELSE @,
                   !.high = IF rev > @ THEN rev ELSE @]

StageRefusal ==
  /\ s.reply = "none" /\ (Current = "reserved" \/ LocalRev > 1)
  /\ s' = [s EXCEPT !.reply = "pending"]

AcknowledgeRefusal ==
  /\ s.reply = "pending"
  /\ s' = [s EXCEPT !.reply = "delivered"]

ExpireRefusal ==
  /\ s.reply \in {"pending", "delivered"}
  /\ s' = [s EXCEPT !.reply = "expired"]

Next == StartPublish \/ RelayAccepts \/ RecordAck \/ PublishFails \/ Commit
        \/ DestroyOrderKey \/ Reserve \/ Fill \/ Release \/ Cancel \/ Expire
        \/ Clock \/ ReadSnapshot \/ StageRefusal \/ AcknowledgeRefusal \/ ExpireRefusal

HeadNeverRegresses == s.cached = s.high
====
