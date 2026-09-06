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
