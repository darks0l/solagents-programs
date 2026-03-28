use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, CloseAccount, close_account};
use crate::state::*;
use crate::errors::CommerceError;

/// Close a terminal job account and its vault, reclaiming rent to the client.
/// Only the client who created the job can close it.
/// Job must be in a terminal state: Completed, Rejected, or Expired.
#[derive(Accounts)]
pub struct CloseJob<'info> {
    #[account(mut)]
    pub client: Signer<'info>,

    #[account(
        mut,
        close = client,
        constraint = job.client == client.key() @ CommerceError::UnauthorizedClient,
        constraint = job.is_terminal() @ CommerceError::InvalidState,
    )]
    pub job: Account<'info, Job>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,

    #[account(
        mut,
        seeds = [b"vault", job.key().as_ref()],
        bump = job.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CloseJob>) -> Result<()> {
    let job_id = ctx.accounts.job.job_id;
    let job_bump = ctx.accounts.job.bump;
    let config_key = ctx.accounts.config.key();
    let job_id_bytes = job_id.to_le_bytes();

    // Close the vault token account, returning any remaining lamports to client.
    // The job PDA is the vault authority, so we sign with the job seeds.
    let seeds: &[&[u8]] = &[b"job", config_key.as_ref(), &job_id_bytes, &[job_bump]];
    let signer = &[seeds];

    close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.client.to_account_info(),
            authority: ctx.accounts.job.to_account_info(),
        },
        signer,
    ))?;

    emit!(JobClosed {
        job_id,
        client: ctx.accounts.client.key(),
    });

    msg!("Job {}: account closed, rent reclaimed", job_id);
    Ok(())
}

#[event]
pub struct JobClosed {
    pub job_id: u64,
    pub client: Pubkey,
}
