use anchor_lang::prelude::*;

// ============================================================
// Global config — one per deployment
// ============================================================

#[account]
#[derive(InitSpace)]
pub struct CurveConfig {
    /// Admin who can update config
    pub admin: Pubkey,
    /// Treasury wallet that receives platform fees
    pub treasury: Pubkey,
    /// Creator fee in basis points (e.g. 140 = 1.4%)
    pub creator_fee_bps: u16,
    /// Platform fee in basis points (e.g. 60 = 0.6%)
    pub platform_fee_bps: u16,
    /// SOL amount (lamports) at which graduation triggers
    pub graduation_threshold: u64,
    /// Total supply for all tokens created (raw units, e.g. 1B * 10^9)
    pub total_supply: u64,
    /// Token decimals
    pub decimals: u8,
    /// Initial virtual SOL reserve (lamports)
    pub initial_virtual_sol: u64,
    /// Whether new token creation is paused
    pub paused: bool,
    /// Whether Raydium permission-based graduation is available.
    /// When true: uses `initialize_with_permission` (enables creator fees on Raydium).
    /// When false: uses standard `initialize` (no post-graduation creator fees).
    /// Admin toggles this after getting whitelisted by Raydium.
    pub raydium_permission_enabled: bool,
    /// Total tokens created through this config
    pub tokens_created: u64,
    /// Total tokens graduated to Raydium
    pub tokens_graduated: u64,
    /// Whether trading (buy/sell) is paused — emergency kill switch
    pub trading_paused: bool,
    /// Proposed new admin (two-step transfer). Pubkey::default() = no pending transfer.
    pub pending_admin: Pubkey,
    /// Bump seed for PDA
    pub bump: u8,
}

impl CurveConfig {
    pub const SEED: &'static [u8] = b"curve_config";

    pub fn total_fee_bps(&self) -> u16 {
        self.creator_fee_bps + self.platform_fee_bps
    }
}

// ============================================================
// Per-token bonding curve pool
// ============================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum PoolStatus {
    /// Trading on bonding curve
    Active,
    /// Graduated to Raydium — curve trading disabled
    Graduated,
}

#[account]
#[derive(InitSpace)]
pub struct CurvePool {
    /// The SPL token mint
    pub mint: Pubkey,
    /// Token creator
    pub creator: Pubkey,
    /// Current virtual SOL reserve (lamports) — includes initial virtual + real deposits
    pub virtual_sol_reserve: u64,
    /// Current virtual token reserve (raw units)
    pub virtual_token_reserve: u64,
    /// Real SOL deposited by buyers (lamports) — this is what accumulates toward graduation
    pub real_sol_balance: u64,
    /// Real tokens remaining in the pool (raw units)
    pub real_token_balance: u64,
    /// Total supply minted at creation
    pub total_supply: u64,
    /// Pool status
    pub status: PoolStatus,
    /// Creator fees accumulated (lamports)
    pub creator_fees_earned: u64,
    /// Creator fees already claimed (lamports)
    pub creator_fees_claimed: u64,
    /// Platform fees accumulated (lamports)
    pub platform_fees_earned: u64,
    /// Platform fees already claimed (lamports)
    pub platform_fees_claimed: u64,
    /// Dev buy tracking — SOL spent by creator
    pub dev_buy_sol: u64,
    /// Dev buy tracking — tokens received by creator
    pub dev_buy_tokens: u64,
    /// Timestamp of pool creation
    pub created_at: i64,
    /// Timestamp of graduation (0 if not graduated)
    pub graduated_at: i64,
    /// Raydium pool address after graduation
    pub raydium_pool: Pubkey,
    /// LP token mint from Raydium
    pub raydium_lp_mint: Pubkey,
    /// LP tokens locked (held by our program, not burned)
    pub lp_tokens_locked: u64,
    /// Raydium creator fees claimed (token 0 cumulative)
    pub raydium_fees_claimed_token_0: u64,
    /// Raydium creator fees claimed (SOL/WSOL cumulative)
    pub raydium_fees_claimed_token_1: u64,
    /// Total volume in SOL (lamports)
    pub total_volume_sol: u64,
    /// Total number of trades
    pub total_trades: u64,
    /// Token name (for reference)
    #[max_len(32)]
    pub name: String,
    /// Token symbol (for reference)
    #[max_len(10)]
    pub symbol: String,
    /// Metadata URI
    #[max_len(200)]
    pub uri: String,
    /// Bump for pool PDA
    pub bump: u8,
    /// Bump for sol vault PDA
    pub vault_bump: u8,
}

impl CurvePool {
    pub const SEED: &'static [u8] = b"curve_pool";
    pub const VAULT_SEED: &'static [u8] = b"sol_vault";
    pub const TOKEN_VAULT_SEED: &'static [u8] = b"token_vault";

    /// Constant product invariant k = virtual_sol * virtual_token
    pub fn invariant_k(&self) -> u128 {
        (self.virtual_sol_reserve as u128) * (self.virtual_token_reserve as u128)
    }

    /// Calculate tokens out for a given SOL input (after fees)
    pub fn calculate_buy(&self, sol_in: u64) -> Option<u64> {
        if sol_in == 0 || self.virtual_sol_reserve == 0 || self.virtual_token_reserve == 0 {
            return None;
        }
        let k = self.invariant_k();
        let new_virtual_sol = (self.virtual_sol_reserve as u128).checked_add(sol_in as u128)?;
        let new_virtual_token = k.checked_div(new_virtual_sol)?;
        let tokens_out = (self.virtual_token_reserve as u128).checked_sub(new_virtual_token)?;

        // Can't buy more than real tokens in pool
        if tokens_out > self.real_token_balance as u128 {
            return None;
        }

        Some(tokens_out as u64)
    }

    /// Calculate SOL out for a given token input (before fees)
    pub fn calculate_sell(&self, tokens_in: u64) -> Option<u64> {
        if tokens_in == 0 || self.virtual_sol_reserve == 0 || self.virtual_token_reserve == 0 {
            return None;
        }
        let k = self.invariant_k();
        let new_virtual_token = (self.virtual_token_reserve as u128).checked_add(tokens_in as u128)?;
        let new_virtual_sol = k.checked_div(new_virtual_token)?;
        let sol_out = (self.virtual_sol_reserve as u128).checked_sub(new_virtual_sol)?;

        // Can't withdraw more SOL than what's real
        if sol_out > self.real_sol_balance as u128 {
            return None;
        }

        Some(sol_out as u64)
    }

    /// Check if pool has reached graduation threshold
    pub fn should_graduate(&self, threshold: u64) -> bool {
        self.status == PoolStatus::Active && self.real_sol_balance >= threshold
    }

    pub fn is_active(&self) -> bool {
        self.status == PoolStatus::Active
    }
}
