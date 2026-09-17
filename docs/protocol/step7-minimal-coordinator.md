# Coordinator documentation

The initial “Step 7” demonstration plan is superseded. It described a sell-only
flow gated on public announcements; those are not current implementation limits.

Use the [protocol specification](../protocol%20spec%20v0.1.md) for the three-message
swap, deadlines, checkpoints and recovery, and
[asynchronous settlement](async-settlement.md) for direct routes, durable
announcements, stale-proposal responses and cross-tab serialization.

The implementation supports buy/sell and one/two-mint swaps. Each coordinator
action preserves its durable financial checkpoint; verified mint observations
determine completion independently of public announcement latency.
