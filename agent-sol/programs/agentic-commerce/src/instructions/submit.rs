use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::CommerceError;

#[derive(Accounts)]
pub struct Submit<'info> {
    pub provider: Signer<'info>,

    #[account(
        mut,
        constraint = job.provider == provider.key() @ CommerceError::UnauthorizedProvider,
        constraint = job.status == JobStatus::Funded @ CommerceError::InvalidState,
    )]
    pub job: Account<'info, Job>,
}

pub fn handler(ctx: Context<Submit>, deliverable: [u8; 32], _opt_params: Vec<u8>) -> Result<()> {
    require!(deliverable != [0u8; 32], CommerceError::EmptyDeliverable);

    let expired_at = ctx.accounts.job.expired_at;
    let job_id = ctx.accounts.job.job_id;
    let provider_key = ctx.accounts.job.provider;

    let clock = Clock::get()?;
    require!(clock.unix_timestamp < expired_at, CommerceError::Expired);

    let job = &mut ctx.accounts.job;
    job.deliverable = deliverable;
    job.status = JobStatus::Submitted;

    emit!(JobSubmitted { job_id, provider: provider_key, deliverable });
    msg!("Job {}: submitted by {}", job_id, provider_key);
    Ok(())
}

#[event]
pub struct JobSubmitted { pub job_id: u64, pub provider: Pubkey, pub deliverable: [u8; 32] }
