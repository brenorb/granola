# Granola verification

[Open the four user-flow statecharts](flows/README.md).

The project-local skills live under `.cursor/skills`. Each models a subsystem as a finite TLA+ transition system and checks one rule against every reachable state within its bounds. The source mappings and limits are in each skill. The models describe Granola at `0fc2d4a5a23837654e23bff16383880efffb7eb1`.

| Skill | State machines covered | Checked rule | Reachable states |
| --- | --- | --- | ---: |
| [Settlement](../../.cursor/skills/verify-granola-settlement/SKILL.md) | Coordinator, mint evidence for each leg, public trade phase, timeouts, refunds | Filled requires verified spends on both legs | 620 |
| [Messages](../../.cursor/skills/verify-granola-messages/SKILL.md) | Wire sequence, transcript, receive and send journals, registration, direct route and fallback | Successful fallback discovery changes the route saved for retry | 110 |
| [Orders](../../.cursor/skills/verify-granola-orders/SKILL.md) | Order status, publication, signed head selection, authority, refusal replies | A stale snapshot cannot regress the remembered order head | 10,772 |
| [Cashu](../../.cursor/skills/verify-granola-cashu/SKILL.md) | Operation journal, proof ownership, exact wallet reconciliation, proof notification, funding quote | A replay applies a completed swap operation to the wallet at most once | 96 |
| [Storage](../../.cursor/skills/verify-granola-storage/SKILL.md) | External action snapshot and merge, announcement progress, admission, database and key readiness | A stale financial result cannot merge | 424 |
| [Transport](../../.cursor/skills/verify-granola-transport/SKILL.md) | Probe validity, warm socket and AUTH, reconnect, subscription generation, buffer and backfill | A stopped generation cannot install a late subscription | 2,388 |
| [Browser](../../.cursor/skills/verify-granola-browser/SKILL.md) | Startup, maker resync, runner and peer wait, retained book, refresh coalescing, pending feedback | A successful dirty refresh schedules another pass | 6,794 |

All seven rules held in TLC. For each rule, the broken model produced a counterexample. The corresponding implementation test passed, failed on a disposable source mutation, then passed after restoration. The unchanged application suite returned 458 passing tests and seven skipped tests. TypeScript type-checking passed.

The chart checks use smaller user-facing projections. The [funding rule breaks](flows/fund-wallet/report.md) even on the unmodified implementation. Once the mint issues proofs, a browser interruption before the wallet write can leave the quote outstanding locally. On retry, the mint says `ISSUED`, the API stores that state, and the wallet still has no credit. The replay drives the real Cashu client and Granola API with a fake mint and an interrupted wallet save.

~~~sh
node --import tsx scripts/verification/replay-funding.mjs
~~~

The state counts cover finite abstractions of application logic. Separate clocks, exact relay and mint behavior, cryptography, loaded extended wire phases, and low-level DOM and cache transitions have limited or no representation. A passing model establishes its named invariant within its bounds. The skills map the checks to specific implementation functions and include the source regression tests.
