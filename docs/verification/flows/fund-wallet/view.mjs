export const title = "Fund the test wallet";
const states = {
  "empty": "Wallet ready to fund",
  "waiting": "Waiting for mint payment",
  "issuedRemotely": "Mint issued tokens",
  "walletSaved": "Wallet balance updated",
  "interrupted": "Browser closed before balance update",
  "funded": "Quote marked issued",
  "timedOut": "Funding wait timed out"
};
const steps = {
  "RequestQuote": "Request test tokens",
  "MintIssues": "Payment clears and the mint issues tokens",
  "SaveWallet": "Browser saves the tokens",
  "ShowIssued": "Funding reports success",
  "ReloadBeforeSave": "Browser closes before the wallet write",
  "RetryClaim": "Retry the saved quote through the agent API",
  "TimeOut": "Polling limit is reached"
};
export const state = (vars) => states[vars.phase];
export const step = (action) => steps[action] ?? null;
