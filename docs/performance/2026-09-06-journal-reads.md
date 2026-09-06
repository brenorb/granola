# Trade journal read reduction — 2026-09-06

The coordinator used to reload the same session immediately after a successful
save. A local action reloaded once only to start durable announcements; an
external action reloaded once only to start announcements after merging its
result. The announcement worker also reloaded once after each successful
background save before checking whether it should stop.

The coordinator now carries the validated session returned by the local or
external commit through announcement scheduling. The announcement worker uses
the session returned by its lock-protected save and reloads only after an
effect or save fails, when the durable state may have changed independently.

Controlled coordinator tests count `CoordinatorSessionRepository.get` calls:

| Path | Before | After |
| --- | ---: | ---: |
| Local journal transition | 2 | 1 |
| External journal transition and merge | 3 | 2 |

These counts cover repository reads in the deterministic test driver. They do
not claim a fixed IndexedDB operation or decryption count because the storage
driver can change its key and ciphertext reads, and no live browser profile was
rerun for this small coordinator change.

The existing CAS save, session lock, conflict fingerprinting, durable
announcement retry, and restart behavior remain in place. The carried value is
used only to schedule or inspect the next announcement; every write still
reloads the current journal under the shared lock and validates its revision.
