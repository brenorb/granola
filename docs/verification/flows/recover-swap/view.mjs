export const title = "Resume or recover an interrupted swap";
const states = {
  "interrupted": "Swap interrupted",
  "settling": "Resume from saved checkpoint",
  "filled": "Swap filled",
  "frozen": "Swap frozen",
  "waitingRefund": "Wait for refund window",
  "refunding": "Refund eligible",
  "waitingRelease": "Offer returned to maker",
  "paymentReturned": "Payment returned to taker",
  "released": "Order released"
};
const steps = {
  "Resume": "Reopen the profile",
  "Finish": "Both spends are verified",
  "Freeze": "Recovery finds no local lock to refund",
  "WaitRefund": "Safe claim window ends",
  "ObserveUnspent": "Mint confirms unspent after the refund guard",
  "ApplyRefund": "Refund reaches the wallet",
  "ReleaseOrder": "Reservation expires and release is acknowledged"
};
export const state = (vars) => states[vars.phase];
export const step = (action) => steps[action] ?? null;
