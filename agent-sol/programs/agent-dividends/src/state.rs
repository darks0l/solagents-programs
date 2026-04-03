use anchor_lang::prelude::*;

// ── Enums ──────────────────────────────────────────────────────────────

/// Three mutually exclusive dividend modes a creator can choose.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum DividendMode {
    /// Creator keeps 100% of their fees. Default.
    Regular,
    /// Creator fees flow to staking rewards — holders stake to earn SOL.
    Dividend,
    /// Creator fees buy tokens off the curve and burn them — passive deflation.
    BuybackBurn,
}

// ── Accounts ───────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct DividendConfig {
    /// Admin that can deposit revenue & update config.
    pub admin: Pubkey,
    /// Share of job revenue routed to dividends (bps, e.g. 5000 = 50%).
    pub job_revenue_share_bps: u16,
    /// Share of creator trading fees routed to dividends (bps).
    pub creator_fee_share_bps: u16,
    /// PDA bump.
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct TokenDividend {
    /// The agent-token mint this dividend belongs to.
    pub mint: Pubkey,
    /// Creator of the agent token (matches bonding-curve pool creator).
    pub creator: Pubkey,

    // ── Mode ───────────────────────────────────────────────────────────
    /// Current dividend mode: Regular, Dividend, or BuybackBurn.
    pub mode: DividendMode,
    /// Timestamp of last mode change (enforce 7-day cooldown).
    pub last_mode_change: i64,

    // ── Staking state (active when mode == Dividend) ───────────────────
    /// Total agent tokens currently staked.
    pub total_staked: u64,
    /// Accumulated reward per staked token, scaled by 1e18.
    pub reward_per_token_stored: u128,
    /// Lifetime SOL deposited to staking rewards.
    pub total_staking_revenue: u64,
    /// Lifetime SOL distributed (claimed) by stakers.
    pub total_rewards_distributed: u64,

    // ── Buyback state (active when mode == BuybackBurn) ────────────────
    /// SOL sitting in the buyback vault awaiting execution.
    pub buyback_balance: u64,
    /// Lifetime tokens burned via buyback.
    pub total_burned: u64,
    /// Lifetime SOL spent on buybacks.
    pub total_buyback_sol_spent: u64,
    /// Number of buyback executions.
    pub burn_count: u64,

    // ── Meta ────────────────────────────────────────────────────────────
    /// Lifetime SOL deposited (across all modes, excluding Regular).
    pub total_revenue_deposited: u64,
    /// Unix timestamp when this dividend was created.
    pub created_at: i64,
    /// PDA bump.
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct StakePosition {
    /// Staker's wallet.
    pub owner: Pubkey,
    /// Agent-token mint.
    pub mint: Pubkey,
    /// Amount currently staked.
    pub amount: u64,
    /// Snapshot of reward_per_token_stored at last stake/claim action.
    pub reward_debt: u128,
    /// Lifetime SOL claimed by this staker.
    pub rewards_claimed: u64,
    /// Unix timestamp of first stake.
    pub staked_at: i64,
    /// PDA bump.
    pub bump: u8,
}

// ── Events ─────────────────────────────────────────────────────────────

#[event]
pub struct RevenueDeposited {
    pub mint: Pubkey,
    pub amount: u64,
    pub mode: DividendMode,
}

#[event]
pub struct Staked {
    pub user: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

#[event]
pub struct Unstaked {
    pub user: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

#[event]
pub struct RewardsClaimed {
    pub user: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BuybackExecuted {
    pub mint: Pubkey,
    pub sol_spent: u64,
    pub tokens_burned: u64,
    pub total_burned: u64,
}

#[event]
pub struct ModeChanged {
    pub mint: Pubkey,
    pub old_mode: DividendMode,
    pub new_mode: DividendMode,
}
