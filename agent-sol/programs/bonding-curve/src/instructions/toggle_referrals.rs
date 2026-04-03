use anchor_lang::prelude::*;
use crate::state::CurvePool;
use crate::errors::CurveError;

#[derive(Accounts)]
pub struct ToggleReferrals<'info> {
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [CurvePool::SEED, pool.mint.as_ref()],
        bump = pool.bump,
        constraint = pool.creator == creator.key() @ CurveError::CreatorMismatch,
        constraint = pool.is_active() @ CurveError::PoolNotActive,
    )]
    pub pool: Account<'info, CurvePool>,
}

pub fn handler(ctx: Context<ToggleReferrals>, enabled: bool) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let old = pool.referrals_enabled;
    pool.referrals_enabled = enabled;

    emit!(ReferralsToggled {
        pool: pool.key(),
        mint: pool.mint,
        creator: ctx.accounts.creator.key(),
        old_enabled: old,
        new_enabled: enabled,
    });

    Ok(())
}

#[event]
pub struct ReferralsToggled {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub old_enabled: bool,
    pub new_enabled: bool,
}
