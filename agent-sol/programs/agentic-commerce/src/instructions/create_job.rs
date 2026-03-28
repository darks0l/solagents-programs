use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::*;
use crate::errors::CommerceError;

/// Create a new job. The caller becomes the client.
/// Provider may be Pubkey::default() (set later via set_provider).
/// Evaluator is mandatory and immutable.
/// Hook is optional — Pubkey::default() means no hook.
#[derive(Accounts)]
pub struct CreateJob<'info> {
    /// The client creating the job.
    #[account(mut)]
    pub client: Signer<'info>,

    /// Platform config (increments job counter).
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, PlatformConfig>,

    /// The job account (PDA).
    #[account(
        init,
        payer = client,
        space = Job::SIZE,
        seeds = [b"job", config.key().as_ref(), &config.job_counter.to_le_bytes()],
        bump,
    )]
    pub job: Account<'info, Job>,

    /// Escrow token vault for this job (PDA-owned token account).
    #[account(
        init,
        payer = client,
        seeds = [b"vault", job.key().as_ref()],
        bump,
        token::mint = payment_mint,
        token::authority = job,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Payment mint (must match platform config).
    #[account(
        constraint = payment_mint.key() == config.payment_mint @ CommerceError::InvalidState
    )]
    pub payment_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<CreateJob>,
    provider: Pubkey,
    evaluator: Pubkey,
    expired_at: i64,
    description: String,
    hook: Pubkey,
) -> Result<()> {
    require!(evaluator != Pubkey::default(), CommerceError::ZeroEvaluator);
    require!(description.len() <= Job::MAX_DESC_LEN, CommerceError::InvalidState);

    let clock = Clock::get()?;
    require!(expired_at > clock.unix_timestamp, CommerceError::ExpirationInPast);

    let config = &mut ctx.accounts.config;
    let job_id = config.job_counter;
    config.job_counter = config.job_counter.checked_add(1).ok_or(CommerceError::Overflow)?;

    let job = &mut ctx.accounts.job;
    job.job_id = job_id;
    job.client = ctx.accounts.client.key();
    job.provider = provider;
    job.evaluator = evaluator;
    job.description = description;
    job.budget = 0;
    job.expired_at = expired_at;
    job.status = JobStatus::Open;
    job.deliverable = [0u8; 32];
    job.reason = [0u8; 32];
    job.hook = hook;
    job.created_at = clock.unix_timestamp;
    job.completed_at = 0;
    job.bump = ctx.bumps.job;
    job.vault_bump = ctx.bumps.vault;

    emit!(JobCreated {
        job_id,
        client: job.client,
        provider: job.provider,
        evaluator: job.evaluator,
        expired_at: job.expired_at,
        hook: job.hook,
    });

    msg!("Job {} created by {}", job_id, job.client);
    Ok(())
}

#[event]
pub struct JobCreated {
    pub job_id: u64,
    pub client: Pubkey,
    pub provider: Pubkey,
    pub evaluator: Pubkey,
    pub expired_at: i64,
    pub hook: Pubkey,
}
