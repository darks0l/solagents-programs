use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::{CurveConfig, CurvePool};
use crate::errors::CurveError;

#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        seeds = [CurveConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, CurveConfig>,

    #[account(
        mut,
        seeds = [CurvePool::SEED, pool.mint.as_ref()],
        bump = pool.bump,
        constraint = pool.creator == creator.key() @ CurveError::CreatorMismatch,
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

pub fn handler(ctx: Context<ClaimCreatorFees>) -> Result<()> {
    let claimable = ctx.accounts.pool.creator_fees_earned
        .checked_sub(ctx.accounts.pool.creator_fees_claimed)
        .ok_or(CurveError::MathOverflow)?;

    require!(claimable > 0, CurveError::NoFeesToClaim);

    // ── Capture seeds before mutable borrow ──────────────────────────────
    let pool_key = ctx.accounts.pool.key();
    let vault_bump = ctx.accounts.pool.vault_bump;

    // ── Transfer SOL from vault to creator via signed CPI ─────────────────
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
                to: ctx.accounts.creator.to_account_info(),
            },
            &[vault_seeds],
        ),
        claimable,
    )?;

    // ── Update claimed amount ─────────────────────────────────────────────
    let pool = &mut ctx.accounts.pool;
    pool.creator_fees_claimed = pool.creator_fees_claimed
        .checked_add(claimable)
        .ok_or(CurveError::MathOverflow)?;
    pool.real_sol_balance = pool.real_sol_balance
        .checked_sub(claimable)
        .ok_or(CurveError::MathOverflow)?;

    emit!(FeesClaimed {
        pool: pool.key(),
        mint: pool.mint,
        claimer: ctx.accounts.creator.key(),
        claim_type: ClaimType::Creator,
        amount: claimable,
        total_earned: pool.creator_fees_earned,
        total_claimed: pool.creator_fees_claimed,
    });

    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum ClaimType {
    Creator,
    Platform,
}

#[event]
pub struct FeesClaimed {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub claimer: Pubkey,
    pub claim_type: ClaimType,
    pub amount: u64,
    pub total_earned: u64,
    pub total_claimed: u64,
}
