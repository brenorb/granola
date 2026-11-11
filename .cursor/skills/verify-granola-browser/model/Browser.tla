---- MODULE Browser ----
EXTENDS Integers
CONSTANT Broken
VARIABLE s

Init ==
  s = [refresh |-> "idle", dirty |-> FALSE, requests |-> 0, reads |-> 0,
       book |-> "loading", seenBook |-> FALSE, runtime |-> "idle",
       followupOwed |-> FALSE,
       maker |-> "idle", queued |-> FALSE, retries |-> 0, owner |-> 0,
       run |-> "idle", peer |-> FALSE, busy |-> FALSE, takeId |-> FALSE]

RequestRefresh ==
  /\ s.requests < 3
  /\ s' = [s EXCEPT !.requests = @ + 1, !.dirty = TRUE,
           !.refresh = IF @ = "idle" THEN "scheduled" ELSE @]

StartRead ==
  /\ s.refresh = "scheduled"
  /\ s' = [s EXCEPT !.refresh = "reading", !.dirty = FALSE, !.reads = @ + 1,
           !.followupOwed = FALSE]

EndRead ==
  /\ s.refresh = "reading"
  /\ \E ok \in BOOLEAN :
       s' = [s EXCEPT !.refresh = IF ok /\ s.dirty /\ ~Broken THEN "scheduled" ELSE "idle",
             !.followupOwed = ok /\ s.dirty,
             !.book = IF ok THEN "ready" ELSE IF s.seenBook THEN @ ELSE "error",
             !.seenBook = @ \/ ok]

StartRuntime ==
  /\ s.runtime = "idle"
  /\ s' = [s EXCEPT !.runtime = "starting"]

RuntimeResult ==
  /\ s.runtime = "starting"
  /\ \E result \in {"ready", "rejected"} : s' = [s EXCEPT !.runtime = result]

SyncMaker ==
  /\ s.runtime \in {"ready", "rejected"} /\ s.maker \in {"idle", "ready", "backoff"}
  /\ s' = [s EXCEPT !.maker = "starting"]

QueueResync ==
  /\ s.maker = "starting" /\ ~s.queued
  /\ s' = [s EXCEPT !.queued = TRUE]

MakerResult ==
  /\ s.maker = "starting"
  /\ \E ok \in BOOLEAN :
       s' = [s EXCEPT !.maker = IF ok THEN IF s.queued THEN "starting" ELSE "ready"
                                      ELSE "backoff",
             !.queued = FALSE, !.retries = IF ok THEN 0 ELSE IF @ < 2 THEN @ + 1 ELSE @]

Take ==
  /\ s.book = "ready" /\ s.runtime = "ready" /\ s.owner = 0 /\ ~s.busy
  /\ s' = [s EXCEPT !.busy = TRUE, !.takeId = TRUE, !.run = "advancing", !.owner = 1]

ResumeMaker ==
  /\ s.maker = "ready" /\ s.owner = 0
  /\ s' = [s EXCEPT !.owner = 2, !.run = "advancing"]

WaitForPeer ==
  /\ s.run = "advancing" /\ s.owner # 0
  /\ s' = [s EXCEPT !.run = "waiting", !.peer = FALSE]

Wake ==
  /\ s.run = "waiting"
  /\ \E signal \in BOOLEAN : s' = [s EXCEPT !.run = "advancing", !.peer = signal]

EndRun ==
  /\ s.owner # 0 /\ s.run = "advancing"
  /\ \E result \in {"filled", "error"} :
       s' = [s EXCEPT !.run = result, !.owner = 0, !.busy = FALSE, !.takeId = FALSE]

Next == RequestRefresh \/ StartRead \/ EndRead \/ StartRuntime \/ RuntimeResult
        \/ SyncMaker \/ QueueResync \/ MakerResult \/ Take \/ ResumeMaker
        \/ WaitForPeer \/ Wake \/ EndRun

DirtyRefreshSchedulesRead == s.followupOwed => s.refresh = "scheduled"
====
