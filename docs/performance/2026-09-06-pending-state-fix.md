# Pending mint-state fix

## Confirmed defect

The old observation code treated every batch other than all-UNSPENT as spent.
A valid NUT-07 PENDING response therefore reached `extractSpentPreimage`, which
correctly rejected it with `proof-not-spent`. A regression using a correctly
bound UNSPENT/PENDING batch reproduced that exact exception before the fix.

[NUT-07](https://github.com/cashubtc/nuts/blob/main/07.md) defines PENDING as an
in-flight transaction, distinct from both UNSPENT and SPENT.

Both observation entry points now use `observeHtlcStates`. It validates the
proof/state mapping and state enums, returns PENDING if any proof is pending,
and never exposes a preimage in that case. Existing persisted PENDING state and
coordinator behavior continue observing the mint. Incoming-lock acceptance still
requires every proof to be UNSPENT. Spending witnesses still require every proof
to be SPENT and the expected hash to match. A mixed UNSPENT/SPENT batch without
PENDING still fails closed, as do missing witnesses and malformed state mappings.

## Evidence and limits

- The new client regression failed on the old code with `proof-not-spent` and
  passes after the change, including the transition from PENDING to verified SPENT.
- Tests cover PENDING with UNSPENT, SPENT, and another PENDING proof. Both buy and
  sell integration flows complete after three pending observations, without
  entering recovery or requiring a user retry.
- Full suite: 392 passed, 7 skipped. Build passed.
- Three diagnostic live swaps on the old behavior completed automatically.
  They used two 20 SAT swaps and one 200 SAT swap; the intermittent exception did
  not reproduce. A first fresh-wallet 20 SAT swap on the fixed behavior also
  completed automatically, with 9,978 SAT + USD 0.01 in the first wallet and
  20 SAT + USD 99.99 in the second.
- Temporary local diagnostics counted only state enums, never proof identifiers
  or witnesses. That fixed live run observed all-UNSPENT and all-SPENT batches;
  it did not observe a pending batch. The historical response vector from the
  two interrupted swaps was not captured and cannot be reconstructed from the UI.

Thus the PENDING handling bug and its correction are demonstrated directly;
attributing the earlier live incidents specifically to PENDING remains unproven.
Do not describe synthetic evidence as a captured historical mint response.

The temporary browser state-count diagnostics are not part of the shipped code.
