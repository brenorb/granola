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

## Validated publication batch

The batch ran from `2026-07-23T00:58:05.785Z` to
`2026-07-23T00:58:22.707Z`. Every transition and projection received an `OK`
from all three relays and was then independently read back from all three:

- `wss://nos.lol`
- `wss://relay.primal.net`
- `wss://offchain.pub`

| Side | Size SAT | USD/BTC | Exact cents/SAT | Order ID | Maker public key | Transition ID | Projection ID | ACK | Readback |
|---|---:|---:|---:|---|---|---|---|---:|---:|
| Ask | 2,000 | 50,500.00 | `101/2000` | `seed-20260723-ask-50500-c2018189-10a8-4792-8e20-f264dcc308bb` | `b2b8c5194d9985355f13d7e60740f3de7a74e62eb237e418b455d1c0a817c708` | `d7c356c59e7e00567be8e9817d0c5b4a4dfb249593ebfcbe3fc52302f501a2bb` | `8e227344a23f8c68241728b7f8405b8a2cdf1e54b7acdcac0c3b6f49b96851b1` | 3/3 + 3/3 | 3/3 + 3/3 |
| Ask | 1,000 | 51,000.00 | `51/1000` | `seed-20260723-ask-51000-3e8084a3-232e-4296-9238-c48b8d4dfdbe` | `773a432031821d8a2ac3c7d644d7058407850e163440c429c2027984d331c7db` | `28979e8ae9ca1a061a89add537d6f2583b5d3137bd0d8fce6b69922815d13554` | `51cdad0b789c01a74def9c7a3fe7ce8f95635ffba2c77941d58bba4e67104453` | 3/3 + 3/3 | 3/3 + 3/3 |
| Ask | 1,000 | 52,000.00 | `13/250` | `seed-20260723-ask-52000-76e80857-c5de-48c1-8433-d5f8f8d37efc` | `6c9559a66b0f23ab2fe8bf99ead1f63ffcad0562d787c027f33a797e5f8a716d` | `1065604ff5c14c29b6be9722291235cf912291dad173a8de1865cbabe29e45e0` | `7c2a1e986f80b1bb7236647094fc1358afd83730ce9162d54eb6f33e9458aa45` | 3/3 + 3/3 | 3/3 + 3/3 |
| Bid | 2,000 | 49,500.00 | `99/2000` | `seed-20260723-bid-49500-8a67656e-44b3-4a84-bc48-3fd60e2edb62` | `66fcd86723a0ee3d3150ffd366e0dba7374862c15d28a5a063f2b2f275c8f6c2` | `bc423933ee6912bc359fac539ea034a33ee8ea1bdc806705d39ff63b9873994a` | `fc0deb5893649289d917775e94ef7025e0eb951e585d01a86e7751c8c27e4206` | 3/3 + 3/3 | 3/3 + 3/3 |
| Bid | 1,000 | 49,000.00 | `49/1000` | `seed-20260723-bid-49000-9e0559cb-16fc-427f-afaa-1da1ad59cf67` | `6c70938e96cb72a349640ed7dbd4e7b8a406ed85930f05bc1a41b4e949b771d9` | `606adef2f6824ed7a74dc202e6a50d8d396da99b19f153c5a63bab159c730d75` | `9680a3f832cf52a73adf3967566e00b196da9e2c19e2cd4e7c35e3cf02ea9abb` | 3/3 + 3/3 | 3/3 + 3/3 |
| Bid | 1,000 | 48,000.00 | `6/125` | `seed-20260723-bid-48000-cf3bf873-6a4e-45a4-a716-3b7f26976636` | `65f1774227e48af5f82a1096d80c517555466512e085476516075d8714de8532` | `9e2fd801fd9dab6a1bd3741bf5ed2501ba2007aaaf86380455b8d0bcdd9199c3` | `e5e3c84212f479bea7cf34db909bbddcbe75e42dbec77012c6def026231fffa9` | 3/3 + 3/3 | 3/3 + 3/3 |

`ACK` shows transition plus projection acknowledgements. `Readback` shows
transition plus projection retrieval. Relay acceptance proves replication, not
consensus or future retention.

The browser independently loaded these signed projections, recomputed the
issuer-pair market tag, and displayed a best ask of USD 50,500/BTC, best bid of
USD 49,500/BTC, and USD 1,000/BTC spread.

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
