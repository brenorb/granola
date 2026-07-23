# Order projection publication trace — 2026-07-23

This trace describes the current projection-only publication check. Earlier
results from the superseded publication design are intentionally not protocol
evidence.

## Protocol under test

- Event: parameterized replaceable kind `30078`
- Address: `30078:<maker>:granola:order:v1:<order-id>`
- Payload: complete canonical `granola/order/v1` state
- Required acknowledgement: one configured public relay
- Retry rule: persist before publish and resend the exact signed event

## Automated evidence

The order event, service, outbox, and API tests demonstrate:

1. create signs exactly one projection;
2. reserve, fill, release, cancel, and expire retain the same `d` tag and
   increment revision;
3. a stale event ID or revision is rejected before signing;
4. the signed projection is durably stored before relay publication;
5. a failed publication retries the same event ID;
6. one successful relay receipt acknowledges the update; and
7. book loading selects and verifies the current replaceable event without
   reconstructing public history.

The two-party integration test additionally demonstrates that reserve and fill
checkpoints bind private messages to projection IDs and revisions while local
settlement and refund evidence remains durable.

## Live evidence

Record a new live trace only after running the current build against configured
test relays. A safe trace may include:

- UTC time and deployed commit;
- order ID;
- maker public key;
- projection event ID and revision;
- canonical relay URL and acknowledgement message; and
- exact readback event ID.

Do not include maker secret keys, private messages, Cashu tokens, proofs,
preimages, witnesses, mint quote IDs, or wallet backups.
