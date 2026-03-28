use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint};
use anchor_spl::associated_token::AssociatedToken;
use crate::state::*;
use crate::errors::CommerceError;

#[derive(Accounts)]
pub struct Complete<'info> {
    #[account(mut)]
    pub evaluator: Signer<'info>,

    #[account(
        mut,
        constraint = job.evaluator == evaluator.key() @ CommerceError::UnauthorizedEvaluator,
        constraint = job.status == JobStatus::Submitted @ CommerceError::InvalidState,
    )]
    pub job: Account<'info, Job>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,

    #[account(
        constraint = payment_mint.key() == config.payment_mint @ CommerceError::InvalidState
    )]
    pub payment_mint: Account<'info, Mint>,

    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump = job.vault_bump)]
    pub vault: Account<'info, TokenAccount>,

    /// Provider's token account — created automatically if it doesn't exist.
    #[account(
        init_if_needed,
        payer = evaluator,
        associated_token::mint = payment_mint,
        associated_token::authority = provider,
    )]
    pub provider_token: Account<'info, TokenAccount>,

    /// CHECK: provider wallet, validated against job.provider
    #[account(constraint = provider.key() == job.provider @ CommerceError::UnauthorizedProvider)]
    pub provider: UncheckedAccount<'info>,

    /// Treasury token account — created automatically if it doesn't exist.
    #[account(
        init_if_needed,
        payer = evaluator,
        associated_token::mint = payment_mint,
        associated_token::authority = treasury,
    )]
    pub treasury_token: Account<'info, TokenAccount>,

    /// CHECK: treasury wallet, validated against config.treasury
    #[account(constraint = treasury.key() == config.treasury @ CommerceError::InvalidState)]
    pub treasury: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Complete>, reason: [u8; 32], _opt_params: Vec<u8>) -> Result<()> {
    let job_id = ctx.accounts.job.job_id;
    let budget = ctx.accounts.job.budget;
    let job_bump = ctx.accounts.job.bump;
    let provider = ctx.accounts.job.provider;
    let evaluator_key = ctx.accounts.job.evaluator;
    let fee_bps = ctx.accounts.config.fee_bps;
    let config_key = ctx.accounts.config.key();
    let job_id_bytes = job_id.to_le_bytes();

    let fee = if fee_bps > 0 {
        budget.checked_mul(fee_bps as u64).ok_or(CommerceError::Overflow)?
              .checked_div(10_000).ok_or(CommerceError::Overflow)?
    } else { 0 };
    let provider_amount = budget.checked_sub(fee).ok_or(CommerceError::Overflow)?;

    let seeds: &[&[u8]] = &[b"job", config_key.as_ref(), &job_id_bytes, &[job_bump]];
    let signer = &[seeds];

    if provider_amount > 0 {
        token::transfer(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.provider_token.to_account_info(),
                authority: ctx.accounts.job.to_account_info(),
            },
            signer,
        ), provider_amount)?;
    }

    if fee > 0 {
        token::transfer(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.treasury_token.to_account_info(),
                authority: ctx.accounts.job.to_account_info(),
            },
            signer,
        ), fee)?;
    }

    let clock = Clock::get()?;
    let job = &mut ctx.accounts.job;
    job.status = JobStatus::Completed;
    job.reason = reason;
    job.completed_at = clock.unix_timestamp;

    emit!(JobCompleted { job_id, provider, evaluator: evaluator_key, amount: provider_amount, fee, reason });
    msg!("Job {}: completed. Provider paid {}, fee {}", job_id, provider_amount, fee);
    Ok(())
}

#[event]
pub struct JobCompleted {
    pub job_id: u64, pub provider: Pubkey, pub evaluator: Pubkey,
    pub amount: u64, pub fee: u64, pub reason: [u8; 32],
}
