# Granola verification

[Open the four user-flow statecharts](flows/README.md).

The project-local skills live under `.cursor/skills`. Each models a subsystem as a finite TLA+ transition system and checks its rules against every reachable state within its bounds. Each skill records its source revision, mappings, and limits.

| Skill | State machines covered | Checked rule | Reachable states |
| --- | --- | --- | ---: |
| [Settlement](../../.cursor/skills/verify-granola-settlement/SKILL.md) | Coordinator, mint evidence for each leg, public trade phase, timeouts, refunds | Filled requires verified spends on both legs | 620 |
| [Messages](../../.cursor/skills/verify-granola-messages/SKILL.md) | Wire sequence, transcript, receive and send journals, registration, direct route and fallback | Successful fallback discovery changes the route saved for retry | 110 |
| [Orders](../../.cursor/skills/verify-granola-orders/SKILL.md) | Order status, publication, signed head selection, authority, refusal replies | A stale snapshot cannot regress the remembered order head | 10,772 |
| [Cashu](../../.cursor/skills/verify-granola-cashu/SKILL.md) | Operation journal, proof ownership, exact wallet reconciliation, proof notification, funding quote | A swap replay applies the wallet result at most once. Funding credit and proofs commit together. | 97 |
| [Storage](../../.cursor/skills/verify-granola-storage/SKILL.md) | External action snapshot and merge, announcement progress, admission, database and key readiness | A stale financial result cannot merge | 424 |
| [Transport](../../.cursor/skills/verify-granola-transport/SKILL.md) | Probe validity, warm socket and AUTH, reconnect, subscription generation, buffer and backfill | A stopped generation cannot install a late subscription | 2,388 |
| [Browser](../../.cursor/skills/verify-granola-browser/SKILL.md) | Startup, maker resync, runner and peer wait, retained book, refresh coalescing, pending feedback | A successful dirty refresh schedules another pass | 6,794 |

The seven subsystem models pass TLC. The deliberately broken versions produce counterexamples. Implementation tests catch the corresponding mutations. The application suite returned 463 passing tests and seven skipped tests after the funding fix. TypeScript type-checking and the production build passed.

The original [funding model](https://github.com/brenorb/granola/blob/f5368db/docs/verification/flows/fund-wallet/report.md) found that retrying an issued quote could report success without wallet credit. The [updated funding check](flows/fund-wallet/report.md) passes with saved issuance outputs, mint restore, and an atomic local commit. The regression test drives the Cashu client and Granola API through interruptions before issuance, after issuance, and during the local commit.

~~~sh
npm test -- src/api/granola-api.test.ts -t "credits a saved funding quote once after an interruption"
~~~

The state counts cover finite abstractions of application logic. Separate clocks, exact relay and mint behavior, cryptography, loaded extended wire phases, and low-level DOM and cache transitions have limited or no representation. A passing model establishes its named invariant within its bounds. The skills map the checks to specific implementation functions and include the source regression tests.
