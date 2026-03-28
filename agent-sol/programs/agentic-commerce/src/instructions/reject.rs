use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint};
use anchor_spl::associated_token::AssociatedToken;
use crate::state::*;
use crate::errors::CommerceError;

#[derive(Accounts)]
pub struct Reject<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut)]
    pub job: Account<'info, Job>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,

    #[account(
        constraint = payment_mint.key() == config.payment_mint @ CommerceError::InvalidState
    )]
    pub payment_mint: Account<'info, Mint>,

    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump = job.vault_bump)]
    pub vault: Account<'info, TokenAccount>,

    /// Client's token account — created automatically if it doesn't exist (for refunds).
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = payment_mint,
        associated_token::authority = client,
    )]
    pub client_token: Account<'info, TokenAccount>,

    /// CHECK: client wallet, validated against job.client
    #[account(constraint = client.key() == job.client @ CommerceError::UnauthorizedClient)]
    pub client: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Reject>, reason: [u8; 32], _opt_params: Vec<u8>) -> Result<()> {
    let job_id = ctx.accounts.job.job_id;
    let job_status = ctx.accounts.job.status;
    let job_client = ctx.accounts.job.client;
    let job_evaluator = ctx.accounts.job.evaluator;
    let job_budget = ctx.accounts.job.budget;
    let job_bump = ctx.accounts.job.bump;
    let config_key = ctx.accounts.config.key();
    let job_id_bytes = job_id.to_le_bytes();
    let caller = ctx.accounts.caller.key();

    match job_status {
        JobStatus::Open => require!(caller == job_client, CommerceError::UnauthorizedClient),
        JobStatus::Funded | JobStatus::Submitted => require!(caller == job_evaluator, CommerceError::UnauthorizedEvaluator),
        _ => return Err(error!(CommerceError::InvalidState)),
    }

    let needs_refund = matches!(job_status, JobStatus::Funded | JobStatus::Submitted);

    if needs_refund && job_budget > 0 {
        let seeds: &[&[u8]] = &[b"job", config_key.as_ref(), &job_id_bytes, &[job_bump]];
        token::transfer(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.client_token.to_account_info(),
                authority: ctx.accounts.job.to_account_info(),
            },
            &[seeds],
        ), job_budget)?;
    }

    let clock = Clock::get()?;
    let job = &mut ctx.accounts.job;
    job.status = JobStatus::Rejected;
    job.reason = reason;
    job.completed_at = clock.unix_timestamp;

    emit!(JobRejected { job_id, rejected_by: caller, was_funded: needs_refund, reason, refunded: needs_refund });
    msg!("Job {}: rejected by {}", job_id, caller);
    Ok(())
}

#[event]
pub struct JobRejected {
    pub job_id: u64, pub rejected_by: Pubkey, pub was_funded: bool,
    pub reason: [u8; 32], pub refunded: bool,
}
