---- MODULE Storage ----
EXTENDS Integers
CONSTANT Broken
VARIABLE s

Init ==
  s = [db |-> "unopened", key |-> "absent", legacy |-> TRUE,
       revision |-> 0, version |-> 0, receipt |-> FALSE, snapshot |-> -1,
       request |-> "unbound", maker |-> "vacant", stale |-> FALSE]

OpenDb ==
  /\ s.db = "unopened"
  /\ s' = [s EXCEPT !.db = "opening"]

OpenResult ==
  /\ s.db = "opening"
  /\ \E result \in {"unopened", "ready"} : s' = [s EXCEPT !.db = result]

Invalidate ==
  /\ s.db \in {"opening", "ready"}
  /\ s' = [s EXCEPT !.db = "invalidated", !.key = "absent", !.snapshot = -1]

StartKey ==
  /\ s.db = "ready" /\ s.key = "absent"
  /\ s' = [s EXCEPT !.key = "loading"]

LoadKey ==
  /\ s.db = "ready" /\ s.key = "loading"
  /\ \E result \in {"ready", "absent"} : s' = [s EXCEPT !.key = result]

Writable == s.db = "ready" /\ s.key = "ready" /\ s.revision < 4

BindTaker ==
  /\ Writable /\ s.request = "unbound"
  /\ s' = [s EXCEPT !.request = "bound"]

AdmitMaker ==
  /\ Writable /\ s.maker \in {"vacant", "filled", "released"}
  /\ s' = [s EXCEPT !.maker = "active"]

FinishMaker ==
  /\ Writable /\ s.maker = "active"
  /\ \E result \in {"filled", "released", "frozen"} : s' = [s EXCEPT !.maker = result]

Snapshot ==
  /\ Writable /\ s.snapshot = -1
  /\ s' = [s EXCEPT !.snapshot = s.version]

AnnouncementCommit ==
  /\ Writable /\ ~s.receipt
  /\ s' = [s EXCEPT !.receipt = TRUE, !.revision = @ + 1, !.legacy = FALSE]

CompetingFinancialCommit ==
  /\ Writable
  /\ s' = [s EXCEPT !.version = @ + 1, !.revision = @ + 1, !.legacy = FALSE]

Merge ==
  /\ Writable /\ s.snapshot >= 0
  /\ s.snapshot = s.version \/ Broken
  /\ s' = [s EXCEPT !.stale = s.snapshot # s.version, !.snapshot = -1,
           !.version = @ + 1, !.revision = @ + 1, !.legacy = FALSE]

RejectStale ==
  /\ s.snapshot >= 0 /\ s.snapshot # s.version
  /\ s' = [s EXCEPT !.snapshot = -1]

Next == OpenDb \/ OpenResult \/ Invalidate \/ StartKey \/ LoadKey \/ BindTaker
        \/ AdmitMaker \/ FinishMaker \/ Snapshot \/ AnnouncementCommit
        \/ CompetingFinancialCommit \/ Merge \/ RejectStale

NoStaleFinancialMerge == ~s.stale
====
