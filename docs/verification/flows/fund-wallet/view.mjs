export const title = "Fund the test wallet";
const states = {
  empty: "Wallet ready to fund",
  waiting: "Waiting for mint payment",
  prepared: "Funding attempt saved",
  issuedRemotely: "Mint issued tokens",
  readyToCommit: "Tokens ready to save",
  interrupted: "Saved funding attempt can resume",
  funded: "Wallet credited",
  timedOut: "Funding wait timed out"
};
const steps = {
  RequestQuote: "Request test tokens",
  SaveOutputs: "Payment clears and the wallet saves the attempt",
  MintIssues: "Mint issues tokens",
  ReceiveProofs: "Wallet receives the tokens",
  Interrupt: "Browser closes or local save fails",
  RetryPaidQuote: "Retry the paid quote with the same outputs",
  RestoreIssuedQuote: "Recover the issued tokens from the mint",
  CommitCredit: "Save the tokens and mark the quote credited together",
  TimeOut: "Polling limit is reached"
};
export const state = (vars) => states[vars.phase];
export const step = (action) => steps[action] ?? null;
