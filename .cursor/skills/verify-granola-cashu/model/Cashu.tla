---- MODULE Cashu ----
EXTENDS Integers
CONSTANT Broken
VARIABLE s

Init ==
  \E kind \in {"lock", "claim", "refund", "fund"} :
    s = [kind |-> kind, journal |-> "empty", owner |-> "none",
         mintIssued |-> FALSE, walletSaved |-> FALSE, quote |-> "none",
         interrupted |-> FALSE,
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

IssueQuote ==
  /\ s.quote = "PAID" /\ ~s.mintIssued
  /\ s' = [s EXCEPT !.mintIssued = TRUE]

SaveFundingWallet ==
  /\ s.quote = "PAID" /\ s.mintIssued /\ ~s.walletSaved /\ ~s.interrupted
  /\ s' = [s EXCEPT !.walletSaved = TRUE, !.writes = @ + 1]

InterruptFunding ==
  /\ s.quote = "PAID" /\ s.mintIssued /\ ~s.walletSaved /\ ~s.interrupted
  /\ s' = [s EXCEPT !.interrupted = TRUE]

SaveIssuedQuote ==
  /\ s.quote = "PAID" /\ s.mintIssued /\ (s.walletSaved \/ s.interrupted)
  /\ s' = [s EXCEPT !.quote = "ISSUED"]

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
        \/ ClearOperation \/ MintQuote \/ MarkPaid \/ IssueQuote \/ SaveFundingWallet
        \/ InterruptFunding \/ SaveIssuedQuote \/ Observe \/ WaitForProof \/ Wake

WalletResultAppliedOnce == s.writes <= 1
====
