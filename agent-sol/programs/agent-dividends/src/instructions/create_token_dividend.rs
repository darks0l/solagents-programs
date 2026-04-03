use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::state::{DividendConfig, DividendMode, TokenDividend};

#[derive(Accounts)]
pub struct CreateTokenDividend<'info> {
    /// Creator of the agent token (must match bonding-curve pool creator).
    #[account(mut)]
    pub creator: Signer<'info>,

    /// Global dividend config (validates existence).
    #[account(
        seeds = [SEED_DIVIDEND_CONFIG],
        bump = config.bump,
    )]
    pub config: Account<'info, DividendConfig>,

    /// The agent-token mint.
    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = creator,
        space = 8 + TokenDividend::INIT_SPACE,
        seeds = [SEED_TOKEN_DIVIDEND, mint.key().as_ref()],
        bump,
    )]
    pub token_dividend: Account<'info, TokenDividend>,

    /// Staking vault — holds staked agent tokens (SPL token account owned by PDA).
    #[account(
        init,
        payer = creator,
        token::mint = mint,
        token::authority = token_dividend,
        seeds = [SEED_STAKING_VAULT, mint.key().as_ref()],
        bump,
    )]
    pub staking_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Creates a dividend account for an agent token.
/// Starts in Regular mode (creator keeps all fees). Creator can switch later.
pub fn handler(ctx: Context<CreateTokenDividend>, mode: DividendMode) -> Result<()> {
    let clock = Clock::get()?;
    let td = &mut ctx.accounts.token_dividend;

    td.mint = ctx.accounts.mint.key();
    td.creator = ctx.accounts.creator.key();
    td.mode = mode;
    td.last_mode_change = clock.unix_timestamp;
    td.total_staked = 0;
    td.reward_per_token_stored = 0;
    td.total_staking_revenue = 0;
    td.total_rewards_distributed = 0;
    td.buyback_balance = 0;
    td.total_burned = 0;
    td.total_buyback_sol_spent = 0;
    td.burn_count = 0;
    td.total_revenue_deposited = 0;
    td.created_at = clock.unix_timestamp;
    td.bump = ctx.bumps.token_dividend;

    Ok(())
}
