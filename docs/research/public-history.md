# Public history and academic follow-up

Research performed on 2026-07-23 across Breno Brito's public site, its sitemap
and full-text index, the linked pitch material, and the linked 2025 thesis.

## What Granola was

The [Granola project page](https://brenorb.com/granola/) describes a Cashu-based
exchange concept built by Breno Brito and Luis Schwab during Vinteum's SatsHack
in October 2024 and pitched at Satsconf 2024. Public project archives record it
as third place overall and Best Nostr.

The motivating problem was private Bitcoin on/off-ramp and asset exchange
without a centralized custodial venue. The proposed split was:

- Nostr for public order discovery and private peer coordination;
- Cashu mints as asset- or currency-specific issuers;
- a shared hash/preimage across two locked ecash transfers for settlement;
- fresh Nostr keys during a trade to reduce identity linkage.

The design was explicitly multi-mint and multi-currency rather than BTC-only.
It removes custody and matching from an exchange operator, but it does not
remove the user's trust in each mint.

## “Without an order book”

The page cites Cashu contributor Calle describing Granola as an exchange
without an order book, while both the recovered diagram and pitch demo publish
and display orders. The consistent interpretation is **without a centralized
exchange-operated matching engine or custodial book**, not without publicly
discoverable orders. The new design must use that distinction consistently.

## Historical sequence

The public page presents this flow:

1. Alice creates an ephemeral Nostr key and publishes an order.
2. Carol discovers it, creates an ephemeral key, and sends a pay request by DM.
3. Alice creates `HTLC_c`, locked to hash `H`.
4. Carol verifies it and creates `HTLC_a` with the same hash.
5. Carol watches `HTLC_a`; Alice spends it and thereby reveals the preimage.
6. Carol observes that preimage and spends `HTLC_c`.

The diagram labels discovery as kind `8338`, but neither the page nor the vault
ties that kind to an adopted NIP. The notation also collapses two mints into one
actor. See the [interpretive expansion](../protocol/original-granola-sequence.md)
for the assumptions that still need proof.

## Academic follow-up

Hugo Szerwinski's 2025 University of Brasilia thesis,
[*Protocolo de Swap Atômico Entre Mints de Cashu*](https://brenorb.com/assets/docs/granola-cashu-thesis-2025.pdf),
states in its motivation that Granola inspired the work, then deliberately
replaces the original HTLC sketch with a Schnorr adaptor-signature construction
over Cashu P2PK conditions.

Thesis §§3–4 specify and exercise that construction: a refund locktime, mint
DLEQ material, an additional Schnorr linkage proof, NUT-03 settlement, and
NUT-07 state/witness observation. That is the thesis implementation's chosen
construction; it is not evidence that arbitrary deployed mints support it.

Thesis §5.2.1 identifies a validation gap: the observed NUT-07 state alone does
not prove the agreed amount or provenance of a received proof. The prototype
therefore exchanges extra mint material and a linkage proof. Thesis §1.2
explicitly excludes Nostr/API communication, Internet-scale latency and fault
tolerance, mint operational security and malicious-mint behavior, large-scale
testing, and a security audit of the cryptographic implementation.

The thesis is therefore evidence that controlled inter-mint settlement is worth
pursuing, not proof of production safety or deployment interoperability.

Public companion implementations are available as
[Cashu-Alice](https://github.com/szerwinski/Cashu-Alice) and
[Cashu-Bob](https://github.com/szerwinski/Cashu-Bob).

## Source quality notes

- The project page displays 2024-11-06 but includes later event results and the
  2025 thesis; its content is retrospective and should not all be dated to the
  displayed publication date.
- The embedded pitch transcription is explicitly experimental and has obvious
  recognition errors. It is useful only for broad intent: multiple asset mints,
  an exchange-like order UI, and possible future liquidity pools/AMMs.
- The public material contains no NIP-69/NIP-78 analysis, normative order schema,
  DM comparison, lifecycle semantics, or verified production atomic trade.
  Those are new decisions and must not be attributed to the 2024 design.

## Public sources

- [Granola project page](https://brenorb.com/granola/)
- [Breno's project archive](https://brenorb.com/projects/)
- [Original Granola repository](https://github.com/GranolaCash/granola)
- [Pitch video](https://www.youtube.com/watch?v=Lq_zZx2cBXk)
- [Szerwinski thesis](https://brenorb.com/assets/docs/granola-cashu-thesis-2025.pdf)
- [No Bullshit Bitcoin event coverage](https://www.nobsbitcoin.com/gm-2024-11-22/)
