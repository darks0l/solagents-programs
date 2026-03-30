use anchor_lang::prelude::*;
use crate::state::PlatformConfig;
use crate::errors::CommerceError;

/// Accept a pending admin transfer. Called by the proposed new admin.
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.pending_admin == new_admin.key() @ CommerceError::NotPendingAdmin,
        constraint = config.pending_admin != Pubkey::default() @ CommerceError::NoPendingAdmin,
    )]
    pub config: Account<'info, PlatformConfig>,
}

pub fn handler(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let old_admin = config.admin;
    config.admin = config.pending_admin;
    config.pending_admin = Pubkey::default();

    emit!(AdminTransferred {
        old_admin,
        new_admin: config.admin,
    });

    msg!("Admin transferred from {} to {}", old_admin, config.admin);
    Ok(())
}

#[event]
pub struct AdminTransferred {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}
