# Bonding Curve Program — SKILL.md

## Program ID
- Devnet/Localnet: `nFc4nPJ2j68QS1pU15XFV2K2k6u7EifuPYpC1nHxuof`
- Mainnet: **NOT DEPLOYED** — generate fresh keypair before mainnet

## Overview

Anchor program implementing a pump.fun-style bonding curve launchpad with:
- SPL token creation + Metaplex metadata
- Constant-product AMM (virtual reserves)
- 2% trade fee split (1.4% creator / 0.6% platform)
- Graduation to Raydium CPMM at 85 SOL threshold
- Dual-path graduation (permission vs standard)
- Excess token burn at graduation (pump.fun style — price continuity)
- LP token burning (permanent, irrecoverable liquidity)

---

## CurvePool Struct (IMPORTANT — struct size is 537 bytes)

```rust
pub struct CurvePool {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub virtual_sol_reserve: u64,
    pub virtual_token_reserve: u64,
    pub real_sol_balance: u64,
    pub real_token_balance: u64,
    pub total_supply: u64,
    pub status: PoolStatus,          // Active | Graduated
    pub creator_fees_earned: u64,
    pub creator_fees_claimed: u64,
    pub platform_fees_earned: u64,
    pub platform_fees_claimed: u64,
    pub dev_buy_sol: u64,
    pub dev_buy_tokens: u64,
    pub created_at: i64,
    pub graduated_at: i64,
    pub raydium_pool: Pubkey,
    pub raydium_lp_mint: Pubkey,
    pub lp_tokens_locked: u64,
    pub raydium_fees_claimed_token_0: u64,
    pub raydium_fees_claimed_token_1: u64,
    pub total_volume_sol: u64,
    pub total_trades: u64,           // Use this, NOT total_buys/total_sells
    pub name: String,                // #[max_len(32)]
    pub symbol: String,              // #[max_len(10)]
    pub uri: String,                 // #[max_len(200)]
    pub bump: u8,
    pub vault_bump: u8,
}
```

### ⚠️ `total_buys` and `total_sells` REMOVED

These two `u64` fields were removed from `CurvePool` because:
- They caused **OOM (out-of-memory) stack overflow** during deserialization on existing devnet pools
- The account size was exceeding what the Solana runtime could handle during `Account<CurvePool>` deserialization
- **Fix:** removing them dropped the struct to 537 bytes and resolved the OOM
- **Do NOT re-add them** — if you need trade counts, use `total_trades` (aggregate) or track in the DB

### ⚠️ No custom heap allocator

A custom heap allocator (`#[global_allocator]`) was added during debugging but then **REMOVED** — it was not needed after the struct size fix. Do not add one; the default Solana allocator is sufficient.

---

## Instructions

### `initialize`
Sets up global `CurveConfig` (admin, treasury, fee bps, graduation threshold, virtual SOL reserve).

### `create_token`
- Mints 1B SPL tokens, stores Metaplex metadata (name, symbol, image URI, attributes)
- Revokes mint authority + freeze authority immediately
- Creates `CurvePool` with initial virtual reserves
- **All 1B tokens go on the bonding curve** — no upfront reserve (burn-at-graduation model)

### `buy`
- Constant-product calculation: `tokens_out = virtual_token - k / (virtual_sol + sol_in_after_fee)`
- Fee taken from `sol_in`: 1.4% to `creator_fees_earned`, 0.6% to `platform_fees_earned`
- Updates `real_sol_balance`, `real_token_balance`, `virtual_sol_reserve`, `virtual_token_reserve`
- Auto-triggers graduation check (calls `should_graduate`)

### `sell`
- Constant-product calculation: `sol_out = virtual_sol - k / (virtual_token + tokens_in)`
- Fee taken from `sol_out`
- Requires `sol_out <= real_sol_balance`

### `graduate`
See dual-path section below.

### `claim_creator_fees`
- Creator claims accumulated `creator_fees_earned - creator_fees_claimed` from SOL vault
- Permissionless after graduation for any remaining pre-grad fees

### `claim_platform_fees`
- Treasury claims platform fees

### `claim_raydium_fees`
- Path A only: claims Raydium CPMM creator fees (50/50 split)
- Reads LP token balance manually via SPL token deserialization

### `update_config`
- Admin: update fee bps, graduation threshold, pause state, `raydium_permission_enabled`

---

## Dual-Path Graduation (`graduate.rs`)

The `graduate` instruction supports two paths controlled by `config.raydium_permission_enabled`:

### Path A — `initialize_with_permission` (creator fees enabled)
```
config.raydium_permission_enabled = true
```
- Uses Raydium's `initialize_with_permission` CPI
- Our pool PDA becomes `pool_creator` on Raydium
- Enables creator fee collection on **all post-graduation Raydium trades**
- Requires: Raydium Permission PDA for our pool PDA address (admin must apply to Raydium)
- `claim_raydium_fees` instruction available to claim these fees

### Path B — Standard `initialize` (fallback, no creator fees)
```
config.raydium_permission_enabled = false
```
- Uses standard Raydium `initialize` CPI
- No Permission PDA needed — works immediately on devnet/mainnet
- No post-graduation creator fee privileges
- Revenue comes from pre-graduation bonding curve fees only

Both paths:
- Excess tokens burned (see "Graduation Amounts" section)
- LP tokens **burned** permanently — liquidity is irrecoverable (stronger than locking)
- Pool marked as `PoolStatus::Graduated`
- Permissionless trigger (anyone can call once threshold met)
- Emits `PoolGraduated` event

### WSOL Wrapping in `graduate.rs`

**Correct approach (current):**
```rust
// 1. Transfer SOL from sol_vault PDA → pool's WSOL ATA
invoke_signed(
    &system_instruction::transfer(sol_vault_key, wsol_ata_key, sol_for_raydium),
    &[sol_vault, wsol_ata, system_program],
    &[vault_seeds],
)?;

// 2. SyncNative so SPL token balance matches
token::sync_native(CpiContext::new(token_program, SyncNative { account: wsol_ata }))?;
```

**Why this matters:** Raydium reads SPL token balances, not lamports directly. You must:
1. Create a proper WSOL ATA (`init_if_needed` on `wsol_ata` with `associated_token::mint = wsol_mint`)
2. Transfer SOL into it via `SystemProgram.transfer`
3. Call `sync_native` to materialize the WSOL balance

The old approach (lamport placeholder) did NOT work — Raydium would see 0 WSOL and fail.

### LP Token Tracking (manual deserialization)

After the Raydium CPI, LP tokens land in `lp_token_account`. We read the balance without using Anchor's typed account because the account doesn't exist before the CPI:

```rust
let lp_amount = {
    let lp_data = ctx.accounts.lp_token_account.try_borrow_data()?;
    if lp_data.len() >= 72 {
        // SPL Token account layout: [0..32] mint, [32..64] owner, [64..72] amount (u64 LE)
        u64::from_le_bytes(lp_data[64..72].try_into().unwrap())
    } else {
        0
    }
};
pool.lp_tokens_locked = lp_amount;
```

This avoids needing to mark `lp_token_account` as `Account<TokenAccount>` before the CPI creates it.

---

## Graduation Amounts (Burn Excess Model)

At graduation, remaining tokens are split — some go to Raydium, the rest are burned:

```rust
let remaining = pool.real_token_balance;
let real_sol = pool.real_sol_balance;  // 85 SOL (graduation threshold)
let virtual_sol = config.initial_virtual_sol;  // 30 SOL

// Split remaining tokens proportionally
let tokens_for_raydium = remaining * real_sol / (real_sol + virtual_sol);  // ~73.9%
let tokens_to_burn = remaining - tokens_for_raydium;                       // ~26.1%

let sol_for_raydium = net_sol;  // real_sol_balance - unclaimed fees
```

The burned tokens account for the "phantom value" of the virtual SOL reserve.
This ensures the Raydium pool opens at the exact same price as the bonding curve's final price.

LP tokens are also **burned** (not locked) — permanent, irrecoverable liquidity.

Unclaimed fees stay in the `sol_vault` for creator/platform to claim post-graduation:
```rust
pool.real_sol_balance = total_unclaimed_fees;  // Only fees remain after graduation
pool.real_token_balance = 0;
```

---

## Raydium CPI Module (`raydium_cpi.rs`)

Builds raw instructions for:
- `initialize` — standard pool creation
- `initialize_with_permission` — permission-gated pool creation
- `swap_base_input` — swap (used post-grad by API, not on-chain)

All discriminators computed via `sha256("global:<instruction_name>")[..8]`.

```rust
pub const RAYDIUM_CPMM_PROGRAM: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"); // mainnet
// Devnet: DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb
```

---

## Anchor.toml — Mainnet IDs Separated

```toml
[programs.devnet]
agentic_commerce = "Ddpj5GCjz8jFuBQXopUfzxkAmkWPCCwC7mhpL6SY9fdx"
bonding_curve = "nFc4nPJ2j68QS1pU15XFV2K2k6u7EifuPYpC1nHxuof"

[programs.mainnet]
# PLACEHOLDER — generate fresh keypairs before mainnet deployment:
# solana-keygen new -o target/deploy/bonding_curve-mainnet-keypair.json
agentic_commerce = "11111111111111111111111111111111"
bonding_curve = "11111111111111111111111111111111"
```

Never use the devnet program ID for mainnet. The `declare_id!()` in `lib.rs` must match the deployed keypair.

---

## Constant-Product AMM Details

Initial state at pool creation:
- `virtual_sol_reserve` = `initial_virtual_sol` (e.g., 30 SOL in lamports)
- `virtual_token_reserve` = total supply (1B tokens)
- `real_sol_balance` = 0
- `real_token_balance` = 1B (all tokens on curve — no reserve)

Invariant: `k = virtual_sol × virtual_token` (constant product)

Price at any moment: `price_sol = virtual_sol_reserve / virtual_token_reserve`

Starting price (30 SOL / 1B tokens ≈ 0.00000003 SOL per token ≈ $0.000003 at $100 SOL).

---

## PDAs

| Account | Seeds |
|---------|-------|
| `CurveConfig` | `["curve_config"]` |
| `CurvePool` | `["curve_pool", mint.key()]` |
| SOL vault | `["sol_vault", pool.key()]` |
| Token vault | `["token_vault", pool.key()]` |

---

## Error Codes (`errors.rs`)

- `AlreadyGraduated` — pool is already graduated
- `NotReadyToGraduate` — `real_sol_balance < graduation_threshold`
- `MathOverflow` — arithmetic overflow
- `InsufficientTokens` — pool doesn't have enough tokens for buy
- `InsufficientSol` — pool doesn't have enough SOL for sell
- `Paused` — `config.paused = true`

---

## Known Issues / Lessons Learned

1. **OOM on CurvePool deserialization** — caused by having too many fields. Removed `total_buys` + `total_sells` to fix. Current 537-byte size is safe.
2. **WSOL wrapping** — must use proper ATA + `sync_native`. Lamport manipulation without `sync_native` doesn't update SPL balance.
3. **LP token balance** — read via raw data slice `[64..72]` after Raydium CPI creates the account. Can't use `Account<TokenAccount>` before the CPI.
4. **Custom heap allocator** — was added, then removed. Not needed; causes more problems than it solves.
5. **Mainnet program IDs** — the `[programs.mainnet]` section has placeholder IDs. Do not deploy without fresh keypairs.
