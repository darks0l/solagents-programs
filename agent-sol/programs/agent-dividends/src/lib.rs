use anchor_lang::prelude::*;
use solana_security_txt::security_txt;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::DividendMode;

declare_id!("Hi5XCC3PvGXYwhELRL7r5BdWRhdaFNKqXBbw7oS3EoWY");

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "SolAgents Agent Dividends",
    project_url: "https://solagents.dev",
    contacts: "email:darksol@agentmail.to,link:https://solagents.dev",
    policy: "https://github.com/darks0l/solagents-programs/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/darks0l/solagents-programs",
    auditors: "None"
}

#[program]
pub mod agent_dividends {
    use super::*;

    /// Initialize the global dividend configuration. Called once.
    pub fn initialize_dividend_config(
        ctx: Context<InitializeDividendConfig>,
        job_revenue_share_bps: u16,
        creator_fee_share_bps: u16,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, job_revenue_share_bps, creator_fee_share_bps)
    }

    /// Create a dividend account for a specific agent token.
    /// Creator picks a mode: Regular (keep fees), Dividend (staking rewards), or BuybackBurn.
    pub fn create_token_dividend(
        ctx: Context<CreateTokenDividend>,
        mode: DividendMode,
    ) -> Result<()> {
        instructions::create_token_dividend::handler(ctx, mode)
    }

    /// Creator switches between Regular / Dividend / BuybackBurn modes.
    /// 7-day cooldown between switches.
    pub fn set_dividend_mode(
        ctx: Context<SetDividendMode>,
        new_mode: DividendMode,
    ) -> Result<()> {
        instructions::set_dividend_mode::handler(ctx, new_mode)
    }

    /// Admin/crank deposits SOL revenue into the dividend system.
    /// Routes to staking rewards (Dividend mode) or buyback vault (BuybackBurn mode).
    /// Rejected if token is in Regular mode.
    pub fn deposit_revenue(ctx: Context<DepositRevenue>, amount: u64) -> Result<()> {
        instructions::deposit_revenue::handler(ctx, amount)
    }

    /// Stake agent tokens to earn pro-rata SOL rewards.
    /// Only works when token is in Dividend mode.
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        instructions::stake::handler(ctx, amount)
    }

    /// Unstake agent tokens. Auto-claims pending rewards.
    /// Works regardless of current mode (you can always exit).
    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        instructions::unstake::handler(ctx, amount)
    }

    /// Claim accumulated SOL staking rewards.
    /// Works regardless of current mode (you can always claim earned rewards).
    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        instructions::claim_rewards::handler(ctx)
    }

    /// Execute a buyback & burn. Permissionless — anyone can crank.
    /// Burns tokens that were purchased off-chain and deposited into
    /// the bought_tokens_account owned by the token_dividend PDA.
    pub fn execute_buyback(
        ctx: Context<ExecuteBuyback>,
        sol_spent: u64,
        tokens_to_burn: u64,
    ) -> Result<()> {
        instructions::execute_buyback::handler(ctx, sol_spent, tokens_to_burn)
    }

    /// Admin updates global dividend configuration.
    pub fn update_dividend_config(
        ctx: Context<UpdateDividendConfig>,
        new_admin: Option<Pubkey>,
        job_revenue_share_bps: Option<u16>,
        creator_fee_share_bps: Option<u16>,
    ) -> Result<()> {
        instructions::update_config::handler(ctx, new_admin, job_revenue_share_bps, creator_fee_share_bps)
    }
}
