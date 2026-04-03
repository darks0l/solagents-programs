use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::errors::DividendError;
use crate::state::{DividendConfig, DividendMode, RevenueDeposited, TokenDividend};

#[derive(Accounts)]
pub struct DepositRevenue<'info> {
    /// Admin / crank that deposits SOL revenue.
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        seeds = [SEED_DIVIDEND_CONFIG],
        bump = config.bump,
        constraint = config.admin == depositor.key() @ DividendError::Unauthorized,
    )]
    pub config: Account<'info, DividendConfig>,

    #[account(
        mut,
        seeds = [SEED_TOKEN_DIVIDEND, token_dividend.mint.as_ref()],
        bump = token_dividend.bump,
    )]
    pub token_dividend: Account<'info, TokenDividend>,

    /// CHECK: SOL vault PDA for staking dividends. Validated by seeds.
    #[account(
        mut,
        seeds = [SEED_DIVIDEND_VAULT, token_dividend.mint.as_ref()],
        bump,
    )]
    pub dividend_vault: SystemAccount<'info>,

    /// CHECK: SOL vault PDA for buyback accumulation. Validated by seeds.
    #[account(
        mut,
        seeds = [SEED_BUYBACK_VAULT, token_dividend.mint.as_ref()],
        bump,
    )]
    pub buyback_vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositRevenue>, amount: u64) -> Result<()> {
    require!(amount > 0, DividendError::ZeroAmount);

    let td = &mut ctx.accounts.token_dividend;

    // Regular mode = creator keeps fees, no deposits accepted
    require!(
        td.mode != DividendMode::Regular,
        DividendError::RegularModeNoDeposits
    );

    match td.mode {
        DividendMode::Dividend => {
            // All revenue goes to staking rewards
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.depositor.to_account_info(),
                        to: ctx.accounts.dividend_vault.to_account_info(),
                    },
                ),
                amount,
            )?;

            // Update reward_per_token_stored (Synthetix pattern)
            if td.total_staked > 0 {
                let reward_increment = (amount as u128)
                    .checked_mul(PRECISION)
                    .ok_or(DividendError::MathOverflow)?
                    .checked_div(td.total_staked as u128)
                    .ok_or(DividendError::MathOverflow)?;

                td.reward_per_token_stored = td
                    .reward_per_token_stored
                    .checked_add(reward_increment)
                    .ok_or(DividendError::MathOverflow)?;
            }
            // If no stakers, SOL sits in vault — reward_per_token stays same.
            // Deposited SOL is effectively locked until stakers arrive.

            td.total_staking_revenue = td
                .total_staking_revenue
                .checked_add(amount)
                .ok_or(DividendError::MathOverflow)?;
        }
        DividendMode::BuybackBurn => {
            // All revenue goes to buyback vault
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.depositor.to_account_info(),
                        to: ctx.accounts.buyback_vault.to_account_info(),
                    },
                ),
                amount,
            )?;

            td.buyback_balance = td
                .buyback_balance
                .checked_add(amount)
                .ok_or(DividendError::MathOverflow)?;
        }
        DividendMode::Regular => unreachable!(), // Already guarded above
    }

    td.total_revenue_deposited = td
        .total_revenue_deposited
        .checked_add(amount)
        .ok_or(DividendError::MathOverflow)?;

    emit!(RevenueDeposited {
        mint: td.mint,
        amount,
        mode: td.mode,
    });

    Ok(())
}
