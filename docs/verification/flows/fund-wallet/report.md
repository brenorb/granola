# FundWallet

TLC reached 8 states and 10 steps. The chart draws 7 states and 7 arrows.
The view hides 3 steps, so the chart does not draw them.

## IssuedQuoteHasWalletCredit breaks
The shortest path has 4 steps:
0. Wallet ready to fund
1. Request test tokens: Waiting for mint payment
2. Payment clears and the mint issues tokens: Mint issued tokens
3. Browser closes before the wallet write: Browser closed before balance update
4. Retry the saved quote through the agent API: Quote marked issued

## Rules that hold
NoDeadlock
