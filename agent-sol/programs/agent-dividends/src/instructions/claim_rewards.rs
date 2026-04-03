use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::constants::*;
use crate::errors::DividendError;
use crate::state::{RewardsClaimed, StakePosition, TokenDividend};
use crate::instructions::stake::pending_rewards;

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [SEED_TOKEN_DIVIDEND, mint.key().as_ref()],
        bump = token_dividend.bump,
    )]
    pub token_dividend: Account<'info, TokenDividend>,

    #[account(
        mut,
        seeds = [SEED_STAKE_POSITION, mint.key().as_ref(), user.key().as_ref()],
        bump = stake_position.bump,
        constraint = stake_position.owner == user.key() @ DividendError::Unauthorized,
    )]
    pub stake_position: Account<'info, StakePosition>,

    /// CHECK: SOL dividend vault — rewards paid from here.
    #[account(
        mut,
        seeds = [SEED_DIVIDEND_VAULT, mint.key().as_ref()],
        bump,
    )]
    pub dividend_vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimRewards>) -> Result<()> {
    let td = &mut ctx.accounts.token_dividend;
    let pos = &mut ctx.accounts.stake_position;

    let pending = pending_rewards(pos, td)?;
    require!(pending > 0, DividendError::NoRewardsToClaim);

    // Transfer SOL from dividend vault PDA to user
    let vault_info = ctx.accounts.dividend_vault.to_account_info();
    let user_info = ctx.accounts.user.to_account_info();

    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(pending)
        .ok_or(DividendError::MathOverflow)?;
    **user_info.try_borrow_mut_lamports()? = user_info
        .lamports()
        .checked_add(pending)
        .ok_or(DividendError::MathOverflow)?;

    // Update state
    pos.reward_debt = td.reward_per_token_stored;
    pos.rewards_claimed = pos
        .rewards_claimed
        .checked_add(pending)
        .ok_or(DividendError::MathOverflow)?;

    td.total_rewards_distributed = td
        .total_rewards_distributed
        .checked_add(pending)
        .ok_or(DividendError::MathOverflow)?;

    emit!(RewardsClaimed {
        user: ctx.accounts.user.key(),
        mint: ctx.accounts.mint.key(),
        amount: pending,
    });

    Ok(())
}
