# Protocol schemas

These JSON Schemas are partial structural descriptions of v1 wire objects.
Runtime validation remains authoritative for exact message bodies, allowed types,
cryptographic, cross-field, and stateful checks; schema validation alone is
insufficient.

- [`order-v1.json`](order-v1.json) — public kind `30078` projection content.
- [`atomic-swap-message-v1.json`](atomic-swap-message-v1.json) — common private
  message envelope only. `type` is currently an unrestricted string and `body`
  and `terms` are generic objects; the schema does not validate body dispatch.
  Use `validateAtomicSwapMessage` for the exact runtime body rules.
