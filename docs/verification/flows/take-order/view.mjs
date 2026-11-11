export const title = "Take an order and settle";
const states = {
  "book": "Choose a bid or ask",
  "proposed": "Waiting for maker",
  "refused": "Order busy or changed",
  "offerLocked": "Maker offer verified",
  "bothLocked": "Both sides locked",
  "paymentClaimed": "Maker claimed payment",
  "offerClaimed": "Both mint spends verified",
  "makerFilled": "Maker shows filled",
  "takerFilled": "Taker shows filled",
  "bothFilled": "Both browsers show filled",
  "stalled": "Swap needs recovery"
};
const steps = {
  "Take": "Take the order",
  "Refused": "Maker replies that order changed or is busy",
  "Accept": "Maker accepts with the locked offer",
  "LockPayment": "Taker sends the locked payment",
  "PaymentClaimed": "Payment mint exposes the spend witness",
  "OfferClaimed": "Taker claims the offer and both spends are verified",
  "TakerDone": "Taker finishes",
  "MakerDone": "Maker finishes after staging the fill",
  "Stall": "Peer wait or settlement window runs out"
};
export const state = (vars) => states[vars.phase];
export const step = (action) => steps[action] ?? null;
