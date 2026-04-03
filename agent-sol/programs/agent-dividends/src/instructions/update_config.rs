use anchor_lang::prelude::*;

use crate::constants::SEED_DIVIDEND_CONFIG;
use crate::errors::DividendError;
use crate::state::DividendConfig;

#[derive(Accounts)]
pub struct UpdateDividendConfig<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_DIVIDEND_CONFIG],
        bump = config.bump,
        constraint = config.admin == admin.key() @ DividendError::Unauthorized,
    )]
    pub config: Account<'info, DividendConfig>,
}

pub fn handler(
    ctx: Context<UpdateDividendConfig>,
    new_admin: Option<Pubkey>,
    job_revenue_share_bps: Option<u16>,
    creator_fee_share_bps: Option<u16>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    if let Some(admin) = new_admin {
        config.admin = admin;
    }
    if let Some(bps) = job_revenue_share_bps {
        config.job_revenue_share_bps = bps;
    }
    if let Some(bps) = creator_fee_share_bps {
        config.creator_fee_share_bps = bps;
    }

    Ok(())
}
