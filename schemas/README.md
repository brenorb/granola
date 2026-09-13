# Protocol schemas

These JSON Schemas describe the committed v1 wire objects. Runtime validation
in the SDK remains authoritative for cryptographic, cross-field, and stateful
checks; schema validation alone is insufficient.

- [`order-v1.json`](order-v1.json) — public kind `30078` projection content.
- [`atomic-swap-message-v1.json`](atomic-swap-message-v1.json) — common private
  message envelope and exact body dispatch boundary.
