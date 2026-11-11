---- MODULE FundWallet ----
EXTENDS Integers
VARIABLES phase, mintIssued, walletSaved
vars == <<phase, mintIssued, walletSaved>>

Init == phase = "empty" /\ mintIssued = FALSE /\ walletSaved = FALSE
RequestQuote ==
  /\ phase = "empty"
  /\ phase' = "waiting"
  /\ UNCHANGED <<mintIssued, walletSaved>>
MintIssues ==
  /\ phase = "waiting"
  /\ phase' = "issuedRemotely" /\ mintIssued' = TRUE /\ UNCHANGED walletSaved
SaveWallet ==
  /\ phase = "issuedRemotely"
  /\ phase' = "walletSaved" /\ walletSaved' = TRUE /\ UNCHANGED mintIssued
ShowIssued ==
  /\ phase = "walletSaved"
  /\ phase' = "funded" /\ UNCHANGED <<mintIssued, walletSaved>>
ReloadBeforeSave ==
  /\ phase = "issuedRemotely"
  /\ phase' = "interrupted" /\ UNCHANGED <<mintIssued, walletSaved>>
RetryClaim ==
  /\ phase = "interrupted" /\ mintIssued
  /\ phase' = "funded" /\ UNCHANGED <<mintIssued, walletSaved>>
TimeOut ==
  /\ phase = "waiting"
  /\ phase' = "timedOut" /\ UNCHANGED <<mintIssued, walletSaved>>
Done ==
  /\ phase \in {"funded", "timedOut"}
  /\ UNCHANGED vars
Next == RequestQuote \/ MintIssues \/ SaveWallet \/ ShowIssued
        \/ ReloadBeforeSave \/ RetryClaim \/ TimeOut \/ Done
IssuedQuoteHasWalletCredit == phase = "funded" => walletSaved
====
