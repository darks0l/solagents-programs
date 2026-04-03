use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::DividendError;
use crate::state::{DividendMode, Staked, StakePosition, TokenDividend};

#[derive(Accounts)]
pub struct Stake<'info> {
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
        init_if_needed,
        payer = user,
        space = 8 + StakePosition::INIT_SPACE,
        seeds = [SEED_STAKE_POSITION, mint.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub stake_position: Account<'info, StakePosition>,

    /// User's agent-token account.
    #[account(
        mut,
        constraint = user_token_account.owner == user.key(),
        constraint = user_token_account.mint == mint.key(),
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// Staking vault that holds staked tokens.
    #[account(
        mut,
        seeds = [SEED_STAKING_VAULT, mint.key().as_ref()],
        bump,
    )]
    pub staking_vault: Account<'info, TokenAccount>,

    /// CHECK: SOL dividend vault — needed for auto-claim on restake.
    #[account(
        mut,
        seeds = [SEED_DIVIDEND_VAULT, mint.key().as_ref()],
        bump,
    )]
    pub dividend_vault: SystemAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Stake>, amount: u64) -> Result<()> {
    require!(amount > 0, DividendError::ZeroAmount);

    let td = &mut ctx.accounts.token_dividend;

    // Staking only works in Dividend mode
    require!(td.mode == DividendMode::Dividend, DividendError::StakingNotActive);
    let pos = &mut ctx.accounts.stake_position;
    let clock = Clock::get()?;

    // If existing position with pending rewards, auto-claim before updating debt
    if pos.amount > 0 {
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
    }

    // Transfer tokens from user to staking vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.staking_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // Initialize if new position
    if pos.amount == 0 && pos.staked_at == 0 {
        pos.owner = ctx.accounts.user.key();
        pos.mint = ctx.accounts.mint.key();
        pos.staked_at = clock.unix_timestamp;
        pos.rewards_claimed = 0;
        pos.bump = ctx.bumps.stake_position;
    }

    pos.amount = pos
        .amount
        .checked_add(amount)
        .ok_or(DividendError::MathOverflow)?;

    // Snapshot current reward_per_token — user earns from this point forward
    pos.reward_debt = td.reward_per_token_stored;

    // Update total staked
    td.total_staked = td
        .total_staked
        .checked_add(amount)
        .ok_or(DividendError::MathOverflow)?;

    emit!(Staked {
        user: ctx.accounts.user.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        total_staked: td.total_staked,
    });

    Ok(())
}

/// Calculate pending SOL rewards for a staker.
pub fn pending_rewards(pos: &StakePosition, td: &TokenDividend) -> Result<u64> {
    if pos.amount == 0 {
        return Ok(0);
    }

    let reward_delta = td
        .reward_per_token_stored
        .checked_sub(pos.reward_debt)
        .ok_or(DividendError::MathOverflow)?;

    let pending = (pos.amount as u128)
        .checked_mul(reward_delta)
        .ok_or(DividendError::MathOverflow)?
        .checked_div(PRECISION)
        .ok_or(DividendError::MathOverflow)?;

    Ok(pending as u64)
}
