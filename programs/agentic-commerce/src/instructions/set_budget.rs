use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::CommerceError;

#[derive(Accounts)]
pub struct SetBudget<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        constraint = job.status == JobStatus::Open @ CommerceError::InvalidState,
        constraint = (
            job.client == caller.key() || job.provider == caller.key()
        ) @ CommerceError::UnauthorizedClient,
    )]
    pub job: Account<'info, Job>,
}

pub fn handler(ctx: Context<SetBudget>, amount: u64, _opt_params: Vec<u8>) -> Result<()> {
    require!(amount > 0, CommerceError::ZeroBudget);

    let job = &mut ctx.accounts.job;
    let job_id = job.job_id;
    job.budget = amount;

    emit!(BudgetSet { job_id, amount, set_by: ctx.accounts.caller.key() });
    msg!("Job {}: budget set to {}", job_id, amount);
    Ok(())
}

#[event]
pub struct BudgetSet {
    pub job_id: u64,
    pub amount: u64,
    pub set_by: Pubkey,
}
