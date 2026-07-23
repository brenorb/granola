# Test order publication trace — 2026-07-23

This trace contains public Nostr identifiers only. No signing key, Cashu proof,
token, quote ID, or preimage was persisted or printed.

## Scope

- Market ID: `79da04f634a843c37c7a5ffb4aa29742a2551d238d9a443b39338c52b8fd1d5b`
- Base: `sat` issued by `https://testnut.cashu.space`
- Quote: `usd` cents issued by `https://nofee.testnut.cashu.space`
- Execution: all-or-none
- Expiry: creation plus 30 days
- Transition: NIP-78 normal kind `78`
- Current projection: NIP-78 addressable kind `30078`
- Required publication quorum: 2 relays per event

## Accepted UUID-conforming publication batch

The replacement batch ran from `2026-07-23T01:22:35.837Z` to
`2026-07-23T01:22:50.871Z`. Every transition and projection received an `OK`
from all three relays and was then independently read back from all three:

- `wss://nos.lol`
- `wss://relay.primal.net`
- `wss://offchain.pub`

| Side | Size SAT | USD/BTC | Exact cents/SAT | Order ID | Maker public key | Transition ID | Projection ID | ACK | Readback |
|---|---:|---:|---:|---|---|---|---|---:|---:|
| Ask | 2,000 | 50,500.00 | `101/2000` | `40edd3fc-0175-47a5-ba72-e128be534680` | `aead5df02653b178b4ba59d5dd9fb2a6bf29ccdd67aeb37f4fa0c06bd4fe004f` | `496c946c9e285766d38dee92476101878ab344f26af80e05404ff2c7544aea0d` | `51ef1229b08efe8d7de64957526e75cef3217f798c67f784276f46f3bf0d1a1f` | 3/3 + 3/3 | 3/3 + 3/3 |
| Ask | 1,000 | 51,000.00 | `51/1000` | `f6116057-569e-4381-adbe-88bcc8f8a811` | `39871ea164b7ebd30c5c0f6ce92c844a7d3e6125cf9f48058c2c80770f22464d` | `1bef3058211983e537a9a9dbb870db454f51306bba3b870ec37207b910f5a9a1` | `5233d6f3a973beccdc3e6c7f181737faaca09e7e349dc46379e80a59d7d048b8` | 3/3 + 3/3 | 3/3 + 3/3 |
| Ask | 1,000 | 52,000.00 | `13/250` | `ac5347c1-c5b5-4c83-8ace-df0f0232c6e6` | `de3517a5de981a8714a7d92773584fbd38f8656318088150f3420dc080f4d64d` | `47b2991291aee288d8e08d2783c9b5491b10cf529a7ce7b04f7c2ba1d2e8eb4c` | `bfebdf1c4ca33dd37230418294514798d069f4bc3ff6372db2b1cf4b4afe0d8a` | 3/3 + 3/3 | 3/3 + 3/3 |
| Bid | 2,000 | 49,500.00 | `99/2000` | `c95f2085-d477-4384-8852-e4c9d1534c22` | `b34041dd682a39e83887b7e99d9bef259f05b93a08ba07402b18b200018a3b69` | `569bd36bfb0a6cc865648e098de396e66928f4db6820df5e4650df311ca59803` | `88510f7aca7d188bbbd18f7aff8d6f88b45cbbcabc4f1a70cf62760d912af859` | 3/3 + 3/3 | 3/3 + 3/3 |
| Bid | 1,000 | 49,000.00 | `49/1000` | `93e0fb64-bc0c-4076-9c94-7d20eff537e6` | `682cfb53198d760555a701dca6c923b4eb985faf81f3069177f0782d3ebf4e1b` | `b3e733c44b3dea8c82ba0176d6a5ac1dcabca0f1d913331ad677342e2a7a36d0` | `4a167baf5956a687c9521bba1e4a2881bc8f7690bced4dc3fb7129931f069a5d` | 3/3 + 3/3 | 3/3 + 3/3 |
| Bid | 1,000 | 48,000.00 | `6/125` | `8e0719a8-08e8-4aa6-bc5a-a90e9497e58d` | `ccd1c8c5a7102bb1db93ef6853307e3965cd72295e32edf6430933ea6ceb1d9e` | `877fa5c8ff9921d6f8836e8f209074a7df3037edb5db27c21520b1a4439e64ee` | `1600cc054a3624a658fdbc3097e8c40cdf268c2b167195b71efc9a20bda4870e` | 3/3 + 3/3 | 3/3 + 3/3 |

`ACK` shows transition plus projection acknowledgements. `Readback` shows
transition plus projection retrieval. Relay acceptance proves replication, not
consensus or future retention.

The browser independently loaded these signed projections, recomputed the
issuer-pair market tag, fetched and verified each referenced transition head,
and displayed a best ask of USD 50,500/BTC, best bid of USD 49,500/BTC, and USD
1,000/BTC spread.

## Legacy decorated-ID batch

An earlier six-order batch used IDs such as
`seed-20260723-ask-50500-c2018189-10a8-4792-8e20-f264dcc308bb`. Those IDs did
not satisfy ADR 0001's UUID requirement. Their events remain on public relays,
but the corrected domain boundary and parser reject all six projections. Along
with the three published asks in the stopped run below, the browser reports
nine ignored invalid projections. Commit `e043a27` retains their complete maker,
transition, projection, acknowledgement, and readback identifiers for audit.

## Earlier stopped run

The first command invocation failed locally because its TypeScript runner was
not installed; it made no relay connection. After that was corrected, the
original relay set exposed inconsistent NIP-78 support:

- `wss://nostr.ltd` returned `unsupported event kind: 78` while accepting kind
  `30078` and advertising NIP-78;
- `wss://relay.damus.io` later returned `rate-limited: you are noting too much`;
- `wss://nos.lol` accepted both event classes.

The fail-fast quorum stopped on the first bid transition. Three asks had already
reached the acknowledgement quorum, and one bid transition had reached only
`nos.lol`. Their public identifiers are retained here rather than hidden:

| Result | Order ID | Maker public key | Transition ID | Projection ID |
|---|---|---|---|---|
| Ask 50,500 published | `seed-20260723-ask-50500-23c8e963-29f7-47d9-aa74-e9a9ac9f1caa` | `6dba6a44366c9da456fad99827bdad0d7ff474bd9d2a050f257577383189d4f3` | `4703b348307d704bf86cd5e29b0122844f982dabffa3b367ee755e03bc4adb80` | `dea1e114654f972291e2062e8419f2adc070dafc0abbb196b2720ebff6940b5c` |
| Ask 51,000 published | `seed-20260723-ask-51000-92275483-4c66-46ef-863d-0a40fded6ce3` | `afacf47b0198d30304a21d4198ddeae193a636cdddedbf63d281edb5af0fc52b` | `bcf80b032d5686fdc7f9b0d495796a70e089f74a684c948388b895edc6f73c8a` | `a9bbbdce3e7e5e6683343b4f0293c334841bb01d0bbeb25c5e243bd2acae807e` |
| Ask 52,000 published | `seed-20260723-ask-52000-58ea852f-15be-4b05-a14c-b88da92941d1` | `f77b127ba3d5bba4293f52e124de70ad9f8a6a785bc99683a5a21b052ac9191a` | `6fd08e89f6e88e0f94c4f28a3511ec2739ddd42b29a90960ffb46133fa89cfb7` | `5dcf8b676b4042b2599a78e7daebaffcc76d6ca3aa15f3fbab82f190fb876b17` |
| Bid 49,500 stopped after transition | `seed-20260723-bid-49500-680954ed-57ce-45ba-abc2-fe9c634946c8` | `2e1e911a0a1e1960dd440c3d6b36bf3115245531b3b56ca0600feb6d748be5b2` | `15b6e8dd97c9360a78106164cf386f9ba065993db7de76fdba9a1e583e82e93f` | none |

The seeding identities existed in memory only and were destroyed with the
process. These test orders cannot be canceled and will expire after 30 days.
Orders used for the atomic-swap demonstration must instead use the browser's
persistent per-profile maker identity.
