use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::CommerceError;

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    #[account(
        mut,
        constraint = job.client == client.key() @ CommerceError::UnauthorizedClient,
        constraint = job.status == JobStatus::Open @ CommerceError::InvalidState,
        constraint = job.provider != Pubkey::default() @ CommerceError::ProviderNotSet,
        constraint = job.budget > 0 @ CommerceError::ZeroBudget,
    )]
    pub job: Account<'info, Job>,

    #[account(mut, constraint = client_token.owner == client.key())]
    pub client_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", job.key().as_ref()],
        bump = job.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Fund>, expected_budget: u64, _opt_params: Vec<u8>) -> Result<()> {
    let budget = ctx.accounts.job.budget;
    let expired_at = ctx.accounts.job.expired_at;
    let job_id = ctx.accounts.job.job_id;

    require!(budget == expected_budget, CommerceError::BudgetMismatch);
    let clock = Clock::get()?;
    require!(clock.unix_timestamp < expired_at, CommerceError::Expired);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.client_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.client.to_account_info(),
            },
        ),
        budget,
    )?;

    let job = &mut ctx.accounts.job;
    job.status = JobStatus::Funded;

    emit!(JobFunded { job_id, amount: budget, client: ctx.accounts.client.key() });
    msg!("Job {}: funded with {} tokens", job_id, budget);
    Ok(())
}

#[event]
pub struct JobFunded { pub job_id: u64, pub amount: u64, pub client: Pubkey }
