use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::DividendError;
use crate::state::{BuybackExecuted, TokenDividend};

/// Execute a buyback & burn.
///
/// For now this is a two-step flow:
/// 1. Off-chain: API swaps SOL from buyback vault for agent tokens
///    (via bonding curve pre-graduation or Raydium post-graduation)
///    and deposits purchased tokens into `bought_tokens_account`.
/// 2. On-chain: This instruction burns those tokens and records the event.
///
/// The `sol_spent` parameter is passed by the crank to record how much SOL
/// was consumed in the off-chain swap. The instruction verifies that
/// `sol_spent <= buyback_balance` and decrements accordingly.
///
/// Future: CPI directly to bonding_curve::buy for pre-graduation tokens.
#[derive(Accounts)]
pub struct ExecuteBuyback<'info> {
    /// Permissionless crank that triggers the burn.
    #[account(mut)]
    pub crank: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [SEED_TOKEN_DIVIDEND, mint.key().as_ref()],
        bump = token_dividend.bump,
    )]
    pub token_dividend: Account<'info, TokenDividend>,

    /// Token account holding agent tokens purchased via off-chain swap,
    /// owned by the token_dividend PDA so we can burn from it.
    #[account(
        mut,
        constraint = bought_tokens_account.mint == mint.key(),
        constraint = bought_tokens_account.owner == token_dividend.key(),
    )]
    pub bought_tokens_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ExecuteBuyback>, sol_spent: u64, tokens_to_burn: u64) -> Result<()> {
    require!(sol_spent > 0, DividendError::ZeroAmount);
    require!(tokens_to_burn > 0, DividendError::ZeroAmount);

    // Extract account infos before any mutable borrows
    let td_info = ctx.accounts.token_dividend.to_account_info();
    let mint_info = ctx.accounts.mint.to_account_info();
    let bought_tokens_info = ctx.accounts.bought_tokens_account.to_account_info();
    let token_program_info = ctx.accounts.token_program.to_account_info();

    let td = &mut ctx.accounts.token_dividend;

    require!(td.buyback_balance >= sol_spent, DividendError::NoBuybackBalance);

    // Burn the purchased tokens
    let mint_key = td.mint;
    let td_bump = td.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        SEED_TOKEN_DIVIDEND,
        mint_key.as_ref(),
        &[td_bump],
    ]];
    token::burn(
        CpiContext::new_with_signer(
            token_program_info,
            Burn {
                mint: mint_info,
                from: bought_tokens_info,
                authority: td_info,
            },
            signer_seeds,
        ),
        tokens_to_burn,
    )?;

    // Update buyback tracking
    td.buyback_balance = td
        .buyback_balance
        .checked_sub(sol_spent)
        .ok_or(DividendError::MathOverflow)?;

    td.total_burned = td
        .total_burned
        .checked_add(tokens_to_burn)
        .ok_or(DividendError::MathOverflow)?;

    td.total_buyback_sol_spent = td
        .total_buyback_sol_spent
        .checked_add(sol_spent)
        .ok_or(DividendError::MathOverflow)?;

    td.burn_count = td
        .burn_count
        .checked_add(1)
        .ok_or(DividendError::MathOverflow)?;

    emit!(BuybackExecuted {
        mint: td.mint,
        sol_spent,
        tokens_burned: tokens_to_burn,
        total_burned: td.total_burned,
    });

    Ok(())
}
