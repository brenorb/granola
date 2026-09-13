# SDK boundary

The supported TypeScript entry point is `src/index.ts`. It exposes the
protocol-safe API and validators without exposing storage drivers, UI modules,
or bearer material internals.

```ts
import {
  GRANOLA_PROTOCOL_VERSION,
  quoteAmountForSettlement,
  validateAtomicSwapMessage
} from "granola";

const quote = quoteAmountForSettlement("200", "4950000");
// "9"
console.log(GRANOLA_PROTOCOL_VERSION, quote);
```

The browser demo uses the same boundary through `window.granola`. Its public
type is `GranolaBrowserFacade` from `src/sdk.ts`; the facade returns redacted
wallet/order/trade views. `createBackup()` is intentionally the only method
that returns spendable bearer material.

The SDK is still testnet-only. A production package needs a separate release
profile for mint allowlists, relay policy, persistence, and key-erasure review.
