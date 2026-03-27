use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount};
use crate::state::{CurveConfig, CurvePool};
use crate::errors::CurveError;

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        seeds = [CurveConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, CurveConfig>,

    #[account(
        mut,
        seeds = [CurvePool::SEED, pool.mint.as_ref()],
        bump = pool.bump,
        constraint = pool.is_active() @ CurveError::PoolNotActive,
    )]
    pub pool: Account<'info, CurvePool>,

    /// SOL vault — sends SOL to seller
    /// CHECK: PDA validated by seeds
    #[account(
        mut,
        seeds = [CurvePool::VAULT_SEED, pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    /// Token vault — receives tokens from seller
    #[account(
        mut,
        seeds = [CurvePool::TOKEN_VAULT_SEED, pool.key().as_ref()],
        bump,
        token::mint = pool.mint,
        token::authority = pool,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    /// Seller's token account
    #[account(
        mut,
        token::mint = pool.mint,
        token::authority = seller,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Sell>,
    token_amount: u64,
    min_sol_out: u64,
) -> Result<()> {
    require!(token_amount > 0, CurveError::ZeroAmount);

    let config = &ctx.accounts.config;

    // ── Calculate SOL out from curve ──────────────────────────────────────
    let sol_out_before_fee = ctx.accounts.pool.calculate_sell(token_amount)
        .ok_or(CurveError::MathOverflow)?;

    require!(sol_out_before_fee > 0, CurveError::ZeroAmount);

    // ── Calculate fees (taken from SOL output) ────────────────────────────
    let total_fee_bps = config.creator_fee_bps as u64 + config.platform_fee_bps as u64;
    let fee = sol_out_before_fee
        .checked_mul(total_fee_bps)
        .ok_or(CurveError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(CurveError::MathOverflow)?;
    let sol_after_fee = sol_out_before_fee
        .checked_sub(fee)
        .ok_or(CurveError::MathOverflow)?;

    require!(sol_after_fee >= min_sol_out, CurveError::SlippageExceeded);
    require!(sol_out_before_fee <= ctx.accounts.pool.real_sol_balance, CurveError::ExceedsRealSol);

    // ── Split fees ────────────────────────────────────────────────────────
    let creator_fee = if total_fee_bps > 0 {
        fee.checked_mul(config.creator_fee_bps as u64)
            .ok_or(CurveError::MathOverflow)?
            .checked_div(total_fee_bps)
            .ok_or(CurveError::MathOverflow)?
    } else {
        0
    };
    let platform_fee = fee.checked_sub(creator_fee).ok_or(CurveError::MathOverflow)?;

    // ── Capture PDA seeds before any mutable borrows ─────────────────────
    let pool_key = ctx.accounts.pool.key();
    let vault_bump = ctx.accounts.pool.vault_bump;

    // ── Transfer tokens from seller to vault ──────────────────────────────
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.seller_token_account.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        token_amount,
    )?;

    // ── Transfer SOL from vault to seller via signed CPI ──────────────────
    // SystemAccount PDAs must use system_program::transfer + invoke_signed;
    // direct lamport mutation only works for accounts owned by this program.
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
                to: ctx.accounts.seller.to_account_info(),
            },
            &[vault_seeds],
        ),
        sol_after_fee,
    )?;

    // ── Update pool state ─────────────────────────────────────────────────
    let pool = &mut ctx.accounts.pool;
    pool.virtual_sol_reserve = pool.virtual_sol_reserve
        .checked_sub(sol_out_before_fee).ok_or(CurveError::MathOverflow)?;
    pool.virtual_token_reserve = pool.virtual_token_reserve
        .checked_add(token_amount).ok_or(CurveError::MathOverflow)?;
    pool.real_sol_balance = pool.real_sol_balance
        .checked_sub(sol_after_fee).ok_or(CurveError::MathOverflow)?;
    pool.real_token_balance = pool.real_token_balance
        .checked_add(token_amount).ok_or(CurveError::MathOverflow)?;
    pool.creator_fees_earned = pool.creator_fees_earned
        .checked_add(creator_fee).ok_or(CurveError::MathOverflow)?;
    pool.platform_fees_earned = pool.platform_fees_earned
        .checked_add(platform_fee).ok_or(CurveError::MathOverflow)?;
    pool.total_volume_sol = pool.total_volume_sol
        .checked_add(sol_out_before_fee).ok_or(CurveError::MathOverflow)?;
    pool.total_trades = pool.total_trades
        .checked_add(1).ok_or(CurveError::MathOverflow)?;

    emit!(super::buy::TradeExecuted {
        pool: pool.key(),
        mint: pool.mint,
        trader: ctx.accounts.seller.key(),
        is_buy: false,
        sol_amount: sol_after_fee,
        token_amount,
        fee,
        creator_fee,
        platform_fee,
        virtual_sol_reserve: pool.virtual_sol_reserve,
        virtual_token_reserve: pool.virtual_token_reserve,
        real_sol_balance: pool.real_sol_balance,
        graduation_pending: false,
    });

    Ok(())
}
