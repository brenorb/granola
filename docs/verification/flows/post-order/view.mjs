export const title = "Post and cancel an order";
const states = {
  "editing": "Order ticket",
  "publishing": "Posting order",
  "pending": "Pending publication",
  "posted": "Order acknowledged",
  "canceling": "Canceling order",
  "pendingCancel": "Pending cancellation",
  "canceled": "Cancellation acknowledged",
  "expired": "Order disappears at expiry"
};
const steps = {
  "Submit": "Post a funded order",
  "NoAck": "No relay acknowledges",
  "Retry": "Retry pending publication",
  "Publish": "A relay acknowledges the order",
  "Cancel": "Cancel the order",
  "CancelFailed": "No relay acknowledges cancellation",
  "RetryCancel": "Retry pending cancellation",
  "CancelAck": "A relay acknowledges cancellation",
  "Expire": "Order lifetime ends"
};
export const state = (vars) => states[vars.phase];
export const step = (action) => steps[action] ?? null;
