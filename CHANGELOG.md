# Changelog

## Unreleased

- Updated ADRs and guides to match the current runtime, shortened duplicate
  transport/coordinator documentation, and corrected SDK/schema limitations.
- Removed the redundant public order `expires_at` tag; the standard `expiration`
  tag remains bound to the signed body's deadline. This PoC wire change requires
  updating older readers that require both tags.
- Consolidated performance decisions and aligned the protocol reference with
  the three-message flow, direct routes, asynchronous announcements and current deadlines.
- Added protocol specification v0.1 as the implementer-facing contract.
- Added a public TypeScript SDK entry point and browser facade type.
- Added initial schemas, safe pricing vector, examples, security policy, and
  contribution guidance.
