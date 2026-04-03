use anchor_lang::prelude::*;

use crate::constants::SEED_DIVIDEND_CONFIG;
use crate::state::DividendConfig;

#[derive(Accounts)]
pub struct InitializeDividendConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + DividendConfig::INIT_SPACE,
        seeds = [SEED_DIVIDEND_CONFIG],
        bump,
    )]
    pub config: Account<'info, DividendConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeDividendConfig>,
    job_revenue_share_bps: u16,
    creator_fee_share_bps: u16,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.job_revenue_share_bps = job_revenue_share_bps;
    config.creator_fee_share_bps = creator_fee_share_bps;
    config.bump = ctx.bumps.config;
    Ok(())
}
