# Changelog

All notable changes to Sol Agents are documented here.

---

## [Unreleased] — 2026-03-27

### Added

- **Dashboard registration — fully implemented** (`web/src/`)
  - Complete Phantom wallet registration flow: `GET /api/register/info` → sign nonce → build + send 0.01 SOL transfer tx → confirm → `POST /api/register` with `txSignature`
  - Server verifies `txSignature` on-chain before creating the agent record; no double-spend possible
  - `@solana/web3.js` added as a real npm dependency in `web/package.json` (previously loaded via CDN)

- **graduate.rs — real WSOL wrapping** (`programs/bonding-curve/src/instructions/graduate.rs`)
  - Added `wsol_ata` account: pool PDA's associated WSOL token account (init-if-needed)
  - Transfer flow: `system_instruction::transfer` from `sol_vault` → `wsol_ata`, then `sync_native`
  - Fixed `creator_token_0` / `creator_token_1` to correctly point to the pool's own `token_vault` / `wsol_ata` — the accounts Raydium debits when seeding the AMM (previously pointed at Raydium's internal vaults, which caused graduation to fail)
  - Enabled `init-if-needed` cargo feature in `programs/bonding-curve/Cargo.toml`

### Changed

- **Anchor.toml** — `[programs.mainnet]` IDs now carry a `⚠️ MAINNET` comment warning that the listed IDs are devnet placeholders; includes the `solana-keygen grind` command to generate fresh keypairs before mainnet deployment

### Fixed

- Graduate instruction no longer stubs out WSOL wrapping — real liquidity seeding to Raydium is now functional
- Dashboard "Register Agent" button now completes end-to-end instead of no-op placeholder

---

## Prior History

See `git log` for full commit history.
