# Agent Dividends Program — SKILL.md

## Program ID
- Devnet/Localnet: **NOT YET DEPLOYED** — placeholder `111...` in declare_id
- Mainnet: **NOT DEPLOYED**

## Overview

Anchor 0.31.1 program implementing a 3-mode dividend system for AI agent tokens:

- **Regular** — Creator keeps 100% of fees (default)
- **Dividend** — Creator fees flow to staking rewards pool (Synthetix reward-per-token math)
- **Buyback & Burn** — Creator fees buy tokens off curve/Raydium and burn them (deflationary)

Creator picks one mode per token. 7-day cooldown between mode switches. Works pre and post graduation (revenue is deposited by crank, chain-agnostic).

---

## Revenue Sources

- **50%** of agent job completion payments (from agentic_commerce escrow)
- **0.5%** of creator trading fees (~35.7% of the 1.4% creator fee on bonding curve)
- Revenue deposited as SOL by admin/crank via `deposit_revenue` instruction

---

## Instructions (9 total)

| Instruction | Who | What |
|---|---|---|
| `initialize_dividend_config` | Admin (once) | Global config: revenue share percentages |
| `create_token_dividend` | Creator | Enable dividends for a token, pick initial mode |
| `set_dividend_mode` | Creator | Switch between Regular/Dividend/BuybackBurn (7-day cooldown) |
| `deposit_revenue` | Admin/crank | Deposit SOL — routes by mode (rejected in Regular) |
| `stake` | User | Stake tokens into vault (Dividend mode only) |
| `unstake` | User | Unstake + auto-claim pending rewards (any mode) |
| `claim_rewards` | User | Claim accumulated SOL rewards (any mode) |
| `execute_buyback` | Anyone (crank) | Record off-chain buyback, burn tokens on-chain |
| `update_dividend_config` | Admin | Update global config params |

---

## State Accounts

### DividendConfig (Global — 1 per deployment)
```
Seeds: ["dividend_config"]
Fields: admin, job_revenue_share_bps, creator_fee_share_bps, bump
```

### TokenDividend (Per agent token)
```
Seeds: ["token_dividend", mint]
Fields: mint, creator, mode, last_mode_change,
        total_staked, reward_per_token_stored, total_staking_revenue, total_rewards_distributed,
        buyback_balance, total_burned, total_buyback_sol_spent, burn_count,
        total_revenue_deposited, created_at, bump
```

### StakePosition (Per user per token)
```
Seeds: ["stake_position", mint, owner]
Fields: owner, mint, amount, reward_debt, rewards_claimed, staked_at, bump
```

---

## PDA Seeds

| Account | Seeds |
|---|---|
| DividendConfig | `["dividend_config"]` |
| TokenDividend | `["token_dividend", mint.as_ref()]` |
| StakePosition | `["stake_position", mint.as_ref(), owner.as_ref()]` |
| Staking Vault | `["staking_vault", mint.as_ref()]` |
| Dividend SOL Vault | `["dividend_vault", mint.as_ref()]` |
| Buyback SOL Vault | `["buyback_vault", mint.as_ref()]` |

---

## Events

- `RevenueDeposited { mint, amount, mode }`
- `Staked { user, mint, amount, total_staked }`
- `Unstaked { user, mint, amount, total_staked }`
- `RewardsClaimed { user, mint, amount }`
- `BuybackExecuted { mint, sol_spent, tokens_burned, total_burned }`
- `ModeChanged { mint, old_mode, new_mode }`

---

## Errors

- `Unauthorized` — Not admin or not token creator
- `SelfReferral` — (inherited, unused here)
- `ReferralsDisabled` — (inherited, unused here)
- `InvalidMode` — Can't deposit in Regular mode
- `StakingNotActive` — Can't stake when mode != Dividend
- `ZeroAmount` — Amount must be > 0
- `InsufficientStake` — Unstaking more than staked
- `NoRewardsToClaim` — Nothing to claim
- `CooldownNotElapsed` — 7-day mode switch cooldown active
- `NoBuybackBalance` — No SOL in buyback vault
- `InvalidFeeConfig` — Fee bps > 10000

---

## Staking Math (Synthetix Pattern)

```
reward_per_token = reward_per_token_stored + (new_revenue * 1e18 / total_staked)
pending_reward = (user_staked * (reward_per_token - user_reward_debt)) / 1e18
```

O(1) distribution — no iteration over stakers. Auto-claim on stake/unstake ensures users never lose pending rewards.

---

## Security

- `solana-security-txt` included (email, source code, policy links)
- All math uses checked operations (checked_mul, checked_div, checked_add, checked_sub)
- Users can always unstake/claim regardless of mode changes
- Mode switch has 7-day enforced cooldown
- Admin-only deposit prevents unauthorized fund injection
- Buyback execution is permissionless (anyone can crank) but only burns tokens already in the vault

---

## Dependencies

- `anchor-lang` 0.31.1 (with init-if-needed)
- `anchor-spl` 0.31.1
- `solana-security-txt` 1.1.2
