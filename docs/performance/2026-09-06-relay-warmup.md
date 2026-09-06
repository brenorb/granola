# Relay connections prepared while browsing

## Change

Page startup already initializes the trade runtime while loading the order book and
existing sessions. The runtime now starts two unauthenticated WebSocket connections
per configured WSS relay and loads its public NIP-11 capabilities in the background.
The existing public order-book pool continues to reuse its own connections.

The inbox adapter consumes each prepared connection once, authenticates it with the
current operation's key, and closes it after the operation/subscription. A used socket
is never returned to the spare queue. No reservation keys or messages are created
by warmup. This retains identity isolation; unauthenticated does not mean IP-anonymous.

Consumed spares are replenished without awaiting them. Idle failed/closed spares are
checked every 30 seconds; configuration is bounded to five remote relays and two
spares each. The default configuration has four WSS endpoints (eight spares per
page). Pagehide disposes spares and timers, including late connection completions.
The optional localhost mesh is not preconnected.

A missing, failed or closed spare falls back to a fresh connection. An expired AUTH
challenge on a prepared socket retries once on a fresh connection before publication.
ACK, validated readback, per-reservation identities and all financial verification
requirements are unchanged. Mint proof subscriptions and their connections are not
part of this relay warmup.

## Validation

TypeScript and the full suite passed: 421 tests passed, 7 skipped. Regressions cover
no publication/AUTH during preparation, identity isolation, non-blocking refill,
late completion cleanup, disposal, bounded idle retry, stale sockets, cached optional
AUTH challenges and expired-challenge fallback. Performance diagnostics whitelist
only the acquisition outcome and timing, never AUTH data or keys.

## Measurement method

The real Testnut browser profile waits 20 seconds after both pages reload before
publishing each order. The taker remains open and receives the order before taking
it. The clock for the swap still starts at the take click and ends at the later
Filled mark; no measured time is subtracted to manufacture a handshake-free result.

`granola:relay-connect` measures how long an operation waits to acquire its transport
(warm, warming, cold or failed), before AUTH. CDP also records raw socket handshakes.
Background refill handshakes may occur during the trade without blocking it, so their
union must not be reported as delay added to the swap. AUTH and relay response waits
remain separate, necessary network operations. A stale connection can still require
a foreground reconnect; the measurements must disclose it if it happens.
