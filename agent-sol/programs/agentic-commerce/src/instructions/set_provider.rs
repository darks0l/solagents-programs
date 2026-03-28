use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::CommerceError;

#[derive(Accounts)]
pub struct SetProvider<'info> {
    pub client: Signer<'info>,

    #[account(
        mut,
        constraint = job.client == client.key() @ CommerceError::UnauthorizedClient,
        constraint = job.status == JobStatus::Open @ CommerceError::InvalidState,
        constraint = job.provider == Pubkey::default() @ CommerceError::ProviderAlreadySet,
    )]
    pub job: Account<'info, Job>,
    // hook_program added in v2
}

pub fn handler(ctx: Context<SetProvider>, provider: Pubkey, _opt_params: Vec<u8>) -> Result<()> {
    require!(provider != Pubkey::default(), CommerceError::ZeroProvider);

    let job = &mut ctx.accounts.job;
    let job_id = job.job_id;
    job.provider = provider;

    emit!(ProviderSet { job_id, provider });
    msg!("Job {}: provider set to {}", job_id, provider);
    Ok(())
}

#[event]
pub struct ProviderSet {
    pub job_id: u64,
    pub provider: Pubkey,
}
