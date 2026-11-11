---- MODULE Cashu ----
EXTENDS Integers
CONSTANTS Broken, BreakFunding
VARIABLE s

Init ==
  \E kind \in {"lock", "claim", "refund", "fund"} :
    s = [kind |-> kind, journal |-> "empty", owner |-> "none",
         mintIssued |-> FALSE, walletSaved |-> FALSE, quote |-> "none",
         prepared |-> FALSE, inFlight |-> FALSE, fundingResult |-> FALSE,
         credited |-> FALSE,
         proof |-> "UNKNOWN", wake |-> "idle", writes |-> 0]

Prepare ==
  /\ s.kind # "fund" /\ s.journal = "empty"
  /\ s' = [s EXCEPT !.journal = "prepared"]

ReserveInputs ==
  /\ s.journal = "prepared" /\ s.owner = "none"
  /\ s' = [s EXCEPT !.owner = "session"]

SaveReservationCheckpoint ==
  /\ s.owner = "session" /\ s.journal = "prepared"
  /\ s' = [s EXCEPT !.journal = "inputs_reserved"]

MintCompletes ==
  /\ s.journal = "inputs_reserved" /\ ~s.mintIssued
  /\ s' = [s EXCEPT !.mintIssued = TRUE]

SaveMintResult ==
  /\ s.journal = "inputs_reserved" /\ s.mintIssued
  /\ s' = [s EXCEPT !.journal = "completed"]

SaveWallet ==
  /\ s.journal = "completed" /\ (~s.walletSaved \/ Broken) /\ s.writes < 2
  /\ s' = [s EXCEPT !.walletSaved = TRUE, !.writes = @ + 1]

ReleaseInputs ==
  /\ s.journal = "completed" /\ s.walletSaved /\ s.owner = "session"
  /\ s' = [s EXCEPT !.owner = "none"]

SaveWalletCheckpoint ==
  /\ s.journal = "completed" /\ s.walletSaved /\ s.owner = "none"
  /\ s' = [s EXCEPT !.journal = "wallet_applied"]

ClearOperation ==
  /\ s.journal = "wallet_applied" /\ s.kind = "refund"
  /\ s' = [s EXCEPT !.journal = "cleared"]

MintQuote ==
  /\ s.kind = "fund" /\ s.quote = "none"
  /\ s' = [s EXCEPT !.quote = "UNPAID"]

MarkPaid ==
  /\ s.quote = "UNPAID"
  /\ s' = [s EXCEPT !.quote = "PAID"]

PrepareFunding ==
  /\ s.quote = "PAID" /\ ~s.prepared
  /\ s' = [s EXCEPT !.prepared = TRUE]

SubmitFunding ==
  /\ s.quote = "PAID" /\ s.prepared /\ ~s.inFlight /\ ~s.mintIssued
  /\ s' = [s EXCEPT !.inFlight = TRUE]

IssueQuote ==
  /\ s.inFlight /\ ~s.mintIssued
  /\ s' = [s EXCEPT !.mintIssued = TRUE]

ReceiveFunding ==
  /\ s.inFlight /\ s.mintIssued
  /\ s' = [s EXCEPT !.inFlight = FALSE, !.fundingResult = TRUE]

InterruptFunding ==
  /\ s.inFlight \/ s.fundingResult
  /\ s' = [s EXCEPT !.inFlight = FALSE, !.fundingResult = FALSE]

RestoreFunding ==
  /\ s.quote = "PAID" /\ s.prepared /\ s.mintIssued
  /\ ~s.inFlight /\ ~s.fundingResult
  /\ s' = [s EXCEPT !.fundingResult = TRUE]

\* The proof batch, credit marker, and removal of prepared outputs share one commit.
CommitFunding ==
  /\ s.fundingResult /\ ~s.credited
  /\ s' = [s EXCEPT !.walletSaved = ~BreakFunding,
           !.credited = TRUE, !.quote = "ISSUED", !.prepared = FALSE,
           !.fundingResult = FALSE, !.writes = IF BreakFunding THEN @ ELSE @ + 1]

\* The initial read may already be SPENT. A notification only ends the wait.
Observe ==
  /\ s.kind = "lock" /\ s.journal \in {"completed", "wallet_applied"}
  /\ s.proof # "SPENT"
  /\ \E state \in {"UNSPENT", "PENDING", "SPENT"} :
       s' = [s EXCEPT !.proof = state]

WaitForProof ==
  /\ s.proof \in {"UNSPENT", "PENDING"} /\ s.wake = "idle"
  /\ s' = [s EXCEPT !.wake = "waiting"]

Wake ==
  /\ s.wake = "waiting"
  /\ \E why \in {"notification", "timeout", "unavailable"} :
       s' = [s EXCEPT !.wake = why]

Next == Prepare \/ ReserveInputs \/ SaveReservationCheckpoint \/ MintCompletes
        \/ SaveMintResult \/ SaveWallet \/ ReleaseInputs \/ SaveWalletCheckpoint
        \/ ClearOperation \/ MintQuote \/ MarkPaid \/ PrepareFunding \/ SubmitFunding
        \/ IssueQuote \/ ReceiveFunding \/ InterruptFunding \/ RestoreFunding \/ CommitFunding
        \/ Observe \/ WaitForProof \/ Wake

WalletResultAppliedOnce == s.writes <= 1
FundingCommitIsAtomic ==
  s.kind = "fund" =>
    /\ s.credited = s.walletSaved
    /\ (s.quote = "ISSUED") = s.credited
    /\ s.credited => s.mintIssued /\ ~s.prepared
====
