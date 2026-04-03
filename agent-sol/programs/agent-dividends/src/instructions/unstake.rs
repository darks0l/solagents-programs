use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::DividendError;
use crate::state::{StakePosition, TokenDividend, Unstaked};
use crate::instructions::stake::pending_rewards;

#[derive(Accounts)]
pub struct Unstake<'info> {
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

    /// User's agent-token account to receive unstaked tokens.
    #[account(
        mut,
        constraint = user_token_account.owner == user.key(),
        constraint = user_token_account.mint == mint.key(),
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// Staking vault holding staked tokens.
    #[account(
        mut,
        seeds = [SEED_STAKING_VAULT, mint.key().as_ref()],
        bump,
    )]
    pub staking_vault: Account<'info, TokenAccount>,

    /// CHECK: SOL dividend vault — rewards paid from here.
    #[account(
        mut,
        seeds = [SEED_DIVIDEND_VAULT, mint.key().as_ref()],
        bump,
    )]
    pub dividend_vault: SystemAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Unstake>, amount: u64) -> Result<()> {
    require!(amount > 0, DividendError::ZeroAmount);

    let td = &mut ctx.accounts.token_dividend;
    let pos = &mut ctx.accounts.stake_position;

    require!(pos.amount >= amount, DividendError::InsufficientStake);

    // Auto-claim pending rewards before unstaking
    let pending = pending_rewards(pos, td)?;
    if pending > 0 {
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

        pos.rewards_claimed = pos
            .rewards_claimed
            .checked_add(pending)
            .ok_or(DividendError::MathOverflow)?;

        td.total_rewards_distributed = td
            .total_rewards_distributed
            .checked_add(pending)
            .ok_or(DividendError::MathOverflow)?;
    }

    // Transfer tokens from staking vault back to user via PDA signer
    let mint_key = td.mint;
    let td_bump = td.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        SEED_TOKEN_DIVIDEND,
        mint_key.as_ref(),
        &[td_bump],
    ]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.staking_vault.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.token_dividend.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // Update position
    pos.amount = pos
        .amount
        .checked_sub(amount)
        .ok_or(DividendError::MathOverflow)?;
    pos.reward_debt = td.reward_per_token_stored;

    // Update total staked
    td.total_staked = td
        .total_staked
        .checked_sub(amount)
        .ok_or(DividendError::MathOverflow)?;

    emit!(Unstaked {
        user: ctx.accounts.user.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        total_staked: td.total_staked,
    });

    Ok(())
}
