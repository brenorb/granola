---- MODULE FundWallet ----
VARIABLES phase, prepared, mintIssued, walletSaved, quoteCredited
vars == <<phase, prepared, mintIssued, walletSaved, quoteCredited>>

Init ==
  /\ phase = "empty"
  /\ prepared = FALSE /\ mintIssued = FALSE
  /\ walletSaved = FALSE /\ quoteCredited = FALSE

RequestQuote ==
  /\ phase = "empty"
  /\ phase' = "waiting"
  /\ UNCHANGED <<prepared, mintIssued, walletSaved, quoteCredited>>

SaveOutputs ==
  /\ phase = "waiting"
  /\ phase' = "prepared" /\ prepared' = TRUE
  /\ UNCHANGED <<mintIssued, walletSaved, quoteCredited>>

MintIssues ==
  /\ phase = "prepared" /\ prepared
  /\ phase' = "issuedRemotely" /\ mintIssued' = TRUE
  /\ UNCHANGED <<prepared, walletSaved, quoteCredited>>

ReceiveProofs ==
  /\ phase = "issuedRemotely"
  /\ phase' = "readyToCommit"
  /\ UNCHANGED <<prepared, mintIssued, walletSaved, quoteCredited>>

Interrupt ==
  /\ phase \in {"prepared", "issuedRemotely", "readyToCommit"}
  /\ phase' = "interrupted"
  /\ UNCHANGED <<prepared, mintIssued, walletSaved, quoteCredited>>

RetryPaidQuote ==
  /\ phase = "interrupted" /\ prepared /\ ~mintIssued
  /\ phase' = "prepared"
  /\ UNCHANGED <<prepared, mintIssued, walletSaved, quoteCredited>>

RestoreIssuedQuote ==
  /\ phase = "interrupted" /\ prepared /\ mintIssued
  /\ phase' = "readyToCommit"
  /\ UNCHANGED <<prepared, mintIssued, walletSaved, quoteCredited>>

CommitCredit ==
  /\ phase = "readyToCommit" /\ mintIssued
  /\ phase' = "funded" /\ prepared' = FALSE
  /\ walletSaved' = TRUE /\ quoteCredited' = TRUE
  /\ UNCHANGED mintIssued

TimeOut ==
  /\ phase = "waiting"
  /\ phase' = "timedOut"
  /\ UNCHANGED <<prepared, mintIssued, walletSaved, quoteCredited>>

Done ==
  /\ phase \in {"funded", "timedOut"}
  /\ UNCHANGED vars

Next == RequestQuote \/ SaveOutputs \/ MintIssues \/ ReceiveProofs \/ Interrupt
        \/ RetryPaidQuote \/ RestoreIssuedQuote \/ CommitCredit \/ TimeOut \/ Done

IssuedQuoteHasWalletCredit ==
  /\ quoteCredited = walletSaved
  /\ phase = "funded" => quoteCredited
====
