use anchor_lang::prelude::*;

pub mod state;
pub mod errors;
pub mod constants;
pub mod instructions;
pub mod raydium_cpi;

use instructions::*;

#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

declare_id!("nFc4nPJ2j68QS1pU15XFV2K2k6u7EifuPYpC1nHxuof");

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "SolAgents Bonding Curve",
    project_url: "https://solagents.dev",
    contacts: "email:darksol@agentmail.to,link:https://solagents.dev",
    policy: "https://github.com/darks0l/solagents-programs/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/darks0l/solagents-programs",
    auditors: "None"
}

#[program]
pub mod bonding_curve {
    use super::*;

    /// Initialize the global curve config — called once per deployment.
    pub fn initialize(
        ctx: Context<Initialize>,
        creator_fee_bps: u16,
        platform_fee_bps: u16,
        graduation_threshold: u64,
        total_supply: u64,
        decimals: u8,
        initial_virtual_sol: u64,
        treasury: Pubkey,
    ) -> Result<()> {
        instructions::initialize::handler(
            ctx,
            creator_fee_bps,
            platform_fee_bps,
            graduation_threshold,
            total_supply,
            decimals,
            initial_virtual_sol,
            treasury,
        )
    }

    /// Create a new token with bonding curve pool.
    /// Mints total supply, creates pool, sets up metadata,
    /// revokes freeze/mint/metadata authorities.
    /// Optional dev_buy_sol for creator's initial buy.
    pub fn create_token(
        ctx: Context<CreateToken>,
        name: String,
        symbol: String,
        uri: String,
        dev_buy_sol: Option<u64>,
    ) -> Result<()> {
        instructions::create_token::handler(ctx, name, symbol, uri, dev_buy_sol)
    }

    /// Buy tokens with SOL.
    /// sol_amount: total SOL to spend (fees deducted before curve calc)
    /// min_tokens_out: slippage protection — revert if fewer tokens received
    pub fn buy(
        ctx: Context<Buy>,
        sol_amount: u64,
        min_tokens_out: u64,
    ) -> Result<()> {
        instructions::buy::handler(ctx, sol_amount, min_tokens_out)
    }

    /// Sell tokens for SOL.
    /// token_amount: tokens to sell
    /// min_sol_out: slippage protection — revert if less SOL received (after fees)
    pub fn sell(
        ctx: Context<Sell>,
        token_amount: u64,
        min_sol_out: u64,
    ) -> Result<()> {
        instructions::sell::handler(ctx, token_amount, min_sol_out)
    }

    /// Graduate pool to Raydium CPMM.
    /// Permissionless — anyone can call once threshold is reached.
    /// Remaining tokens + accumulated SOL migrate to Raydium.
    /// LP tokens are burned (liquidity permanently locked).
    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        instructions::graduate::handler(ctx)
    }

    /// Claim accumulated creator fees from a pool.
    /// Only the token creator can call this.
    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        instructions::claim_creator_fees::handler(ctx)
    }

    /// Claim accumulated platform fees from a pool.
    /// Only the treasury wallet can call this.
    pub fn claim_platform_fees(ctx: Context<ClaimPlatformFees>) -> Result<()> {
        instructions::claim_platform_fees::handler(ctx)
    }

    /// Claim Raydium creator fees from a graduated pool.
    /// Fees are split 50/50 between token creator and platform treasury.
    /// Either the creator or treasury can trigger this.
    pub fn claim_raydium_fees(ctx: Context<ClaimRaydiumFees>) -> Result<()> {
        instructions::claim_raydium_fees::handler(ctx)
    }

    /// Update global config.
    /// Only admin can call this. Fee changes don't affect existing pools retroactively.
    /// Setting new_admin initiates a two-step transfer — the new admin must call accept_admin.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_creator_fee_bps: Option<u16>,
        new_platform_fee_bps: Option<u16>,
        new_graduation_threshold: Option<u64>,
        new_treasury: Option<Pubkey>,
        new_admin: Option<Pubkey>,
        paused: Option<bool>,
        raydium_permission_enabled: Option<bool>,
        trading_paused: Option<bool>,
    ) -> Result<()> {
        instructions::update_config::handler(
            ctx,
            new_creator_fee_bps,
            new_platform_fee_bps,
            new_graduation_threshold,
            new_treasury,
            new_admin,
            paused,
            raydium_permission_enabled,
            trading_paused,
        )
    }

    /// Accept a pending admin transfer.
    /// The pending admin (set via update_config) calls this to complete the two-step transfer.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::accept_admin::handler(ctx)
    }

    /// Batch claim platform fees across multiple pools in a single transaction.
    /// Treasury signs once; remaining_accounts contains [pool, sol_vault] pairs.
    pub fn claim_all_platform_fees<'info>(
        ctx: Context<'_, '_, 'info, 'info, ClaimAllPlatformFees<'info>>,
    ) -> Result<()> {
        instructions::claim_all_platform_fees::handler(ctx)
    }

    /// Close a graduated pool's accounts and reclaim rent to treasury.
    /// Pool must be graduated and have all fees claimed; token vault must be empty.
    /// Only admin or treasury can call.
    pub fn close_graduated_pool(ctx: Context<CloseGraduatedPool>) -> Result<()> {
        instructions::close_graduated_pool::handler(ctx)
    }
}
