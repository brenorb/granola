# Local production-like QA stack

Runs the production build of Granola against local copies of every external
service it uses, with sanitized production-scale data. The browser sees the
real production hostnames, TLS, and CSP; nothing reaches public relays or
mints.

| Production host | Local stand-in |
| --- | --- |
| `brenorb.com/granola/` | `dist/` served by `proxy.mjs` |
| `testnut.cashu.space` | Nutshell 0.20.2 mint, fake Lightning, `sat`, 100 ppk input fee |
| `testnut.cashudevkit.org` | cdk-mintd 0.18.3 mint, fake Lightning, `sat` + `usd`, no fee |
| `nos.lol`, `relay.primal.net`, `offchain.pub` | khatru relays (`relay/main.go`), Badger storage, NIP-40 expiry |
| `auth.nostr1.com` | khatru relay with mandatory NIP-42 AUTH and recipient-only gift-wrap reads |
| `ws://localhost:4870` (local mesh) | left absent, as for most users |

Chromium resolves those hostnames to `proxy.mjs` (`--host-resolver-rules`,
every other host → NXDOMAIN). The proxy's control port (`127.0.0.1:8444`)
injects outages: `/fault?host=<h>&mode=down|slow|up`, `/drop?host=<h>`,
`/stats`, `/reset`.

## Data

`seed-local-orderbook.ts` publishes, with throwaway keys and the app's own
order code: 1,200 open orders from 300 makers spread over 25 days, 400
canceled orders, and 5 hostile/malformed events. The best ask (49,500.00) and
best bid (49,200.00) are deliberately the *oldest* open orders. Seeded makers
are offline, which doubles as the unresponsive-maker case. The mint
mnemonic is the public BIP39 test vector.

## Use

```bash
scripts/qa/stack.sh tools
```

```bash
scripts/qa/stack.sh start
```

```bash
scripts/qa/stack.sh seed
```

```bash
node scripts/qa/inventory-run.mjs after
```

Tools need Go, `uv` with Python 3.12, Rust with `protoc`, and the
pre-installed Playwright Chromium. `inventory-run.mjs` executes every check in
[docs/qa/inventory.md](../../docs/qa/inventory.md) and writes screenshots and
`<label>-results.json` to `$QA_ROOT/evidence` (default `/tmp/granola-qa`).
Run `stack.sh reset` before a rerun to restore the seeded relays. Pass a
comma-separated ID list as the second argument to run a subset.
