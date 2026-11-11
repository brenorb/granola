---- MODULE Transport ----
EXTENDS Integers, Sequences
CONSTANT Broken
VARIABLE s

Init ==
  s = [generation |-> 0, captured |-> -1, active |-> FALSE, installed |-> -1,
       relay |-> "unprobed", socket |-> "empty", query |-> "idle",
       reconnect |-> "idle", backlog |-> <<>>, seen |-> {}, nextEvent |-> 1]

Probe ==
  /\ s.relay = "unprobed"
  /\ \E result \in {"verified", "failed"} : s' = [s EXCEPT !.relay = result]

ProbeAges ==
  /\ s.relay = "verified"
  /\ s' = [s EXCEPT !.relay = "expired"]

Warm ==
  /\ s.socket \in {"empty", "failed"}
  /\ s' = [s EXCEPT !.socket = "warming"]

WarmResult ==
  /\ s.socket = "warming"
  /\ \E result \in {"ready", "failed"} : s' = [s EXCEPT !.socket = result]

Start ==
  /\ s.generation < 2 /\ s.captured = -1 /\ ~s.active /\ s.relay = "verified"
  /\ s' = [s EXCEPT !.captured = s.generation, !.socket = "auth"]

AuthFails ==
  /\ s.captured >= 0 /\ s.socket = "auth"
  /\ s' = [s EXCEPT !.socket = "fresh_auth"]

Connect ==
  /\ s.captured >= 0 /\ s.socket \in {"auth", "fresh_auth"}
  /\ s' = [s EXCEPT !.active = s.captured = s.generation \/ Broken,
           !.installed = IF s.captured = s.generation \/ Broken THEN s.captured ELSE -1,
           !.socket = "empty", !.captured = -1, !.reconnect = "idle"]

Stop ==
  /\ s.generation < 2
  /\ s' = [s EXCEPT !.generation = @ + 1, !.active = FALSE,
           !.seen = {}, !.reconnect = "idle"]

CloseUnexpectedly ==
  /\ s.active
  /\ s' = [s EXCEPT !.active = FALSE, !.reconnect = "waiting", !.seen = {}]

ReadBacklog ==
  /\ s.query = "idle" /\ s.relay = "verified"
  /\ s' = [s EXCEPT !.query = IF Len(s.backlog) = 0 THEN "querying" ELSE "drained",
           !.backlog = <<>>]

EndQuery ==
  /\ s.query = "querying"
  /\ \E result \in {"match", "eose", "error"} : s' = [s EXCEPT !.query = result]

Buffer ==
  /\ s.active /\ s.nextEvent <= 2 /\ s.nextEvent \notin s.seen
  /\ s' = [s EXCEPT !.backlog = Append(@, s.nextEvent), !.seen = @ \cup {s.nextEvent},
           !.nextEvent = @ + 1]

Next == Probe \/ ProbeAges \/ Warm \/ WarmResult \/ Start \/ AuthFails \/ Connect
        \/ Stop \/ CloseUnexpectedly \/ ReadBacklog \/ EndQuery \/ Buffer

StoppedGenerationStaysStopped == s.active => s.installed = s.generation
====
