use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount};
use crate::state::{CurveConfig, CurvePool};
use crate::errors::CurveError;

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

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

    /// SOL vault — receives SOL payment
    /// CHECK: PDA validated by seeds
    #[account(
        mut,
        seeds = [CurvePool::VAULT_SEED, pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    /// Token vault — sends tokens to buyer
    #[account(
        mut,
        seeds = [CurvePool::TOKEN_VAULT_SEED, pool.key().as_ref()],
        bump,
        token::mint = pool.mint,
        token::authority = pool,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    /// Buyer's token account (ATA)
    #[account(
        mut,
        token::mint = pool.mint,
        token::authority = buyer,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    /// Optional referrer who earns a share of the platform fee.
    /// CHECK: Any valid system account can be a referrer. Validated in handler.
    #[account(mut)]
    pub referrer: Option<AccountInfo<'info>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Buy>,
    sol_amount: u64,
    min_tokens_out: u64,
) -> Result<()> {
    require!(sol_amount > 0, CurveError::ZeroAmount);

    let config = &ctx.accounts.config;
    require!(!config.trading_paused, CurveError::TradingPaused);

    let pool = &mut ctx.accounts.pool;

    // ── Validate referrer ───────────────────────────────────
    let referrer_key = if let Some(ref referrer) = ctx.accounts.referrer {
        let rk = referrer.key();
        // Block self-referral
        require!(rk != ctx.accounts.buyer.key(), CurveError::SelfReferral);
        // Referrals must be enabled on this pool
        if pool.referrals_enabled && config.referral_fee_bps > 0 {
            Some(rk)
        } else {
            None // Referrer passed but referrals disabled — silently ignore
        }
    } else {
        None
    };

    // ── Calculate fees ──────────────────────────────────────
    let total_fee_bps = config.creator_fee_bps as u64 + config.platform_fee_bps as u64;
    let fee = sol_amount
        .checked_mul(total_fee_bps)
        .ok_or(CurveError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(CurveError::MathOverflow)?;
    let sol_after_fee = sol_amount
        .checked_sub(fee)
        .ok_or(CurveError::MathOverflow)?;

    // ── Calculate tokens out from curve ─────────────────────
    let tokens_out = pool.calculate_buy(sol_after_fee)
        .ok_or(CurveError::MathOverflow)?;

    require!(tokens_out > 0, CurveError::ZeroAmount);
    require!(tokens_out >= min_tokens_out, CurveError::SlippageExceeded);
    require!(tokens_out <= pool.real_token_balance, CurveError::ExceedsPoolBalance);

    // ── Split fees ──────────────────────────────────────────
    let creator_fee = fee
        .checked_mul(config.creator_fee_bps as u64)
        .ok_or(CurveError::MathOverflow)?
        .checked_div(total_fee_bps)
        .ok_or(CurveError::MathOverflow)?;
    let total_platform_fee = fee
        .checked_sub(creator_fee)
        .ok_or(CurveError::MathOverflow)?;

    // ── Calculate referral fee (carved from platform fee) ───
    let referral_fee = if referrer_key.is_some() {
        // referral_fee_bps is relative to the total trade, not to the platform fee
        sol_amount
            .checked_mul(config.referral_fee_bps as u64)
            .ok_or(CurveError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(CurveError::MathOverflow)?
            .min(total_platform_fee) // Never exceed the platform's share
    } else {
        0
    };
    let platform_fee = total_platform_fee
        .checked_sub(referral_fee)
        .ok_or(CurveError::MathOverflow)?;

    // ── Transfer SOL from buyer to vault ────────────────────
    // Send full amount minus referral fee to vault (fees tracked internally)
    let sol_to_vault = sol_amount
        .checked_sub(referral_fee)
        .ok_or(CurveError::MathOverflow)?;

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.sol_vault.to_account_info(),
            },
        ),
        sol_to_vault,
    )?;

    // ── Transfer referral fee directly to referrer ──────────
    if referral_fee > 0 {
        if let Some(ref referrer) = ctx.accounts.referrer {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.buyer.to_account_info(),
                        to: referrer.to_account_info(),
                    },
                ),
                referral_fee,
            )?;
        }
    }

    // ── Transfer tokens from vault to buyer ─────────────────
    let mint_key = pool.mint;
    let pool_seeds: &[&[u8]] = &[
        CurvePool::SEED,
        mint_key.as_ref(),
        &[pool.bump],
    ];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.token_vault.to_account_info(),
                to: ctx.accounts.buyer_token_account.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[pool_seeds],
        ),
        tokens_out,
    )?;

    // ── Update pool state ───────────────────────────────────
    pool.virtual_sol_reserve = pool.virtual_sol_reserve
        .checked_add(sol_after_fee).ok_or(CurveError::MathOverflow)?;
    pool.virtual_token_reserve = pool.virtual_token_reserve
        .checked_sub(tokens_out).ok_or(CurveError::MathOverflow)?;
    // real_sol_balance tracks SOL in vault (excludes referral fee which went directly to referrer)
    pool.real_sol_balance = pool.real_sol_balance
        .checked_add(sol_to_vault).ok_or(CurveError::MathOverflow)?;
    pool.real_token_balance = pool.real_token_balance
        .checked_sub(tokens_out).ok_or(CurveError::MathOverflow)?;
    pool.creator_fees_earned = pool.creator_fees_earned
        .checked_add(creator_fee).ok_or(CurveError::MathOverflow)?;
    pool.platform_fees_earned = pool.platform_fees_earned
        .checked_add(platform_fee).ok_or(CurveError::MathOverflow)?;
    pool.referral_fees_paid = pool.referral_fees_paid
        .checked_add(referral_fee).ok_or(CurveError::MathOverflow)?;
    pool.total_volume_sol = pool.total_volume_sol
        .checked_add(sol_amount).ok_or(CurveError::MathOverflow)?;
    pool.total_trades = pool.total_trades
        .checked_add(1).ok_or(CurveError::MathOverflow)?;

    // ── Track dev buy if buyer is creator ────────────────────
    if ctx.accounts.buyer.key() == pool.creator {
        pool.dev_buy_sol = pool.dev_buy_sol
            .checked_add(sol_amount).ok_or(CurveError::MathOverflow)?;
        pool.dev_buy_tokens = pool.dev_buy_tokens
            .checked_add(tokens_out).ok_or(CurveError::MathOverflow)?;
    }

    // ── Check graduation ────────────────────────────────────
    let net_sol = pool.real_sol_balance
        .checked_sub(pool.creator_fees_earned.checked_sub(pool.creator_fees_claimed).ok_or(CurveError::MathOverflow)?)
        .ok_or(CurveError::MathOverflow)?
        .checked_sub(pool.platform_fees_earned.checked_sub(pool.platform_fees_claimed).ok_or(CurveError::MathOverflow)?)
        .ok_or(CurveError::MathOverflow)?;

    let graduation_pending = net_sol >= config.graduation_threshold;

    emit!(TradeExecuted {
        pool: pool.key(),
        mint: pool.mint,
        trader: ctx.accounts.buyer.key(),
        is_buy: true,
        sol_amount,
        token_amount: tokens_out,
        fee,
        creator_fee,
        platform_fee,
        referral_fee,
        referrer: referrer_key.unwrap_or_default(),
        virtual_sol_reserve: pool.virtual_sol_reserve,
        virtual_token_reserve: pool.virtual_token_reserve,
        real_sol_balance: pool.real_sol_balance,
        graduation_pending,
    });

    Ok(())
}

#[event]
pub struct TradeExecuted {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    pub sol_amount: u64,
    pub token_amount: u64,
    pub fee: u64,
    pub creator_fee: u64,
    pub platform_fee: u64,
    pub referral_fee: u64,
    pub referrer: Pubkey,
    pub virtual_sol_reserve: u64,
    pub virtual_token_reserve: u64,
    pub real_sol_balance: u64,
    pub graduation_pending: bool,
}
