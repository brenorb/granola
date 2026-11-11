---- MODULE TakeOrder ----
VARIABLES phase, paySpent, offerSpent, makerFillStaged, publicFillAck
vars == <<phase, paySpent, offerSpent, makerFillStaged, publicFillAck>>
Init == phase = "book" /\ paySpent = FALSE /\ offerSpent = FALSE /\ makerFillStaged = FALSE /\ publicFillAck = FALSE
Take ==
  /\ phase = "book"
  /\ phase' = "proposed" /\ UNCHANGED <<paySpent, offerSpent, makerFillStaged, publicFillAck>>
Refused ==
  /\ phase = "proposed"
  /\ phase' = "refused" /\ UNCHANGED <<paySpent, offerSpent, makerFillStaged, publicFillAck>>
Accept ==
  /\ phase = "proposed"
  /\ phase' = "offerLocked" /\ UNCHANGED <<paySpent, offerSpent, makerFillStaged, publicFillAck>>
LockPayment ==
  /\ phase = "offerLocked"
  /\ phase' = "bothLocked" /\ UNCHANGED <<paySpent, offerSpent, makerFillStaged, publicFillAck>>
PaymentClaimed ==
  /\ phase = "bothLocked"
  /\ phase' = "paymentClaimed" /\ paySpent' = TRUE
  /\ UNCHANGED <<offerSpent, makerFillStaged, publicFillAck>>
OfferClaimed ==
  /\ phase = "paymentClaimed"
  /\ phase' = "offerClaimed" /\ offerSpent' = TRUE
  /\ UNCHANGED <<paySpent, makerFillStaged, publicFillAck>>
StageFill ==
  /\ phase \in {"offerClaimed", "takerFilled", "makerFilled"} /\ ~makerFillStaged
  /\ makerFillStaged' = TRUE /\ UNCHANGED <<phase, paySpent, offerSpent, publicFillAck>>
TakerDone ==
  /\ phase \in {"offerClaimed", "makerFilled"}
  /\ phase' = IF phase = "makerFilled" THEN "bothFilled" ELSE "takerFilled"
  /\ UNCHANGED <<paySpent, offerSpent, makerFillStaged, publicFillAck>>
MakerDone ==
  /\ phase \in {"offerClaimed", "takerFilled"} /\ makerFillStaged
  /\ phase' = IF phase = "takerFilled" THEN "bothFilled" ELSE "makerFilled"
  /\ UNCHANGED <<paySpent, offerSpent, makerFillStaged, publicFillAck>>
AnnounceFill ==
  /\ makerFillStaged /\ ~publicFillAck
  /\ publicFillAck' = TRUE /\ UNCHANGED <<phase, paySpent, offerSpent, makerFillStaged>>
Stall ==
  /\ phase \in {"proposed", "offerLocked", "bothLocked", "paymentClaimed"}
  /\ phase' = "stalled" /\ UNCHANGED <<paySpent, offerSpent, makerFillStaged, publicFillAck>>
Done ==
  /\ phase \in {"refused", "stalled", "bothFilled"}
  /\ UNCHANGED vars
Next == Take \/ Refused \/ Accept \/ LockPayment \/ PaymentClaimed \/ OfferClaimed
        \/ StageFill \/ TakerDone \/ MakerDone \/ AnnounceFill \/ Stall \/ Done
FilledNeedsBothSpends == phase \in {"takerFilled", "makerFilled", "bothFilled"} => paySpent /\ offerSpent
====
