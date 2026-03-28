use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::{CurveConfig, CurvePool};
use crate::errors::CurveError;
use super::claim_creator_fees::{ClaimType, FeesClaimed};

#[derive(Accounts)]
pub struct ClaimPlatformFees<'info> {
    #[account(mut)]
    pub treasury: Signer<'info>,

    #[account(
        seeds = [CurveConfig::SEED],
        bump = config.bump,
        constraint = config.treasury == treasury.key() @ CurveError::Unauthorized,
    )]
    pub config: Account<'info, CurveConfig>,

    #[account(
        mut,
        seeds = [CurvePool::SEED, pool.mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, CurvePool>,

    /// SOL vault — fees are paid from here
    /// CHECK: PDA validated by seeds
    #[account(
        mut,
        seeds = [CurvePool::VAULT_SEED, pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimPlatformFees>) -> Result<()> {
    let claimable = ctx.accounts.pool.platform_fees_earned
        .checked_sub(ctx.accounts.pool.platform_fees_claimed)
        .ok_or(CurveError::MathOverflow)?;

    require!(claimable > 0, CurveError::NoFeesToClaim);

    // ── Capture seeds before mutable borrow ──────────────────────────────
    let pool_key = ctx.accounts.pool.key();
    let vault_bump = ctx.accounts.pool.vault_bump;

    // ── Transfer SOL from vault to treasury via signed CPI ────────────────
    let vault_seeds: &[&[u8]] = &[
        CurvePool::VAULT_SEED,
        pool_key.as_ref(),
        &[vault_bump],
    ];
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.sol_vault.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
            &[vault_seeds],
        ),
        claimable,
    )?;

    // ── Update claimed amount ─────────────────────────────────────────────
    let pool = &mut ctx.accounts.pool;
    pool.platform_fees_claimed = pool.platform_fees_claimed
        .checked_add(claimable)
        .ok_or(CurveError::MathOverflow)?;
    pool.real_sol_balance = pool.real_sol_balance
        .checked_sub(claimable)
        .ok_or(CurveError::MathOverflow)?;

    emit!(FeesClaimed {
        pool: pool.key(),
        mint: pool.mint,
        claimer: ctx.accounts.treasury.key(),
        claim_type: ClaimType::Platform,
        amount: claimable,
        total_earned: pool.platform_fees_earned,
        total_claimed: pool.platform_fees_claimed,
    });

    Ok(())
}
