# Prioritize atomic settlement (2026-09-06)

## Durable public outbox

The existing per-order outbox stores the latest complete signed projection. Financial
session journals remain responsible for the reservation, prepared mint operation,
inputs, outputs, encrypted messages and transcript. A pending reserve announcement
may be superseded by its exact signed fill/release successor, atomically in the same
outbox storage lock. The complete successor is sufficient for the public book; no
public receipt history or distributed reservation service is added.

Publishing does not hold the local successor queue during network I/O. Delayed ACKs
for an older projection cannot overwrite or acknowledge the newer durable head.
Restart republishes the exact latest signed artifact. The maker reads its durable
local head when staging a successor; a mismatching local revision is rejected.
A public projection with an equal/higher conflicting revision, a conflicting exact
predecessor, or a non-advancing timestamp prevents stale publication.

The atomic-swap protocol must still validate all mint operations, preserve proof
reservations and reconcile durable results before updating wallet balances. Public
announcements are not reservation consensus, mint settlement evidence, or custody.

Validation: a regression blocks reserve publication, stages/persists its exact fill
successor before releasing the network gate, recreates the outbox repository, then
verifies that the delayed reserve ACK cannot regress or falsely acknowledge the fill.

## Receiving and settling independently of announcements

New sessions communicate the staged inbox route inside their authenticated proposal
and acceptance. The receiver subscribes as soon as the receiving identity and route
exist; the order receiver subscribes before launching its discovery announcement.
Session inbox and reserve/fill artifacts are persisted first, then retried in the
background by the existing coordinator. Listing recovered sessions restarts pending
announcements, including for financially completed sessions. Legacy sessions without
communicated routes retain their discovery gates. Refund/release gates remain intact.

Only announcement receipt fields may change concurrently with financial checkpoints.
The coordinator still rejects changed financial state, action identity, or wallet
fingerprints. A delayed publisher cannot overwrite phase, proofs, or transcript.
Both wallets complete only after independent validated SPENT observations with the
required witness evidence for both legs. Public fill ACK is tracked separately.

Tests exercise buy/sell, one/two mints, pending proof observations, and both wallets
settling while public and discovery publication are disconnected. Recreated
coordinators then publish their durable announcements without changing settlement.
The live book also rejects a lower revision even if it arrives with a later timestamp.

Session identities remain separate from order authority (ADR 0003). The safe timing
`granola:session-keys` measures creation/derivation of the three independent session
keys separately from registration; no key material is included in diagnostics.

## Stale and competing proposals

The maker validates its persisted signed head locally before mint preflight; an
unavailable public book does not delay that check. The storage reservation lock
still chooses one active maker session per order. Rejected competing or stale
proposals receive an order-authority-signed, encrypted, session/transcript-bound
`error` carrying the current signed projection and `preparing` or `changed`.
The receiver validates that projection's signature, address, maker and revision;
an authenticated refusal terminates the attempted negotiation before spending.
The verified projection updates the local book head, which does not regress to
older revisions delivered later. A retry is a new attempt against the new head.

The existing order outbox also persists exact encrypted refusals, bounded to 100
short-lived attempts. Repeated delivery of a proposal reuses its reply. Startup
resumes unacknowledged replies; ACK cannot acknowledge a different wrapper. These
messages contain no bearer material. The order's signed public head can remain
open while the separate authenticated availability says `preparing`; the local
reservation is the exclusivity mechanism, not the timelock or public timestamp.
